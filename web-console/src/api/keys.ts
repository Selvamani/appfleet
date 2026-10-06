import type { AuditFilter, DashboardFilter } from './types';

/**
 * Query keys, in one place so mutations invalidate exactly what they change.
 * Convention: [service, resource, ...params].
 */
export const qk = {
  me: () => ['identity', 'me'] as const,
  teams: () => ['identity', 'teams'] as const,
  users: (q?: string) => ['identity', 'users', q ?? ''] as const,
  /** Prefix of every users list, for invalidation. */
  allUsers: () => ['identity', 'users'] as const,
  user: (id: string) => ['identity', 'user', id] as const,
  serviceAccounts: () => ['identity', 'service-accounts'] as const,
  loginAudit: () => ['identity', 'login-audit'] as const,

  applications: () => ['control', 'applications'] as const,
  application: (id: string) => ['control', 'application', id] as const,
  releases: (applicationId: string) => ['control', 'releases', applicationId] as const,
  release: (applicationId: string, releaseId: string) => ['control', 'releases', applicationId, releaseId] as const,
  environments: () => ['control', 'environments'] as const,
  deployment: (id: string) => ['control', 'deployment', id] as const,
  deploymentTasks: (id: string) => ['control', 'deployment-tasks', id] as const,
  catalogue: () => ['control', 'catalogue'] as const,

  dashboardOverview: () => ['query', 'dashboard', 'overview'] as const,
  dashboardDeployments: (status?: DashboardFilter) => ['query', 'dashboard', 'deployments', status ?? 'all'] as const,
  whatRunsWhere: (applicationId?: string) => ['query', 'dashboard', 'where', applicationId ?? 'all'] as const,
  applicationHistory: (id: string) => ['query', 'application-history', id] as const,
  timeline: (deploymentId: string) => ['query', 'timeline', deploymentId] as const,
  fleet: () => ['query', 'fleet'] as const,
  projections: () => ['query', 'projections'] as const,
  audit: (filter: AuditFilter) => ['query', 'audit', filter] as const,
  correlation: (cid: string) => ['query', 'correlation', cid] as const,

  sessions: () => ['agent', 'sessions'] as const,
  deadLetters: () => ['task', 'dlq'] as const,
};

/** Everything the read side shows; invalidated after any write so read-your-writes catches up. */
export const READ_SIDE = ['query'] as const;
