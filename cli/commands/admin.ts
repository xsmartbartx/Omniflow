import { accessSync, chmodSync, constants, copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, statfsSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { OmniflowError, randomToken } from '../../core/index.ts';
import type { Principal, Role } from '../../schemas/index.ts';
import { ROLES } from '../../schemas/index.ts';
import { Authenticator } from '../../gateway/auth.ts';
import { createKeyring, decryptSecret, SecretBroker } from '../../security/secret-broker/index.ts';
import { loadConfig } from '../../server/config.ts';
import { createLogger } from '../../core/index.ts';
import { openState, type State, stateOptionsFor } from '../../state/index.ts';
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
  const config = loadConfig({ ...ctx.env, OMNIFLOW_DATA_DIR: dataDir, OMNIFLOW_LOG_LEVEL: 'silent' }, { cwd: ctx.cwd, persistMasterKey: false });
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
  if (!sub) throw new UsageError('Usage: omniflow admin <create-user|reset-password|create-api-key|list-users|verify-audit|backup|restore|doctor|rotate-master-key>');

  // Restore may target a fresh, empty data directory, so it cannot require an existing database.
  if (sub === 'restore') return restore(ctx);

  const { config, state, auth, dataDir } = open(ctx);
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
        // Large step outputs live in a content-addressed directory: copy it beside the database snapshot.
        const artifacts = join(dataDir, 'artifacts');
        const artifactsCopy = `${abs}.artifacts`;
        if (existsSync(artifacts) && readdirSync(artifacts).length > 0) cpSync(artifacts, artifactsCopy, { recursive: true });
        emit(ctx, { ok: true, file: abs, bytes }, () =>
          `${s.green('✓')} backed up ${dataDir} to ${abs} (${(bytes / 1024).toFixed(0)} KiB)\n  ${s.dim('The master key is NOT in the backup. Keep OMNIFLOW_MASTER_KEY (or data/master.key) safely elsewhere — without it stored secrets cannot be decrypted.')}`,
        );
        return 0;
      }
      case 'doctor':
        return doctor(ctx, { config, state, dataDir });
      case 'rotate-master-key': {
        if (config.masterKeySource === 'ephemeral') throw new UsageError('No master key is available. Provide the new key in OMNIFLOW_MASTER_KEY and the old one(s) in OMNIFLOW_PREVIOUS_MASTER_KEYS.');
        const keyring = createKeyring(config.masterKey, config.previousMasterKeys);
        const broker = new SecretBroker(state.secrets, keyring);
        const rewritten = broker.rotate(keyring);
        emit(ctx, { ok: true, rewritten }, () =>
          `${s.green('✓')} ${rewritten} secret${rewritten === 1 ? '' : 's'} re-encrypted under the current master key\n  ${s.dim('Once every instance runs the new OMNIFLOW_MASTER_KEY you can drop OMNIFLOW_PREVIOUS_MASTER_KEYS.')}`,
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

// ------------------------------------------------------------------ doctor
type Level = 'ok' | 'warn' | 'fail';
interface Check {
  level: Level;
  check: string;
  detail: string;
}

/** A deployment health check: everything an operator would otherwise verify by hand. */
function doctor(ctx: CliContext, { config, state, dataDir }: { config: ReturnType<typeof loadConfig>; state: State; dataDir: string }): number {
  const s = ctx.style;
  const checks: Check[] = [];
  const add = (level: Level, check: string, detail: string) => checks.push({ level, check, detail });

  try {
    accessSync(dataDir, constants.R_OK | constants.W_OK);
    const probe = join(dataDir, `.doctor-${process.pid}`);
    writeFileSync(probe, 'x');
    unlinkSync(probe);
    add('ok', 'data directory', `${dataDir} is readable and writable`);
  } catch (e) {
    add('fail', 'data directory', `${dataDir} is not writable: ${(e as Error).message}`);
  }
  try {
    const fs = statfsSync(dataDir);
    const freeMb = Math.round((fs.bavail * fs.bsize) / 1_048_576);
    add(freeMb < 200 ? 'fail' : freeMb < 1024 ? 'warn' : 'ok', 'disk space', `${freeMb.toLocaleString('en')} MiB free`);
  } catch {
    /* not available on every platform */
  }

  const integrity = state.db.get<{ integrity_check: string }>('PRAGMA integrity_check')?.integrity_check;
  add(integrity === 'ok' ? 'ok' : 'fail', 'database integrity', integrity === 'ok' ? 'SQLite integrity_check passed' : `SQLite reports: ${integrity}`);

  let chained = 0;
  const broken: string[] = [];
  for (const t of state.identity.listTenants()) {
    const v = state.events.verify(t.id);
    chained += v.checked;
    if (!v.ok) broken.push(`${t.id} at event ${v.brokenAtSeq}`);
  }
  add(broken.length ? 'fail' : 'ok', 'audit log', broken.length ? `hash chain broken: ${broken.join('; ')}` : `${chained.toLocaleString('en')} events, hash chain intact`);

  const keyring = createKeyring(config.masterKey, config.previousMasterKeys);
  const secrets = config.masterKeySource === 'ephemeral' ? [] : state.secrets.all();
  if (config.masterKeySource === 'ephemeral') {
    const n = state.secrets.all().length;
    add(n ? 'fail' : 'warn', 'master key', `not available to this command (no OMNIFLOW_MASTER_KEY and no ${join(dataDir, 'master.key')}); ${n ? `${n} stored secret(s) could not be checked` : 'no secrets are stored yet'}`);
  }
  let unreadable = 0;
  let old = 0;
  for (const rec of secrets) {
    if (rec.keyId !== keyring.primaryId) old++;
    try {
      decryptSecret(keyring, rec.tenant, rec.name, rec.cipher);
    } catch {
      unreadable++;
    }
  }
  if (unreadable) add('fail', 'secrets', `${unreadable} of ${secrets.length} cannot be decrypted with the configured master key(s) — is OMNIFLOW_MASTER_KEY the one they were written with?`);
  else if (old) add('warn', 'secrets', `${old} secret(s) still use an older master key; run 'omniflow admin rotate-master-key'`);
  else if (config.masterKeySource !== 'ephemeral') add('ok', 'secrets', `${secrets.length} stored, all readable with the current master key`);

  const keyFile = join(dataDir, 'master.key');
  if (config.masterKeySource === 'ephemeral') {
    /* reported above */
  } else if (ctx.env.OMNIFLOW_MASTER_KEY) add('ok', 'master key', 'supplied through OMNIFLOW_MASTER_KEY');
  else if (existsSync(keyFile)) {
    const loose = (statSync(keyFile).mode & 0o077) !== 0;
    add(loose ? 'fail' : config.environment === 'production' ? 'warn' : 'ok', 'master key', loose ? `${keyFile} is readable by other users (chmod 600)` : `generated key in ${keyFile}${config.environment === 'production' ? ' — in production, supply OMNIFLOW_MASTER_KEY from a secret manager and keep a copy off this host' : ''}`);
  }

  const admins = state.identity.listUsers('default').filter((u) => u.roles.includes('admin') && !u.disabled);
  add(admins.length ? 'ok' : 'fail', 'administrators', admins.length ? `${admins.length} active admin${admins.length === 1 ? '' : 's'}` : 'no active administrator — run: omniflow admin create-user --role admin');

  if (config.environment === 'production') {
    if (!config.publicUrl.startsWith('https://')) add('warn', 'HTTPS', `OMNIFLOW_PUBLIC_URL is ${config.publicUrl}: session cookies will not be marked Secure. Put a TLS-terminating proxy in front and set an https:// URL.`);
    else if (!config.trustProxy) add('warn', 'reverse proxy', 'OMNIFLOW_PUBLIC_URL is https but OMNIFLOW_TRUST_PROXY is off: rate limits and audit will see the proxy\'s address, not the client\'s');
    else add('ok', 'HTTPS', 'public URL is https and the proxy is trusted');
    add('ok', 'metrics', config.metricsToken ? '/metrics accepts the OMNIFLOW_METRICS_TOKEN bearer token' : '/metrics needs an API key with audit access (set OMNIFLOW_METRICS_TOKEN for a dedicated scrape token)');
    add(config.alertChannels.length ? 'ok' : 'warn', 'alerting', config.alertChannels.length ? `alerts go to: ${config.alertChannels.join(', ')}` : 'no OMNIFLOW_ALERT_CHANNELS: alerts are only visible in the console');
  }
  if (config.adapters.shell.allowedCommands.length) add('warn', 'shell capability', `enabled for ${config.adapters.shell.allowedCommands.length} executable(s); run OmniFlow in a network-restricted container`);
  if (config.adapters.allowPrivateNetworks) add('warn', 'private network egress', 'OMNIFLOW_ALLOW_PRIVATE_EGRESS is on: allow-listed hosts may resolve to private addresses');

  const failed = checks.filter((c) => c.level === 'fail').length;
  const warned = checks.filter((c) => c.level === 'warn').length;
  emit(ctx, { ok: failed === 0, failed, warnings: warned, checks }, () =>
    [
      ...checks.map((c) => `${c.level === 'ok' ? s.green('✓') : c.level === 'warn' ? s.yellow('!') : s.red('✗')} ${s.bold(c.check.padEnd(22))} ${c.detail}`),
      '',
      failed ? s.red(`${failed} problem${failed === 1 ? '' : 's'} need attention`) : s.green('Healthy') + (warned ? s.yellow(` — ${warned} warning${warned === 1 ? '' : 's'}`) : ''),
    ].join('\n'),
  );
  return failed === 0 ? 0 : 1;
}

// ----------------------------------------------------------------- restore
/**
 * Restore a snapshot made by `admin backup`. Refuses to touch a database that a running server holds,
 * verifies the snapshot first (integrity and audit chain), and keeps the previous database beside it.
 */
function restore(ctx: CliContext): number {
  const s = ctx.style;
  const src = ctx.args.positionals[2];
  if (!src) throw new UsageError('Usage: omniflow admin restore <backup-file> [--yes]   (stop the server first)');
  const from = resolve(ctx.cwd, src);
  if (!existsSync(from)) throw new UsageError(`No such backup: ${src}`);
  const dataDir = resolve(ctx.cwd, flag(ctx.args, 'data-dir') ?? ctx.env.OMNIFLOW_DATA_DIR ?? './data');
  const target = join(dataDir, 'omniflow.db');

  // 1. verify the snapshot on a scratch copy, so the original is never modified (opening migrates)
  const scratch = mkdtempSync(join(tmpdir(), 'omniflow-restore-'));
  try {
    const copy = join(scratch, 'snapshot.db');
    copyFileSync(from, copy);
    const state = openState({ dbPath: copy, artifactDir: join(scratch, 'artifacts') });
    try {
      const ok = state.db.get<{ integrity_check: string }>('PRAGMA integrity_check')?.integrity_check;
      if (ok !== 'ok') throw new UsageError(`The backup is damaged (integrity_check: ${ok})`);
      for (const t of state.identity.listTenants()) {
        const v = state.events.verify(t.id);
        if (!v.ok) throw new UsageError(`The backup's audit log for tenant '${t.id}' fails verification at event ${v.brokenAtSeq}: ${v.reason}. Refusing to restore it.`);
      }
    } finally {
      state.close();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }

  // 2. make sure nothing is using the live database
  mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  let previous: string | undefined;
  if (existsSync(target)) {
    if (!has(ctx.args, 'yes')) throw new UsageError(`${target} already exists. Re-run with --yes to replace it (the old database is kept as omniflow.db.pre-restore-*).`);
    const live = new DatabaseSync(target);
    try {
      live.exec('BEGIN EXCLUSIVE');
      live.exec('ROLLBACK');
      live.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    } catch {
      live.close();
      throw new UsageError('The database is in use. Stop the OmniFlow server before restoring.');
    }
    live.close();
    previous = `${target}.pre-restore-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    renameSync(target, previous);
  }
  for (const ext of ['-wal', '-shm']) rmSync(`${target}${ext}`, { force: true });

  // 3. put the snapshot (and its artifacts) in place
  copyFileSync(from, target);
  chmodSync(target, 0o600);
  const artifacts = `${from}.artifacts`;
  if (existsSync(artifacts)) cpSync(artifacts, join(dataDir, 'artifacts'), { recursive: true });

  emit(ctx, { ok: true, restored: target, previous: previous ?? null }, () =>
    [`${s.green('✓')} restored ${from} → ${target}`, previous ? `  previous database kept at ${previous}` : '', '  Start the server, then run: omniflow admin doctor', s.dim('  Secrets in the snapshot can only be read with the master key they were written with.')].filter(Boolean).join('\n'),
  );
  return 0;
}
