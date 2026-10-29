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
  {
    id: 2,
    name: 'nexora',
    sql: `
-- Proposed migration 2 for state/migrations.ts (SQLite dialect, same conventions as migration 1:
-- TEXT ids, ISO-8601 UTC TEXT timestamps, tenant_id on every tenant-owned row).
-- Access rule: data-layer checks only (no RLS in SQLite). Every query takes the tenant and filters on it;
-- tests must prove a second tenant cannot read these rows (same pattern as the existing isolation suite).
-- These tables are only written when OMNIFLOW_MODE=nexora. In standalone mode they stay empty.

-- NEXORA organisation <-> OmniFlow tenant. One row per org that has used the product.
CREATE TABLE nexora_orgs (
  org_id TEXT PRIMARY KEY,                         -- NEXORA/Clerk organisation id
  tenant_id TEXT NOT NULL UNIQUE REFERENCES tenants(id) ON DELETE RESTRICT,
  plan TEXT NOT NULL DEFAULT 'free'
    CHECK (plan IN ('free','starter','pro','business','scale')),
  status TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active','suspended','disabled')),   -- 'disabled' = product lifecycle switch (T-10)
  plan_synced_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (org_id, tenant_id)                       -- parent key for the composite foreign keys below
);

-- Parent key so child rows can prove a user belongs to the same tenant (SQLite needs a unique index here).
CREATE UNIQUE INDEX users_id_tenant ON users (id, tenant_id);

-- NEXORA user in an org <-> OmniFlow user. Created on first sign-in; password_hash stays NULL.
CREATE TABLE nexora_identities (
  org_id TEXT NOT NULL,
  external_user_id TEXT NOT NULL,                  -- Clerk user id
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  nexora_role TEXT NOT NULL
    CHECK (nexora_role IN ('owner','admin','member','billing','viewer')),
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (org_id, external_user_id),
  -- org and user must both belong to this row's tenant, not merely exist
  FOREIGN KEY (org_id, tenant_id) REFERENCES nexora_orgs (org_id, tenant_id) ON DELETE CASCADE,
  FOREIGN KEY (user_id, tenant_id) REFERENCES users (id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX nexora_identities_user ON nexora_identities (user_id);
CREATE INDEX nexora_identities_tenant ON nexora_identities (tenant_id);

-- Short-lived answers from C-ENT, so a run does not wait on a network call every time.
CREATE TABLE nexora_entitlement_cache (
  org_id TEXT NOT NULL REFERENCES nexora_orgs(org_id) ON DELETE CASCADE,
  action TEXT NOT NULL,                            -- e.g. 'run.start'
  allowed INTEGER NOT NULL CHECK (allowed IN (0,1)),
  remaining INTEGER,                               -- NULL = unlimited
  limit_total INTEGER,                             -- NULL = unlimited; shown in the usage meter
  fetched_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  PRIMARY KEY (org_id, action)
);

-- Verified org API keys (C-AUTH). Only a SHA-256 of the key is stored, never the key.
-- Revocation is "immediate and global" at Core, so valid_until must stay in seconds, not minutes.
CREATE TABLE nexora_key_cache (
  key_hash TEXT PRIMARY KEY,
  org_id TEXT NOT NULL REFERENCES nexora_orgs(org_id) ON DELETE CASCADE,
  key_id TEXT NOT NULL,                            -- logged on every use; the key value never is
  scopes TEXT NOT NULL,                            -- JSON array
  verified_at TEXT NOT NULL,
  valid_until TEXT NOT NULL
);
CREATE INDEX nexora_key_cache_org ON nexora_key_cache (org_id);

-- Transactional outbox for C-EVENT (usage, audit, health). Written in the same transaction as the
-- OmniFlow event it mirrors; a worker delivers it. idempotency_key makes redelivery safe.
CREATE TABLE nexora_outbox (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL,
  org_id TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('usage','audit','health')),
  name TEXT NOT NULL,                              -- <domain>.<object>.<action>, e.g. omniflow.run.started
  payload TEXT NOT NULL,                           -- JSON
  idempotency_key TEXT NOT NULL UNIQUE,            -- = id of the source OmniFlow event, assigned once and reused on retries
  correlation_id TEXT,
  occurred_at TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  sent_at TEXT,
  last_error TEXT,
  FOREIGN KEY (org_id, tenant_id) REFERENCES nexora_orgs (org_id, tenant_id) ON DELETE CASCADE
);
CREATE INDEX nexora_outbox_due ON nexora_outbox (sent_at, next_attempt_at);
CREATE INDEX nexora_outbox_org ON nexora_outbox (org_id, occurred_at);

`,
  },
  {
    id: 3,
    name: 'webhooks',
    sql: `
-- Outbound run-lifecycle webhooks: one row per (hook, event). The worker reads new events past a cursor,
-- writes the rows, then delivers them with retries; UNIQUE makes enqueueing idempotent after a crash.
CREATE TABLE webhook_deliveries (
  id TEXT PRIMARY KEY,
  tenant_id TEXT NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  hook_id TEXT NOT NULL,
  event_seq INTEGER NOT NULL,
  event_type TEXT NOT NULL,
  run_id TEXT,
  payload TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','delivered','failed')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  last_status INTEGER,
  last_error TEXT,
  created_at TEXT NOT NULL,
  delivered_at TEXT,
  UNIQUE (hook_id, event_seq)
);
CREATE INDEX idx_webhook_due ON webhook_deliveries (status, next_attempt_at);
CREATE INDEX idx_webhook_tenant ON webhook_deliveries (tenant_id, created_at DESC);
`,
  },
  {
    id: 4,
    name: 'stripe-billing',
    sql: `
CREATE TABLE billing_accounts (
  tenant_id TEXT PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  stripe_customer_id TEXT UNIQUE,
  stripe_subscription_id TEXT UNIQUE,
  plan TEXT NOT NULL DEFAULT 'free' CHECK (plan IN ('free','pro','team')),
  status TEXT NOT NULL DEFAULT 'free',
  current_period_end TEXT,
  cancel_at_period_end INTEGER NOT NULL DEFAULT 0 CHECK (cancel_at_period_end IN (0,1)),
  updated_at TEXT NOT NULL
);

CREATE TABLE billing_webhook_events (
  event_id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  processed_at TEXT NOT NULL
);

CREATE INDEX billing_accounts_status ON billing_accounts (status, plan);
`,
  },
  {
    id: 5,
    name: 'password-resets',
    sql: `
-- Only a hash of each reset token is stored; a token works once and expires.
CREATE TABLE password_resets (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  used_at TEXT
);
CREATE INDEX password_resets_user ON password_resets (user_id);
`,
  },
];
