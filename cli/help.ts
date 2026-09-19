export const HELP = `omniflow — the AI workflow substrate

Usage: omniflow <command> [options]

Work on manifest files (no server needed)
  validate <file|dir|->        Validate, compile and risk-review manifests. Exit 1 on errors (use in CI).
  compile <file>               Print the immutable plan and its content hash  [--out plan.json]
  dev <file>                   Run a workflow end to end on a throw-away platform
                               [--input k=v] [--secret NAME=value] [--dry-run] [--auto-approve]

Talk to a server (set OMNIFLOW_URL and OMNIFLOW_API_KEY)
  status                       Server version and readiness
  workflows [list]             List workflows
  workflows show <name>        Versions, triggers and recent runs
  workflows graph <name>       The workflow as a Mermaid flowchart
  workflows <op> <name> …      activate <version> · canary <version> <percent> · promote · rollback-canary
                               deprecate <version> · enable · disable · kill <reason> · revive · autonomy <T0-T3>
  publish <file|dir>           Publish (or open a change request)  [--canary <percent>]
  run <workflow>               Start a run  [--input k=v] [--input-file f.json] [--dry-run] [--wait]
  runs [list]                  Recent runs  [--workflow n] [--status s] [--limit n]
  runs show|events|tail|cancel|retry <run-id>
  runs output <run-id> <step>  The full output of one step
  approvals [list]             What is waiting for a decision
  approvals approve|deny <id>  [--comment text]
  changes [list|show]          Change requests; also  approve|reject|withdraw <id>
  capabilities                 The capability catalogue and its health
  secrets list|set|delete      Manage secrets (values via stdin: --stdin)
  insights [--hours n]         Dashboard: outcomes, latency, cost, failing steps
  alerts                       Open alerts (exit 1 if any is critical)
  analyze                      Run the Analysis Agent now
  proposals [list|show]        Improvement proposals; also  accept|dismiss <id>
  plan "<intent>"              AI drafts a workflow from a description  [--workflow n] [--out f]
  drafts [list|show|create]    Drafts; also  validate|submit|apply|delete <id>
  import crontab <file>        One draft per cron job (Lift)  [--owner e] [--out-dir d]
  import script <file>         AI proposes a decomposed workflow from a legacy script
  explain workflow|run <x>     Plain-language explanation
  docs workflow <n>|capabilities|index  Generated docs (Markdown / Mermaid)  [--out f]
  audit verify|export          Check the tamper-evident audit chain / export it  [--out file]

Operate the data directory (run on the server host; OMNIFLOW_DATA_DIR)
  admin create-user --email e [--name n] [--role r]
  admin reset-password --email e
  admin create-api-key --name label [--role r] [--tenant t]
  admin list-users
  admin verify-audit
  admin backup <file>

Global options
  --json           Machine-readable output
  --url <url>      Server URL (default $OMNIFLOW_URL or http://127.0.0.1:8080)
  --key <key>      API key (default $OMNIFLOW_API_KEY)
  --no-color       Disable colours (also honours NO_COLOR)
  -h, --help       Show help
  -v, --version    Show the version

Exit codes: 0 success · 1 the operation failed (invalid manifest, failed run…) · 2 usage error
`;
