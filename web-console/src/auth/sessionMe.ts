import type { Me, Team } from '../api/types';
import { ALL_TEAMS } from './permissions';
import type { Session } from './session';

/**
 * The signed-in user as the console models it, read from the access token itself: the token's `teams` claim is
 * team id to permissions, and `perms` (when present) holds on every team. This is the same shape as the mock
 * identity's `Me.permissions`, so can() and visibleTeams() work on it unchanged.
 *
 * `grants` stays empty here: the token carries permissions, not role names, on purpose (enforcement never reads
 * roles). The Account screen reads the roles from GET /users/me.
 */
export function meFromSession(session: Session): Me {
  const permissions: Record<string, string[]> = { ...(session.claims.teams ?? {}) };
  if (session.claims.perms?.length) permissions[ALL_TEAMS] = session.claims.perms;
  return { id: session.claims.sub ?? '', username: session.email, displayName: session.email, grants: [], permissions };
}

/**
 * The teams the token mentions. Team NAMES are not in the token, and only a platform administrator may list the
 * teams (GET /teams), so a team is shown by the start of its id unless the console has read the names (useTeamNames).
 */
export function teamsFromSession(session: Session): Team[] {
  return Object.keys(session.claims.teams ?? {}).map(id => ({ id, name: `Team ${id.slice(0, 8)}` }));
}
