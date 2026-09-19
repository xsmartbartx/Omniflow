import semver from 'semver';
import { contentHash, ERROR_CLASSES, type Issue, isSensitivity, ValidationError } from '../../core/index.ts';
import type { CapabilityDeclaration } from '../../schemas/index.ts';
import { checkSchemaDefinition, isValidEgressHost, parseCapabilityRef } from '../../security/validator/index.ts';
import type { CapabilityAdapter, CapabilityRegistration, RegisteredCapability } from './types.ts';

const NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

/** Check a declaration against the capability contract; returns every violation found. */
export function validateDeclaration(d: CapabilityDeclaration): Issue[] {
  const issues: Issue[] = [];
  const err = (path: string, code: string, message: string) => issues.push({ path, code, message });

  if (!NAME.test(d.name)) err('name', 'INVALID_NAME', 'name must be kebab-case');
  if (!semver.valid(d.version)) err('version', 'INVALID_VERSION', 'version must be semver');
  if (!d.description?.trim()) err('description', 'MISSING_DESCRIPTION', 'description is required');
  if (!d.family) err('family', 'MISSING_FAMILY', 'family is required');
  for (const key of ['inputSchema', 'outputSchema'] as const) {
    const bad = checkSchemaDefinition(d[key]);
    if (bad) err(key, 'INVALID_SCHEMA', bad);
    else if ((d[key] as { type?: unknown }).type !== 'object') {
      err(key, 'SCHEMA_NOT_OBJECT', `${key} must describe an object`);
    }
  }
  if (!['pure', 'idempotent', 'effectful'].includes(d.effect)) {
    err('effect', 'INVALID_EFFECT', "effect must be 'pure', 'idempotent' or 'effectful'");
  }
  if (!['simulate', 'execute'].includes(d.dryRun)) {
    err('dryRun', 'MISSING_DRY_RUN', "every capability must declare dryRun: 'simulate' | 'execute' (ADR-0002 D3)");
  }
  if (d.effect === 'effectful' && d.dryRun !== 'simulate') {
    err(
      'dryRun',
      'EFFECTFUL_MUST_SIMULATE',
      "an effectful capability must declare dryRun: 'simulate' so shadow runs can never perform its effect",
    );
  }
  if (d.effect === 'pure' && d.egress?.mode !== 'none') {
    err('egress', 'PURE_WITH_EGRESS', 'a pure capability cannot have network egress');
  }
  if (d.egress?.mode === 'static') {
    if (d.egress.hosts.length === 0) err('egress.hosts', 'EMPTY_EGRESS', 'static egress needs at least one host');
    for (const h of d.egress.hosts) {
      if (!isValidEgressHost(h)) err('egress.hosts', 'INVALID_EGRESS_HOST', `'${h}' is not a valid host`);
    }
  } else if (d.egress?.mode !== 'none' && d.egress?.mode !== 'step') {
    err('egress', 'INVALID_EGRESS', "egress.mode must be 'none', 'static' or 'step'");
  }
  if (!isSensitivity(d.dataClassification)) {
    err('dataClassification', 'INVALID_CLASSIFICATION', 'dataClassification is required');
  }
  if (!Array.isArray(d.scopes)) err('scopes', 'INVALID_SCOPES', 'scopes must be an array');
  if (!d.costModel || typeof d.costModel.unitsPerInvocation !== 'number' || d.costModel.unitsPerInvocation < 0) {
    err('costModel', 'INVALID_COST_MODEL', 'costModel.unitsPerInvocation must be a non-negative number');
  }
  const codes = new Set<string>();
  for (const fm of d.failureModes ?? []) {
    if (codes.has(fm.code)) err('failureModes', 'DUPLICATE_FAILURE_MODE', `duplicate failure mode '${fm.code}'`);
    codes.add(fm.code);
    if (!(ERROR_CLASSES as readonly string[]).includes(fm.class)) {
      err('failureModes', 'INVALID_ERROR_CLASS', `failure mode '${fm.code}' has an unknown class`);
    }
  }
  if (d.compensation !== undefined && !parseCapabilityRef(d.compensation)) {
    err('compensation', 'INVALID_COMPENSATION', 'compensation must be name@constraint');
  }
  return issues;
}

/**
 * Catalogue of available capabilities (architecture §5.1 #12): name, version, typed contract,
 * declared side effects and required scopes. Purely declarative metadata plus the adapter handle.
 */
export class CapabilityRegistry {
  private readonly byName = new Map<string, Map<string, RegisteredCapability>>();

  register(
    adapter: CapabilityAdapter,
    registration: CapabilityRegistration = { owner: 'omniflow', source: 'builtin' },
  ): RegisteredCapability {
    const declaration = adapter.declaration;
    const issues = validateDeclaration(declaration);
    if (!registration.owner?.trim()) {
      issues.push({
        path: 'owner',
        code: 'OWNER_REQUIRED',
        message: 'a named owner is required to register a capability',
      });
    }
    if (issues.length > 0) {
      throw new ValidationError(
        `Invalid capability '${declaration.name}@${declaration.version}': ${issues.map((i) => i.message).join('; ')}`,
        issues,
      );
    }
    const versions = this.byName.get(declaration.name) ?? new Map<string, RegisteredCapability>();
    if (versions.has(declaration.version)) {
      throw new ValidationError(`Capability ${declaration.name}@${declaration.version} is already registered`, [
        { path: 'version', code: 'DUPLICATE_CAPABILITY', message: 'already registered' },
      ]);
    }
    const entry: RegisteredCapability = {
      adapter,
      declaration,
      hash: contentHash(declaration),
      registration,
    };
    versions.set(declaration.version, entry);
    this.byName.set(declaration.name, versions);
    return entry;
  }

  get(name: string, version: string): RegisteredCapability | undefined {
    return this.byName.get(name)?.get(version);
  }

  /** Highest registered version satisfying the constraint. */
  resolve(name: string, range: string): RegisteredCapability | undefined {
    const versions = this.byName.get(name);
    if (!versions) return undefined;
    const best = semver.maxSatisfying([...versions.keys()], range);
    return best ? versions.get(best) : undefined;
  }

  resolveRef(ref: string): RegisteredCapability | undefined {
    const parsed = parseCapabilityRef(ref);
    return parsed ? this.resolve(parsed.name, parsed.range) : undefined;
  }

  /** All registered versions of a capability, ascending. */
  versions(name: string): string[] {
    return [...(this.byName.get(name)?.keys() ?? [])].sort(semver.compare);
  }

  names(): string[] {
    return [...this.byName.keys()].sort();
  }

  has(name: string): boolean {
    return this.byName.has(name);
  }

  /** Every registered declaration, sorted by name then version. */
  list(): RegisteredCapability[] {
    return [...this.byName.values()]
      .flatMap((v) => [...v.values()])
      .sort(
        (a, b) =>
          a.declaration.name.localeCompare(b.declaration.name) ||
          semver.compare(a.declaration.version, b.declaration.version),
      );
  }

  /** Latest version of every capability. */
  latest(): RegisteredCapability[] {
    const out: RegisteredCapability[] = [];
    for (const [name, versions] of this.byName) {
      const best = semver.maxSatisfying([...versions.keys()], '*');
      if (best) out.push(versions.get(best)!);
      else void name;
    }
    return out.sort((a, b) => a.declaration.name.localeCompare(b.declaration.name));
  }
}
