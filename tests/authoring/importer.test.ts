import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { importCrontab, needsShell, tokenize } from '../../authoring/index.ts';
import { createDefaultRegistry, defaultAdapterConfig } from '../../capabilities/index.ts';
import { compile } from '../../orchestration/compiler/index.ts';
import { analyzeWorkflow } from '../../security/pentest/index.ts';

const opts = { owner: 'ops@example.com', today: '2026-06-01' };
const base = defaultAdapterConfig();
const caps = createDefaultRegistry({ ...base, shell: { ...base.shell, allowedCommands: ['/usr/bin/curl'] } });
const check = (manifest: string) => {
  const r = compile(manifest, { environment: 'production', capabilities: caps, today: '2026-06-01' });
  return {
    ...r,
    risk: r.plan ? analyzeWorkflow({ manifest: parse(manifest), plan: r.plan, origin: 'human' }) : undefined,
  };
};

describe('tokenize', () => {
  it('splits on whitespace and honours quotes and escapes', () => {
    expect(tokenize(`curl -s "https://x.test/a b" 'it''s' plain\\ word`)).toEqual([
      'curl',
      '-s',
      'https://x.test/a b',
      'its',
      'plain word',
    ]);
    expect(tokenize('   ')).toEqual([]);
    expect(tokenize('echo "unbalanced')).toBeUndefined();
  });
});

describe('needsShell', () => {
  it('spots real shell syntax and ignores quoted text and URLs', () => {
    for (const c of [
      'a | b',
      'a > out',
      'a && b',
      'a; b',
      'ls *.log',
      'echo $HOME',
      'echo "$HOME"',
      'echo `date`',
      'echo $(date)',
      'cat ~/x',
    ])
      expect(needsShell(c), c).toBe(true);
    for (const c of [
      'curl -s https://x.test/y?a=1&b=2',
      "grep 'a|b' file",
      'echo "a > b"',
      '/usr/bin/backup --full',
      "echo '$HOME'",
    ])
      expect(needsShell(c), c).toBe(false);
  });
});

describe('crontab import (Lift)', () => {
  it('turns a plain job into a compiling workflow with a schedule and a sunset date', () => {
    const r = importCrontab('30 2 * * 1-5 /usr/bin/curl -fsS https://backup.example.com/run\n', opts);
    expect(r.skipped).toEqual([]);
    const [w] = r.workflows;
    expect(w!.name).toBe('cron-curl-https-backup-example-com-run'.slice(0, w!.name.length));
    const m = parse(w!.manifest);
    expect(m.triggers).toEqual([{ type: 'schedule', name: 'cron', cron: '30 2 * * 1-5' }]);
    expect(m.steps[0]).toMatchObject({
      id: 'run',
      uses: 'shell-exec@^1',
      with: { argv: ['/usr/bin/curl', '-fsS', 'https://backup.example.com/run'] },
      sunset: '2026-08-30',
    });
    expect(m.metadata.labels).toEqual({ 'imported-from': 'crontab', strategy: 'lift' });
    const c = check(w!.manifest);
    expect(c.errors).toEqual([]);
    expect(c.ok).toBe(true);
    expect(c.risk!.blocking).toBe(false);
    expect(w!.notes.join(' ')).toContain('OMNIFLOW_SHELL_ALLOWED_COMMANDS');
  });

  it('understands macros, comments, blank lines, environment lines and MAILTO', () => {
    const r = importCrontab(
      [
        '# nightly jobs',
        '',
        'MAILTO=ops@example.com',
        'PATH=/usr/bin:/bin',
        '@daily /usr/bin/curl -s https://a.example.com/x',
        '@hourly /usr/bin/curl -s https://b.example.com/y',
      ].join('\n'),
      opts,
    );
    expect(r.environment).toEqual({ MAILTO: 'ops@example.com', PATH: '/usr/bin:/bin' });
    expect(r.workflows.map((w) => parse(w.manifest).triggers[0].cron)).toEqual(['0 0 * * *', '0 * * * *']);
    expect(r.workflows[0]!.notes.join(' ')).toContain('OMNIFLOW_ALERT_CHANNELS');
    expect(r.workflows[0]!.notes.join(' ')).toContain('environment variables');
  });

  it('assumes an absolute path for bare command names, and says so', () => {
    const [w] = importCrontab('0 * * * * curl -s https://x.example.com/ping', opts).workflows;
    expect(parse(w!.manifest).steps[0].with.argv[0]).toBe('/usr/bin/curl');
    expect(w!.notes.join(' ')).toContain('assumed /usr/bin/curl');
  });

  it('never emits `sh -c`: shell syntax goes into a script file that is run directly', () => {
    const [w] = importCrontab('15 3 * * * /usr/bin/pg_dump mydb | gzip > /backups/db.sql.gz', opts).workflows;
    const m = parse(w!.manifest);
    expect(m.steps[0].with.argv).toEqual([w!.script!.path]);
    expect(w!.script!.path).toMatch(/^\/opt\/omniflow\/scripts\/cron-pg-dump.*\.sh$/);
    expect(w!.script!.content).toBe('#!/bin/sh\nset -eu\n/usr/bin/pg_dump mydb | gzip > /backups/db.sql.gz\n');
    expect(w!.notes.join(' ')).toContain('refuses `sh -c`');
    const risk = check(w!.manifest).risk!;
    expect(risk.blocking).toBe(false);
    expect(risk.findings.some((f) => f.ruleId === 'PT-SHELL-002')).toBe(false);
  });

  it('warns about credentials and destructive commands', () => {
    const r = importCrontab(
      [
        '0 4 * * * /usr/bin/curl -u admin:hunter2 https://x.example.com',
        '0 5 * * * /usr/bin/curl https://user:pw@x.example.com/a',
        '0 6 * * * rm -rf /var/cache/app/*',
        '0 7 * * * /opt/job.sh --password=abc123',
      ].join('\n'),
      opts,
    );
    expect(r.workflows).toHaveLength(4);
    expect(r.workflows[1]!.notes.join(' ')).toContain('credential');
    expect(r.workflows[2]!.notes.join(' ')).toContain('destructive');
    expect(r.workflows[3]!.notes.join(' ')).toContain('credential');
  });

  it('skips what it cannot express, and says why', () => {
    const r = importCrontab(
      [
        '@reboot /usr/bin/start-thing',
        'not a crontab line at all',
        '* * * * *',
        '0 0 * * * echo "unbalanced',
        '@sometimes /bin/true',
        '61 0 * * * /bin/true',
      ].join('\n'),
      opts,
    );
    expect(r.workflows.map((w) => w.line)).toEqual([6]); // "61" is accepted by the shape check; validation catches it later
    expect(r.skipped.map((s) => [s.line, s.reason.split('.')[0]])).toEqual([
      [1, '@reboot jobs run at machine start; OmniFlow has no equivalent trigger'],
      [2, 'Not a crontab entry (expected five schedule fields followed by a command)'],
      [3, 'Not a crontab entry (expected five schedule fields followed by a command)'],
      [4, 'The command has unbalanced quotes'],
      [5, 'Unknown schedule macro @sometimes'],
    ]);
  });

  it('gives duplicate jobs distinct names', () => {
    const r = importCrontab(
      '0 1 * * * /usr/bin/curl https://a.example.com/x\n0 2 * * * /usr/bin/curl https://a.example.com/x\n0 3 * * * /usr/bin/curl https://a.example.com/x',
      opts,
    );
    const names = r.workflows.map((w) => w.name);
    expect(new Set(names).size).toBe(3);
    for (const w of r.workflows) expect(check(w.manifest).errors, w.name).toEqual([]);
  });

  it('is deterministic', () => {
    const text = '5 4 * * * /usr/bin/curl https://a.example.com/x\n@weekly /usr/bin/curl https://b.example.com/y';
    expect(importCrontab(text, opts)).toEqual(importCrontab(text, opts));
  });

  it('carries the timezone, team and sunset settings through', () => {
    const [w] = importCrontab('0 9 * * * /usr/bin/curl https://a.example.com/x', {
      ...opts,
      timezone: 'Europe/Warsaw',
      team: 'platform',
      sunsetDays: 30,
    }).workflows;
    const m = parse(w!.manifest);
    expect(m.triggers[0].timezone).toBe('Europe/Warsaw');
    expect(m.metadata.team).toBe('platform');
    expect(m.steps[0].sunset).toBe('2026-07-01');
  });
});
