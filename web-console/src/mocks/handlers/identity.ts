import { delay, http, type HttpResponseResolver } from 'msw';
import type { Grant, Role, RotatedKey } from '../../api/types';
import { allows, currentMe, db, iso, ME_ID, recordAudit, teamName, tick } from '../db';
import { correlationOf, forbidden, json, notFound, page, problem } from '../respond';

/** identity-service (planned S4). Mocked in both modes; there is no live identity-service yet. */

function handler(resolver: HttpResponseResolver): HttpResponseResolver {
  return async info => {
    await delay();
    tick();
    return resolver(info);
  };
}

const ROLES: Role[] = ['VIEWER', 'DEPLOYER', 'OPERATOR', 'ADMIN', 'AUDITOR'];
/** Path segment for a grant on every team, since a path cannot carry null. */
const ALL = 'all';

function userView(id: string) {
  if (id === ME_ID) currentMe(); // refresh the dev user's grants from the role switch
  return db.users.find(u => u.id === id);
}

export const identityHandlers = [
  http.get('/api/v1/users/me', handler(({ request }) => json(request, currentMe()))),

  http.get('/api/v1/teams', handler(({ request }) => json(request, db.teams))),

  http.get('/api/v1/users', handler(({ request }) => {
    if (!allows('user:manage')) return forbidden(request, 'Managing users needs ADMIN.');
    currentMe();
    const url = new URL(request.url);
    const q = url.searchParams.get('q')?.trim().toLowerCase() ?? '';
    const users = db.users.filter(u => !q || u.username.toLowerCase().includes(q));
    return json(request, page(users, u => u.id, url.searchParams.get('cursor'), 50));
  })),

  http.get('/api/v1/users/:id', handler(({ request, params }) => {
    if (!allows('user:manage') && params.id !== ME_ID) return forbidden(request, 'Managing users needs ADMIN.');
    const user = userView(String(params.id));
    return user ? json(request, user) : notFound(request, `User ${String(params.id)}`);
  })),

  http.post('/api/v1/teams/:teamId/members', handler(async ({ request, params }) => {
    if (!allows('user:manage')) return forbidden(request, 'Granting roles needs ADMIN.');
    const body = (await request.json()) as { userId?: string; role?: Role };
    const teamId = params.teamId === ALL ? null : String(params.teamId);
    if (teamId && !db.teams.some(t => t.id === teamId)) return notFound(request, `Team ${teamId}`);
    if (!body.role || !ROLES.includes(body.role)) {
      return problem(request, 400, 'validation-failed', 'Validation failed', 'One or more fields are invalid.', { errors: [{ field: 'role', message: `must be one of ${ROLES.join(', ')}` }] });
    }
    const user = userView(body.userId ?? '');
    if (!user) return problem(request, 422, 'unprocessable', 'Unprocessable request', `User ${body.userId} does not exist.`);
    if (user.status === 'DEACTIVATED') return problem(request, 409, 'conflict', 'Conflict', `${user.username} is deactivated.`);
    if (user.grants.some(g => g.teamId === teamId && g.role === body.role)) {
      return problem(request, 409, 'conflict', 'Conflict', `${user.username} already has ${body.role} on ${teamId ? teamName(teamId) : 'all teams'}.`);
    }
    const grant: Grant = { teamId, teamName: teamId ? teamName(teamId) : 'All teams', role: body.role, grantedBy: currentMe().username, grantedAt: iso(db.now()) };
    user.grants.push(grant);
    recordAudit({ actor: currentMe().username, action: 'GRANT_ADDED', object: `${user.username}, ${grant.role} on ${grant.teamName}`, outcome: 'SUCCESS', correlationId: correlationOf(request) });
    return json(request, user, { status: 201 });
  })),

  http.delete('/api/v1/teams/:teamId/members/:userId', handler(({ request, params }) => {
    if (!allows('user:manage')) return forbidden(request, 'Revoking roles needs ADMIN.');
    const role = new URL(request.url).searchParams.get('role');
    const teamId = params.teamId === ALL ? null : String(params.teamId);
    const user = userView(String(params.userId));
    if (!user) return notFound(request, `User ${String(params.userId)}`);
    const idx = user.grants.findIndex(g => g.teamId === teamId && g.role === role);
    if (idx < 0) return notFound(request, `Grant ${role} on ${teamId ?? 'all teams'}`);
    const [removed] = user.grants.splice(idx, 1);
    recordAudit({ actor: currentMe().username, action: 'GRANT_REVOKED', object: `${user.username}, ${removed!.role} on ${removed!.teamName}`, outcome: 'SUCCESS', correlationId: correlationOf(request) });
    return json(request, user);
  })),

  http.post('/api/v1/users/:id/deactivate', handler(({ request, params }) => {
    if (!allows('user:manage')) return forbidden(request, 'Deactivating users needs ADMIN.');
    if (params.id === ME_ID) return problem(request, 409, 'conflict', 'Conflict', 'You cannot deactivate your own account.');
    const user = userView(String(params.id));
    if (!user) return notFound(request, `User ${String(params.id)}`);
    if (user.status === 'DEACTIVATED') return problem(request, 409, 'conflict', 'Conflict', `${user.username} is already deactivated.`);
    user.status = 'DEACTIVATED';
    user.securityNote = `Deactivated just now by ${currentMe().username}; live tokens denylisted`;
    recordAudit({ actor: currentMe().username, action: 'USER_DEACTIVATED', object: user.username, outcome: 'SUCCESS', correlationId: correlationOf(request) });
    return json(request, user);
  })),

  http.get('/api/v1/service-accounts', handler(({ request }) => {
    if (!allows('user:manage')) return forbidden(request, 'Service accounts need ADMIN.');
    return json(request, db.serviceAccounts);
  })),

  http.post('/api/v1/service-accounts/:id/rotate', handler(({ request, params }) => {
    if (!allows('user:manage')) return forbidden(request, 'Rotating keys needs ADMIN.');
    const sa = db.serviceAccounts.find(s => s.id === params.id);
    if (!sa) return notFound(request, `Service account ${String(params.id)}`);
    const secret = `ak_live_${crypto.randomUUID().replace(/-/g, '')}`;
    sa.keyHint = `ak_…${secret.slice(-4)}`;
    sa.rotatedAt = iso(db.now());
    recordAudit({ actor: currentMe().username, action: 'KEY_ROTATED', object: `service account ${sa.name}`, outcome: 'SUCCESS', correlationId: correlationOf(request) });
    const body: RotatedKey = { key: secret, keyHint: sa.keyHint, oldKeyValidUntil: iso(db.now() + 10 * 60_000) };
    return json(request, body);
  })),

  http.get('/api/v1/audit/logins', handler(({ request }) => {
    if (!allows('audit:read') && !allows('user:manage')) return forbidden(request, 'Sign-in history needs audit:read.');
    const url = new URL(request.url);
    return json(request, page(db.logins, l => l.id, url.searchParams.get('cursor'), 25));
  })),
];
