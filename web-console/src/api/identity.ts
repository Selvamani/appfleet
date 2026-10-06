import { request } from './http';
import type { CursorPage, LoginAuditRow, Me, Role, RotatedKey, ServiceAccount, Team, UserSummary } from './types';

/** identity-service (port 8082, planned S4). */

export const getMe = () => request<Me>('/api/v1/users/me');

export const listTeams = () => request<Team[]>('/api/v1/teams');

export const listUsers = (q?: string, cursor?: string) =>
  request<CursorPage<UserSummary>>('/api/v1/users', { query: { q, cursor } });

export const getUser = (id: string) => request<UserSummary>(`/api/v1/users/${id}`);

/** POST /teams/{id}/members is in the spec; the role travels in the body. */
export const grantRole = (teamId: string, userId: string, role: Role) =>
  request<UserSummary>(`/api/v1/teams/${teamId}/members`, { method: 'POST', body: { userId, role } });

/** Proposed: revoking one role. Takes effect within 5 minutes, live tokens included (NFR-6). */
export const revokeRole = (teamId: string, userId: string, role: Role) =>
  request<UserSummary>(`/api/v1/teams/${teamId}/members/${userId}`, { method: 'DELETE', query: { role } });

/** Proposed: users are deactivated, never deleted (audit integrity). */
export const deactivateUser = (id: string) =>
  request<UserSummary>(`/api/v1/users/${id}/deactivate`, { method: 'POST' });

/** Proposed (gap 9). */
export const listServiceAccounts = () => request<ServiceAccount[]>('/api/v1/service-accounts');

/** Proposed (gap 9). The new key is in the response once and never again. */
export const rotateServiceAccountKey = (id: string) =>
  request<RotatedKey>(`/api/v1/service-accounts/${id}/rotate`, { method: 'POST' });

export const listLoginAudit = (cursor?: string) =>
  request<CursorPage<LoginAuditRow>>('/api/v1/audit/logins', { query: { cursor } });
