import semver from 'semver';
import { type Clock, ConflictError, systemClock } from '../core/index.ts';
import type { AutonomyTier, Plan } from '../schemas/index.ts';
import { type Db, fromJson, toJson } from './database.ts';

export type VersionStatus = 'published' | 'deprecated' | 'frozen';

export interface VersionRecord {
  tenant: string;
  name: string;
  version: string;
  status: VersionStatus;
  manifestText: string;
  manifestHash: string;
  planHash: string;
  environment: string;
  parentVersion?: string;
  publishedBy: string;
  publishedAt: string;
  approval?: unknown;
  risk?: unknown;
}

export interface NewVersion {
  tenant: string;
  name: string;
  version: string;
  manifestText: string;
  manifestHash: string;
  planHash: string;
  plan: Plan;
  environment: string;
  parentVersion?: string;
  publishedBy: string;
  approval?: unknown;
  risk?: unknown;
}

export interface WorkflowSettings {
  tenant: string;
  name: string;
  enabled: boolean;
  killed: boolean;
  killReason?: string;
  autonomyTier: AutonomyTier;
  stableVersion?: string;
  canaryVersion?: string;
  canaryPercent: number;
  updatedAt: string;
  updatedBy: string;
}

interface VRow {
  tenant_id: string;
  name: string;
  version: string;
  status: VersionStatus;
  manifest_text: string;
  manifest_hash: string;
  plan_hash: string;
  environment: string;
  parent_version: string | null;
  published_by: string;
  published_at: string;
  approval: string | null;
  risk: string | null;
}

interface SRow {
  tenant_id: string;
  name: string;
  enabled: number;
  killed: number;
  kill_reason: string | null;
  autonomy_tier: AutonomyTier;
  stable_version: string | null;
  canary_version: string | null;
  canary_percent: number;
  updated_at: string;
  updated_by: string;
}

const toVersion = (r: VRow): VersionRecord => ({
  tenant: r.tenant_id,
  name: r.name,
  version: r.version,
  status: r.status,
  manifestText: r.manifest_text,
  manifestHash: r.manifest_hash,
  planHash: r.plan_hash,
  environment: r.environment,
  ...(r.parent_version ? { parentVersion: r.parent_version } : {}),
  publishedBy: r.published_by,
  publishedAt: r.published_at,
  ...(r.approval ? { approval: fromJson(r.approval) } : {}),
  ...(r.risk ? { risk: fromJson(r.risk) } : {}),
});

const toSettings = (r: SRow): WorkflowSettings => ({
  tenant: r.tenant_id,
  name: r.name,
  enabled: r.enabled === 1,
  killed: r.killed === 1,
  ...(r.kill_reason ? { killReason: r.kill_reason } : {}),
  autonomyTier: r.autonomy_tier,
  ...(r.stable_version ? { stableVersion: r.stable_version } : {}),
  ...(r.canary_version ? { canaryVersion: r.canary_version } : {}),
  canaryPercent: r.canary_percent,
  updatedAt: r.updated_at,
  updatedBy: r.updated_by,
});

export type SettingsPatch = Partial<
  Pick<
    WorkflowSettings,
    'enabled' | 'killed' | 'killReason' | 'autonomyTier' | 'stableVersion' | 'canaryVersion' | 'canaryPercent'
  >
> & { clearCanary?: boolean };

/**
 * Immutable, content-addressed store of published workflow versions with lineage
 * (architecture §5.1 #7). Published versions are never edited, only superseded — enforced by
 * database triggers as well as by this API.
 */
export class RegistryStore {
  private readonly db: Db;
  private readonly clock: Clock;
  private readonly planCache = new Map<string, Plan>();

  constructor(db: Db, clock: Clock = systemClock) {
    this.db = db;
    this.clock = clock;
  }

  insertVersion(v: NewVersion): VersionRecord {
    return this.db.transaction(() => {
      if (this.getVersion(v.tenant, v.name, v.version)) {
        throw new ConflictError(
          `${v.name}@${v.version} is already published; published versions are immutable — publish a new version`,
          {
            workflow: v.name,
            version: v.version,
          },
        );
      }
      const now = this.clock.now().toISOString();
      this.db.run(`INSERT OR IGNORE INTO plans (tenant_id, hash, body, created_at) VALUES (?, ?, ?, ?)`, [
        v.tenant,
        v.planHash,
        JSON.stringify(v.plan),
        now,
      ]);
      this.db.run(
        `INSERT INTO workflow_versions (tenant_id, name, version, status, manifest_text, manifest_hash, plan_hash, environment,
           parent_version, published_by, published_at, approval, risk)
         VALUES (?, ?, ?, 'published', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          v.tenant,
          v.name,
          v.version,
          v.manifestText,
          v.manifestHash,
          v.planHash,
          v.environment,
          v.parentVersion ?? null,
          v.publishedBy,
          now,
          toJson(v.approval),
          toJson(v.risk),
        ],
      );
      this.db.run(
        `INSERT OR IGNORE INTO workflow_settings (tenant_id, name, updated_at, updated_by) VALUES (?, ?, ?, ?)`,
        [v.tenant, v.name, now, v.publishedBy],
      );
      return this.getVersion(v.tenant, v.name, v.version)!;
    });
  }

  getVersion(tenant: string, name: string, version: string): VersionRecord | undefined {
    const r = this.db.get<VRow>('SELECT * FROM workflow_versions WHERE tenant_id = ? AND name = ? AND version = ?', [
      tenant,
      name,
      version,
    ]);
    return r ? toVersion(r) : undefined;
  }

  /** Versions of a workflow, newest (highest semver) first. */
  listVersions(tenant: string, name: string): VersionRecord[] {
    return this.db
      .all<VRow>('SELECT * FROM workflow_versions WHERE tenant_id = ? AND name = ?', [tenant, name])
      .map(toVersion)
      .sort((a, b) => semver.rcompare(a.version, b.version));
  }

  latestVersion(tenant: string, name: string): VersionRecord | undefined {
    return this.listVersions(tenant, name).find((v) => v.status === 'published');
  }

  listWorkflows(
    tenant: string,
  ): Array<{ name: string; versions: number; latest?: string; lastPublishedAt?: string; settings: WorkflowSettings }> {
    const names = this.db.all<{ name: string; n: number; last: string }>(
      'SELECT name, COUNT(*) AS n, MAX(published_at) AS last FROM workflow_versions WHERE tenant_id = ? GROUP BY name ORDER BY name',
      [tenant],
    );
    return names.map((n) => {
      const latest = this.latestVersion(tenant, n.name)?.version;
      return {
        name: n.name,
        versions: n.n,
        ...(latest ? { latest } : {}),
        lastPublishedAt: n.last,
        settings: this.getSettings(tenant, n.name)!,
      };
    });
  }

  setStatus(tenant: string, name: string, version: string, status: VersionStatus): void {
    this.db.run('UPDATE workflow_versions SET status = ? WHERE tenant_id = ? AND name = ? AND version = ?', [
      status,
      tenant,
      name,
      version,
    ]);
  }

  getPlan(tenant: string, hash: string): Plan | undefined {
    const key = `${tenant}/${hash}`;
    const cached = this.planCache.get(key);
    if (cached) return cached;
    const r = this.db.get<{ body: string }>('SELECT body FROM plans WHERE tenant_id = ? AND hash = ?', [tenant, hash]);
    if (!r) return undefined;
    const plan = JSON.parse(r.body) as Plan;
    if (this.planCache.size > 200) this.planCache.clear();
    this.planCache.set(key, plan);
    return plan;
  }

  getSettings(tenant: string, name: string): WorkflowSettings | undefined {
    const r = this.db.get<SRow>('SELECT * FROM workflow_settings WHERE tenant_id = ? AND name = ?', [tenant, name]);
    return r ? toSettings(r) : undefined;
  }

  patchSettings(tenant: string, name: string, patch: SettingsPatch, by: string): WorkflowSettings {
    const cur = this.getSettings(tenant, name);
    if (!cur) throw new ConflictError(`Workflow '${name}' has no published version yet`);
    const next = { ...cur, ...patch };
    this.db.run(
      `UPDATE workflow_settings SET enabled = ?, killed = ?, kill_reason = ?, autonomy_tier = ?, stable_version = ?,
         canary_version = ?, canary_percent = ?, updated_at = ?, updated_by = ? WHERE tenant_id = ? AND name = ?`,
      [
        next.enabled ? 1 : 0,
        next.killed ? 1 : 0,
        next.killed ? (next.killReason ?? null) : null,
        next.autonomyTier,
        next.stableVersion ?? null,
        patch.clearCanary ? null : (next.canaryVersion ?? null),
        patch.clearCanary ? 0 : next.canaryPercent,
        this.clock.now().toISOString(),
        by,
        tenant,
        name,
      ],
    );
    return this.getSettings(tenant, name)!;
  }
}
