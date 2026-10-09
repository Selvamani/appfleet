import { describe, expect, it } from 'vitest';
import { can, visibleTeams } from './permissions';
import type { Session } from './session';
import { meFromSession, teamsFromSession } from './sessionMe';

const TEAM_A = '00000000-0000-0000-0000-0000000000a1';
const TEAM_B = '00000000-0000-0000-0000-0000000000b2';

function session(claims: Session['claims']): Session {
  return { tokens: { accessToken: 'a.b.c', refreshToken: 'r', tokenType: 'Bearer', expiresIn: 900 }, email: 'ada@example.io', claims };
}

describe('meFromSession', () => {
  it('reads the permissions per team from the token, and the user from the session', () => {
    const me = meFromSession(session({ sub: 'u1', teams: { [TEAM_A]: ['deployment:create', 'deployment:read'], [TEAM_B]: ['application:read'] } }));
    expect(me.id).toBe('u1');
    expect(me.username).toBe('ada@example.io');
    expect(me.permissions).toEqual({ [TEAM_A]: ['deployment:create', 'deployment:read'], [TEAM_B]: ['application:read'] });
    expect(me.grants).toEqual([]);
  });

  it('works with can() and visibleTeams() unchanged: allowed on the team it was granted for, refused on another', () => {
    const me = meFromSession(session({ sub: 'u1', teams: { [TEAM_A]: ['deployment:create'] } }));
    expect(can(me, 'deployment:create', TEAM_A)).toBe(true);
    expect(can(me, 'deployment:create', TEAM_B)).toBe(false);
    expect(can(me, 'deployment:create')).toBe(true);
    expect(visibleTeams(me)).toEqual([TEAM_A]);
  });

  it('puts global permissions under "every team"', () => {
    const me = meFromSession(session({ sub: 'u1', perms: ['user:manage'] }));
    expect(can(me, 'user:manage', TEAM_B)).toBe(true);
    expect(visibleTeams(me)).toBe('all');
  });

  it('has no permission at all when the token has no grants', () => {
    const me = meFromSession(session({ sub: 'u1' }));
    expect(me.permissions).toEqual({});
    expect(can(me, 'application:read')).toBe(false);
    expect(visibleTeams(me)).toEqual([]);
  });
});

describe('teamsFromSession', () => {
  it('lists the teams of the token, named by the start of their id', () => {
    expect(teamsFromSession(session({ teams: { [TEAM_A]: ['x:y'] } }))).toEqual([{ id: TEAM_A, name: 'Team 00000000' }]);
    expect(teamsFromSession(session({}))).toEqual([]);
  });
});