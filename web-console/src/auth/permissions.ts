import type { Me } from '../api/types';

/**
 * Permission atoms. The identity spec names deployment:create, deployment:rollback, node:drain,
 * catalog:publish and user:manage; the others are proposals the UI needs to gate its screens.
 * Roles are bundles of these, defined as data in identity-service, never checked by name here.
 */
export type Permission =
  | 'application:read'
  | 'application:create'
  | 'release:create'
  | 'deployment:read'
  | 'deployment:create'
  | 'deployment:rollback'
  | 'session:use'
  | 'fleet:read'
  | 'node:drain'
  | 'task:reclaim'
  | 'dlq:replay'
  | 'projection:rebuild'
  | 'catalog:publish'
  | 'user:manage'
  | 'audit:read';

export const ALL_TEAMS = '*';

/**
 * True when the token's team-scoped permissions allow `permission` on `teamId`,
 * or anywhere when teamId is omitted. UI gating is a convenience: the API enforces the same rule.
 */
export function can(me: Me | undefined, permission: Permission, teamId?: string): boolean {
  if (!me) return false;
  const everywhere = me.permissions[ALL_TEAMS] ?? [];
  if (everywhere.includes(permission)) return true;
  if (teamId) return (me.permissions[teamId] ?? []).includes(permission);
  return Object.values(me.permissions).some(list => list.includes(permission));
}

/** Team ids the caller may see at all, or 'all'. Mirrors data-level filtering on the server. */
export function visibleTeams(me: Me | undefined): string[] | 'all' {
  if (!me) return [];
  if (me.permissions[ALL_TEAMS]?.length) return 'all';
  return Object.keys(me.permissions);
}
