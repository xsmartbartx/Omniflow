import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ManualClock } from '../../core/index.ts';
import type { Principal } from '../../schemas/index.ts';
import { openState, type State } from '../../state/index.ts';

export interface TestState extends State {
  clock: ManualClock;
  dir: string;
}

/** Fresh in-memory state plane with a manual clock and a temporary artifact directory. */
export function makeState(): TestState {
  const clock = new ManualClock('2026-06-01T12:00:00.000Z');
  const dir = mkdtempSync(join(tmpdir(), 'omniflow-test-'));
  const state = openState({ dbPath: ':memory:', artifactDir: join(dir, 'artifacts'), clock });
  state.identity.ensureTenant('default', 'Default');
  return Object.assign(state, { clock, dir }) as TestState;
}

export const principal = (over: Partial<Principal> = {}): Principal => ({
  id: 'usr_test',
  type: 'user',
  name: 'Test User',
  tenant: 'default',
  roles: ['admin'],
  ...over,
});
