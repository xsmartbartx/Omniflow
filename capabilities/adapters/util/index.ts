import { isTruthy } from '../../../core/index.ts';
import type { CapabilityDeclaration } from '../../../schemas/index.ts';
import { type CapabilityAdapter, CapabilityError } from '../../contract/types.ts';

const pureBase = {
  family: 'util',
  scopes: [] as string[],
  egress: { mode: 'none' as const },
  costModel: { unitsPerInvocation: 0, latencyClass: 'instant' as const },
  dataClassification: 'secret' as const,
  effect: 'pure' as const,
  dryRun: 'execute' as const,
};

/** Pure, side-effect-free helpers. They also make workflows testable without any external system. */
export function createUtilCapabilities(): CapabilityAdapter[] {
  const noop: CapabilityAdapter = {
    declaration: {
      ...pureBase,
      name: 'util-noop',
      version: '1.0.0',
      description: 'Does nothing and succeeds. Useful as a placeholder or join point.',
      inputSchema: { type: 'object' },
      outputSchema: {
        type: 'object',
        required: ['ok'],
        properties: { ok: { type: 'boolean' } },
        additionalProperties: false,
      },
      failureModes: [],
    } as CapabilityDeclaration,
    execute: async () => ({ ok: true }),
  };

  const echo: CapabilityAdapter = {
    declaration: {
      ...pureBase,
      name: 'util-echo',
      version: '1.0.0',
      description: 'Returns its input value unchanged. Use to shape data with expressions.',
      inputSchema: {
        type: 'object',
        required: ['value'],
        properties: { value: {} },
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        required: ['value'],
        properties: { value: {} },
        additionalProperties: false,
      },
      failureModes: [],
    } as CapabilityDeclaration,
    execute: async (_ctx, input: { value: unknown }) => ({ value: input.value }),
  };

  const assert: CapabilityAdapter = {
    declaration: {
      ...pureBase,
      name: 'util-assert',
      version: '1.0.0',
      description: 'Fails the step with a business error when the condition is falsy.',
      inputSchema: {
        type: 'object',
        required: ['condition'],
        properties: { condition: {}, message: { type: 'string', maxLength: 1000 } },
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        required: ['passed'],
        properties: { passed: { type: 'boolean' } },
        additionalProperties: false,
      },
      failureModes: [
        {
          code: 'ASSERTION_FAILED',
          class: 'business',
          retryable: false,
          description: 'The condition was falsy',
        },
      ],
    } as CapabilityDeclaration,
    execute: async (_ctx, input: { condition: unknown; message?: string }) => {
      if (!isTruthy(input.condition)) {
        throw new CapabilityError('ASSERTION_FAILED', input.message ?? 'Assertion failed', {
          errorClass: 'business',
          retryable: false,
        });
      }
      return { passed: true };
    },
  };

  const fail: CapabilityAdapter = {
    declaration: {
      ...pureBase,
      name: 'util-fail',
      version: '1.0.0',
      description: 'Always fails with the given error class. For drills, chaos tests and demonstrating error routing.',
      inputSchema: {
        type: 'object',
        properties: {
          message: { type: 'string', maxLength: 1000, default: 'Deliberate failure' },
          errorClass: {
            enum: ['transient', 'contract', 'authorisation', 'business', 'systemic', 'catastrophic'],
            default: 'business',
          },
        },
        additionalProperties: false,
      },
      outputSchema: { type: 'object' },
      failureModes: [
        {
          code: 'DELIBERATE_FAILURE',
          class: 'business',
          retryable: false,
          description: 'Raised on purpose',
        },
      ],
    } as CapabilityDeclaration,
    execute: async (_ctx, input: { message?: string; errorClass?: string }) => {
      throw new CapabilityError('DELIBERATE_FAILURE', input.message ?? 'Deliberate failure', {
        errorClass: (input.errorClass as never) ?? 'business',
      });
    },
  };

  return [noop, echo, assert, fail];
}
