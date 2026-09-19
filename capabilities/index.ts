import { type AdapterConfig, defaultAdapterConfig } from './adapters/config.ts';
import { createHttpCapabilities } from './adapters/http/index.ts';
import { createUtilCapabilities } from './adapters/util/index.ts';
import { CapabilityRegistry } from './contract/registry.ts';

export { type AdapterConfig, defaultAdapterConfig } from './adapters/config.ts';
export { classifyAddress, isAddressAllowed, matchesEgress } from './adapters/http/egress.ts';
export { createHttpCapabilities } from './adapters/http/index.ts';
export { safeRequest } from './adapters/http/safe-http.ts';
export { createUtilCapabilities } from './adapters/util/index.ts';
export * from './contract/index.ts';

/** Registry populated with every built-in capability enabled by the configuration. */
export function createDefaultRegistry(config: AdapterConfig = defaultAdapterConfig()): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  for (const adapter of createUtilCapabilities()) registry.register(adapter);
  for (const adapter of createHttpCapabilities(config)) registry.register(adapter);
  return registry;
}
