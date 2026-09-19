import { type AdapterConfig, defaultAdapterConfig } from './adapters/config.ts';
import { createDatabaseCapabilities, type PgFactory } from './adapters/database/index.ts';
import { createHttpCapabilities } from './adapters/http/index.ts';
import { createLlmCapabilities } from './adapters/llm/index.ts';
import { createChannelNotifier, createEmailNotifier, createWebhookNotifier } from './adapters/notify/index.ts';
import { createShellCapabilities } from './adapters/shell/index.ts';
import { createStorageCapabilities } from './adapters/storage/index.ts';
import { createUtilCapabilities } from './adapters/util/index.ts';
import { type CapabilityAdapter } from './contract/types.ts';
import { CapabilityRegistry } from './contract/registry.ts';

export { type AdapterConfig, defaultAdapterConfig } from './adapters/config.ts';
export { createDatabaseCapabilities, type DbDriver, type PgFactory, type PgLike } from './adapters/database/index.ts';
export { createLlmCapabilities } from './adapters/llm/index.ts';
export { createChannelNotifier, createEmailNotifier, createWebhookNotifier, parseChannel, sendToChannel } from './adapters/notify/index.ts';
export { createShellCapabilities } from './adapters/shell/index.ts';
export { createStorageCapabilities } from './adapters/storage/index.ts';
export { classifyAddress, isAddressAllowed, matchesEgress } from './adapters/http/egress.ts';
export { createHttpCapabilities } from './adapters/http/index.ts';
export { safeRequest } from './adapters/http/safe-http.ts';
export { createUtilCapabilities } from './adapters/util/index.ts';
export * from './contract/index.ts';

/**
 * Registry populated with every built-in capability the operator has enabled. Capabilities that
 * reach beyond the engine (shell, databases, email, LLM, named chat channels) exist only when they
 * are configured — an unconfigured integration is absent from the catalogue rather than present
 * and failing at run time.
 */
export function createDefaultRegistry(
  config: AdapterConfig = defaultAdapterConfig(),
  opts: { pgFactory?: PgFactory } = {},
): CapabilityRegistry {
  const registry = new CapabilityRegistry();
  const all: CapabilityAdapter[] = [
    ...createUtilCapabilities(),
    ...createHttpCapabilities(config),
    ...createStorageCapabilities(config),
    ...createWebhookNotifier(config),
    ...(config.shell.allowedCommands.length > 0 ? createShellCapabilities(config) : []),
    ...(Object.keys(config.datasources).length > 0 ? createDatabaseCapabilities(config, opts) : []),
    ...(Object.keys(config.channels).length > 0 ? createChannelNotifier(config) : []),
    ...createEmailNotifier(config),
    ...createLlmCapabilities(config),
  ];
  for (const adapter of all) registry.register(adapter);
  return registry;
}
