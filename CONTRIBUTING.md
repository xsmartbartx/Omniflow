# Contributing

Thanks for helping. This is a small, opinionated codebase; the rules below keep it that way.

## Set up

Node.js 24+.

```bash
npm ci
npm run verify        # typecheck + lint + architecture layers + all tests — must pass before a PR
npm run dev           # server with reload on :8080 (set OMNIFLOW_ADMIN_PASSWORD)
npm run test:coverage # the coverage floor CI enforces
npm run format        # Biome formatter/fixer
```

Docker is only needed for `deploy/smoke-test.sh` (CI runs it).

## Ground rules

1. **Respect the layers.** `scripts/check-layers.ts` (run by `verify`) enforces
   `core ← schemas ← security ← capabilities/state ← orchestration ← insight/authoring ← gateway ← server/cli`.
   Agent code (`authoring/agents`, `insight/analysis`, `security/pentest`) must never import the execution
   plane — that is the safety argument, not a style preference. See [docs/architecture.md](docs/architecture.md).
2. **Everything that acts on the outside world is a capability**, declared up front. Do not reach out from
   anywhere else.
3. **Determinism.** No `Date.now()`, `Math.random()` or unseeded randomness in the compiler, orchestrator
   or expression evaluator; inject a `Clock` / use the run seed.
4. **Errors are classified** (`transient`, `systemic`, `contract`, `business`, `authorisation`,
   `catastrophic`). Pick the class that is true: it decides retry behaviour.
5. **Secrets never travel.** Not in logs, events, errors, artifacts or API responses.
6. **Tests prove behaviour.** A bug fix starts with a failing test; a new control comes with the test that
   attacks it. Prefer real components over mocks (the suite runs a real SQLite state plane and real HTTP).
7. **Docs are part of the change.** User-visible behaviour changes update `docs/` and `CHANGELOG.md`.
   Reference docs generated from code (`docs/reference/*`, `THIRD_PARTY_NOTICES.md`) are regenerated with
   `npm run docs:generate` and `npm run licenses`; CI fails if they are stale.

## Common changes

- **A capability:** implement it under `capabilities/adapters/<family>/`, declare it fully, register it in
  `capabilities/index.ts` (only when configured, if it needs config), add tests for the contract, its failure
  classes and its dry-run behaviour, then `npm run docs:generate`.
- **An API route:** add a `RouteDef` in `gateway/routes/` with a strict `schema` and an RBAC `action`; it
  appears in the OpenAPI document automatically. Test the happy path, authorisation, validation, tenancy.
- **A CLI command:** add it under `cli/commands/`, register it in `cli/main.ts` and `cli/help.ts`, cover it in
  `tests/cli/`, then `npm run docs:generate`.
- **An Analysis rule:** a pure function in `insight/analysis/rules.ts`; test it with a few numbers.
- **A configuration variable:** read it in `server/config.ts`; add it to `.env.example` and
  `docs/configuration.md` (a test fails if any of the three drift).
- **The console:** vanilla JS modules under `console/js/`; build DOM with `h()` (never `innerHTML`), no inline
  script or style. `tests/console/static.test.ts` enforces the CSP properties.

## Pull requests

Small and focused. Say what changed and why; note anything that affects operators or the security model.
CI must be green. By contributing you agree your work is licensed under the Apache License 2.0.
