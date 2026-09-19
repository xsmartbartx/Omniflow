import { ForbiddenError, NotFoundError } from '../../core/index.ts';
import type { EventRecord } from '../../schemas/index.ts';
import { isTerminalRun, type RunStatus } from '../../state/index.ts';
import type { RouteDef } from '../http.ts';
import { csv, id, limitQ, mustRun, obj, planOf, runSummary, stepView } from './util.ts';

const runParam = obj({ id }, ['id']);

export function runRoutes(): RouteDef[] {
  return [
    {
      method: 'GET',
      url: '/v1/runs',
      summary: 'List runs',
      tag: 'Runs',
      action: 'run.read',
      schema: {
        querystring: obj({
          workflow: { type: 'string', maxLength: 64 },
          status: { type: 'string', maxLength: 200, description: 'Comma-separated statuses' },
          trigger: { type: 'string', maxLength: 40 },
          since: { type: 'string', maxLength: 40 },
          limit: limitQ,
          offset: { type: 'integer', minimum: 0, default: 0 },
        }),
      },
      handler: ({ app, principal, query }) => {
        const filter = {
          tenant: principal.tenant,
          ...(query.workflow ? { workflow: query.workflow } : {}),
          ...(csv(query.status) ? { status: csv(query.status) as RunStatus[] } : {}),
          ...(query.trigger ? { triggerType: query.trigger } : {}),
          ...(query.since ? { since: query.since } : {}),
        };
        return {
          items: app.state.runs
            .listRuns({ ...filter, limit: query.limit ?? 50, offset: query.offset ?? 0 })
            .map(runSummary),
          total: app.state.runs.countRuns(filter),
          byStatus: app.state.runs.countByStatus(principal.tenant),
        };
      },
    },
    {
      method: 'GET',
      url: '/v1/runs/:id',
      summary: 'A run with its step timeline',
      tag: 'Runs',
      action: 'run.read',
      schema: { params: runParam },
      handler: ({ app, principal, params }) => {
        const run = mustRun(app, principal, params.id);
        const plan = planOf(app, run);
        const recs = app.state.runs.getSteps(run.id);
        const steps = plan
          ? plan.steps.map((ps) => stepView(plan, recs.find((r) => r.stepId === ps.id)!, ps))
          : recs.map((r) => stepView(undefined as never, r, undefined));
        return {
          run: {
            ...runSummary(run),
            inputs: maskInputs(plan, run.inputs),
            outputs: run.outputs ?? null,
            planHash: run.planHash,
            seed: run.seed,
            contextNow: run.contextNow,
          },
          steps,
          plan: plan ? { workflow: plan.workflow, analysis: plan.analysis, inputs: plan.inputs } : null,
          approvals: app.state.approvals.list({ tenant: principal.tenant, runId: run.id }),
          children: app.state.runs.childrenOf(run.id).map(runSummary),
          terminal: isTerminalRun(run.status),
        };
      },
    },
    {
      method: 'GET',
      url: '/v1/runs/:id/steps/:step/output',
      summary: 'The full output of a step (including outputs stored as artifacts)',
      tag: 'Runs',
      action: 'run.read',
      schema: { params: obj({ id, step: id }, ['id', 'step']) },
      handler: ({ app, principal, params }) => {
        const run = mustRun(app, principal, params.id);
        const rec = app.state.runs.getStep(run.id, params.step);
        if (!rec) throw new NotFoundError('Step', params.step);
        const ps = planOf(app, run)?.steps.find((s) => s.id === params.step);
        if (
          (ps?.sensitivity === 'confidential' || ps?.sensitivity === 'secret') &&
          !principal.roles.some((r) => r === 'admin' || r === 'operator')
        ) {
          throw new ForbiddenError(
            'This step handles confidential data; only operators and admins may read its output',
          );
        }
        return {
          output: rec.outputRef ? app.state.artifacts.getJson(run.tenant, rec.outputRef) : (rec.output ?? null),
          outputRef: rec.outputRef ?? null,
        };
      },
    },
    {
      method: 'GET',
      url: '/v1/runs/:id/events',
      summary: 'The audit events of a run (sanitised, hash-chained)',
      tag: 'Runs',
      action: 'run.read',
      schema: {
        params: runParam,
        querystring: obj({
          afterSeq: { type: 'integer', minimum: 0 },
          limit: { type: 'integer', minimum: 1, maximum: 5000, default: 500 },
        }),
      },
      handler: ({ app, principal, params, query }) => {
        const run = mustRun(app, principal, params.id);
        return {
          items: app.state.events.list({
            tenant: principal.tenant,
            runId: run.id,
            ...(query.afterSeq ? { afterSeq: query.afterSeq } : {}),
            limit: query.limit ?? 500,
          }),
        };
      },
    },
    {
      method: 'GET',
      url: '/v1/runs/:id/stream',
      summary: 'Server-sent events: live run events (replays history first; supports Last-Event-ID)',
      tag: 'Runs',
      action: 'run.read',
      raw: true,
      schema: { params: runParam },
      handler: ({ req, reply, app, principal, params }) => {
        const run = mustRun(app, principal, params.id);
        reply.hijack();
        const raw = reply.raw;
        raw.writeHead(200, {
          'content-type': 'text/event-stream; charset=utf-8',
          'cache-control': 'no-cache, no-transform',
          connection: 'keep-alive',
          'x-accel-buffering': 'no',
          'x-content-type-options': 'nosniff',
        });
        let last = Number(req.headers['last-event-id'] ?? 0) || 0;
        let closed = false;
        const queue: EventRecord[] = [];
        let replaying = true;
        const send = (e: EventRecord) => {
          if (closed || e.seq <= last) return;
          last = e.seq;
          raw.write(`id: ${e.seq}\nevent: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
          if (
            ['run.succeeded', 'run.failed', 'run.cancelled', 'run.rolled-back', 'run.compensation-failed'].includes(
              e.type,
            )
          ) {
            setTimeout(() => end(), 250);
          }
        };
        const end = () => {
          if (closed) return;
          closed = true;
          off();
          clearInterval(hb);
          raw.end();
        };
        const off = app.state.events.onAppend((e) => {
          if (e.tenant !== principal.tenant || e.runId !== run.id) return;
          if (replaying) queue.push(e);
          else send(e);
        });
        const hb = setInterval(() => !closed && raw.write(': keep-alive\n\n'), 15_000);
        req.raw.on('close', () => {
          closed = true;
          off();
          clearInterval(hb);
        });
        for (const e of app.state.events.list({ tenant: principal.tenant, runId: run.id, afterSeq: last, limit: 5000 }))
          send(e);
        replaying = false;
        for (const e of queue) send(e);
        if (isTerminalRun(app.state.runs.getRun(run.id)!.status)) setTimeout(() => end(), 250);
      },
    },
    {
      method: 'POST',
      url: '/v1/runs/:id/cancel',
      summary: 'Cancel a run',
      tag: 'Runs',
      action: 'run.cancel',
      schema: { params: runParam, body: obj({ reason: { type: 'string', maxLength: 500 } }) },
      handler: ({ app, principal, params, body }) => runSummary(app.runs.cancel(principal, params.id, body?.reason)),
    },
    {
      method: 'POST',
      url: '/v1/runs/:id/retry',
      summary: 'Run a finished run again with the same inputs and the same plan',
      tag: 'Runs',
      action: 'run.retry',
      status: 202,
      schema: { params: runParam },
      handler: ({ app, principal, params }) => {
        const r = app.runs.retry(principal, params.id);
        return r.status === 'skipped'
          ? { status: 'skipped', reason: r.reason }
          : { status: r.status, run: runSummary(r.run) };
      },
    },

    // ------------------------------------------------------------- approvals
    {
      method: 'GET',
      url: '/v1/approvals',
      summary: 'Approval requests',
      tag: 'Approvals',
      action: 'workflow.read',
      schema: { querystring: obj({ status: { enum: ['pending', 'approved', 'denied', 'timed-out'] }, limit: limitQ }) },
      handler: ({ app, principal, query }) => ({
        items: app.approvals
          .list(principal, { ...(query.status ? { status: query.status } : {}), limit: query.limit ?? 100 })
          .map((a) => ({
            ...a,
            canDecide:
              a.status === 'pending' &&
              app.policy.can(principal, 'approval.decide') &&
              app.approvals.canDecide(principal, a) &&
              (a.allowSelf || a.requestedBy !== principal.id),
          })),
      }),
    },
    {
      method: 'POST',
      url: '/v1/approvals/:id/decide',
      summary: 'Approve or deny a request',
      tag: 'Approvals',
      action: 'approval.decide',
      schema: {
        params: obj({ id }, ['id']),
        body: obj({ decision: { enum: ['approved', 'denied'] }, comment: { type: 'string', maxLength: 1000 } }, [
          'decision',
        ]),
      },
      handler: ({ app, principal, params, body }) =>
        app.approvals.decide(principal, params.id, body.decision, body.comment),
    },
  ];
}

function maskInputs(plan: ReturnType<typeof planOf>, inputs: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(inputs)) {
    const s = plan?.inputs[k]?.sensitivity;
    out[k] = s === 'confidential' || s === 'secret' ? '[REDACTED]' : v;
  }
  return out;
}
