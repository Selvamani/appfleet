import { request, requestRaw } from './http';
import type {
  ApplicationResponse, CatalogueImage, CreateApplicationRequest, CreateDeploymentRequest, CreateReleaseRequest,
  CursorPage, DeploymentAccepted, DeploymentResponse, EnvironmentResponse, ReleaseResponse, RollbackAccepted,
  TaskResponse,
} from './types';

/** control-api (port 8081). Built endpoints unless marked otherwise. */

export const listApplications = (cursor?: string, limit = 20) =>
  request<CursorPage<ApplicationResponse>>('/api/v1/applications', { query: { cursor, limit } });

export const getApplication = (id: string) =>
  request<ApplicationResponse>(`/api/v1/applications/${id}`);

export const createApplication = (body: CreateApplicationRequest) =>
  request<ApplicationResponse>('/api/v1/applications', { method: 'POST', body });

/** Proposed (gap 1): the backend has GET /releases/{releaseId} but no list. */
export const listReleases = (applicationId: string, cursor?: string, limit = 50) =>
  request<CursorPage<ReleaseResponse>>(`/api/v1/applications/${applicationId}/releases`, { query: { cursor, limit } });

export const getRelease = (applicationId: string, releaseId: string) =>
  request<ReleaseResponse>(`/api/v1/applications/${applicationId}/releases/${releaseId}`);

export const createRelease = (applicationId: string, body: CreateReleaseRequest) =>
  request<ReleaseResponse>(`/api/v1/applications/${applicationId}/releases`, { method: 'POST', body });

/** Proposed (gap 2). */
export const listEnvironments = () => request<EnvironmentResponse[]>('/api/v1/environments');

export interface DeploymentRequestResult {
  accepted: DeploymentAccepted;
  /** Location header: /api/v1/tasks/{taskId}. */
  location: string | null;
  /** Idempotent-Replayed header: true when the server returned the stored answer to an earlier identical request. */
  replayed: boolean;
}

export async function requestDeployment(body: CreateDeploymentRequest, idempotencyKey?: string): Promise<DeploymentRequestResult> {
  const res = await requestRaw<DeploymentAccepted>('/api/v1/deployments', { method: 'POST', body, idempotencyKey });
  return {
    accepted: res.data,
    location: res.headers.get('Location'),
    replayed: res.headers.get('Idempotent-Replayed') === 'true',
  };
}

export const getDeployment = (id: string) => request<DeploymentResponse>(`/api/v1/deployments/${id}`);

export const requestRollback = (id: string) =>
  request<RollbackAccepted>(`/api/v1/deployments/${id}/rollback`, { method: 'POST' });

export const listDeploymentTasks = (deploymentId: string, cursor?: string, limit = 20) =>
  request<CursorPage<TaskResponse>>(`/api/v1/deployments/${deploymentId}/tasks`, { query: { cursor, limit } });

export const getTask = (id: string) => request<TaskResponse>(`/api/v1/tasks/${id}`);

/** Planned (catalogue module). */
export const listCatalogue = () => request<CatalogueImage[]>('/api/v1/catalogue/images');
