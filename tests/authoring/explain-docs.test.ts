import { describe, expect, it } from 'vitest';
import { createDefaultRegistry, defaultAdapterConfig } from '../../capabilities/index.ts';
import { capabilityMarkdown, describeCron, explainPlan, explainRun, indexMarkdown, workflowMarkdown, workflowMermaid } from '../../authoring/index.ts';
import { addRun, bad, compileWf, echo, ok, skipped } from '../helpers/history.ts';
import { makeState } from '../helpers/state.ts';

describe('describeCron', () => {
  it.each([
    ['* * * * *', undefined, 'every minute'],
    ['*/15 * * * *', undefined, 'every 15 minutes'],
    ['0 * * * *', undefined, 'every hour, on the hour'],
    ['30 * * * *', undefined, 'every hour at minute 30'],
    ['0 */6 * * *', undefined, 'every 6 hours, at minute 0'],
    ['5 3 * * *', undefined, 'every day at 03:05 (UTC)'],
    ['0 9 * * 1', 'Europe/Warsaw', 'every Monday at 09:00 (Europe/Warsaw)'],
    ['0 8 * * 1-5', undefined, 'every weekday at 08:00 (UTC)'],
    ['0 6 1 * *', undefined, 'on the 1st of every month at 06:00 (UTC)'],
    ['0 6 22 * *', undefined, 'on the 22nd of every month at 06:00 (UTC)'],
    ['0 6 13 * *', undefined, 'on the 13th of every month at 06:00 (UTC)'],
    ['0 0 25 12 *', undefined, 'every December 25th at 00:00 (UTC)'],
    ['0 0 1,15 * *', undefined, 'on the cron schedule `0 0 1,15 * *` (UTC)'],
    ['0 0 * *', undefined, 'on the cron schedule `0 0 * *` (UTC)'],
  ])('%s → %s', (expr, tz, expected) => {
    expect(describeCron(expr, tz)).toBe(expected);
  });
});

const wf = () =>
  compileWf(
    'order-flow',
    [
      echo('check', 1),
      { id: 'decide', type: 'branch', dependsOn: ['check'], cases: [{ name: 'big', when: "steps.check.output.value > 0" }], default: 'small' },
      { id: 'gate', type: 'approval', dependsOn: ['decide'], message: 'Ship it?', timeout: '2h', onTimeout: 'deny' },
      { id: 'charge', type: 'capability', uses: 'notify-webhook@^1', dependsOn: ['gate'], egress: ['hooks.example.com'], with: { url: 'https://hooks.example.com/x', text: 'go' }, idempotencyKey: 'k-${{ run.id }}', retry: { attempts: 3, retryOn: ['transient'] }, timeout: '30s' },
      { id: 'fallback', type: 'capability', uses: 'util-noop@^1', dependsOn: ['decide'], when: "steps.decide.output.case == 'small'" },
    ],
    { triggers: [{ type: 'schedule', name: 'daily', cron: '0 3 * * *' }, { type: 'webhook', name: 'incoming' }], inputs: { orderId: { type: 'string', required: true, description: 'The order' }, note: { type: 'string', default: 'hi' } }, policy: { maxRunCost: 50, concurrency: 1, concurrencyPolicy: 'skip' } },
  );

describe('explaining a plan', () => {
  it('describes triggers, inputs, every step and the safeguards in plain language', () => {
    const e = explainPlan(wf().plan);
    expect(e.title).toBe('order-flow 1.0.0');
    expect(e.triggers).toEqual(['every day at 03:00 (UTC)', 'when an external system calls its webhook “incoming”']);
    expect(e.inputs).toEqual(['`orderId` (string, required) — The order', '`note` (string, default "hi")']);
    expect(e.steps.map((s) => s.id)).toEqual(['check', 'decide', 'fallback', 'gate', 'charge']);
    const text = Object.fromEntries(e.steps.map((s) => [s.id, s.text]));
    expect(text.check).toContain('read-only');
    expect(text.decide).toContain('chooses a path');
    expect(text.gate).toContain('pauses for a person to approve: “Ship it?”');
    expect(text.gate).toContain('denied after 2 h');
    expect(text.charge).toContain('changes something in the outside world');
    expect(text.charge).toContain('Retries up to 2 more times on transient errors');
    expect(text.charge).toContain('Times out after 30 s');
    expect(text.fallback).toContain("Only runs when `steps.decide.output.case == 'small'`");
    expect(e.safeguards.join(' ')).toContain('capped at 50 cost units');
    expect(e.safeguards.join(' ')).toContain('At most 1 run at a time; extra triggers are skipped');
    expect(e.safeguards.join(' ')).toContain('A person must approve');
    expect(e.risks.join(' ')).toContain('“charge”');
    expect(e.risks.join(' ')).toContain('cannot be undone automatically');
    expect(e.risks.join(' ')).toContain('hooks.example.com');
    expect(e.summary).toContain('It changes things in 1 of them.');
    expect(e.markdown).toMatch(/^# order-flow 1\.0\.0/);
    expect(e.markdown).toContain('## What it does');
  });

  it('says so when a workflow changes nothing', () => {
    const e = explainPlan(compileWf('calm', [echo('a')]).plan);
    expect(e.summary).toContain('only reads and computes');
    expect(e.risks).toEqual([]);
    expect(e.triggers).toEqual(['when someone starts it by hand (or through the API)']);
  });

  it('mentions shell bridges and their sunset', () => {
    const { plan } = compileWf('bridge', [echo('a')]);
    plan.steps[0]!.sunset = '2026-09-01';
    plan.analysis.families = ['shell'];
    const e = explainPlan(plan);
    expect(e.steps[0]!.text).toContain('must be reviewed by 2026-09-01');
    expect(e.risks.join(' ')).toContain('shell commands');
  });
});

describe('explaining a run', () => {
  const s = makeState();
  const { plan } = wf();
  const run = (spec: Parameters<typeof addRun>[1]) => {
    const id = addRun(s, spec);
    return { run: s.runs.getRun(id)!, steps: s.runs.getSteps(id) };
  };

  it('narrates a success', () => {
    const r = run({ workflow: 'order-flow', stepIds: ['check', 'fallback'], steps: { check: ok({ completedSeq: 1 }), fallback: skipped() } });
    const e = explainRun({ ...r });
    expect(e.headline).toBe('Succeeded in 1 s.');
    expect(e.narrative[0]).toContain('Run of order-flow 1.0.0, started by Test User by hand');
    expect(e.narrative.some((n) => n.includes('“check” succeeded'))).toBe(true);
    expect(e.narrative.some((n) => n.includes('“fallback” was skipped (when false)'))).toBe(true);
    expect(e.failure).toBeUndefined();
  });

  it.each([
    ['transient', 'Usually safe to retry'],
    ['contract', 'Retrying will not help until then'],
    ['business', 'needs a decision, not a retry'],
    ['authorisation', 'secret it uses'],
    ['systemic', 'Capabilities page'],
    ['catastrophic', 'report it, with the run id'],
  ] as const)('explains a %s failure with advice that fits', (cls, advice) => {
    const r = run({ workflow: 'order-flow', status: 'failed', stepIds: ['check', 'charge'], steps: { check: ok({ completedSeq: 1 }), charge: bad('PAY_DECLINED', cls, { attempt: 3 }) } });
    const e = explainRun({ ...r, plan });
    expect(e.headline).toBe('Failed at “charge”.');
    expect(e.failure).toMatchObject({ stepId: 'charge', code: 'PAY_DECLINED', errorClass: cls });
    expect(e.failure!.suggestion).toContain(advice);
    expect(e.failure!.whatHappenedNext).toBe('Nothing needed to be undone.');
    expect(e.narrative.some((n) => n.includes('failed after 3 attempts'))).toBe(true);
    expect(e.markdown).toContain('**What to do:**');
  });

  it('reports rollbacks and failed rollbacks', () => {
    const undone = run({ workflow: 'order-flow', status: 'failed', stepIds: ['check', 'charge'], steps: { check: ok({ completedSeq: 1, compensationStatus: 'done' }), charge: bad('X', 'business') } });
    expect(explainRun({ ...undone, plan }).failure!.whatHappenedNext).toBe('1 earlier step was undone.');
    const stuck = run({ workflow: 'order-flow', status: 'failed', stepIds: ['check', 'charge'], steps: { check: ok({ completedSeq: 1, compensationStatus: 'failed', compensationError: { code: 'UNDO', message: 'cannot undo', class: 'business', retryable: false } }), charge: bad('X', 'business') } });
    const e = explainRun({ ...stuck, plan });
    expect(e.failure!.whatHappenedNext).toBe('Rollback started, but 1 compensation failed.');
    expect(e.narrative.join(' ')).toContain('FAILED: cannot undo');
  });

  it('points at what a paused run is waiting for', () => {
    const r = run({ workflow: 'order-flow', status: 'running', stepIds: ['check', 'gate'], steps: { check: ok({ completedSeq: 1 }), gate: { status: 'waiting-approval' } } });
    s.runs.transition(r.run.id, 'waiting-approval');
    const e = explainRun({ run: s.runs.getRun(r.run.id)!, steps: s.runs.getSteps(r.run.id), plan });
    expect(e.headline).toBe('Paused, waiting for approval at “gate”.');
    expect(e.waitingOn).toBe('gate');
  });

  it('says when an absorbed failure did not stop the run', () => {
    const r = run({ workflow: 'order-flow', stepIds: ['check', 'fallback'], steps: { check: bad('E', 'transient', { handled: 'continue', completedSeq: 1 }), fallback: ok({ completedSeq: 2 }) } });
    expect(explainRun({ ...r, plan }).narrative.join(' ')).toContain('The workflow carried on anyway.');
  });
});

describe('generated documentation', () => {
  it('draws the plan as a well-formed Mermaid flowchart', () => {
    const m = workflowMermaid(wf().plan);
    const lines = m.split('\n');
    expect(lines[0]).toBe('flowchart TD');
    const declared = new Set(lines.flatMap((l) => (/^ {2}(s\d+|start)[[({]/.exec(l) ? [/^ {2}(\w+)/.exec(l)![1]!] : [])));
    expect(declared.size).toBe(6); // five steps + start
    for (const l of lines.filter((x) => /-->|-\.->|-\. /.test(x))) {
      const ids = [...l.matchAll(/\b(s\d+|start)\b/g)].map((x) => x[1]!);
      expect(ids.length, l).toBeGreaterThanOrEqual(2);
      for (const id of ids) expect(declared.has(id), `${id} in "${l}"`).toBe(true);
    }
    expect(m).toMatch(/s\d+\{"decide/); // branch → diamond
    expect(m).toMatch(/s\d+\[\["gate/); // approval → subroutine
    expect(m).toContain(`-.->|"steps.decide.output.case == 'small'"|`); // conditional edge, dotted
    expect(m).toMatch(/class s\d+ effectful/);
    expect(m).toMatch(/class s\d+(,s\d+)* gate/);
    expect(m).not.toMatch(/"[^"\n]*"[^"\n]*"[^"\n]*"[^\n]*<br/); // labels are escaped, quotes cannot break out
  });

  it('shows error routes and escapes hostile names', () => {
    const { plan } = compileWf('routes', [
      { ...echo('risky'), onError: { routeTo: 'handle' } },
      echo('handle', 2, { dependsOn: ['risky'] }),
      echo('done', 3, { dependsOn: ['risky'] }),
    ]);
    plan.steps[0]!.name = 'say "hi" <b>x</b>';
    const m = workflowMermaid(plan);
    expect(m).toContain('on error');
    expect(m).not.toContain('<b>');
    expect(m).not.toContain('say "hi"');
    expect(m).toContain('#quot;hi#quot;');
  });

  it('writes a Markdown page with flow, triggers, inputs, steps, analysis, risk and versions', () => {
    const md = workflowMarkdown(wf().plan, {
      settings: { enabled: true, killed: false, autonomyTier: 'T1', stableVersion: '1.0.0' },
      risk: { level: 'medium', score: 25, findings: [{ severity: 'medium', message: 'Effectful step without compensation', stepId: 'charge' }] },
      versions: [{ version: '1.0.0', status: 'published', publishedAt: '2026-06-01T00:00:00Z', publishedBy: 'alice' }],
    });
    expect(md).toMatch(/^# order-flow/);
    for (const h of ['## Flow', '```mermaid', '## Triggers', '## Inputs', '## Steps', '## Analysis', '## Risk review — medium (25/100)', '## Versions']) expect(md).toContain(h);
    expect(md).toContain('- **schedule** — every day at 03:00 (UTC) (`0 3 * * *`)');
    expect(md).toContain('| `orderId` | string | yes |');
    expect(md).toContain('| 5 | `charge` | capability | notify-webhook@1.0.0 | effectful | `gate` | 30s | 2 |');
    expect(md).toContain('State | enabled · autonomy T1');
    expect(md).toContain('Effectful step without compensation (`charge`)');
  });

  it('documents the capability catalogue and an index', () => {
    const caps = createDefaultRegistry(defaultAdapterConfig()).list().map((c) => c.declaration);
    const md = capabilityMarkdown(caps);
    expect(md).toContain('## http-get@1.0.0');
    expect(md).toContain('## util-echo@1.0.0');
    expect(md).toMatch(/\| `url` \| string \| yes \|/);
    expect(md.indexOf('## http-get')).toBeLessThan(md.indexOf('## util-echo')); // sorted
    const idx = indexMarkdown([{ name: 'b', description: 'Second | with pipe', stableVersion: '1.0.0' }, { name: 'a', description: 'First', criticality: 'high', owner: 'x' }]);
    expect(idx.indexOf('[a]')).toBeLessThan(idx.indexOf('[b]'));
    expect(idx).toContain('Second \\| with pipe');
  });
});
