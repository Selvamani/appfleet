import type { AuditFilter, DashboardFilter } from './types';

/**
 * Query keys, in one place so mutations invalidate exactly what they change.
 * Convention: [service, resource, ...params].
 */
export const qk = {
  me: () => ['identity', 'me'] as const,
  profile: () => ['identity', 'profile'] as const,
  /** Teams the console can name; the platform flag is part of the key because the source differs. */
  teams: (platform = false) => ['identity', 'teams', platform] as const,
  allTeams: () => ['identity', 'teams'] as const,
  members: (teamId: string) => ['identity', 'members', teamId] as const,
  /** Prefix of every members list (a grant changes one team, the grants of a user span all of them). */
  allMembers: () => ['identity', 'members'] as const,
  users: () => ['identity', 'users'] as const,
  user: (id: string) => ['identity', 'user', id] as const,
  roles: () => ['identity', 'roles'] as const,
  serviceAccounts: (teamId: string) => ['identity', 'service-accounts', teamId] as const,
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
