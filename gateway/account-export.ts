import type { State } from '../state/index.ts';

const RUN_PAGE = 500;

/**
 * Everything a workspace holds that a person can reasonably ask for a copy of, as one JSON document. Secret values,
 * password hashes and API-key hashes are never included (secrets are listed by name only); the audit log has its own
 * export. Written for a data-portability request, so it is plain data with no references to this server.
 */
export function accountExport(st: State, tenant: string, exportedAt: string) {
  const workflows = st.registry.listWorkflows(tenant).map((w) => ({
    name: w.name,
    settings: w.settings,
    versions: st.registry.listVersions(tenant, w.name).map((v) => ({
      version: v.version,
      status: v.status,
      publishedBy: v.publishedBy,
      publishedAt: v.publishedAt,
      manifest: v.manifestText,
    })),
  }));
  const runs: unknown[] = [];
  for (let offset = 0; ; offset += RUN_PAGE) {
    const page = st.runs.listRuns({ tenant, limit: RUN_PAGE, offset });
    for (const r of page)
      runs.push({
        id: r.id,
        workflow: r.workflowName,
        version: r.workflowVersion,
        status: r.status,
        dryRun: r.dryRun,
        trigger: r.triggerType,
        inputs: r.inputs,
        outputs: r.outputs,
        error: r.error,
        createdAt: r.createdAt,
        finishedAt: r.finishedAt,
      });
    if (page.length < RUN_PAGE) break;
  }
  const tenantRow = st.identity.getTenant(tenant);
  return {
    format: 'omniflow-account-export/1',
    exportedAt,
    workspace: { id: tenant, name: tenantRow?.name, createdAt: tenantRow?.createdAt },
    people: st.identity.listUsers(tenant).map((u) => ({
      id: u.id,
      email: u.email,
      name: u.name,
      roles: u.roles,
      createdAt: u.createdAt,
      lastLoginAt: u.lastLoginAt,
    })),
    workflows,
    runs,
    secrets: st.secrets.list(tenant),
  };
}
