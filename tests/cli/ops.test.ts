import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  statSync,
  truncateSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { describe, expect, it } from 'vitest';
import { runCli } from '../../cli/main.ts';
import { createLogger } from '../../core/index.ts';
import { generateMasterKey } from '../../security/secret-broker/index.ts';
import { loadConfig } from '../../server/config.ts';
import { createOmniflow } from '../../server/platform.ts';
import { openState, stateOptionsFor } from '../../state/index.ts';

const tmp = () => mkdtempSync(join(tmpdir(), 'omniflow-ops-'));

async function cli(argv: string[], env: Record<string, string>, cwd = tmpdir()) {
  let out = '';
  let err = '';
  const code = await runCli(
    argv,
    { out: (t) => (out += t), err: (t) => (err += t), readStdin: async () => '' },
    { OMNIFLOW_LOG_LEVEL: 'silent', ...env },
    cwd,
  );
  return { code, out, err };
}

/** A data directory that a real server has run against, then shut down cleanly. */
async function provision(env: Record<string, string> = {}, secret?: { name: string; value: string }) {
  const dir = tmp();
  const config = loadConfig(
    {
      OMNIFLOW_DATA_DIR: dir,
      OMNIFLOW_LOG_LEVEL: 'silent',
      OMNIFLOW_ADMIN_PASSWORD: 'correct-horse-battery-staple',
      ...env,
    },
    { cwd: dir },
  );
  const app = createOmniflow(config, { log: createLogger({ level: 'silent' }) });
  await app.start();
  if (secret) app.broker.put('default', secret.name, secret.value, 'test');
  await app.stop();
  return dir;
}

describe('admin doctor', () => {
  it('reports a healthy installation', async () => {
    const dir = await provision();
    const r = await cli(['admin', 'doctor'], { OMNIFLOW_DATA_DIR: dir });
    expect(r.code).toBe(0);
    for (const c of ['data directory', 'database integrity', 'audit log', 'master key', 'administrators'])
      expect(r.out).toContain(c);
    expect(r.out).toContain('Healthy');
    const json = JSON.parse((await cli(['admin', 'doctor', '--json'], { OMNIFLOW_DATA_DIR: dir })).out);
    expect(json).toMatchObject({ ok: true, failed: 0 });
  });

  it('warns about a production deployment that is not ready for the internet', async () => {
    const dir = await provision();
    const r = await cli(['admin', 'doctor'], {
      OMNIFLOW_DATA_DIR: dir,
      OMNIFLOW_ENV: 'production',
      OMNIFLOW_PUBLIC_URL: 'http://omniflow.example.com',
    });
    expect(r.code).toBe(0);
    expect(r.out).toContain('HTTPS');
    expect(r.out).toContain('not be marked Secure');
    expect(r.out).toContain('OMNIFLOW_METRICS_TOKEN');
    const ready = await cli(['admin', 'doctor'], {
      OMNIFLOW_DATA_DIR: dir,
      OMNIFLOW_ENV: 'production',
      OMNIFLOW_PUBLIC_URL: 'https://omniflow.example.com',
      OMNIFLOW_TRUST_PROXY: 'true',
      OMNIFLOW_METRICS_TOKEN: 'x'.repeat(20),
    });
    expect(ready.out).toContain('public URL is https and the proxy is trusted');
  });

  it('fails loudly when the audit log has been tampered with', async () => {
    const dir = await provision();
    const raw = new DatabaseSync(join(dir, 'omniflow.db'));
    raw.exec('DROP TRIGGER events_no_update');
    raw.exec(`UPDATE events SET data = '{"evil":true}' WHERE seq = 2`);
    raw.close();
    const r = await cli(['admin', 'doctor'], { OMNIFLOW_DATA_DIR: dir });
    expect(r.code).toBe(1);
    expect(r.out).toContain('hash chain broken');
    expect(r.out).toContain('need attention');
    expect((await cli(['admin', 'verify-audit'], { OMNIFLOW_DATA_DIR: dir })).code).toBe(1);
  });

  it('notices secrets that the configured master key cannot read', async () => {
    const dir = await provision({}, { name: 'API_TOKEN', value: 'hunter2' });
    const wrong = await cli(['admin', 'doctor'], { OMNIFLOW_DATA_DIR: dir, OMNIFLOW_MASTER_KEY: generateMasterKey() });
    expect(wrong.code).toBe(1);
    expect(wrong.out).toContain('cannot be decrypted');
    expect((await cli(['admin', 'doctor'], { OMNIFLOW_DATA_DIR: dir })).out).toContain('1 stored, all readable');
  });

  it('never invents and stores a master key just because a diagnostic was run', async () => {
    const dir = await provision({ OMNIFLOW_MASTER_KEY: generateMasterKey() });
    expect(existsSync(join(dir, 'master.key'))).toBe(false);
    const r = await cli(['admin', 'doctor'], { OMNIFLOW_DATA_DIR: dir });
    expect(r.out).toContain('not available to this command');
    expect(existsSync(join(dir, 'master.key'))).toBe(false);
    expect((await cli(['admin', 'rotate-master-key'], { OMNIFLOW_DATA_DIR: dir })).code).toBe(2);
  });

  it('flags a master key file that other users can read', async () => {
    const dir = await provision();
    const { chmodSync } = await import('node:fs');
    chmodSync(join(dir, 'master.key'), 0o644);
    const r = await cli(['admin', 'doctor'], { OMNIFLOW_DATA_DIR: dir });
    expect(r.code).toBe(1);
    expect(r.out).toContain('readable by other users');
  });
});

describe('master key rotation', () => {
  it('re-encrypts every secret under the new key, after which the old key can be retired', async () => {
    const oldKey = generateMasterKey();
    const newKey = generateMasterKey();
    const dir = await provision({ OMNIFLOW_MASTER_KEY: oldKey }, { name: 'DB_PASSWORD', value: 'p4ss' });

    // with the new key only, the secret is unreadable …
    expect((await cli(['admin', 'doctor'], { OMNIFLOW_DATA_DIR: dir, OMNIFLOW_MASTER_KEY: newKey })).code).toBe(1);
    // … with both, it is readable but flagged as using an older key
    const both = { OMNIFLOW_DATA_DIR: dir, OMNIFLOW_MASTER_KEY: newKey, OMNIFLOW_PREVIOUS_MASTER_KEYS: oldKey };
    expect((await cli(['admin', 'doctor'], both)).out).toContain('still use an older master key');

    const rotated = await cli(['admin', 'rotate-master-key', '--json'], both);
    expect(rotated.code).toBe(0);
    expect(JSON.parse(rotated.out)).toEqual({ ok: true, rewritten: 1 });

    // now the old key is no longer needed
    const after = await cli(['admin', 'doctor'], { OMNIFLOW_DATA_DIR: dir, OMNIFLOW_MASTER_KEY: newKey });
    expect(after.code).toBe(0);
    expect(after.out).toContain('1 stored, all readable');
    expect(JSON.parse((await cli(['admin', 'rotate-master-key', '--json'], both)).out).rewritten).toBe(0);
  });
});

describe('backup and restore', () => {
  it('round-trips a data directory, including artifacts, onto a fresh host', async () => {
    const dir = await provision({}, { name: 'TOKEN', value: 'v' });
    mkdirSync(join(dir, 'artifacts', 'ab'), { recursive: true });
    writeFileSync(join(dir, 'artifacts', 'ab', 'abcdef'), '{"big":"output"}');
    const backup = join(tmp(), 'snap.db');
    const b = await cli(['admin', 'backup', backup], { OMNIFLOW_DATA_DIR: dir });
    expect(b.code).toBe(0);
    expect(existsSync(`${backup}.artifacts/ab/abcdef`)).toBe(true);

    const fresh = tmp();
    const r = await cli(['admin', 'restore', backup], { OMNIFLOW_DATA_DIR: fresh });
    expect(r.code).toBe(0);
    expect(r.out).toContain('restored');
    expect(statSync(join(fresh, 'omniflow.db')).mode & 0o077).toBe(0);
    expect(readFileSync(join(fresh, 'artifacts', 'ab', 'abcdef'), 'utf8')).toBe('{"big":"output"}');

    // the restored data is a working installation: same users, intact audit chain, secrets readable with the original key
    const state = openState(stateOptionsFor(fresh));
    try {
      expect(state.identity.countUsers()).toBe(1);
      expect(state.events.verify('default').ok).toBe(true);
    } finally {
      state.close();
    }
    const keyText = readFileSync(join(dir, 'master.key'), 'utf8').trim();
    const doc = await cli(['admin', 'doctor'], { OMNIFLOW_DATA_DIR: fresh, OMNIFLOW_MASTER_KEY: keyText });
    expect(doc.code).toBe(0);
    expect(doc.out).toContain('1 stored, all readable');
  });

  it('will not overwrite an existing database without --yes, and keeps the old one when it does', async () => {
    const dir = await provision();
    const other = await provision();
    const backup = join(tmp(), 'snap.db');
    await cli(['admin', 'backup', backup], { OMNIFLOW_DATA_DIR: other });
    const refused = await cli(['admin', 'restore', backup], { OMNIFLOW_DATA_DIR: dir });
    expect(refused.code).toBe(2);
    expect(refused.err).toContain('--yes');
    const done = await cli(['admin', 'restore', backup, '--yes'], { OMNIFLOW_DATA_DIR: dir });
    expect(done.code).toBe(0);
    expect(readdirSync(dir).some((f) => f.startsWith('omniflow.db.pre-restore-'))).toBe(true);
    expect(done.out).toContain('previous database kept at');
  });

  it('refuses to restore over a database a running server holds', async () => {
    const dir = await provision();
    const backup = join(tmp(), 'snap.db');
    await cli(['admin', 'backup', backup], { OMNIFLOW_DATA_DIR: dir });
    const busy = new DatabaseSync(join(dir, 'omniflow.db'));
    busy.exec('BEGIN EXCLUSIVE');
    try {
      const r = await cli(['admin', 'restore', backup, '--yes'], { OMNIFLOW_DATA_DIR: dir });
      expect(r.code).toBe(2);
      expect(r.err).toContain('in use');
    } finally {
      busy.exec('ROLLBACK');
      busy.close();
    }
    expect(readdirSync(dir).some((f) => f.includes('pre-restore'))).toBe(false); // nothing was moved
  });

  it('refuses damaged or tampered backups, and leaves the target untouched', async () => {
    const dir = await provision();
    const good = join(tmp(), 'good.db');
    await cli(['admin', 'backup', good], { OMNIFLOW_DATA_DIR: dir });

    const tampered = join(tmp(), 'tampered.db');
    await cli(['admin', 'backup', tampered], { OMNIFLOW_DATA_DIR: dir });
    const raw = new DatabaseSync(tampered);
    raw.exec('DROP TRIGGER events_no_update');
    raw.exec(`UPDATE events SET data = '{"evil":true}' WHERE seq = 2`);
    raw.close();
    const t = await cli(['admin', 'restore', tampered, '--yes'], { OMNIFLOW_DATA_DIR: tmp() });
    expect(t.code).toBe(2);
    expect(t.err).toContain('fails verification');

    const damaged = join(tmp(), 'damaged.db');
    writeFileSync(damaged, readFileSync(good));
    truncateSync(damaged, 4000);
    const d = await cli(['admin', 'restore', damaged, '--yes'], { OMNIFLOW_DATA_DIR: tmp() });
    expect(d.code).not.toBe(0);

    const target = tmp();
    await cli(['admin', 'restore', tampered], { OMNIFLOW_DATA_DIR: target });
    expect(existsSync(join(target, 'omniflow.db'))).toBe(false);
    expect((await cli(['admin', 'restore', join(tmp(), 'missing.db')], { OMNIFLOW_DATA_DIR: target })).code).toBe(2);
    expect((await cli(['admin', 'restore'], { OMNIFLOW_DATA_DIR: target })).code).toBe(2);
  });
});

describe('admin prune', () => {
  const OLD = '2026-01-01T00:00:00.000Z';
  function seed(dir: string) {
    const st = openState(stateOptionsFor(dir));
    const raw = new DatabaseSync(join(dir, 'omniflow.db'));
    const run = (id: string, status: string, finished: string | null) =>
      raw
        .prepare(
          `INSERT INTO runs (id, tenant_id, workflow_name, workflow_version, plan_hash, status, environment, trigger_type,
             inputs, seed, context_now, requested_by, created_at, finished_at)
           VALUES (?, 'default', 'w', '1', 'h', ?, 'dev', 'manual', '{}', 's', ?, 'u', ?, ?)`,
        )
        .run(id, status, OLD, OLD, finished);
    run('run_old', 'succeeded', OLD);
    run('run_active', 'running', null);
    const oldA = st.artifacts.put('default', 'old output', { runId: 'run_old' });
    const liveA = st.artifacts.put('default', 'still running', { runId: 'run_active' });
    st.close();
    raw.close();
    return { oldA, liveA };
  }

  it('erases old artifacts only, supports a dry run, and leaves the audit chain intact', async () => {
    const dir = await provision();
    const { oldA, liveA } = seed(dir);
    const env = { OMNIFLOW_DATA_DIR: dir };

    const dry = JSON.parse((await cli(['admin', 'prune', '--older-than-days', '30', '--dry-run', '--json'], env)).out);
    expect(dry).toMatchObject({ dryRun: true, artifacts: 1 });
    let st = openState(stateOptionsFor(dir));
    expect(st.artifacts.meta('default', oldA.ref)?.tombstonedAt).toBeUndefined();
    st.close();

    const real = JSON.parse((await cli(['admin', 'prune', '--older-than-days', '30', '--json'], env)).out);
    expect(real).toMatchObject({ dryRun: false, artifacts: 1 });
    st = openState(stateOptionsFor(dir));
    expect(st.artifacts.meta('default', oldA.ref)?.tombstonedAt).toBeDefined();
    expect(st.artifacts.meta('default', liveA.ref)?.tombstonedAt).toBeUndefined();
    st.close();

    expect((await cli(['admin', 'verify-audit'], env)).code).toBe(0);
    const again = JSON.parse((await cli(['admin', 'prune', '--older-than-days', '30', '--json'], env)).out);
    expect(again.artifacts).toBe(0);
  });

  it('requires a sensible age', async () => {
    const dir = await provision();
    for (const bad of [[], ['--older-than-days', '0'], ['--older-than-days', 'soon']]) {
      const r = await cli(['admin', 'prune', ...bad], { OMNIFLOW_DATA_DIR: dir });
      expect(r.code).not.toBe(0);
    }
  });
});

describe('admin prune: sign-ups that never confirmed their email', () => {
  it('removes only old, never-confirmed, never-used self-serve tenants, and a dry run changes nothing', async () => {
    const dir = await provision();
    const st = openState(stateOptionsFor(dir));
    const person = (tenant: string, unverified: boolean) => {
      st.identity.createTenant(tenant, tenant);
      st.identity.createUser({
        tenant,
        email: `${tenant}@example.com`,
        name: tenant,
        roles: ['admin'],
        ...(unverified ? { emailUnverified: true } : {}),
      });
    };
    person('acct-stale', true); // the one to remove
    person('acct-confirmed', false); // confirmed: stays
    person('acct-fresh', true); // too new: stays
    person('acct-used', true); // unconfirmed but has a workflow: stays
    st.db.run(
      "UPDATE tenants SET created_at = '2020-01-01T00:00:00.000Z' WHERE id IN ('acct-stale', 'acct-confirmed', 'acct-used')",
    );
    st.db.run(
      `INSERT INTO workflow_versions (tenant_id, name, version, manifest_text, manifest_hash, plan_hash, environment, published_by, published_at)
       VALUES ('acct-used', 'w', '1.0.0', '{}', 'h', 'h', 'production', 'u', '2020-01-01T00:00:00.000Z')`,
    );
    st.close();
    const env = { OMNIFLOW_DATA_DIR: dir };

    const dry = JSON.parse((await cli(['admin', 'prune', '--older-than-days', '30', '--dry-run', '--json'], env)).out);
    expect(dry.unconfirmedAccounts).toBe(1);
    const real = JSON.parse((await cli(['admin', 'prune', '--older-than-days', '30', '--json'], env)).out);
    expect(real.unconfirmedAccounts).toBe(1);

    const after = openState(stateOptionsFor(dir));
    const tenants = after.identity.listTenants().map((x) => x.id);
    after.close();
    expect(tenants).toEqual(expect.arrayContaining(['acct-confirmed', 'acct-fresh', 'acct-used']));
    expect(tenants).not.toContain('acct-stale');
    expect((await cli(['admin', 'verify-audit'], env)).code).toBe(0);
  });
});
