/**
 * A custom OmniFlow distribution: the stock platform plus one capability of your own.
 *
 * A capability is the ONLY way a workflow touches the outside world, so adding one means declaring — up
 * front, in data — what it does, what it needs and how it fails. The compiler, policy engine, pentest
 * review and dry-run all work from that declaration; the adapter below is just the implementation.
 *
 *   node --disable-warning=ExperimentalWarning examples/custom-capability/server.ts
 */
import { CapabilityError, type CapabilityRegistry, createDefaultRegistry, defineCapability } from '../../capabilities/index.ts';
import { buildServer } from '../../gateway/server.ts';
import { loadConfig } from '../../server/config.ts';
import { createOmniflow } from '../../server/platform.ts';

interface Input {
  customerId: string;
}
interface Output {
  name: string;
  tier: 'free' | 'pro';
}

// Stand-in for your CRM client. In real life: an HTTP/SQL call, using ctx.signal and ctx.lease.
const CUSTOMERS: Record<string, Output> = { c_1: { name: 'Acme Ltd', tier: 'pro' }, c_2: { name: 'Globex', tier: 'free' } };

export const lookupCustomer = defineCapability<Input, Output>({
  declaration: {
    name: 'acme-lookup-customer',
    version: '1.0.0',
    family: 'acme',
    description: 'Look up a customer in the Acme CRM. Read-only.',
    inputSchema: { type: 'object', required: ['customerId'], additionalProperties: false, properties: { customerId: { type: 'string', pattern: '^c_[0-9]+$' } } },
    outputSchema: {
      type: 'object',
      required: ['name', 'tier'],
      additionalProperties: false,
      properties: { name: { type: 'string' }, tier: { enum: ['free', 'pro'] } },
    },
    // pure = deterministic and side-effect free · idempotent = safe to repeat (reads, upserts) · effectful = changes the world
    effect: 'idempotent',
    scopes: ['crm:read'],
    egress: { mode: 'none' }, // a real one would declare its hosts: { mode: 'static', hosts: ['crm.acme.example:443'] }
    costModel: { unitsPerInvocation: 1, latencyClass: 'fast' },
    // Every way it can fail, classified — this is how the engine decides between retry, route, compensate and stop.
    failureModes: [{ code: 'CUSTOMER_NOT_FOUND', class: 'business', retryable: false, description: 'No customer has that id' }],
    dataClassification: 'confidential',
    dryRun: 'execute', // reads are safe to run for real in a dry run
  },
  async execute(ctx, input) {
    ctx.log('looking up customer', { customerId: input.customerId });
    const found = CUSTOMERS[input.customerId];
    if (!found) throw new CapabilityError('CUSTOMER_NOT_FOUND', `No customer ${input.customerId}`, { errorClass: 'business', retryable: false });
    return found;
  },
});

/** The stock capabilities plus yours. A named owner is required: someone is accountable for every capability. */
export function createRegistry(config: ReturnType<typeof loadConfig>): CapabilityRegistry {
  const registry = createDefaultRegistry(config.adapters);
  registry.register(lookupCustomer, { owner: 'crm-platform-team', source: 'plugin' });
  return registry;
}

if (import.meta.main) {
  const config = loadConfig();
  const app = createOmniflow(config, { capabilities: createRegistry(config) });
  await app.start();
  const { server } = await buildServer(app);
  await server.listen({ host: config.host, port: config.port });
  app.log.info('custom OmniFlow listening', { url: config.publicUrl });
}
