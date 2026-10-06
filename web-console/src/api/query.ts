import { request } from './http';
import type {
  ApplicationHistory, AuditFilter, AuditPage, CorrelationStep, DashboardFilter, DashboardOverview, DashboardPage,
  DeploymentTimeline, FleetView, ProjectionStatus, WhatRunsWhere,
} from './types';

/** query-service (port 8085, planned S6). Every response carries asOf. */

export const getDashboardOverview = () => request<DashboardOverview>('/api/v1/dashboard/overview');

export const listDashboardDeployments = (opts: { cursor?: string; status?: DashboardFilter; teamId?: string; limit?: number } = {}) =>
  request<DashboardPage>('/api/v1/dashboard/deployments', {
    query: { cursor: opts.cursor, status: opts.status, teamId: opts.teamId, limit: opts.limit ?? 20 },
  });

/** Proposed (gap 3). Pass applicationId for one application's environments. */
export const getWhatRunsWhere = (applicationId?: string) =>
  request<WhatRunsWhere>('/api/v1/dashboard/where', { query: { applicationId } });

export const getApplicationHistory = (applicationId: string) =>
  request<ApplicationHistory>(`/api/v1/applications/${applicationId}/history`);

export const getDeploymentTimeline = (deploymentId: string) =>
  request<DeploymentTimeline>(`/api/v1/deployments/${deploymentId}/timeline`);

export const getFleet = () => request<FleetView>('/api/v1/fleet');

/** Proposed (gap 8). */
export const listProjections = () => request<ProjectionStatus[]>('/admin/projections');

export const rebuildProjection = (name: string) =>
  request<ProjectionStatus>(`/admin/projections/${name}/rebuild`, { method: 'POST' });

/** Proposed (gap 10). */
export const listAuditEvents = (filter: AuditFilter, cursor?: string) =>
  request<AuditPage>('/api/v1/audit', {
    query: { actor: filter.actor, action: filter.action, object: filter.object, cid: filter.correlationId, cursor },
  });

/** Proposed (gap 10): every recorded step that carried one correlation id, across services. */
export const getCorrelationWalk = (correlationId: string) =>
  request<CorrelationStep[]>(`/api/v1/audit/correlation/${encodeURIComponent(correlationId)}`);
