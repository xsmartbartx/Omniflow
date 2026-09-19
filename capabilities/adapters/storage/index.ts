import { createHash } from 'node:crypto';
import { mkdir, readdir, readFile, realpath, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';
import type { CapabilityDeclaration } from '../../../schemas/index.ts';
import { type CapabilityAdapter, CapabilityError } from '../../contract/types.ts';
import type { AdapterConfig } from '../config.ts';

const base = {
  version: '1.0.0',
  family: 'storage',
  egress: { mode: 'none' as const },
  costModel: { unitsPerInvocation: 0, latencyClass: 'fast' as const },
  dataClassification: 'confidential' as const,
};

const failureModes = [
  {
    code: 'PATH_ESCAPES_ROOT',
    class: 'authorisation' as const,
    retryable: false,
    description: 'The path resolves outside the storage root',
  },
  { code: 'FILE_NOT_FOUND', class: 'business' as const, retryable: false },
  { code: 'FILE_EXISTS', class: 'business' as const, retryable: false },
  { code: 'FILE_TOO_LARGE', class: 'contract' as const, retryable: false },
];

function denied(path: string): CapabilityError {
  return new CapabilityError('PATH_ESCAPES_ROOT', `Path '${path}' is outside the storage root`, {
    errorClass: 'authorisation',
    retryable: false,
  });
}

/**
 * File operations confined to one directory. Paths are resolved against the root and re-checked
 * after resolving symlinks, so neither `../` nor a planted symlink can reach outside it.
 */
export function createStorageCapabilities(config: AdapterConfig): CapabilityAdapter[] {
  const root = resolve(config.storage.root);
  const maxBytes = config.storage.maxFileBytes;

  async function safePath(path: string, opts: { mustExist?: boolean } = {}): Promise<string> {
    if (path.includes('\0')) throw denied(path);
    await mkdir(root, { recursive: true });
    const realRoot = await realpath(root);
    const target = resolve(realRoot, path.replace(/^\/+/, ''));
    if (target !== realRoot && !target.startsWith(realRoot + sep)) throw denied(path);
    // Resolve the deepest existing ancestor so a symlink anywhere on the path cannot escape.
    let probe = target;
    for (;;) {
      try {
        const real = await realpath(probe);
        if (real !== realRoot && !real.startsWith(realRoot + sep)) throw denied(path);
        break;
      } catch (e) {
        if (e instanceof CapabilityError) throw e;
        const parent = dirname(probe);
        if (parent === probe) break;
        probe = parent;
      }
    }
    if (opts.mustExist) {
      try {
        await stat(target);
      } catch {
        throw new CapabilityError('FILE_NOT_FOUND', `'${path}' does not exist`, {
          errorClass: 'business',
          retryable: false,
        });
      }
    }
    return target;
  }

  const decode = (content: string, encoding: string) => Buffer.from(content, encoding === 'base64' ? 'base64' : 'utf8');

  const read: CapabilityAdapter = {
    declaration: {
      ...base,
      name: 'file-read',
      description: 'Read a file from the storage root.',
      inputSchema: {
        type: 'object',
        required: ['path'],
        additionalProperties: false,
        properties: {
          path: { type: 'string', minLength: 1, maxLength: 1024 },
          encoding: { enum: ['utf8', 'base64'], default: 'utf8' },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['content', 'size', 'encoding', 'sha256'],
        properties: {
          content: { type: 'string' },
          size: { type: 'integer' },
          encoding: { type: 'string' },
          sha256: { type: 'string' },
        },
        additionalProperties: false,
      },
      effect: 'idempotent',
      scopes: ['storage:read'],
      failureModes,
      dryRun: 'execute',
    } as CapabilityDeclaration,
    async execute(_ctx, input: { path: string; encoding?: string }) {
      const file = await safePath(input.path, { mustExist: true });
      const info = await stat(file);
      if (info.size > maxBytes)
        throw new CapabilityError('FILE_TOO_LARGE', `File is ${info.size} bytes; the limit is ${maxBytes}`, {
          errorClass: 'contract',
          retryable: false,
        });
      const buf = await readFile(file);
      const encoding = input.encoding ?? 'utf8';
      return {
        content: buf.toString(encoding === 'base64' ? 'base64' : 'utf8'),
        size: buf.length,
        encoding,
        sha256: createHash('sha256').update(buf).digest('hex'),
      };
    },
  };

  const list: CapabilityAdapter = {
    declaration: {
      ...base,
      name: 'file-list',
      description: 'List files under a directory of the storage root.',
      inputSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', maxLength: 1024, default: '.' },
          recursive: { type: 'boolean', default: false },
          maxEntries: { type: 'integer', minimum: 1, maximum: 10000, default: 1000 },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['entries', 'truncated'],
        properties: {
          entries: {
            type: 'array',
            items: {
              type: 'object',
              required: ['path', 'type', 'size'],
              properties: {
                path: { type: 'string' },
                type: { enum: ['file', 'directory'] },
                size: { type: 'integer' },
              },
            },
          },
          truncated: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      effect: 'idempotent',
      scopes: ['storage:read'],
      failureModes,
      dryRun: 'execute',
    } as CapabilityDeclaration,
    async execute(_ctx, input: { path?: string; recursive?: boolean; maxEntries?: number }) {
      const dir = await safePath(input.path ?? '.', { mustExist: true });
      const realRoot = await realpath(root);
      const limit = input.maxEntries ?? 1000;
      const entries: Array<{ path: string; type: 'file' | 'directory'; size: number }> = [];
      let truncated = false;
      const walk = async (d: string): Promise<void> => {
        for (const e of (await readdir(d, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
          if (entries.length >= limit) {
            truncated = true;
            return;
          }
          const full = join(d, e.name);
          if (e.isSymbolicLink()) continue; // never follow links
          const st = await stat(full);
          entries.push({
            path: relative(realRoot, full),
            type: e.isDirectory() ? 'directory' : 'file',
            size: e.isDirectory() ? 0 : st.size,
          });
          if (e.isDirectory() && input.recursive) await walk(full);
        }
      };
      await walk(dir);
      return { entries, truncated };
    },
  };

  const write: CapabilityAdapter = {
    declaration: {
      ...base,
      name: 'file-write',
      description: 'Write a file into the storage root, atomically. Writing identical content again is a no-op.',
      inputSchema: {
        type: 'object',
        required: ['path', 'content'],
        additionalProperties: false,
        properties: {
          path: { type: 'string', minLength: 1, maxLength: 1024 },
          content: { type: 'string' },
          encoding: { enum: ['utf8', 'base64'], default: 'utf8' },
          overwrite: { type: 'boolean', default: true },
        },
      },
      outputSchema: {
        type: 'object',
        required: ['path', 'size', 'sha256', 'created'],
        properties: {
          path: { type: 'string' },
          size: { type: 'integer' },
          sha256: { type: 'string' },
          created: { type: 'boolean' },
        },
        additionalProperties: false,
      },
      effect: 'effectful',
      scopes: ['storage:write'],
      failureModes,
      dryRun: 'simulate',
    } as CapabilityDeclaration,
    simulate: (_ctx, input: { path: string; content: string; encoding?: string }) => {
      const buf = decode(input.content, input.encoding ?? 'utf8');
      return {
        path: input.path,
        size: buf.length,
        sha256: createHash('sha256').update(buf).digest('hex'),
        created: false,
      };
    },
    async execute(_ctx, input: { path: string; content: string; encoding?: string; overwrite?: boolean }) {
      const buf = decode(input.content, input.encoding ?? 'utf8');
      if (buf.length > maxBytes)
        throw new CapabilityError('FILE_TOO_LARGE', `Content is ${buf.length} bytes; the limit is ${maxBytes}`, {
          errorClass: 'contract',
          retryable: false,
        });
      const file = await safePath(input.path);
      const sha256 = createHash('sha256').update(buf).digest('hex');
      let existing: Buffer | undefined;
      try {
        existing = await readFile(file);
      } catch {
        existing = undefined;
      }
      if (existing) {
        if (existing.equals(buf)) return { path: input.path, size: buf.length, sha256, created: false };
        if (input.overwrite === false)
          throw new CapabilityError('FILE_EXISTS', `'${input.path}' already exists`, {
            errorClass: 'business',
            retryable: false,
          });
      }
      await mkdir(dirname(file), { recursive: true });
      const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, buf, { mode: 0o640 });
      await rename(tmp, file);
      return { path: input.path, size: buf.length, sha256, created: existing === undefined };
    },
  };

  const del: CapabilityAdapter = {
    declaration: {
      ...base,
      name: 'file-delete',
      description: 'Delete a file from the storage root. Deleting a missing file succeeds.',
      inputSchema: {
        type: 'object',
        required: ['path'],
        additionalProperties: false,
        properties: { path: { type: 'string', minLength: 1, maxLength: 1024 } },
      },
      outputSchema: {
        type: 'object',
        required: ['deleted'],
        properties: { deleted: { type: 'boolean' } },
        additionalProperties: false,
      },
      effect: 'effectful',
      scopes: ['storage:write'],
      failureModes,
      dryRun: 'simulate',
    } as CapabilityDeclaration,
    simulate: () => ({ deleted: false }),
    async execute(_ctx, input: { path: string }) {
      const file = await safePath(input.path);
      try {
        const st = await stat(file);
        if (st.isDirectory())
          throw new CapabilityError('NOT_A_FILE', 'Only files can be deleted', {
            errorClass: 'contract',
            retryable: false,
          });
        await rm(file);
        return { deleted: true };
      } catch (e) {
        if (e instanceof CapabilityError) throw e;
        return { deleted: false };
      }
    },
  };

  return [read, list, write, del];
}
