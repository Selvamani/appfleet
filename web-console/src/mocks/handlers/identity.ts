import { delay, http, passthrough, type HttpResponseResolver } from 'msw';
import type { ApiKeyView, MemberView, Profile, ServiceAccount, TeamView, UserSummary } from '../../api/types';
import { apiMode } from '../../api/http';
import { isPlatformAdmin } from '../../auth/permissions';
import { getSession } from '../../auth/session';
import { allows, currentMe, db, iso, ME_ID, permissionsOfRole, recordAudit, teamName, tick } from '../db';
import { correlationOf, forbidden, json, noContent, notFound, page, problem } from '../respond';

/**
 * identity-service. Mock mode answers the same shapes and the same rules as the live service (steps I2 to I8), so one
 * console serves both. The comments say which rule of the real service each check copies.
 */

function handler(resolver: HttpResponseResolver): HttpResponseResolver {
  return async info => {
    // Hybrid mode with a real sign-in: the live identity-service answers. Without one, the simulation keeps the screens usable.
    if (apiMode === 'hybrid' && getSession()) return passthrough();
    await delay();
    tick();
    return resolver(info);
  };
}

/** The password the simulated sign-in accepts as "current". The real service checks the hash of the user's own. */
export const MOCK_PASSWORD = 'correct horse battery';
const MAX_TEAMS = 10;
const COMMON_PASSWORDS = ['password123456', 'qwertyuiop12', 'iloveyou1234', 'administrator'];

const validation = (request: Request, field: string, message: string) =>
  problem(request, 400, 'validation-failed', 'Validation failed', 'The request body is not valid', { errors: [{ field, message }] });

const platformAdmin = () => isPlatformAdmin(currentMe());

function randomText(length: number): string {
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return [...bytes].map(b => 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-'[b % 64]).join('');
}

const user = (id: string) => db.users.find(u => u.id === id);
const memberView = (m: { userId: string; role: string }): MemberView => {
  const u = user(m.userId)!;
  return { userId: u.id, email: u.email, displayName: u.displayName, role: m.role };
};

export const identityHandlers = [
  // ---------- who am I ----------

  http.get('/api/v1/users/me', handler(({ request }) => {
    const me = currentMe();
    const u = user(ME_ID)!;
    // `permissions` and `teamName` are mock only: in the real service the permissions are in the access token.
    const body: Profile & { permissions: Record<string, string[]> } = {
      id: u.id, email: u.email, displayName: u.displayName, status: u.status, createdAt: u.createdAt,
      teams: me.grants.map(g => ({ teamId: g.teamId, role: g.role, teamName: g.teamName })) as Profile['teams'],
      permissions: me.permissions,
    };
    return json(request, body);
  })),

  http.put('/api/v1/users/me', handler(async ({ request }) => {
    const body = (await request.json()) as { displayName?: string };
    const name = (body.displayName ?? '').trim();
    if (!name || name.length > 100) return validation(request, 'displayName', 'must not be blank and at most 100 characters');
    const u = user(ME_ID)!;
    u.displayName = name;
    const me = currentMe();
    return json(request, { id: u.id, email: u.email, displayName: u.displayName, status: u.status, createdAt: u.createdAt,
      teams: me.grants.map(g => ({ teamId: g.teamId, role: g.role })) });
  })),

  http.post('/api/v1/users/me/password', handler(async ({ request }) => {
    const body = (await request.json()) as { currentPassword?: string; newPassword?: string };
    if (body.currentPassword !== MOCK_PASSWORD) return validation(request, 'currentPassword', 'is not correct');
    const next = body.newPassword ?? '';
    if (next.length < 12) return validation(request, 'newPassword', 'size must be between 12 and 72');
    if (COMMON_PASSWORDS.includes(next.toLowerCase())) return validation(request, 'newPassword', 'is on the list of common passwords');
    if (next === body.currentPassword) return validation(request, 'newPassword', 'must differ from the current password');
    recordAudit({ actor: currentMe().username, action: 'PASSWORD_CHANGED', object: currentMe().username, outcome: 'SUCCESS', correlationId: correlationOf(request) });
    return noContent(request);
  })),

  // ---------- teams and members ----------

  http.get('/api/v1/teams', handler(({ request }) => {
    if (!platformAdmin()) return forbidden(request, 'Listing teams needs a platform administrator.');
    return json(request, [...db.teams].sort((a, b) => a.name.localeCompare(b.name)));
  })),

  http.post('/api/v1/teams', handler(async ({ request }) => {
    if (!platformAdmin()) return forbidden(request, 'Creating teams needs a platform administrator.');
    const name = (((await request.json()) as { name?: string }).name ?? '').trim();
    if (name.length < 2 || name.length > 100) return validation(request, 'name', 'size must be between 2 and 100');
    if (db.teams.some(t => t.name === name)) return problem(request, 409, 'conflict', 'Conflict', 'a team with that name exists');
    const team: TeamView = { id: crypto.randomUUID(), name, createdAt: iso(db.now()) };
    db.teams.push(team);
    recordAudit({ actor: currentMe().username, action: 'TEAM_CREATED', object: name, outcome: 'SUCCESS', correlationId: correlationOf(request) });
    return json(request, team, { status: 201 });
  })),

  http.get('/api/v1/teams/:teamId/members', handler(({ request, params }) => {
    currentMe();
    const teamId = String(params.teamId);
    if (!allows('user:manage', teamId) && !platformAdmin()) return forbidden(request, 'Managing members needs ADMIN of the team.');
    if (!db.teams.some(t => t.id === teamId)) return notFound(request, 'team');
    return json(request, db.members.filter(m => m.teamId === teamId).map(memberView).sort((a, b) => a.email.localeCompare(b.email)));
  })),

  http.post('/api/v1/teams/:teamId/members', handler(async ({ request, params }) => {
    currentMe();
    const teamId = String(params.teamId);
    if (!allows('user:manage', teamId) && !platformAdmin()) return forbidden(request, 'Managing members needs ADMIN of the team.');
    if (!db.teams.some(t => t.id === teamId)) return notFound(request, 'team');
    const body = (await request.json()) as { userId?: string; role?: string };
    const u = body.userId ? user(body.userId) : undefined;
    if (!u) return notFound(request, 'user');
    if (u.status !== 'ACTIVE') return problem(request, 409, 'conflict', 'Conflict', 'the user is deactivated');
    if (!body.role || !db.roles.some(r => r.name === body.role)) return validation(request, 'role', 'unknown role');
    if (db.members.some(m => m.teamId === teamId && m.userId === u.id)) return problem(request, 409, 'conflict', 'Conflict', 'the user is already a member of the team');
    if (db.members.filter(m => m.userId === u.id).length >= MAX_TEAMS) {
      return problem(request, 422, 'team-limit', 'Unprocessable', `a user can be a member of at most ${MAX_TEAMS} teams (one token carries that many grants)`);
    }
    const member = { teamId, userId: u.id, role: body.role };
    db.members.push(member);
    recordAudit({ actor: currentMe().username, action: 'GRANT_ADDED', object: `${u.email}, ${member.role} on ${teamName(teamId)}`, outcome: 'SUCCESS', correlationId: correlationOf(request) });
    return json(request, memberView(member), { status: 201 });
  })),

  http.put('/api/v1/teams/:teamId/members/:userId', handler(async ({ request, params }) => {
    currentMe();
    const teamId = String(params.teamId);
    if (!allows('user:manage', teamId) && !platformAdmin()) return forbidden(request, 'Managing members needs ADMIN of the team.');
    const member = db.members.find(m => m.teamId === teamId && m.userId === params.userId);
    if (!member) return notFound(request, 'membership');
    const role = ((await request.json()) as { role?: string }).role;
    if (!role || !db.roles.some(r => r.name === role)) return validation(request, 'role', 'unknown role');
    if (member.role === 'ADMIN' && role !== 'ADMIN' && db.members.filter(m => m.teamId === teamId && m.role === 'ADMIN').length <= 1) {
      return problem(request, 409, 'conflict', 'Conflict', 'a team must keep at least one ADMIN');
    }
    member.role = role;   // the member's sessions end in the real service
    recordAudit({ actor: currentMe().username, action: 'GRANT_CHANGED', object: `${user(member.userId)!.email}, ${role} on ${teamName(teamId)}`, outcome: 'SUCCESS', correlationId: correlationOf(request) });
    return json(request, memberView(member));
  })),

  http.delete('/api/v1/teams/:teamId/members/:userId', handler(({ request, params }) => {
    currentMe();
    const teamId = String(params.teamId);
    if (!allows('user:manage', teamId) && !platformAdmin()) return forbidden(request, 'Managing members needs ADMIN of the team.');
    const idx = db.members.findIndex(m => m.teamId === teamId && m.userId === params.userId);
    if (idx < 0) return notFound(request, 'membership');
    const member = db.members[idx]!;
    if (member.role === 'ADMIN' && db.members.filter(m => m.teamId === teamId && m.role === 'ADMIN').length <= 1) {
      return problem(request, 409, 'conflict', 'Conflict', 'a team must keep at least one ADMIN');
    }
    db.members.splice(idx, 1);
    recordAudit({ actor: currentMe().username, action: 'GRANT_REVOKED', object: `${user(member.userId)!.email}, ${member.role} on ${teamName(teamId)}`, outcome: 'SUCCESS', correlationId: correlationOf(request) });
    return noContent(request);
  })),

  // ---------- users and roles (platform administrators) ----------

  http.get('/api/v1/users', handler(({ request }) => {
    currentMe();
    if (!platformAdmin()) return forbidden(request, 'Listing users needs a platform administrator.');
    const url = new URL(request.url);
    const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 200));
    return json(request, page(db.users, u => u.id, url.searchParams.get('cursor'), limit));
  })),

  http.get('/api/v1/users/:id', handler(({ request, params }) => {
    currentMe();
    if (!platformAdmin()) return forbidden(request, 'Reading users needs a platform administrator.');
    const u = user(String(params.id));
    return u ? json(request, u) : notFound(request, 'user');
  })),

  http.post('/api/v1/users/:id/deactivate', handler(({ request, params }) => {
    currentMe();
    if (!platformAdmin()) return forbidden(request, 'Deactivating users needs a platform administrator.');
    if (params.id === ME_ID) return problem(request, 409, 'conflict', 'Conflict', 'you cannot deactivate your own account');
    const u = user(String(params.id));
    if (!u) return notFound(request, 'user');
    if (u.status === 'ACTIVE') {
      u.status = 'DEACTIVATED';
      u.deactivatedAt = iso(db.now());
      recordAudit({ actor: currentMe().username, action: 'USER_DEACTIVATED', object: u.email, outcome: 'SUCCESS', correlationId: correlationOf(request) });
    }
    return json(request, u satisfies UserSummary);
  })),

  http.get('/api/v1/roles', handler(({ request }) => {
    currentMe();
    if (!platformAdmin()) return forbidden(request, 'Listing roles needs a platform administrator.');
    return json(request, [...db.roles].sort((a, b) => a.name.localeCompare(b.name)));
  })),

  http.post('/api/v1/roles', handler(async ({ request }) => {
    currentMe();
    if (!platformAdmin()) return forbidden(request, 'Creating roles needs a platform administrator.');
    const body = (await request.json()) as { name?: string; description?: string; permissions?: string[] };
    if (!/^[A-Z][A-Z0-9_]{1,31}$/.test(body.name ?? '')) return validation(request, 'name', 'must be upper case letters, digits and underscores, 2 to 32 characters');
    if (!body.permissions?.length) return validation(request, 'permissions', 'must not be empty');
    if (db.roles.some(r => r.name === body.name)) return problem(request, 409, 'conflict', 'Conflict', 'a role with that name exists');
    const known = new Set(db.roles.flatMap(r => r.permissions));
    const unknown = body.permissions.find(p => !known.has(p));
    if (unknown) return validation(request, 'permissions', `unknown permission: ${unknown}`);
    const role = { name: body.name!, description: (body.description ?? '').trim(), permissions: [...new Set(body.permissions)].sort() };
    db.roles.push(role);
    recordAudit({ actor: currentMe().username, action: 'ROLE_CREATED', object: role.name, outcome: 'SUCCESS', correlationId: correlationOf(request) });
    return json(request, role, { status: 201 });
  })),

  // ---------- service accounts ----------

  http.get('/api/v1/teams/:teamId/service-accounts', handler(({ request, params }) => {
    currentMe();
    const teamId = String(params.teamId);
    if (!allows('user:manage', teamId) && !platformAdmin()) return forbidden(request, 'Service accounts need ADMIN of the team.');
    if (!db.teams.some(t => t.id === teamId)) return notFound(request, 'team');
    return json(request, db.serviceAccounts.filter(a => a.teamId === teamId).sort((a, b) => a.name.localeCompare(b.name)));
  })),

  http.post('/api/v1/teams/:teamId/service-accounts', handler(async ({ request, params }) => {
    currentMe();
    const teamId = String(params.teamId);
    if (!allows('user:manage', teamId) && !platformAdmin()) return forbidden(request, 'Service accounts need ADMIN of the team.');
    if (!db.teams.some(t => t.id === teamId)) return notFound(request, 'team');
    const body = (await request.json()) as { name?: string; role?: string };
    if (!/^[a-z0-9][a-z0-9-]{1,62}$/.test(body.name ?? '')) return validation(request, 'name', 'must be lower case letters, digits and hyphens, 2 to 63 characters');
    const role = db.roles.find(r => r.name === body.role);
    if (!role) return validation(request, 'role', 'unknown role');
    if (permissionsOfRole(role.name).includes('user:manage')) return validation(request, 'role', 'a service account cannot hold a role that manages users');
    if (db.serviceAccounts.some(a => a.teamId === teamId && a.name === body.name)) {
      return problem(request, 409, 'conflict', 'Conflict', 'a service account with that name exists in the team');
    }
    const prefix = randomText(11);
    const issued = { keyId: crypto.randomUUID(), prefix, apiKey: `afk_${prefix}.${randomText(43)}` };
    const key: ApiKeyView = { id: issued.keyId, prefix, status: 'ACTIVE', createdAt: iso(db.now()), revokedAt: null, lastUsedAt: null };
    const account: ServiceAccount = { id: crypto.randomUUID(), teamId, name: body.name!, role: role.name, status: 'ACTIVE', createdAt: iso(db.now()), disabledAt: null, keys: [key] };
    db.serviceAccounts.push(account);
    recordAudit({ actor: currentMe().username, action: 'SERVICE_ACCOUNT_CREATED', object: `${account.name} in ${teamName(teamId)}`, outcome: 'SUCCESS', correlationId: correlationOf(request) });
    return json(request, { account, key: issued }, { status: 201 });
  })),

  http.post('/api/v1/teams/:teamId/service-accounts/:id/keys', handler(({ request, params }) => {
    currentMe();
    const teamId = String(params.teamId);
    if (!allows('user:manage', teamId) && !platformAdmin()) return forbidden(request, 'Service accounts need ADMIN of the team.');
    const account = db.serviceAccounts.find(a => a.id === params.id && a.teamId === teamId);
    if (!account) return notFound(request, 'service account');
    if (account.status !== 'ACTIVE') return problem(request, 409, 'conflict', 'Conflict', 'the service account is disabled');
    if (account.keys.filter(k => k.status === 'ACTIVE').length >= 2) {
      return problem(request, 409, 'conflict', 'Conflict', 'the service account already has 2 active keys; revoke one first');
    }
    const prefix = randomText(11);
    const key: ApiKeyView = { id: crypto.randomUUID(), prefix, status: 'ACTIVE', createdAt: iso(db.now()), revokedAt: null, lastUsedAt: null };
    account.keys.push(key);
    recordAudit({ actor: currentMe().username, action: 'KEY_ADDED', object: `service account ${account.name}`, outcome: 'SUCCESS', correlationId: correlationOf(request) });
    return json(request, { keyId: key.id, prefix, apiKey: `afk_${prefix}.${randomText(43)}` }, { status: 201 });
  })),

  http.delete('/api/v1/teams/:teamId/service-accounts/:id/keys/:keyId', handler(({ request, params }) => {
    currentMe();
    const teamId = String(params.teamId);
    if (!allows('user:manage', teamId) && !platformAdmin()) return forbidden(request, 'Service accounts need ADMIN of the team.');
    const account = db.serviceAccounts.find(a => a.id === params.id && a.teamId === teamId);
    const key = account?.keys.find(k => k.id === params.keyId);
    if (!account || !key) return notFound(request, account ? 'key' : 'service account');
    if (key.status === 'ACTIVE') {
      key.status = 'REVOKED';
      key.revokedAt = iso(db.now());
      recordAudit({ actor: currentMe().username, action: 'KEY_REVOKED', object: `service account ${account.name}`, outcome: 'SUCCESS', correlationId: correlationOf(request) });
    }
    return noContent(request);
  })),

  http.post('/api/v1/teams/:teamId/service-accounts/:id/disable', handler(({ request, params }) => {
    currentMe();
    const teamId = String(params.teamId);
    if (!allows('user:manage', teamId) && !platformAdmin()) return forbidden(request, 'Service accounts need ADMIN of the team.');
    const account = db.serviceAccounts.find(a => a.id === params.id && a.teamId === teamId);
    if (!account) return notFound(request, 'service account');
    if (account.status === 'ACTIVE') {
      account.status = 'DISABLED';
      account.disabledAt = iso(db.now());
      recordAudit({ actor: currentMe().username, action: 'SERVICE_ACCOUNT_DISABLED', object: account.name, outcome: 'SUCCESS', correlationId: correlationOf(request) });
    }
    return json(request, account);
  })),

  // ---------- the login audit (platform administrators) ----------

  http.get('/api/v1/audit/logins', handler(({ request }) => {
    currentMe();
    if (!platformAdmin()) return forbidden(request, 'The sign-in history needs a platform administrator.');
    const url = new URL(request.url);
    const limit = Math.max(1, Math.min(Number(url.searchParams.get('limit') ?? 50) || 50, 200));
    return json(request, page(db.logins, l => l.id, url.searchParams.get('cursor'), limit));
  })),
];
