import {
  type CapabilityAdapter,
  type CapabilityRegistry,
  createDefaultRegistry,
  defineCapability,
} from '../../capabilities/index.ts';
import type { CapabilityDeclaration } from '../../schemas/index.ts';

const base: Omit<CapabilityDeclaration, 'name' | 'effect'> = {
  version: '1.0.0',
  description: 'test capability',
  family: 'test',
  inputSchema: { type: 'object' },
  outputSchema: { type: 'object' },
  scopes: [],
  egress: { mode: 'none' },
  costModel: { unitsPerInvocation: 1, latencyClass: 'fast' },
  failureModes: [],
  dataClassification: 'internal',
  dryRun: 'execute',
};

export const testCapabilities = (): CapabilityAdapter[] => [
  defineCapability({
    declaration: {
      ...base,
      name: 'test-charge',
      effect: 'effectful',
      dryRun: 'simulate',
      scopes: ['payments:write'],
      egress: { mode: 'static', hosts: ['pay.example.com'] },
      inputSchema: {
        type: 'object',
        required: ['amount', 'customer'],
        properties: { amount: { type: 'integer', minimum: 1 }, customer: { type: 'string' } },
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        required: ['chargeId'],
        properties: {
          chargeId: { type: 'string' },
          receipt: { type: 'object', properties: { url: { type: 'string' } } },
        },
        additionalProperties: false,
      },
      compensation: 'test-refund@^1',
      dataClassification: 'confidential',
      regions: ['eu'],
    },
    execute: async (_ctx, i: { amount: number }) => ({ chargeId: `ch_${i.amount}` }),
  }),
  defineCapability({
    declaration: {
      ...base,
      name: 'test-refund',
      effect: 'effectful',
      dryRun: 'simulate',
      scopes: ['payments:write'],
      egress: { mode: 'static', hosts: ['pay.example.com'] },
      inputSchema: {
        type: 'object',
        required: ['chargeId'],
        properties: { chargeId: { type: 'string' } },
        additionalProperties: false,
      },
      dataClassification: 'confidential',
    },
    execute: async () => ({ refunded: true }),
  }),
  defineCapability({
    declaration: {
      ...base,
      name: 'test-shell',
      family: 'shell',
      effect: 'effectful',
      dryRun: 'simulate',
      scopes: ['process:exec'],
      inputSchema: {
        type: 'object',
        required: ['argv'],
        properties: { argv: { type: 'array', items: { type: 'string' } } },
      },
    },
    execute: async () => ({}),
  }),
  defineCapability({
    declaration: {
      ...base,
      name: 'test-reader',
      effect: 'idempotent',
      scopes: ['db:read'],
      inputSchema: {
        type: 'object',
        properties: { query: { type: 'string' }, limit: { type: 'integer', minimum: 1, maximum: 10 } },
        additionalProperties: false,
      },
      outputSchema: {
        type: 'object',
        required: ['rows'],
        properties: { rows: { type: 'array', items: { type: 'object' } } },
        additionalProperties: false,
      },
    },
    execute: async () => ({ rows: [] }),
  }),
  defineCapability({
    declaration: {
      ...base,
      name: 'test-chat',
      effect: 'effectful',
      dryRun: 'simulate',
      scopes: ['chat:write'],
      egress: { mode: 'static', hosts: ['chat.example.com'] },
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, additionalProperties: false },
      dataClassification: 'internal',
    },
    execute: async () => ({}),
  }),
];

export function testRegistry(): CapabilityRegistry {
  const r = createDefaultRegistry();
  for (const a of testCapabilities()) r.register(a);
  return r;
}
