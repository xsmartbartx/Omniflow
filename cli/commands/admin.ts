import { existsSync, mkdirSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { OmniflowError, randomToken } from '../../core/index.ts';
import type { Principal, Role } from '../../schemas/index.ts';
import { ROLES } from '../../schemas/index.ts';
import { Authenticator } from '../../gateway/auth.ts';
import { loadConfig } from '../../server/config.ts';
import { createLogger } from '../../core/index.ts';
import { openState, stateOptionsFor } from '../../state/index.ts';
import { UsageError, flag, flagAll, has } from '../args.ts';
import { type CliContext, emit } from '../context.ts';
import { table } from '../format.ts';

/**
 * Operator commands that act directly on a data directory (`OMNIFLOW_DATA_DIR`) — the break-glass
 * path for when there is no API key yet (first install) or the server is down (backup, integrity
 * check). They run on the machine that holds the data; SQLite's WAL makes them safe alongside a
 * running server.
 */

const SYSTEM: Principal = { id: 'system:cli', type: 'system', name: 'omniflow-cli', tenant: 'default', roles: ['admin'] };

function open(ctx: CliContext) {
  const dataDir = resolve(ctx.cwd, flag(ctx.args, 'data-dir') ?? ctx.env.OMNIFLOW_DATA_DIR ?? './data');
  if (!existsSync(join(dataDir, 'omniflow.db'))) {
    throw new UsageError(`No OmniFlow database in ${dataDir}. Set OMNIFLOW_DATA_DIR (or --data-dir) to the directory the server uses.`);
  }
  const config = loadConfig({ ...ctx.env, OMNIFLOW_DATA_DIR: dataDir, OMNIFLOW_LOG_LEVEL: 'silent' }, { cwd: ctx.cwd });
  const state = openState(stateOptionsFor(dataDir));
  const auth = new Authenticator(state, { sessionTtlHours: config.sessionTtlHours, log: createLogger({ level: 'silent' }) });
  return { config, state, auth, dataDir };
}

function rolesOf(ctx: CliContext, dflt: Role): Role[] {
  const given = flagAll(ctx.args, 'role');
  const roles = (given.length ? given : [dflt]).flatMap((r) => r.split(',')) as Role[];
  for (const r of roles) if (!(ROLES as readonly string[]).includes(r)) throw new UsageError(`Unknown role '${r}'. Roles: ${ROLES.join(', ')}`);
  return roles;
}

export async function adminCommand(ctx: CliContext): Promise<number> {
  const sub = ctx.args.positionals[1];
  const s = ctx.style;
  if (!sub) throw new UsageError('Usage: omniflow admin <create-user|reset-password|create-api-key|list-users|verify-audit|backup>');

  const { state, auth, dataDir } = open(ctx);
  try {
    switch (sub) {
      case 'create-user': {
        const email = flag(ctx.args, 'email');
        if (!email) throw new UsageError('Usage: omniflow admin create-user --email <email> [--name <name>] [--role admin|operator|…]');
        const generated = `${randomToken(12)}Aa1`;
        const password = ctx.env.OMNIFLOW_NEW_PASSWORD ?? generated;
        const user = await auth.createUser(SYSTEM, { email, ...(flag(ctx.args, 'name') ? { name: flag(ctx.args, 'name')! } : {}), password, roles: rolesOf(ctx, 'operator'), mustChangePassword: password === generated });
        emit(ctx, { id: user.id, email: user.email, roles: user.roles, ...(password === generated ? { password } : {}) }, () =>
          `${s.green('✓')} created ${user.email} (${user.roles.join(', ')})${password === generated ? `\n  temporary password: ${s.bold(password)}\n  it must be changed at first sign-in` : ''}`,
        );
        return 0;
      }
      case 'reset-password': {
        const email = flag(ctx.args, 'email');
        if (!email) throw new UsageError('Usage: omniflow admin reset-password --email <email>');
        const user = state.identity.findUsersByEmail(email)[0];
        if (!user) throw new UsageError(`No user with email ${email}`);
        const password = `${randomToken(12)}Aa1`;
        await auth.resetPassword(SYSTEM, user.id, password);
        emit(ctx, { email, password }, () => `${s.green('✓')} password reset for ${email}\n  temporary password: ${s.bold(password)}\n  it must be changed at first sign-in`);
        return 0;
      }
      case 'create-api-key': {
        const name = flag(ctx.args, 'name');
        if (!name) throw new UsageError('Usage: omniflow admin create-api-key --name <label> [--role operator] [--tenant default]');
        const tenant = flag(ctx.args, 'tenant') ?? 'default';
        if (!state.identity.getTenant(tenant)) throw new UsageError(`No such tenant '${tenant}'`);
        const { key, record } = auth.createApiKey({ ...SYSTEM, tenant }, { name, roles: rolesOf(ctx, 'operator') });
        emit(ctx, { id: record.id, key, roles: record.roles }, () => `${s.green('✓')} API key created (${record.roles.join(', ')})\n  ${s.bold(key)}\n  Store it now — it cannot be shown again.\n  export OMNIFLOW_API_KEY=${key}`);
        return 0;
      }
      case 'list-users': {
        const users = state.identity.listUsers(flag(ctx.args, 'tenant') ?? 'default');
        emit(ctx, users.map(({ passwordHash: _p, ...u }: any) => u), () => table(users.map((u) => [u.email, u.name ?? '', u.roles.join(','), u.disabled ? s.red('disabled') : s.green('active')]), ['EMAIL', 'NAME', 'ROLES', 'STATE'], s));
        return 0;
      }
      case 'verify-audit': {
        const bad: Array<{ tenant: string; brokenAtSeq?: number; reason?: string }> = [];
        let checked = 0;
        for (const t of state.identity.listTenants()) {
          const r = state.events.verify(t.id);
          checked += r.checked;
          if (!r.ok) bad.push({ tenant: t.id, ...(r.brokenAtSeq !== undefined ? { brokenAtSeq: r.brokenAtSeq } : {}), ...(r.reason ? { reason: r.reason } : {}) });
        }
        emit(ctx, { ok: bad.length === 0, checked, problems: bad }, () =>
          bad.length === 0 ? `${s.green('✓')} audit log intact — ${checked} events verified` : bad.map((b) => `${s.red('✗')} tenant ${b.tenant}: tampering detected at event ${b.brokenAtSeq} (${b.reason})`).join('\n'),
        );
        return bad.length === 0 ? 0 : 1;
      }
      case 'backup': {
        const dest = ctx.args.positionals[2];
        if (!dest) throw new UsageError('Usage: omniflow admin backup <destination-file>');
        const abs = resolve(ctx.cwd, dest);
        if (existsSync(abs)) throw new UsageError(`${dest} already exists; refusing to overwrite a backup`);
        mkdirSync(dirname(abs), { recursive: true });
        state.db.backupTo(abs);
        const bytes = statSync(abs).size;
        emit(ctx, { ok: true, file: abs, bytes }, () =>
          `${s.green('✓')} backed up ${dataDir} to ${abs} (${(bytes / 1024).toFixed(0)} KiB)\n  ${s.dim('The master key is NOT in the backup. Keep OMNIFLOW_MASTER_KEY (or data/master.key) safely elsewhere — without it stored secrets cannot be decrypted.')}`,
        );
        return 0;
      }
      default:
        throw new UsageError(`Unknown admin subcommand '${sub}'`);
    }
  } catch (e) {
    if (e instanceof OmniflowError && !(e instanceof UsageError)) {
      ctx.err(`${s.red('error')}: ${e.message}\n`);
      return 1;
    }
    throw e;
  } finally {
    state.close();
    void has;
  }
}
