import { getSession } from '../auth/session';
import { meFromSession, teamsFromSession } from '../auth/sessionMe';
import { request } from './http';
import type {
  CreatedServiceAccount, CursorPage, IssuedKey, LoginAuditRow, MemberView, Me, Profile, Role, RoleView, ServiceAccount,
  Team, TeamView, UserSummary,
} from './types';

/** identity-service (port 8082). Every endpoint here is built (steps I2 to I8); mock mode answers the same shapes. */

// ---------- who am I ----------

/** GET /users/me: the profile and the roles held, never the permissions (those are in the token). */
export const getProfile = () => request<Profile>('/api/v1/users/me');

export const updateProfile = (displayName: string) =>
  request<Profile>('/api/v1/users/me', { method: 'PUT', body: { displayName } });

/** 204. Every session of the user ends, this one included: the caller signs in again. A wrong current password is 400. */
export const changePassword = (currentPassword: string, newPassword: string) =>
  request<void>('/api/v1/users/me/password', { method: 'POST', body: { currentPassword, newPassword } });

/**
 * With a real session the permissions are read from the access token; in mock mode the simulated identity also sends
 * them (`permissions`, mock only) because there is no token to read.
 */
export const getMe = async (): Promise<Me> => {
  const session = getSession();
  if (session) return meFromSession(session);
  const profile = await request<Profile & { permissions?: Record<string, string[]> }>('/api/v1/users/me');
  return {
    id: profile.id,
    username: profile.email,
    displayName: profile.displayName,
    grants: profile.teams.map(t => ({ teamId: t.teamId, teamName: (t as { teamName?: string }).teamName ?? `Team ${t.teamId.slice(0, 8)}`, role: t.role })),
    permissions: profile.permissions ?? {},
  };
};

// ---------- teams ----------

/**
 * The teams the console can name. A platform administrator lists them all (GET /teams). Anyone else only has the ids in
 * their token, shown shortened: identity-service has no endpoint that names a caller's own teams yet.
 */
export const listTeams = async (platformAdmin: boolean): Promise<Team[]> => {
  if (platformAdmin) return (await request<TeamView[]>('/api/v1/teams')).map(t => ({ id: t.id, name: t.name }));
  const session = getSession();
  return session ? teamsFromSession(session) : [];
};

export const createTeam = (name: string) => request<TeamView>('/api/v1/teams', { method: 'POST', body: { name } });

export const listMembers = (teamId: string) => request<MemberView[]>(`/api/v1/teams/${teamId}/members`);

/** 201. The user must be active and in fewer than 10 teams (422 team-limit). */
export const addMember = (teamId: string, userId: string, role: Role) =>
  request<MemberView>(`/api/v1/teams/${teamId}/members`, { method: 'POST', body: { userId, role } });

/** The member's sessions end: their tokens still say the old role. A team always keeps one ADMIN (409). */
export const changeMemberRole = (teamId: string, userId: string, role: Role) =>
  request<MemberView>(`/api/v1/teams/${teamId}/members/${userId}`, { method: 'PUT', body: { role } });

/** 204. The member's sessions end. */
export const removeMember = (teamId: string, userId: string) =>
  request<void>(`/api/v1/teams/${teamId}/members/${userId}`, { method: 'DELETE' });

// ---------- users and roles (platform administrators) ----------

export const listUsers = (cursor?: string, limit = 50) =>
  request<CursorPage<UserSummary>>('/api/v1/users', { query: { cursor, limit } });

export const getUser = (id: string) => request<UserSummary>(`/api/v1/users/${id}`);

/** Users are deactivated, never deleted. Every session of the user ends at once. You cannot deactivate yourself (409). */
export const deactivateUser = (id: string) =>
  request<UserSummary>(`/api/v1/users/${id}/deactivate`, { method: 'POST' });

export const listRoles = () => request<RoleView[]>('/api/v1/roles');

export const createRole = (name: string, description: string, permissions: string[]) =>
  request<RoleView>('/api/v1/roles', { method: 'POST', body: { name, description, permissions } });

// ---------- service accounts (administrators of the team) ----------

const accounts = (teamId: string) => `/api/v1/teams/${teamId}/service-accounts`;

export const listServiceAccounts = (teamId: string) => request<ServiceAccount[]>(accounts(teamId));

/** 201. The key is in this response once and never again. A role that manages users is refused (400). */
export const createServiceAccount = (teamId: string, name: string, role: Role) =>
  request<CreatedServiceAccount>(accounts(teamId), { method: 'POST', body: { name, role } });

/** Rotation is two steps: add a key (at most two are active), deploy it, then revoke the old one. */
export const addServiceAccountKey = (teamId: string, accountId: string) =>
  request<IssuedKey>(`${accounts(teamId)}/${accountId}/keys`, { method: 'POST' });

export const revokeServiceAccountKey = (teamId: string, accountId: string, keyId: string) =>
  request<void>(`${accounts(teamId)}/${accountId}/keys/${keyId}`, { method: 'DELETE' });

/** The account can never get a token again. Tokens already issued run out within their 5 minutes. */
export const disableServiceAccount = (teamId: string, accountId: string) =>
  request<ServiceAccount>(`${accounts(teamId)}/${accountId}/disable`, { method: 'POST' });

// ---------- audit ----------

export const listLoginAudit = (cursor?: string, limit = 25) =>
  request<CursorPage<LoginAuditRow>>('/api/v1/audit/logins', { query: { cursor, limit } });
