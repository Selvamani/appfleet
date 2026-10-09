import { PLATFORM_TEAM_ID, type Me } from '../api/types';

/**
 * What the console asks about. These are screen-level questions ("may this user see the fleet screen?"), and each one is
 * answered by one of the eight permissions identity-service really issues (see REAL below). The access token carries the
 * real ones, per team; roles are bundles of them, defined as data in identity-service, and are never checked by name here.
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

/** The permission identity-service issues that answers each console question. */
export const REAL: Record<Permission, string> = {
  'application:read': 'application:read',
  'application:create': 'application:create',
  'release:create': 'application:create',
  'deployment:read': 'deployment:read',
  'deployment:create': 'deployment:create',
  'deployment:rollback': 'deployment:rollback',
  'session:use': 'application:read',
  'fleet:read': 'node:drain',
  'node:drain': 'node:drain',
  'task:reclaim': 'node:drain',
  'dlq:replay': 'node:drain',
  'projection:rebuild': 'node:drain',
  'catalog:publish': 'catalog:publish',
  'user:manage': 'user:manage',
  // Answered by being a platform administrator, see isPlatformAdmin.
  'audit:read': 'user:manage',
};

/** A token may carry permissions that hold on every team under this key (identity-service does not issue it today). */
export const ALL_TEAMS = '*';

/** Holds user:manage in the platform team: may list users, create teams and roles, and read the login audit. */
export function isPlatformAdmin(me: Me | undefined): boolean {
  return !!me && (me.permissions[PLATFORM_TEAM_ID] ?? []).includes('user:manage');
}

/**
 * True when the token's team-scoped permissions allow `permission` on `teamId`,
 * or anywhere when teamId is omitted. UI gating is a convenience: the API enforces the same rule.
 */
export function can(me: Me | undefined, permission: Permission, teamId?: string): boolean {
  if (!me) return false;
  // The audit and the user list belong to the platform, not to a team: a team administrator does not get them.
  if (permission === 'audit:read') return isPlatformAdmin(me);
  const real = REAL[permission];
  const everywhere = me.permissions[ALL_TEAMS] ?? [];
  if (everywhere.includes(real)) return true;
  if (teamId) return (me.permissions[teamId] ?? []).includes(real);
  return Object.values(me.permissions).some(list => list.includes(real));
}

/** Team ids the caller may see at all, or 'all'. Mirrors data-level filtering on the server. */
export function visibleTeams(me: Me | undefined): string[] | 'all' {
  if (!me) return [];
  if (me.permissions[ALL_TEAMS]?.length) return 'all';
  return Object.keys(me.permissions);
}
