import type { Role } from '../schemas/index.ts';
import type { NexoraRole } from '../state/index.ts';

/**
 * NEXORA roles -> Constans roles (architecture D6). NEXORA has no "approver"; owners and admins get it, so
 * four-eyes approval needs two of them. Billing and viewer only read.
 */
export function constansRoles(role: NexoraRole): Role[] {
  switch (role) {
    case 'owner':
    case 'admin':
      return ['admin', 'approver'];
    case 'member':
      return ['author', 'operator'];
    default:
      return ['viewer'];
  }
}
