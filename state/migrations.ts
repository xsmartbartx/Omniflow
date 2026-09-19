export interface Migration {
  id: number;
  name: string;
  sql: string;
}

/**
 * Schema migrations, applied in order at start-up. Every tenant-owned table carries `tenant_id`
 * (multi-tenancy is designed in from the start — retrofitting isolation is historically expensive).
 * Append-only and immutable tables are protected by triggers as well as by the code paths.
 */
export const MIGRATIONS: Migration[] = [
  {
    id: 1,
    name: 'initial',
    sql: `
CREATE TABLE tenants (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE users (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  email TEXT NOT NULL,
  name TEXT NOT NULL,
  password_hash TEXT,
  roles TEXT NOT NULL,
  disabled INTEGER NOT NULL DEFAULT 0,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  last_login_at TEXT,
  failed_logins INTEGER NOT NULL DEFAULT 0,
  locked_until TEXT,
  UNIQUE (tenant_id, email)
);

CREATE TABLE api_keys (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id),
  name TEXT NOT NULL,
  key_prefix TEXT NOT NULL UNIQUE,
  key_hash TEXT NOT NULL,
  roles TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT,
  last_used_at TEXT,
  revoked_at TEXT
);

CREATE TABLE sessions (
  id TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id),
  tenant_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  ip TEXT,
  user_agent TEXT
);

-- ------------------------------------------------------------------ event log
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  id TEXT NOT NULL UNIQUE,
  tenant_id TEXT NOT NULL,
  ts TEXT NOT NULL,
  type TEXT NOT NULL,
  run_id TEXT,
  step_id TEXT,
  attempt INTEGER,
  actor TEXT,
  correlation_id TEXT,
  data TEXT NOT NULL,
  prev_hash TEXT NOT NULL,
  hash TEXT NOT NULL
);
CREATE INDEX idx_events_tenant_seq ON events (tenant_id, seq);
CREATE INDEX idx_events_run_seq ON events (run_id, seq);
CREATE INDEX idx_events_type_seq ON events (type, seq);
CREATE TRIGGER events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;
CREATE TRIGGER events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events are append-only'); END;

-- ------------------------------------------------------------------- registry
CREATE TABLE workflow_versions (
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'published',
  manifest_text TEXT NOT NULL,
  manifest_hash TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  environment TEXT NOT NULL,
  parent_version TEXT,
  published_by TEXT NOT NULL,
  published_at TEXT NOT NULL,
  approval TEXT,
  risk TEXT,
  PRIMARY KEY (tenant_id, name, version)
);
CREATE TRIGGER workflow_versions_immutable BEFORE UPDATE ON workflow_versions
WHEN OLD.manifest_text != NEW.manifest_text OR OLD.manifest_hash != NEW.manifest_hash
  OR OLD.plan_hash != NEW.plan_hash OR OLD.published_at != NEW.published_at
  OR OLD.published_by != NEW.published_by OR OLD.version != NEW.version OR OLD.name != NEW.name
BEGIN SELECT RAISE(ABORT, 'published workflow versions are immutable — publish a new version'); END;
CREATE TRIGGER workflow_versions_no_delete BEFORE DELETE ON workflow_versions
BEGIN SELECT RAISE(ABORT, 'published workflow versions cannot be deleted'); END;

CREATE TABLE plans (
  tenant_id TEXT NOT NULL,
  hash TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, hash)
);
CREATE TRIGGER plans_immutable BEFORE UPDATE ON plans
BEGIN SELECT RAISE(ABORT, 'plans are immutable'); END;
CREATE TRIGGER plans_no_delete BEFORE DELETE ON plans
BEGIN SELECT RAISE(ABORT, 'plans cannot be deleted'); END;

CREATE TABLE workflow_settings (
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  killed INTEGER NOT NULL DEFAULT 0,
  kill_reason TEXT,
  autonomy_tier TEXT NOT NULL DEFAULT 'T1',
  stable_version TEXT,
  canary_version TEXT,
  canary_percent INTEGER NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (tenant_id, name)
);

-- ---------------------------------------------------------------- authoring
CREATE TABLE drafts (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workflow_name TEXT,
  manifest_text TEXT NOT NULL,
  origin TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  notes TEXT,
  validation TEXT
);
CREATE INDEX idx_drafts_tenant ON drafts (tenant_id, updated_at);

CREATE TABLE change_requests (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  version TEXT NOT NULL,
  manifest_text TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  requested_by TEXT NOT NULL,
  requested_by_name TEXT,
  requested_at TEXT NOT NULL,
  reason_code TEXT NOT NULL,
  reason TEXT NOT NULL,
  required_approvals INTEGER NOT NULL DEFAULT 1,
  approvals TEXT NOT NULL DEFAULT '[]',
  decided_by TEXT,
  decided_at TEXT,
  decision_comment TEXT,
  risk TEXT,
  origin TEXT NOT NULL DEFAULT 'human'
);
CREATE INDEX idx_changes_tenant ON change_requests (tenant_id, status, requested_at);

CREATE TABLE proposals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  workflow_name TEXT,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  source TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL,
  decided_by TEXT,
  decided_at TEXT,
  dedupe_key TEXT
);
CREATE INDEX idx_proposals_tenant ON proposals (tenant_id, status, created_at);
CREATE UNIQUE INDEX idx_proposals_dedupe ON proposals (tenant_id, dedupe_key) WHERE dedupe_key IS NOT NULL AND status = 'open';

CREATE TABLE findings (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  version TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  rule_id TEXT NOT NULL,
  severity TEXT NOT NULL,
  blocking INTEGER NOT NULL DEFAULT 0,
  message TEXT NOT NULL,
  detail TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX idx_findings_wf ON findings (tenant_id, workflow_name, version);

-- --------------------------------------------------------------------- runs
CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  workflow_version TEXT NOT NULL,
  plan_hash TEXT NOT NULL,
  status TEXT NOT NULL,
  dry_run INTEGER NOT NULL DEFAULT 0,
  environment TEXT NOT NULL,
  trigger_type TEXT NOT NULL,
  trigger_name TEXT,
  trigger_payload TEXT,
  correlation_id TEXT,
  parent_run_id TEXT,
  parent_step_id TEXT,
  inputs TEXT NOT NULL,
  seed TEXT NOT NULL,
  context_now TEXT NOT NULL,
  priority INTEGER NOT NULL DEFAULT 5,
  dedup_key TEXT,
  requested_by TEXT NOT NULL,
  canary INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  started_at TEXT,
  finished_at TEXT,
  error TEXT,
  outputs TEXT,
  cost REAL NOT NULL DEFAULT 0,
  cancel_requested INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_runs_tenant_created ON runs (tenant_id, created_at DESC);
CREATE INDEX idx_runs_status ON runs (status, priority, created_at);
CREATE INDEX idx_runs_workflow ON runs (tenant_id, workflow_name, status);
CREATE INDEX idx_runs_parent ON runs (parent_run_id);
CREATE INDEX idx_runs_dedup ON runs (tenant_id, workflow_name, dedup_key, created_at);

CREATE TABLE step_states (
  run_id TEXT NOT NULL REFERENCES runs(id),
  step_id TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 0,
  started_at TEXT,
  finished_at TEXT,
  wake_at TEXT,
  output TEXT,
  output_ref TEXT,
  error TEXT,
  skipped_reason TEXT,
  handled TEXT,
  idempotency_key TEXT,
  child_run_id TEXT,
  approval_id TEXT,
  wait_event TEXT,
  wait_correlation TEXT,
  compensation_status TEXT,
  compensation_error TEXT,
  completed_seq INTEGER,
  cost REAL NOT NULL DEFAULT 0,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (run_id, step_id)
);
CREATE INDEX idx_steps_due ON step_states (status, wake_at);
CREATE INDEX idx_steps_wait ON step_states (wait_event, wait_correlation) WHERE status = 'waiting-event';

CREATE TABLE idempotency (
  tenant_id TEXT NOT NULL,
  capability TEXT NOT NULL,
  key TEXT NOT NULL,
  state TEXT NOT NULL,
  owner TEXT NOT NULL,
  output TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, capability, key)
);

CREATE TABLE approvals (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  run_id TEXT NOT NULL,
  step_id TEXT NOT NULL,
  status TEXT NOT NULL,
  message TEXT NOT NULL,
  approvers TEXT NOT NULL,
  requested_by TEXT,
  requested_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  on_timeout TEXT NOT NULL,
  escalated INTEGER NOT NULL DEFAULT 0,
  allow_self INTEGER NOT NULL DEFAULT 0,
  decided_by TEXT,
  decided_at TEXT,
  comment TEXT,
  workflow_name TEXT
);
CREATE INDEX idx_approvals_tenant ON approvals (tenant_id, status, requested_at);
CREATE INDEX idx_approvals_run ON approvals (run_id);

CREATE TABLE cost_ledger (
  tenant_id TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  day TEXT NOT NULL,
  cost REAL NOT NULL DEFAULT 0,
  PRIMARY KEY (tenant_id, workflow_name, day)
);

-- ----------------------------------------------------------------- triggers
CREATE TABLE triggers (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  workflow_name TEXT NOT NULL,
  workflow_version TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  config TEXT NOT NULL,
  enabled INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_fired_at TEXT,
  next_fire_at TEXT,
  UNIQUE (tenant_id, workflow_name, name)
);
CREATE INDEX idx_triggers_due ON triggers (type, enabled, next_fire_at);

CREATE TABLE trigger_fires (
  trigger_id TEXT NOT NULL,
  fire_key TEXT NOT NULL,
  run_id TEXT,
  fired_at TEXT NOT NULL,
  PRIMARY KEY (trigger_id, fire_key)
);

CREATE TABLE webhook_nonces (
  tenant_id TEXT NOT NULL,
  nonce TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, nonce)
);

-- ----------------------------------------------------------------- secrets
CREATE TABLE secrets (
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  cipher TEXT NOT NULL,
  key_id TEXT NOT NULL,
  description TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, name)
);

CREATE TABLE secret_leases (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  run_id TEXT,
  step_id TEXT,
  names TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT
);

-- ---------------------------------------------------------------- artifacts
CREATE TABLE artifacts (
  tenant_id TEXT NOT NULL,
  hash TEXT NOT NULL,
  size INTEGER NOT NULL,
  content_type TEXT NOT NULL,
  run_id TEXT,
  created_at TEXT NOT NULL,
  tombstoned_at TEXT,
  tombstone_reason TEXT,
  PRIMARY KEY (tenant_id, hash)
);

-- --------------------------------------------------------------- operations
CREATE TABLE kv (
  tenant_id TEXT NOT NULL,
  key TEXT NOT NULL,
  value TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, key)
);

CREATE TABLE capability_flags (
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  killed INTEGER NOT NULL DEFAULT 0,
  reason TEXT,
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL,
  PRIMARY KEY (tenant_id, name)
);

CREATE TABLE channels (
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  type TEXT NOT NULL,
  config TEXT NOT NULL,
  secret_name TEXT,
  created_at TEXT NOT NULL,
  PRIMARY KEY (tenant_id, name)
);
`,
  },
];
