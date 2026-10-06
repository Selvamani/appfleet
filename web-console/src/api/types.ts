/*
 * Wire types. Built endpoints mirror the Java records in control-api exactly
 * (ApplicationResponse, ReleaseResponse, DeploymentResponse, DeploymentAccepted, RollbackAccepted,
 * TaskResponse, CursorPage). Everything marked "proposed" answers a gap listed in
 * docs/design/ux/web-console-react-plan.md §10.1 and is served only by the mock until the backend
 * decides its real shape.
 */

export type Uuid = string;
/** ISO-8601 instant in UTC, as Jackson writes java.time.Instant. */
export type Instant = string;

export const DEPLOYMENT_STATES = ['PENDING', 'VALIDATING', 'DEPLOYING', 'HEALTHY', 'DEGRADED', 'FAILED', 'ROLLED_BACK'] as const;
export type DeploymentState = (typeof DEPLOYMENT_STATES)[number];

export type TaskStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';
export type TaskType = 'DEPLOY' | 'ROLLBACK';

export interface CursorPage<T> {
  items: T[];
  nextCursor: string | null;
}

// ---------- control-api: built ----------

export interface ApplicationResponse {
  id: Uuid;
  name: string;
  description: string | null;
  ownerTeamId: Uuid;
  createdAt: Instant;
}

export interface CreateApplicationRequest {
  name: string;
  description?: string;
  ownerTeamId: Uuid;
}

export interface ReleaseResponse {
  id: Uuid;
  applicationId: Uuid;
  version: string;
  artifactRef: string;
  checksum: string;
  createdAt: Instant;
}

export interface CreateReleaseRequest {
  version: string;
  artifactRef: string;
  checksum: string;
}

export interface CreateDeploymentRequest {
  applicationId: Uuid;
  releaseId: Uuid;
  /** Environment name, for example "staging". */
  environment: string;
}

export interface DeploymentAccepted {
  deploymentId: Uuid;
  taskId: Uuid;
  status: DeploymentState;
}

export interface DeploymentResponse {
  id: Uuid;
  applicationId: Uuid;
  releaseId: Uuid;
  environment: string;
  status: DeploymentState;
  createdAt: Instant;
  updatedAt: Instant;
}

export interface RollbackAccepted {
  deploymentId: Uuid;
  taskId: Uuid;
}

export interface TaskResponse {
  id: Uuid;
  deploymentId: Uuid;
  taskType: TaskType | string;
  status: TaskStatus;
  createdAt: Instant;
  updatedAt: Instant;
}

// ---------- control-api: proposed (gaps 1, 2) and planned (catalogue) ----------

/** Proposed: GET /api/v1/environments (gap 2). */
export interface EnvironmentResponse {
  id: Uuid;
  name: string;
}

/** Planned: GET /api/v1/catalogue/images (control-api catalogue module). */
export interface CatalogueImage {
  id: Uuid;
  name: string;
  version: string;
  baseImage: string;
  /** A warm pool keeps containers ready, so sessions start in under 5 s instead of up to 30 s. */
  warmPool: boolean;
}

// ---------- query-service: planned (S6) ----------

export interface ReadModel {
  /** High-water mark of the projection that answered. Reads may be seconds stale; this says how stale. */
  asOf: Instant;
}

export interface DeploymentSummaryRow {
  deploymentId: Uuid;
  applicationId: Uuid;
  applicationName: string;
  teamId: Uuid;
  teamName: string;
  releaseId: Uuid;
  releaseVersion: string;
  environment: string;
  status: DeploymentState;
  requestedBy: string;
  requestedAt: Instant;
  updatedAt: Instant;
  taskCount: number;
}

export type DashboardFilter = 'flight' | 'attention' | 'finished';

export interface DashboardPage extends CursorPage<DeploymentSummaryRow>, ReadModel {}

export interface DashboardOverview extends ReadModel {
  inFlight: Partial<Record<DeploymentState, number>>;
  attention: Partial<Record<DeploymentState, number>>;
  prodHealthy: number;
  prodTotal: number;
  sessionsRunning: number;
}

/** Proposed (gap 3): current and latest deployment per application and environment. */
export interface WhereCell {
  deploymentId: Uuid;
  releaseVersion: string;
  status: DeploymentState;
  since: Instant;
  requestedBy: string;
  /** The most recent deployment, when it is not the one in `deploymentId` (for example a FAILED attempt). */
  latest?: { deploymentId: Uuid; releaseVersion: string; status: DeploymentState };
}

export interface WhereRow {
  applicationId: Uuid;
  applicationName: string;
  teamId: Uuid;
  teamName: string;
  cells: Record<string, WhereCell | undefined>;
}

export interface WhatRunsWhere extends ReadModel {
  environments: string[];
  rows: WhereRow[];
}

export interface ApplicationHistory extends ReadModel {
  last30Days: { total: number; healthy: number; failed: number; rolledBack: number };
  items: DeploymentSummaryRow[];
}

export interface TimelineEvent {
  at: Instant;
  text: string;
  status?: DeploymentState;
  actor?: string;
}

/** Proposed (gap 4): attempts are owned by task-service; query-service projects them. */
export interface Attempt {
  taskId: Uuid;
  attempt: number;
  status: TaskStatus;
  startedAt: Instant;
  finishedAt: Instant | null;
  node: string;
  fencingToken: number;
  message: string;
  /** True when the failure was classified PERMANENT and the task went to the dead-letter topic. */
  permanent: boolean;
}

export interface DeploymentTimeline extends ReadModel {
  deploymentId: Uuid;
  applicationName: string;
  releaseVersion: string;
  requestedBy: string;
  correlationId: string;
  node: string | null;
  events: TimelineEvent[];
  attempts: Attempt[];
}

export type NodeState = 'HEARTBEATING' | 'STALE' | 'DRAINING';

export interface FleetNode {
  id: Uuid;
  name: string;
  environment: string;
  leaseHolder: string | null;
  fencingToken: number;
  lastHeartbeatAt: Instant;
  sessionsUsed: number;
  sessionsCapacity: number;
  state: NodeState;
}

export interface StuckTask {
  taskId: Uuid;
  deploymentId: Uuid;
  title: string;
  taskType: TaskType | string;
  runningSince: Instant;
  node: string;
  reason: string;
}

export interface FleetView extends ReadModel {
  projectionLagMs: number;
  queueWaiting: number;
  nodes: FleetNode[];
  stuckTasks: StuckTask[];
}

/** Proposed (gap 8). */
export interface ProjectionStatus {
  name: string;
  lagMs: number;
  state: 'UP_TO_DATE' | 'REBUILDING';
}

export type AuditOutcome = 'ACCEPTED' | 'SUCCESS' | 'DENIED' | 'FAILED';

/** Proposed (gap 10). */
export interface AuditEventRow {
  id: Uuid;
  at: Instant;
  actor: string;
  action: string;
  object: string;
  outcome: AuditOutcome;
  sourceIp: string;
  userAgent: string;
  correlationId: string;
}

export interface AuditPage extends CursorPage<AuditEventRow>, ReadModel {}

export interface AuditFilter {
  actor?: string;
  action?: string;
  object?: string;
  correlationId?: string;
}

export interface CorrelationStep {
  at: Instant;
  service: string;
  text: string;
}

// ---------- task-service: planned (S4, S7) ----------

/** Proposed (gap 7) list; replay endpoint is in the task-service spec. */
export interface DeadLetter {
  taskId: Uuid;
  failedAt: Instant;
  work: string;
  taskType: string;
  reason: string;
  attempts: number;
  replayed: boolean;
}

// ---------- node-agent: planned (S5) ----------

export type SessionStatus = 'STARTING' | 'RUNNING' | 'ENDED';

export interface SessionResponse {
  sessionId: Uuid;
  appImageId: Uuid;
  toolName: string;
  version: string;
  status: SessionStatus;
  startedAt: Instant;
  lastActivityAt: Instant;
  /** Browser address of the running tool; null until RUNNING. */
  endpoint: string | null;
  startMode: 'warm' | 'cold';
}

export interface StartSessionResponse {
  sessionId: Uuid;
  endpoint: string | null;
}

// ---------- identity-service: planned (S4) ----------

/** Roles are data: AUDITOR was added without code changes, as the RBAC spec intends. */
export type Role = 'VIEWER' | 'DEPLOYER' | 'OPERATOR' | 'ADMIN' | 'AUDITOR';

export interface Team {
  id: Uuid;
  name: string;
}

export interface Grant {
  /** null means every team. */
  teamId: Uuid | null;
  teamName: string;
  role: Role;
  grantedBy: string;
  grantedAt: Instant;
}

export interface Me {
  id: Uuid;
  username: string;
  grants: Grant[];
  /** Team-scoped permissions, as carried in the access token: key is a team id, or '*' for every team. */
  permissions: Record<string, string[]>;
}

export type UserStatus = 'ACTIVE' | 'DEACTIVATED';

export interface UserSummary {
  id: Uuid;
  username: string;
  status: UserStatus;
  grants: Grant[];
  lastSignIn: { at: Instant; ip: string } | null;
  failedSignIns: number;
  securityNote: string;
}

export interface ServiceAccount {
  id: Uuid;
  name: string;
  scopes: string[];
  keyHint: string;
  createdAt: Instant;
  lastUsedAt: Instant | null;
  rotatedAt: Instant | null;
}

export interface RotatedKey {
  /** Shown once. */
  key: string;
  keyHint: string;
  oldKeyValidUntil: Instant;
}

export interface LoginAuditRow {
  id: Uuid;
  at: Instant;
  username: string;
  outcome: 'SUCCESS' | 'FAILED';
  sourceIp: string;
  userAgent: string;
  correlationId: string;
}
