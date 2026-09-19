import type { Plan } from '../../schemas/index.ts';
import type { ApprovalStat, RunTiming, StepErrorStat, StepStat, WorkflowRunStat } from '../../state/index.ts';

export type Severity = 'info' | 'low' | 'medium' | 'high';

/** What the Analysis Agent concludes. A finding is advice, never an edit. */
export interface Finding {
  rule: string;
  severity: Severity;
  workflow?: string;
  stepId?: string;
  title: string;
  summary: string;
  recommendation: string;
  evidence: Record<string, unknown>;
  /** Stable identity: the same problem yields the same key on every analysis run. */
  key: string;
}

/** Everything a rule may look at — a plain, read-only snapshot, so rules are pure functions. */
export interface WorkflowFacts {
  name: string;
  version: string;
  enabled: boolean;
  killed: boolean;
  /** When the active version was published (ISO). */
  activeSince: string | undefined;
  plan: Plan;
  runs: WorkflowRunStat;
  steps: Map<string, StepStat>;
  errors: Map<string, StepErrorStat[]>;
}

export interface AnalysisInput {
  /** ISO timestamp of "now" for the analysis. */
  now: string;
  /** `YYYY-MM-DD`. */
  today: string;
  windowDays: number;
  workflows: WorkflowFacts[];
  approvals: ApprovalStat[];
  timings: RunTiming[];
}

export interface Thresholds {
  /** Minimum observations before a rate is trusted. */
  minSamples: number;
  ignoredFailureRate: number;
  failingStepRate: number;
  retryStormRate: number;
  retryStormMinRetried: number;
  duplicateSimilarity: number;
  costWorkflowShare: number;
  costStepShare: number;
  minCost: number;
  rubberStampMinApprovals: number;
  deniedRate: number;
  timeoutRate: number;
  sunsetWarnDays: number;
  scheduleDriftP95Ms: number;
  queueWaitP95Ms: number;
  /** Runs (in the window) before "compensation was never exercised" is worth saying. */
  compensationMinRuns: number;
}

export const DEFAULT_THRESHOLDS: Thresholds = {
  minSamples: 10,
  ignoredFailureRate: 0.5,
  failingStepRate: 0.3,
  retryStormRate: 0.3,
  retryStormMinRetried: 5,
  duplicateSimilarity: 0.8,
  costWorkflowShare: 0.6,
  costStepShare: 0.7,
  minCost: 1,
  rubberStampMinApprovals: 10,
  deniedRate: 0.3,
  timeoutRate: 0.3,
  sunsetWarnDays: 30,
  scheduleDriftP95Ms: 60_000,
  queueWaitP95Ms: 120_000,
  compensationMinRuns: 20,
};

export type Rule = (input: AnalysisInput, t: Thresholds) => Finding[];
