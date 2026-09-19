/**
 * Error taxonomy (architecture §12.2). Every failure in the system carries one of six classes,
 * which decides default retry handling. Errors are data: they serialise to `ErrorInfo` and never
 * carry secrets.
 */

export const ERROR_CLASSES = [
  'transient',
  'contract',
  'authorisation',
  'business',
  'systemic',
  'catastrophic',
] as const;
export type ErrorClass = (typeof ERROR_CLASSES)[number];

/** Default retryability by class (§12.2). Capabilities and steps may override per failure mode. */
export const DEFAULT_RETRYABLE: Record<ErrorClass, boolean> = {
  transient: true,
  contract: false, // one bounded retry is applied by the orchestrator for output-schema violations
  authorisation: false,
  business: false,
  systemic: true,
  catastrophic: false,
};

export interface Issue {
  /** JSON-pointer-like location inside the offending document, e.g. `steps[2].with.url`. */
  path: string;
  message: string;
  code: string;
  severity?: 'error' | 'warning';
  /** 1-based source position when the document came from text. */
  line?: number;
  column?: number;
}

export interface ErrorInfo {
  code: string;
  message: string;
  class: ErrorClass;
  retryable: boolean;
  details?: Record<string, unknown>;
}

export interface ErrorOptions {
  errorClass?: ErrorClass;
  retryable?: boolean;
  details?: Record<string, unknown>;
  cause?: unknown;
}

export class OmniflowError extends Error {
  readonly code: string;
  readonly errorClass: ErrorClass;
  readonly retryable: boolean;
  readonly details?: Record<string, unknown>;

  constructor(code: string, message: string, options: ErrorOptions = {}) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = new.target.name;
    this.code = code;
    this.errorClass = options.errorClass ?? 'business';
    this.retryable = options.retryable ?? DEFAULT_RETRYABLE[this.errorClass];
    if (options.details) this.details = options.details;
  }

  toInfo(): ErrorInfo {
    const info: ErrorInfo = {
      code: this.code,
      message: this.message,
      class: this.errorClass,
      retryable: this.retryable,
    };
    if (this.details) info.details = this.details;
    return info;
  }
}

/** Input, manifest or output failed schema/semantic validation. Never retryable. */
export class ValidationError extends OmniflowError {
  readonly issues: Issue[];
  constructor(message: string, issues: Issue[], options: ErrorOptions = {}) {
    super('VALIDATION_FAILED', message, { errorClass: 'contract', retryable: false, ...options });
    this.issues = issues;
  }
  override toInfo(): ErrorInfo {
    return { ...super.toInfo(), details: { ...this.details, issues: this.issues } };
  }
}

export class NotFoundError extends OmniflowError {
  constructor(what: string, id?: string) {
    super('NOT_FOUND', id === undefined ? `${what} not found` : `${what} '${id}' not found`, {
      errorClass: 'business',
      retryable: false,
    });
  }
}

export class ConflictError extends OmniflowError {
  constructor(message: string, details?: Record<string, unknown>) {
    super('CONFLICT', message, {
      errorClass: 'business',
      retryable: false,
      ...(details ? { details } : {}),
    });
  }
}

export class AuthenticationError extends OmniflowError {
  constructor(message = 'Authentication required') {
    super('UNAUTHENTICATED', message, { errorClass: 'authorisation', retryable: false });
  }
}

export class ForbiddenError extends OmniflowError {
  constructor(message = 'Forbidden', details?: Record<string, unknown>) {
    super('FORBIDDEN', message, {
      errorClass: 'authorisation',
      retryable: false,
      ...(details ? { details } : {}),
    });
  }
}

/** A Policy Engine `deny` decision surfaced as an error. */
export class PolicyDeniedError extends OmniflowError {
  constructor(reasonCode: string, message: string, details?: Record<string, unknown>) {
    super(reasonCode, message, {
      errorClass: 'authorisation',
      retryable: false,
      ...(details ? { details } : {}),
    });
  }
}

export class RateLimitedError extends OmniflowError {
  constructor(retryAfterSeconds: number) {
    super('RATE_LIMITED', 'Too many requests', {
      errorClass: 'transient',
      retryable: true,
      details: { retryAfterSeconds },
    });
  }
}

/** Normalise anything thrown into an `ErrorInfo` without leaking stack traces. */
export function toErrorInfo(error: unknown): ErrorInfo {
  if (error instanceof OmniflowError) return error.toInfo();
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return {
      code: typeof code === 'string' ? code : 'INTERNAL',
      message: error.message,
      class: 'systemic',
      retryable: true,
    };
  }
  return { code: 'INTERNAL', message: String(error), class: 'systemic', retryable: true };
}

export function isErrorClass(value: unknown): value is ErrorClass {
  return typeof value === 'string' && (ERROR_CLASSES as readonly string[]).includes(value);
}
