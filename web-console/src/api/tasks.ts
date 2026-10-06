import { request } from './http';
import type { CursorPage, DeadLetter } from './types';

/** task-service (port 8083, planned S4 and S7). */

/** Proposed (gap 7). */
export const listDeadLetters = (cursor?: string) =>
  request<CursorPage<DeadLetter>>('/api/v1/dlq', { query: { cursor } });

/** In the task-service spec: resets attempts, requeues, audit-logged. OPERATOR only. */
export const replayDeadLetter = (taskId: string) =>
  request<DeadLetter>(`/api/v1/dlq/${taskId}/replay`, { method: 'POST' });

/** Proposed: release a stale claim so another worker takes the task. */
export const reclaimTask = (taskId: string) =>
  request<void>(`/api/v1/dlq/stuck/${taskId}/reclaim`, { method: 'POST' });
