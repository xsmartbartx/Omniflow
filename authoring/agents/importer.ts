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

/**
 * Does the command rely on the shell (pipes, redirects, globs, variables, substitutions)? Quoted text and
 * URLs are ignored: `curl 'https://x/y?a=1&b=2'` is a plain argument vector.
 */
export function needsShell(command: string): boolean {
  const noSingle = command.replace(/'[^']*'/g, "''");
  if (/\$[A-Za-z_{(]|`/.test(noSingle)) return true; // expansions still happen inside double quotes
  const bare = noSingle.replace(/"(?:[^"\\]|\\.)*"/g, '""').replace(/\S+:\/\/\S+/g, 'URL');
  return /[|&;<>*?]|(^|\s)~/.test(bare);
}

/** Split a command line into words, honouring single and double quotes and backslash escapes. */
export function tokenize(command: string): string[] | undefined {
  const st: LexState = { out: [], cur: '', inWord: false, i: 0 };
  for (; st.i < command.length; st.i++) {
    if (st.quote) lexQuoted(command, st);
    else lexBare(command, st);
  }
  if (st.quote) return undefined;
  if (st.inWord) st.out.push(st.cur);
  return st.out;
}

interface LexState {
  out: string[];
  cur: string;
  inWord: boolean;
  quote?: '"' | "'";
  i: number;
}

/** One character inside quotes: the closing quote ends it, `\\` escapes only inside double quotes. */
function lexQuoted(command: string, st: LexState): void {
  const c = command[st.i]!;
  if (c === st.quote) st.quote = undefined;
  else if (c === '\\' && st.quote === '"' && st.i + 1 < command.length) st.cur += command[++st.i];
  else st.cur += c;
}

/** One character outside quotes: opens a quote, escapes the next character, ends a word, or extends it. */
function lexBare(command: string, st: LexState): void {
  const c = command[st.i]!;
  if (c === '"' || c === "'") {
    st.quote = c;
    st.inWord = true;
  } else if (c === '\\' && st.i + 1 < command.length) {
    st.cur += command[++st.i];
    st.inWord = true;
  } else if (/\s/.test(c)) {
    if (st.inWord) st.out.push(st.cur);
    st.cur = '';
    st.inWord = false;
  } else {
    st.cur += c;
    st.inWord = true;
  }
}

const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40) || 'job';

function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);
}

const CRON_FIELD =
  /^(\*|\*\/\d+|\d+(-\d+)?(\/\d+)?)(,(\*|\d+(-\d+)?(\/\d+)?))*$|^[A-Za-z]{3}(-[A-Za-z]{3})?(,[A-Za-z]{3}(-[A-Za-z]{3})?)*$/;

type CronLine = { cron: string; command: string } | { skip: string };

/** Split one crontab entry into its schedule and command, or say why it cannot be imported. */
function parseCronLine(line: string): CronLine {
  const words = line.split(/\s+/);
  const first = words[0]!;
  if (first.startsWith('@')) {
    if (first === '@reboot') {
      return {
        skip: '@reboot jobs run at machine start; OmniFlow has no equivalent trigger. Run it as a service, or trigger the workflow manually on deploy.',
      };
    }
    const expanded = MACROS[first.toLowerCase()];
    if (!expanded) return { skip: `Unknown schedule macro ${first}` };
    const command = line.slice(first.length).trim();
    return command === '' ? { skip: 'The entry has a schedule but no command' } : { cron: expanded, command };
  }
  const fields = words.slice(0, 5);
  if (words.length < 6 || !fields.every((f) => CRON_FIELD.test(f))) {
    return { skip: 'Not a crontab entry (expected five schedule fields followed by a command)' };
  }
  // recover the original spacing of the command (split/join above collapsed it)
  const m = /^\s*(?:\S+\s+){5}([\s\S]*)$/.exec(line);
  const command = m ? m[1]!.trim() : words.slice(5).join(' ');
  return command === '' ? { skip: 'The entry has a schedule but no command' } : { cron: fields.join(' '), command };
}

/** A stable, readable, unique workflow name from the first word(s) of the command. */
function workflowName(command: string, used: Set<string>): string {
  const words = command.split(/[\s|&;<>]+/).filter(Boolean);
  const exeWord = (words[0] ?? 'job').split('/').pop() ?? 'job';
  const second = words[1];
  const target =
    second && !second.startsWith('-') && !needsShell(second) ? `-${slug(second.split('/').pop() ?? '')}` : '';
  let name = `cron-${slug(exeWord)}${target}`.replace(/-{2,}/g, '-').replace(/-+$/, '');
  for (let n = 2; used.has(name); ) name = `${name.replace(/-\d+$/, '')}-${n++}`;
  used.add(name);
  return name;
}

/** The argument vector for the step: a script file when the command needs a shell, otherwise the parsed words. */
function commandArgv(
  command: string,
  name: string,
  opts: ImportOptions,
  notes: string[],
): { argv: string[]; script?: NonNullable<ImportedWorkflow['script']> } | undefined {
  if (needsShell(command)) {
    const path = `${(opts.scriptDir ?? '/opt/omniflow/scripts').replace(/\/$/, '')}/${name}.sh`;
    notes.push(
      `The command uses shell syntax (pipes, redirects, globs or substitutions). OmniFlow refuses \`sh -c\` strings because they reintroduce shell injection, so the step runs a script file instead. Save the command as ${path} (mode 0755) and add that path to OMNIFLOW_SHELL_ALLOWED_COMMANDS. The script's content is provided with this draft.`,
    );
    return { argv: [path], script: { path, content: `#!/bin/sh\nset -eu\n${command}\n` } };
  }
  const argv = tokenize(command);
  if (!argv || argv.length === 0) return undefined;
  const exe = argv[0]!;
  if (exe.startsWith('/')) {
    notes.push(`Add ${exe} to OMNIFLOW_SHELL_ALLOWED_COMMANDS or the shell capability will refuse to run it.`);
  } else {
    argv[0] = KNOWN_PATHS[exe] ?? `/usr/bin/${exe}`;
    notes.push(
      `'${exe}' has no absolute path in the crontab; assumed ${argv[0]}. Check it, and add it to OMNIFLOW_SHELL_ALLOWED_COMMANDS.`,
    );
  }
  return { argv };
}

/** Review notes about risks visible in the command and in the crontab's environment. */
function riskNotes(command: string, environment: Record<string, string>, timezone: string | undefined): string[] {
  const notes: string[] = [];
  if (/\b(rm\s+-rf?|dd\s+if=|mkfs|:\s*\(\)\s*\{)/.test(command))
    notes.push('This command looks destructive. Review it carefully before publishing.');
  if (
    /(password|passwd|secret|token|api[_-]?key)\s*=/i.test(command) ||
    /https?:\/\/[^\s/@]+:[^\s/@]+@/.test(command)
  ) {
    notes.push(
      'The command appears to contain a credential. Move it into a secret and pass it with ${{ secrets.NAME }} before publishing.',
    );
  }
  if (environment.MAILTO)
    notes.push(
      `The crontab mailed output to ${environment.MAILTO}. Configure an alert channel (OMNIFLOW_ALERT_CHANNELS) so failures are reported the same way.`,
    );
  if (Object.keys(environment).some((k) => k !== 'MAILTO'))
    notes.push(
      'The crontab sets environment variables. Shell steps run with a scrubbed environment; pass what the job needs through the step `env`.',
    );
  notes.push(
    `Schedules run in ${timezone ?? 'UTC'}. Cron ran in the server's local time zone; set the trigger's timezone if that differs.`,
  );
  return notes;
}

function cronManifest(
  entry: { name: string; cron: string; command: string; argv: string[]; lineNo: number },
  opts: ImportOptions,
): string {
  const { name, cron, command, argv, lineNo } = entry;
  const shortCommand = command.length > 120 ? `${command.slice(0, 117)}...` : command;
  return stringify(
    {
      apiVersion: 'omniflow.dev/v1',
      kind: 'Workflow',
      metadata: {
        name,
        version: '1.0.0',
        owner: opts.owner,
        ...(opts.team ? { team: opts.team } : {}),
        description: `Imported from crontab line ${lineNo}: ${shortCommand}`,
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
    },
    { lineWidth: 0 },
  );
}

export function importCrontab(text: string, opts: ImportOptions): ImportResult {
  const result: ImportResult = { workflows: [], skipped: [], environment: {} };
  const used = new Set<string>();
  const lines = text.split(/\r?\n/);

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    if (line === '' || line.startsWith('#')) continue;
    const skip = (reason: string) => result.skipped.push({ line: i + 1, source: line, reason });

    const env = /^([A-Za-z_]\w*)\s*=\s*(.*)$/.exec(line);
    if (env) {
      result.environment[env[1]!] = env[2]!.replace(/^["']|["']$/g, '');
      continue;
    }

    const parsed = parseCronLine(line);
    if ('skip' in parsed) {
      skip(parsed.skip);
      continue;
    }
    const { cron, command } = parsed;
    const notes: string[] = [];
    const name = workflowName(command, used);
    const step = commandArgv(command, name, opts, notes);
    if (!step) {
      skip('The command has unbalanced quotes');
      used.delete(name);
      continue;
    }
    notes.push(...riskNotes(command, result.environment, opts.timezone));
    result.workflows.push({
      name,
      line: i + 1,
      source: line,
      manifest: cronManifest({ name, cron, command, argv: step.argv, lineNo: i + 1 }, opts),
      notes,
      ...(step.script ? { script: step.script } : {}),
    });
  }
  return result;
}
