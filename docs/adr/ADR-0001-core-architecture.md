# ADR 0001: Core Architecture

## Status

Accepted

## Date

2026-09-19

## Context

`omniflow-architecture-and-vision.md` and `ADR-0002-workflow-execution-model.md` both extend a
foundational decision, `ADR-0001-core-architecture`, that was referenced but not present in the
repository. This ADR records that foundation so the extension documents are self-consistent. It
captures the decisions those documents *assume*; it introduces no new constraint beyond them.

## Decision

### D1. Layered architecture with inward-only dependencies

| Layer | Owns |
|---|---|
| **Core** | Models, typed value objects, error taxonomy, logging and validation primitives. No business logic, no external calls. |
| **Modules** | Isolated functional units. |
| **Pipeline** | CI/CD, deterministic builds, artifact promotion, environment gates. |
| **Security** | Zero-trust validation, policy, secret brokering, pentest heuristics, risk scoring. |
| **Documentation** | Architecture, ADRs, generated documentation, system flows. |

`ADR-0002` adds a sixth layer, **Orchestration**.

- Core depends on nothing.
- Security may be called from anywhere but calls only Core.
- No cross-module state sharing: modules communicate through defined interfaces, never through
  shared mutable memory.
- The rules are enforced mechanically (`npm run check:layers`); a violation is a build failure.

### D2. Zero trust

Every input is untrusted until validated — user input, external-system responses and (per ADR-0002)
AI-generated artifacts. Validation is fail-fast. Sensitive data never reaches a log. Security is
embedded in every layer rather than appended.

### D3. Deterministic, fail-fast CI/CD

Builds are reproducible. Static analysis, dependency audit, schema validation, tests and security
checks run in a fixed order and stop at the first failure. Artifacts are immutable.

### D4. Documentation-first governance

Architectural decisions are recorded as ADRs and diagrammed. A change to a public contract
requires an ADR reference.

### D5. Agents operate under hard guardrails

Automated agents may analyse and propose. They hold no direct write path to production systems and
obey the rules in `ADR-0002` D4.

## Consequences

- Boundaries are cheap to reason about and cheap to check.
- Any new capability that needs to break a boundary must first change this ADR (or a successor).
- Conventions: folders and files in `kebab-case`; the standards in this ADR apply regardless of
  implementation language.

## Implementation note (2026-09-19)

The reference implementation in this repository is TypeScript on Node.js 24+. The layer rules of
D1 are encoded in `scripts/check-layers.ts`. See `docs/architecture.md` for how the source tree
maps to the layers.
