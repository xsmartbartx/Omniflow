import type { NexoraPlan } from '../state/index.ts';

/**
 * Monthly run quotas per plan, used ONLY by the fake Core. Numbers are placeholders mirroring the shape of
 * NEXORA's other products; real quotas and prices are an owner decision (see /replica-launch) and live in
 * NEXORA Billing, not here.
 */
export const PLACEHOLDER_RUN_LIMITS: Record<NexoraPlan, number> = {
  free: 100,
  starter: 1500,
  pro: 12000,
  business: 60000,
  scale: 300000,
};
