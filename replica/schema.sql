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
