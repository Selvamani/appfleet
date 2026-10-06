import { request } from './http';
import type { SessionResponse, StartSessionResponse } from './types';

/** node-agent (port 8084+, planned S5). */

/** Proposed (gap 5): the caller's own sessions. */
export const listMySessions = () => request<SessionResponse[]>('/api/v1/sessions');

export const startSession = (appImageId: string) =>
  request<StartSessionResponse>('/api/v1/sessions', { method: 'POST', body: { appImageId } });

export const getSession = (id: string) => request<SessionResponse>(`/api/v1/sessions/${id}`);

export const endSession = (id: string) => request<void>(`/api/v1/sessions/${id}`, { method: 'DELETE' });

/** Proposed (gap 6). */
export const drainNode = (nodeId: string) => request<void>(`/api/v1/nodes/${nodeId}/drain`, { method: 'POST' });
