import { stringify } from 'yaml';

/**
 * The Legacy Importer (architecture §11): crontab in, *Lift* drafts out. "Lift" means each job is wrapped
 * as-is in a supervised `shell-exec` step with a sunset date — it gains retries, timeouts, an audit trail
 * and alerting on day one, and the sunset date keeps the bridge from becoming permanent. Deterministic:
 * no model is involved, so the same crontab always yields the same drafts.
 */

export interface ImportedWorkflow {
  name: string;
  /** The line of the crontab this came from (1-based). */
  line: number;
  source: string;
  manifest: string;
  /** Things the person should know or decide, in plain language. */
  notes: string[];
  /** Set when the command needs shell syntax: OmniFlow refuses `sh -c` strings, so the command must live in a script file. */
  script?: { path: string; content: string };
}

export interface ImportResult {
  workflows: ImportedWorkflow[];
  skipped: Array<{ line: number; source: string; reason: string }>;
  /** Environment assignments and MAILTO found in the file. */
  environment: Record<string, string>;
}

export interface ImportOptions {
  owner: string;
  /** `YYYY-MM-DD` used as "today" when computing sunset dates. */
  today: string;
  /** Days until the bridge must be reviewed. Default 90. */
  sunsetDays?: number;
  team?: string;
  timezone?: string;
  /** Where operator-installed scripts live (default /opt/omniflow/scripts). */
  scriptDir?: string;
}

const MACROS: Record<string, string> = {
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
  '@monthly': '0 0 1 * *',
  '@weekly': '0 0 * * 0',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@hourly': '0 * * * *',
};

const KNOWN_PATHS: Record<string, string> = {
  sh: '/bin/sh',
  bash: '/bin/bash',
  curl: '/usr/bin/curl',
  wget: '/usr/bin/wget',
  python: '/usr/bin/python3',
  python3: '/usr/bin/python3',
  node: '/usr/bin/node',
  rsync: '/usr/bin/rsync',
  find: '/usr/bin/find',
  tar: '/usr/bin/tar',
  php: '/usr/bin/php',
  psql: '/usr/bin/psql',
  pg_dump: '/usr/bin/pg_dump',
  mysqldump: '/usr/bin/mysqldump',
  certbot: '/usr/bin/certbot',
};

/** Shell syntax that cannot be expressed as a plain argument vector. */
const SHELL_SYNTAX = /[|&;<>`]|\$\(|\$\{|\*|\?|(^|\s)~/;

/** Split a command line into words, honouring single and double quotes and backslash escapes. */
export function tokenize(command: string): string[] | undefined {
  const out: string[] = [];
  let cur = '';
  let inWord = false;
  let quote: '"' | "'" | undefined;
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      if (c === quote) quote = undefined;
      else if (c === '\\' && quote === '"' && i + 1 < command.length) cur += command[++i];
      else cur += c;
    } else if (c === '"' || c === "'") {
      quote = c;
      inWord = true;
    } else if (c === '\\' && i + 1 < command.length) {
      cur += command[++i];
      inWord = true;
    } else if (/\s/.test(c)) {
      if (inWord) out.push(cur);
      cur = '';
      inWord = false;
    } else {
      cur += c;
      inWord = true;
    }
  }
  if (quote) return undefined;
  if (inWord) out.push(cur);
  return out;
}

const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'job';

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

const CRON_FIELD = /^(\*|\*\/\d+|\d+(-\d+)?(\/\d+)?)(,(\*|\d+(-\d+)?(\/\d+)?))*$|^[A-Za-z]{3}(-[A-Za-z]{3})?(,[A-Za-z]{3}(-[A-Za-z]{3})?)*$/;

export function importCrontab(text: string, opts: ImportOptions): ImportResult {
  const result: ImportResult = { workflows: [], skipped: [], environment: {} };
  const used = new Set<string>();
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]!;
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const skip = (reason: string) => result.skipped.push({ line: i + 1, source: line, reason });

    const env = /^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (env) {
      result.environment[env[1]!] = env[2]!.replace(/^["']|["']$/g, '');
      continue;
    }

    let cron: string;
    let command: string;
    const words = line.split(/\s+/);
    if (words[0]!.startsWith('@')) {
      if (words[0] === '@reboot') {
        skip('@reboot jobs run at machine start; OmniFlow has no equivalent trigger. Run it as a service, or trigger the workflow manually on deploy.');
        continue;
      }
      const expanded = MACROS[words[0]!.toLowerCase()];
      if (!expanded) {
        skip(`Unknown schedule macro ${words[0]}`);
        continue;
      }
      cron = expanded;
      command = line.slice(words[0]!.length).trim();
    } else {
      const fields = words.slice(0, 5);
      if (words.length < 6 || !fields.every((f) => CRON_FIELD.test(f))) {
        skip('Not a crontab entry (expected five schedule fields followed by a command)');
        continue;
      }
      cron = fields.join(' ');
      command = words.slice(5).join(' ');
      // recover the original spacing of the command (split/join above collapsed it)
      const m = new RegExp(`^\\s*(?:\\S+\\s+){5}([\\s\\S]*)$`).exec(line);
      if (m) command = m[1]!.trim();
    }
    if (command === '') {
      skip('The entry has a schedule but no command');
      continue;
    }

    const notes: string[] = [];
    let script: ImportedWorkflow['script'];

    // A stable, readable name from the first word(s) of the command.
    const words0 = command.split(/[\s|&;<>]+/).filter(Boolean);
    const exeWord = (words0[0] ?? 'job').split('/').pop() ?? 'job';
    let name = `cron-${slug(exeWord)}${words0[1] && !words0[1].startsWith('-') && !SHELL_SYNTAX.test(words0[1]) ? `-${slug(words0[1].split('/').pop() ?? '')}` : ''}`.replace(/-{2,}/g, '-').replace(/-+$/, '');
    for (let n = 2; used.has(name); n++) name = `${name.replace(/-\d+$/, '')}-${n}`;
    used.add(name);

    let argv: string[];
    if (SHELL_SYNTAX.test(command)) {
      const path = `${(opts.scriptDir ?? '/opt/omniflow/scripts').replace(/\/$/, '')}/${name}.sh`;
      script = { path, content: `#!/bin/sh\nset -eu\n${command}\n` };
      argv = [path];
      notes.push(`The command uses shell syntax (pipes, redirects, globs or substitutions). OmniFlow refuses \`sh -c\` strings because they reintroduce shell injection, so the step runs a script file instead. Save the command as ${path} (mode 0755) and add that path to OMNIFLOW_SHELL_ALLOWED_COMMANDS. The script's content is provided with this draft.`);
    } else {
      const parsed = tokenize(command);
      if (!parsed || parsed.length === 0) {
        skip('The command has unbalanced quotes');
        used.delete(name);
        continue;
      }
      argv = parsed;
      const exe = argv[0]!;
      if (!exe.startsWith('/')) {
        const known = KNOWN_PATHS[exe];
        argv[0] = known ?? `/usr/bin/${exe}`;
        notes.push(`'${exe}' has no absolute path in the crontab; assumed ${argv[0]}. Check it, and add it to OMNIFLOW_SHELL_ALLOWED_COMMANDS.`);
      } else notes.push(`Add ${exe} to OMNIFLOW_SHELL_ALLOWED_COMMANDS or the shell capability will refuse to run it.`);
    }
    if (/\b(rm\s+-rf?|dd\s+if=|mkfs|:\s*\(\)\s*\{)/.test(command)) notes.push('This command looks destructive. Review it carefully before publishing.');
    if (/(password|passwd|secret|token|api[_-]?key)\s*=/i.test(command) || /https?:\/\/[^\s/@]+:[^\s/@]+@/.test(command)) {
      notes.push('The command appears to contain a credential. Move it into a secret and pass it with ${{ secrets.NAME }} before publishing.');
    }
    if (result.environment.MAILTO) notes.push(`The crontab mailed output to ${result.environment.MAILTO}. Configure an alert channel (OMNIFLOW_ALERT_CHANNELS) so failures are reported the same way.`);
    if (Object.keys(result.environment).some((k) => k !== 'MAILTO')) notes.push('The crontab sets environment variables. Shell steps run with a scrubbed environment; pass what the job needs through the step `env`.');
    notes.push(`Schedules run in ${opts.timezone ?? 'UTC'}. Cron ran in the server's local time zone; set the trigger's timezone if that differs.`);

    const manifest = {
      apiVersion: 'omniflow.dev/v1',
      kind: 'Workflow',
      metadata: {
        name,
        version: '1.0.0',
        owner: opts.owner,
        ...(opts.team ? { team: opts.team } : {}),
        description: `Imported from crontab line ${i + 1}: ${command.length > 120 ? `${command.slice(0, 117)}...` : command}`,
        criticality: 'medium',
        labels: { 'imported-from': 'crontab', strategy: 'lift' },
      },
      triggers: [{ type: 'schedule', name: 'cron', cron, ...(opts.timezone ? { timezone: opts.timezone } : {}) }],
      inputs: {},
      steps: [
        {
          id: 'run',
          name: 'Run the legacy job',
          type: 'capability',
          uses: 'shell-exec@^1',
          with: { argv },
          timeout: '1h',
          idempotencyKey: `${name}-\${{ run.id }}`,
          sunset: addDays(opts.today, opts.sunsetDays ?? 90),
        },
      ],
    };
    result.workflows.push({ name, line: i + 1, source: line, manifest: stringify(manifest, { lineWidth: 0 }), notes, ...(script ? { script } : {}) });
  }
  return result;
}
