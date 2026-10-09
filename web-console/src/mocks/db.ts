/*
 * In-memory backend for mock mode. One seeded world shared by every handler, plus a clock: new
 * deployments move PENDING → VALIDATING → DEPLOYING → HEALTHY over about 9 seconds, rollbacks finish
 * after 5 seconds, sessions start after their warm or cold start time. Seeded deployments are frozen
 * so the demo stays stable.
 *
 * Business rules copied from control-api so the UI meets the real ones:
 *  - uq_deployment_active_per_app_env: one deployment per application and environment whose status is
 *    not FAILED or ROLLED_BACK. A HEALTHY deployment therefore blocks a new one (409 conflict).
 *  - Rollback only from HEALTHY or DEGRADED (409 illegal-transition); a second open rollback is 409 conflict.
 */
import type {
  ApplicationResponse, Attempt, AuditEventRow, CatalogueImage, CorrelationStep, DeadLetter, DeploymentResponse,
  DeploymentState, DeploymentSummaryRow, EnvironmentResponse, FleetNode, LoginAuditRow, Me, ProjectionStatus,
  ReleaseResponse, Role, RoleView, ServiceAccount, SessionResponse, TaskResponse, TeamView, TimelineEvent, UserSummary,
} from '../api/types';
import { PLATFORM_TEAM_ID } from '../api/types';
import { can, type Permission } from '../auth/permissions';
import { uuidv7 } from '../lib/uuid';
import { getDevRole } from './devRole';

const SEC = 1000;
const MIN = 60 * SEC;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

/** Deterministic UUIDv7-shaped ids for seed data. */
export function sid(n: number): string {
  return `0192f3a1-0000-7000-8000-${n.toString(16).padStart(12, '0')}`;
}

function checksumOf(text: string): string {
  let h = 0x811c9dc5;
  let out = '';
  for (let round = 0; round < 8; round++) {
    for (const ch of `${text}#${round}`) {
      h ^= ch.charCodeAt(0);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
    out += h.toString(16).padStart(8, '0');
  }
  return `sha256:${out}`;
}

const iso = (t: number) => new Date(t).toISOString();

// ---------- internal records ----------

export interface DbDeployment extends DeploymentResponse {
  requestedBy: string;
  correlationId: string;
  node: string;
  history: TimelineEvent[];
  /** Absent for frozen seed data. */
  schedule?: { start: number; failPermanently: boolean };
  rollbackAt?: number;
}

export type DbTask = TaskResponse;

export interface DbSession extends SessionResponse {
  ownerId: string;
  readyAt: number;
}

export interface IdempotencyEntry {
  fingerprint: string;
  deploymentId: string;
  taskId: string;
  /** Until then the key is IN_PROGRESS, as in control-api before the transaction commits. */
  completesAt: number;
}

export interface Db {
  now: () => number;
  teams: TeamView[];
  users: UserSummary[];
  members: DbMember[];
  roles: RoleView[];
  applications: ApplicationResponse[];
  releases: ReleaseResponse[];
  environments: EnvironmentResponse[];
  deployments: DbDeployment[];
  tasks: DbTask[];
  attempts: Attempt[];
  nodes: FleetNode[];
  catalogue: CatalogueImage[];
  sessions: DbSession[];
  deadLetters: DeadLetter[];
  projections: Array<ProjectionStatus & { rebuildUntil?: number }>;
  audit: AuditEventRow[];
  correlation: Map<string, CorrelationStep[]>;
  serviceAccounts: ServiceAccount[];
  logins: LoginAuditRow[];
  idempotency: Map<string, IdempotencyEntry>;
  otherSessionsRunning: number;
}

// Assigned by seed() and resetDb(); declared first so helpers can read it while seeding.
export let db: Db = undefined as unknown as Db;

export const ENV_ORDER = ['dev', 'qa', 'staging', 'prod'];
export const NODE_FOR_ENV: Record<string, string> = { dev: 'dev-node-01', qa: 'qa-node-01', staging: 'stg-node-02', prod: 'prd-node-01' };
export const ME_ID = sid(10);

export const TEAM_PAY = sid(1);
export const TEAM_SEARCH = sid(2);

// ---------- roles and the signed-in user ----------

/** One membership: this user holds this role in this team (identity-service: one role per user per team). */
export interface DbMember {
  teamId: string;
  userId: string;
  role: Role;
}

/**
 * The roles identity-service seeds, with each role's OWN permissions. A role also holds what the roles below it hold
 * (the role hierarchy, expanded in code when a token is built): VIEWER < DEPLOYER < OPERATOR < ADMIN.
 */
export const SEEDED_ROLES: RoleView[] = [
  { name: 'VIEWER', description: 'Read-only', permissions: ['application:read', 'deployment:read'] },
  { name: 'DEPLOYER', description: 'Creates applications and deployments', permissions: ['application:create', 'deployment:create'] },
  { name: 'OPERATOR', description: 'Rolls back and drains nodes', permissions: ['deployment:rollback', 'node:drain'] },
  { name: 'ADMIN', description: 'Publishes to the catalogue and manages users', permissions: ['catalog:publish', 'user:manage'] },
];
const HIERARCHY = ['VIEWER', 'DEPLOYER', 'OPERATOR', 'ADMIN'];

/** The permissions a role grants, including the ones it inherits. A role outside the hierarchy grants only its own. */
export function permissionsOfRole(role: Role): string[] {
  const rank = HIERARCHY.indexOf(role);
  const names = rank < 0 ? [role] : HIERARCHY.slice(0, rank + 1);
  const out = new Set<string>();
  for (const name of names) db.roles.find(r => r.name === name)?.permissions.forEach(p => out.add(p));
  return [...out].sort();
}

/** What the development role switch gives the signed-in user: roles in teams, the way a real administrator would grant them. */
function membershipsForDevRole(role: Role): Array<{ teamId: string; role: Role }> {
  switch (role) {
    case 'VIEWER': return [{ teamId: TEAM_PAY, role: 'VIEWER' }];
    case 'DEPLOYER': return [{ teamId: TEAM_PAY, role: 'DEPLOYER' }];
    case 'OPERATOR': return [{ teamId: TEAM_PAY, role: 'OPERATOR' }, { teamId: TEAM_SEARCH, role: 'OPERATOR' }];
    default: return [{ teamId: TEAM_PAY, role: 'ADMIN' }, { teamId: PLATFORM_TEAM_ID, role: 'ADMIN' }];   // platform administrator
  }
}

export function permissionsFor(grants: Array<{ teamId: string; role: Role }>): Record<string, string[]> {
  const out: Record<string, Set<string>> = {};
  for (const grant of grants) {
    out[grant.teamId] ??= new Set();
    permissionsOfRole(grant.role).forEach(p => out[grant.teamId]!.add(p));
  }
  return Object.fromEntries(Object.entries(out).map(([k, v]) => [k, [...v].sort()]));
}

/** Applies the development role switch to the signed-in user's memberships, and returns who they are now. */
export function currentMe(): Me {
  const you = db.users.find(u => u.id === ME_ID)!;
  db.members = db.members.filter(m => m.userId !== ME_ID);
  for (const g of membershipsForDevRole(getDevRole())) db.members.push({ ...g, userId: ME_ID });
  const grants = db.members.filter(m => m.userId === ME_ID).map(m => ({ teamId: m.teamId, teamName: teamName(m.teamId), role: m.role }));
  return { id: you.id, username: you.email, displayName: you.displayName, grants, permissions: permissionsFor(grants) };
}

export function allows(permission: Permission, teamId?: string): boolean {
  return can(currentMe(), permission, teamId);
}

export function teamName(teamId: string): string {
  return db.teams.find(t => t.id === teamId)?.name ?? 'Unknown team';
}

// ---------- seed ----------

interface SeedDeployment {
  n: number;
  app: string;
  env: string;
  version: string;
  status: DeploymentState;
  ago: number;
  by: string;
}

function seed(now: number): Db {
  const d: Db = {
    now: () => Date.now(),
    teams: [
      { id: PLATFORM_TEAM_ID, name: 'platform', createdAt: iso(now - 420 * DAY) },
      { id: TEAM_PAY, name: 'Payments', createdAt: iso(now - 300 * DAY) },
      { id: TEAM_SEARCH, name: 'Search', createdAt: iso(now - 250 * DAY) },
    ],
    users: [],
    members: [],
    roles: SEEDED_ROLES.map(r => ({ ...r, permissions: [...r.permissions] })),
    applications: [],
    releases: [],
    environments: [],
    deployments: [],
    tasks: [],
    attempts: [],
    nodes: [],
    catalogue: [],
    sessions: [],
    deadLetters: [],
    projections: [],
    audit: [],
    correlation: new Map(),
    serviceAccounts: [],
    logins: [],
    idempotency: new Map(),
    otherSessionsRunning: 12,
  };
  db = d; // helpers such as teamName() read the db being built

  const user = (n: number, username: string, displayName: string, daysAgo: number, deactivatedDaysAgo?: number): UserSummary => ({
    id: sid(n), email: `${username}@appfleet.example`, displayName, status: deactivatedDaysAgo === undefined ? 'ACTIVE' : 'DEACTIVATED',
    createdAt: iso(now - daysAgo * DAY), deactivatedAt: deactivatedDaysAgo === undefined ? null : iso(now - deactivatedDaysAgo * DAY),
  });
  d.users = [
    user(10, 'you', 'You', 213),
    user(11, 'm.okafor', 'M. Okafor', 263),
    user(12, 's.iyer', 'S. Iyer', 224),
    user(13, 'p.novak', 'P. Novak', 332),
    user(14, 'audit.k', 'K. Audit', 87),
    user(15, 'r.lee', 'R. Lee', 400, 48),
    user(16, 'admin.t', 'T. Admin', 400),
  ];
  const member = (userN: number, teamId: string, role: Role) => d.members.push({ teamId, userId: sid(userN), role });
  member(10, TEAM_PAY, 'DEPLOYER');
  member(11, TEAM_PAY, 'DEPLOYER'); member(11, TEAM_SEARCH, 'VIEWER');
  member(12, TEAM_SEARCH, 'DEPLOYER');
  member(13, TEAM_PAY, 'OPERATOR'); member(13, TEAM_SEARCH, 'OPERATOR');
  member(14, TEAM_PAY, 'VIEWER'); member(14, TEAM_SEARCH, 'VIEWER');
  member(16, PLATFORM_TEAM_ID, 'ADMIN'); member(16, TEAM_PAY, 'ADMIN'); member(16, TEAM_SEARCH, 'ADMIN');

  const apps: Array<[number, string, string, string]> = [
    [20, 'billing-api', TEAM_PAY, 'Invoices and payment intents API'],
    [21, 'checkout-web', TEAM_PAY, 'Checkout pages and cart'],
    [22, 'ledger-worker', TEAM_PAY, 'Posts settled payments to the ledger'],
    [23, 'search-indexer', TEAM_SEARCH, 'Builds the product search index'],
    [24, 'query-gateway', TEAM_SEARCH, 'Public search API'],
  ];
  d.applications = apps.map(([n, name, team, description]) => ({ id: sid(n), name, description, ownerTeamId: team, createdAt: iso(now - (300 - n) * DAY) }));

  const versions: Record<string, Array<[string, number]>> = {
    'billing-api': [['2.2.7', 33], ['2.3.0', 20], ['2.3.1', 8], ['2.4.0', 1], ['2.5.0-rc1', 0.2]],
    'checkout-web': [['5.11.3', 15], ['5.11.4', 4], ['5.12.0', 0.5]],
    'ledger-worker': [['0.18.1', 25], ['0.18.2', 6]],
    'search-indexer': [['1.9.1', 30], ['1.9.2', 12], ['1.9.3', 2]],
    'query-gateway': [['3.0.4', 18], ['3.1.0', 3]],
  };
  let relN = 100;
  for (const app of d.applications) {
    const team = teamName(app.ownerTeamId).toLowerCase();
    for (const [version, daysAgo] of versions[app.name]!) {
      d.releases.push({
        id: sid(relN++), applicationId: app.id, version,
        artifactRef: `registry.internal/${team}/${app.name}:${version}`,
        checksum: checksumOf(`${app.name}:${version}`), createdAt: iso(now - daysAgo * DAY),
      });
    }
  }

  d.environments = ENV_ORDER.map((name, i) => ({ id: sid(40 + i), name }));

  const nodes: Array<[number, string, string, string | null, number, number, number, FleetNode['state']]> = [
    [50, 'dev-node-01', 'dev', 'agent-dev-1', 1203, 2, 3, 'HEARTBEATING'],
    [51, 'qa-node-01', 'qa', 'agent-qa-1', 310, 1, 0, 'HEARTBEATING'],
    [52, 'stg-node-01', 'staging', 'agent-stg-1', 881, 1, 2, 'HEARTBEATING'],
    [53, 'stg-node-02', 'staging', 'agent-stg-2', 4417, 3, 4, 'HEARTBEATING'],
    [54, 'prd-node-01', 'prod', 'agent-prd-1', 9920, 2, 5, 'HEARTBEATING'],
    [55, 'prd-node-02', 'prod', 'agent-prd-2', 9921, 41, 0, 'STALE'],
    [56, 'prd-node-03', 'prod', 'agent-prd-3', 9930, 1, 0, 'DRAINING'],
  ];
  d.nodes = nodes.map(([n, name, environment, leaseHolder, token, hbAgo, used, state]) => ({
    id: sid(n), name, environment, leaseHolder, fencingToken: token, lastHeartbeatAt: iso(now - hbAgo * SEC), sessionsUsed: used, sessionsCapacity: 8, state,
  }));

  const deployments: SeedDeployment[] = [
    { n: 200, app: 'billing-api', env: 'dev', version: '2.4.0', status: 'HEALTHY', ago: 5 * HOUR, by: 'you' },
    { n: 201, app: 'billing-api', env: 'staging', version: '2.3.1', status: 'ROLLED_BACK', ago: 3 * DAY, by: 'm.okafor' },
    { n: 202, app: 'billing-api', env: 'staging', version: '2.4.0', status: 'DEPLOYING', ago: 1 * MIN, by: 'you' },
    { n: 203, app: 'billing-api', env: 'prod', version: '2.3.0', status: 'ROLLED_BACK', ago: 5 * DAY, by: 'you' },
    { n: 204, app: 'billing-api', env: 'prod', version: '2.3.1', status: 'HEALTHY', ago: 160 * MIN, by: 'you' },
    { n: 205, app: 'checkout-web', env: 'dev', version: '5.12.0', status: 'DEPLOYING', ago: 11 * MIN, by: 'm.okafor' },
    { n: 206, app: 'checkout-web', env: 'staging', version: '5.11.4', status: 'HEALTHY', ago: 1 * DAY, by: 'm.okafor' },
    { n: 207, app: 'checkout-web', env: 'prod', version: '5.11.4', status: 'ROLLED_BACK', ago: 240 * MIN, by: 'm.okafor' },
    { n: 208, app: 'checkout-web', env: 'prod', version: '5.11.3', status: 'HEALTHY', ago: 230 * MIN, by: 'm.okafor' },
    { n: 209, app: 'ledger-worker', env: 'dev', version: '0.18.2', status: 'HEALTHY', ago: 2 * DAY, by: 'you' },
    { n: 210, app: 'ledger-worker', env: 'staging', version: '0.18.2', status: 'HEALTHY', ago: 1 * DAY, by: 'you' },
    { n: 211, app: 'ledger-worker', env: 'prod', version: '0.18.2', status: 'DEGRADED', ago: 45 * MIN, by: 'you' },
    { n: 212, app: 'search-indexer', env: 'dev', version: '1.9.3', status: 'HEALTHY', ago: 1 * DAY, by: 's.iyer' },
    { n: 213, app: 'search-indexer', env: 'staging', version: '1.9.3', status: 'HEALTHY', ago: 6 * HOUR, by: 's.iyer' },
    { n: 214, app: 'search-indexer', env: 'prod', version: '1.9.2', status: 'HEALTHY', ago: 3 * DAY, by: 's.iyer' },
    { n: 215, app: 'search-indexer', env: 'qa', version: '1.9.3', status: 'PENDING', ago: 4 * MIN, by: 's.iyer' },
    { n: 216, app: 'query-gateway', env: 'dev', version: '3.1.0', status: 'HEALTHY', ago: 1 * DAY, by: 's.iyer' },
    { n: 217, app: 'query-gateway', env: 'staging', version: '3.1.0', status: 'FAILED', ago: 75 * MIN, by: 's.iyer' },
    { n: 218, app: 'query-gateway', env: 'staging', version: '3.0.4', status: 'HEALTHY', ago: 60 * MIN, by: 's.iyer' },
    { n: 219, app: 'query-gateway', env: 'prod', version: '3.0.4', status: 'HEALTHY', ago: 4 * DAY, by: 's.iyer' },
  ];
  for (const spec of deployments) seedDeployment(d, spec, now);

  d.catalogue = [
    [60, 'Java IDE (JDK 21)', '2026.2-r3', 'base/desktop:24.04', true],
    [61, 'Python data notebook', '4.2-r1', 'base/desktop:24.04', true],
    [62, 'Design suite', '12.1-r2', 'base/desktop-gpu:24.04', false],
    [63, 'Vendor planning tool', '8.0-r5', 'base/desktop:24.04', false],
    [64, 'SQL workbench', '3.4-r1', 'base/desktop:24.04', true],
    [65, 'Load-test console', '1.7-r2', 'base/cli:24.04', false],
  ].map(([n, name, version, baseImage, warmPool]) => ({ id: sid(n as number), name: name as string, version: version as string, baseImage: baseImage as string, warmPool: warmPool as boolean }));

  const session = (n: number, imageN: number, ageMin: number, idleMin: number): DbSession => {
    const img = d.catalogue.find(c => c.id === sid(imageN))!;
    return {
      sessionId: sid(n), appImageId: img.id, toolName: img.name, version: img.version, status: 'RUNNING',
      startedAt: iso(now - ageMin * MIN), lastActivityAt: iso(now - idleMin * MIN),
      endpoint: `https://sessions.appfleet.internal/${sid(n)}`, startMode: img.warmPool ? 'warm' : 'cold', ownerId: ME_ID, readyAt: now - ageMin * MIN,
    };
  };
  d.sessions = [session(70, 60, 50, 4), session(71, 61, 20, 0)];

  const failedDeploy = d.deployments.find(x => x.id === sid(217))!;
  const failedTask = d.tasks.find(t => t.deploymentId === failedDeploy.id)!;
  d.deadLetters = [
    { taskId: failedTask.id, failedAt: failedDeploy.updatedAt, work: 'query-gateway 3.1.0 to staging', taskType: 'DEPLOY', reason: 'Image pull denied (PERMANENT)', attempts: 3, replayed: false },
    { taskId: sid(80), failedAt: iso(now - 3 * HOUR), work: 'search-indexer 1.9.1 to dev', taskType: 'DEPLOY', reason: 'Release checksum mismatch (PERMANENT)', attempts: 1, replayed: false },
    { taskId: sid(81), failedAt: iso(now - 5 * HOUR), work: 'Session reap on prd-node-02', taskType: 'REAP', reason: 'Container not found (UNKNOWN, cap reached)', attempts: 2, replayed: false },
  ];

  d.projections = [
    { name: 'deployment_summary', lagMs: 1800, state: 'UP_TO_DATE' },
    { name: 'fleet_view', lagMs: 900, state: 'UP_TO_DATE' },
    { name: 'task_timeline', lagMs: 2400, state: 'UP_TO_DATE' },
    { name: 'application_history', lagMs: 3100, state: 'UP_TO_DATE' },
  ];

  const ev = (n: number, ago: number, actor: string, action: string, object: string, outcome: AuditEventRow['outcome'], ip: string, ua: string, cid: string, walk: Array<[number, string, string]>) => {
    d.audit.push({ id: sid(n), at: iso(now - ago), actor, action, object, outcome, sourceIp: ip, userAgent: ua, correlationId: cid });
    d.correlation.set(cid, walk.map(([offset, service, text]) => ({ at: iso(now - ago + offset), service, text })));
  };
  ev(300, 13 * MIN, 'm.okafor', 'DEPLOYMENT_REQUESTED', 'search-indexer 1.9.3 to prod', 'DENIED', '10.2.4.17', 'Chrome 129, macOS', 'c-51b0e7a4', [
    [0, 'identity-service', 'Token checked: DEPLOYER on Search was revoked 7 minutes earlier'],
    [40, 'control-api', 'No DEPLOYER grant on Search; replied 404 Not Found'],
  ]);
  ev(301, 20 * MIN, 'admin.t', 'GRANT_REVOKED', 'm.okafor, DEPLOYER on Search', 'SUCCESS', '10.2.1.5', 'Firefox 131, Windows', 'c-2d19c0f8', [
    [0, 'identity-service', 'Grant removed; live tokens for m.okafor added to the denylist (effective in under 5 min)'],
  ]);
  ev(302, 90 * MIN, 'p.novak', 'DLQ_REPLAYED', 'task 0192d1f0, checkout-web 5.11.2', 'SUCCESS', '10.2.6.12', 'Chrome 129, Linux', 'c-9a6e4b13', [
    [0, 'task-service', 'Message moved from task.work.DLT back to task.work'],
    [800, 'node-agent stg-node-01, token 881', 'Attempt 4 started'],
    [31000, 'node-agent stg-node-01, token 881', 'Attempt 4 succeeded'],
  ]);
  ev(303, 240 * MIN, 'm.okafor', 'ROLLBACK_REQUESTED', 'checkout-web 5.11.4 in prod', 'ACCEPTED', '10.2.4.17', 'Chrome 129, macOS', 'c-0be3f5a1', [
    [0, 'control-api', 'Rollback requested; replied 202 Accepted'],
    [600, 'task-service', 'ROLLBACK task created'],
    [45000, 'node-agent prd-node-01, token 9920', 'Previous release restored; deployment ROLLED_BACK'],
  ]);
  ev(304, 6 * HOUR, 'm.okafor', 'LOGIN_FAILED', 'account m.okafor', 'FAILED', '203.0.113.24', 'curl/8.9', 'c-e4c1d7b0', [
    [0, 'identity-service', 'Wrong password (failure 3 of 3); account locked for 15 min'],
  ]);
  ev(305, 6 * HOUR + 46 * SEC, 'm.okafor', 'LOGIN_FAILED', 'account m.okafor', 'FAILED', '203.0.113.24', 'curl/8.9', 'c-a03f6e19', [
    [0, 'identity-service', 'Wrong password (failure 2 of 3)'],
  ]);
  // deployments carry their own correlation ids; give each seeded request an audit row and its walk
  for (const dep of d.deployments) {
    d.correlation.set(dep.correlationId, dep.history.map(e => ({ at: e.at, service: serviceOf(e.text, dep.node), text: e.text })));
    d.audit.push({
      id: uuidv7(new Date(dep.createdAt).getTime()), at: dep.createdAt, actor: dep.requestedBy, action: 'DEPLOYMENT_REQUESTED',
      object: `${appName(dep.applicationId)} ${versionOf(dep.releaseId)} to ${dep.environment}`, outcome: 'ACCEPTED',
      sourceIp: '10.2.8.31', userAgent: 'Firefox 131, Linux', correlationId: dep.correlationId,
    });
  }
  d.audit.sort((a, b) => b.at.localeCompare(a.at));

  const key = (n: number, prefix: string, status: 'ACTIVE' | 'REVOKED', daysAgo: number, usedAgo: number | null, revokedDaysAgo?: number) => ({
    id: sid(n), prefix, status, createdAt: iso(now - daysAgo * DAY),
    revokedAt: revokedDaysAgo === undefined ? null : iso(now - revokedDaysAgo * DAY), lastUsedAt: usedAgo === null ? null : iso(now - usedAgo),
  });
  d.serviceAccounts = [
    { id: sid(90), teamId: TEAM_PAY, name: 'node-agent', role: 'OPERATOR', status: 'ACTIVE', createdAt: iso(now - 31 * DAY), disabledAt: null,
      keys: [key(190, '3f9eKq0Ab_x', 'ACTIVE', 31, 2 * SEC)] },
    { id: sid(91), teamId: TEAM_PAY, name: 'deploy-bot', role: 'DEPLOYER', status: 'ACTIVE', createdAt: iso(now - 60 * DAY), disabledAt: null,
      keys: [key(191, '0d58Zr1Qm-L', 'REVOKED', 60, null, 20), key(192, '71c2Hn8Tj_V', 'ACTIVE', 20, 4 * MIN)] },
    { id: sid(92), teamId: TEAM_SEARCH, name: 'ci-release-bot', role: 'DEPLOYER', status: 'ACTIVE', createdAt: iso(now - 42 * DAY), disabledAt: null,
      keys: [key(193, 'b7Xw3Lc9Ed_', 'ACTIVE', 42, 9 * MIN)] },
  ];

  const login = (n: number, ago: number, event: LoginAuditRow['event'], outcome: string, who: { email?: string; user?: number; sa?: number },
    ip: string, ua: string, cid: string): LoginAuditRow => ({
    id: sid(n), occurredAt: iso(now - ago), event, outcome, email: who.email ?? null, userId: who.user ? sid(who.user) : null,
    serviceAccountId: who.sa ? sid(who.sa) : null, ip, userAgent: ua, correlationId: cid,
  });
  d.logins = [
    login(400, 2 * HOUR, 'LOGIN', 'SUCCESS', { email: 'you@appfleet.example', user: 10 }, '10.2.8.31', 'Firefox 131, Linux', 'c-11aa0001'),
    login(401, 3 * HOUR, 'LOGIN', 'SUCCESS', { email: 'm.okafor@appfleet.example', user: 11 }, '10.2.4.17', 'Chrome 129, macOS', 'c-11aa0002'),
    login(402, 5 * MIN + 2 * HOUR, 'LOGIN', 'LOCKED', { email: 'm.okafor@appfleet.example', user: 11 }, '203.0.113.24', 'curl/8.9', 'c-e4c1d7b1'),
    login(403, 6 * HOUR, 'LOGIN', 'BAD_CREDENTIALS', { email: 'm.okafor@appfleet.example', user: 11 }, '203.0.113.24', 'curl/8.9', 'c-e4c1d7b0'),
    login(404, 6 * HOUR + 46 * SEC, 'LOGIN', 'BAD_CREDENTIALS', { email: 'm.okafor@appfleet.example', user: 11 }, '203.0.113.24', 'curl/8.9', 'c-a03f6e19'),
    login(405, 7 * HOUR, 'LOGIN', 'UNKNOWN_USER', { email: 'root@appfleet.example' }, '198.51.100.7', 'python-requests/2.32', 'c-77de0a31'),
    login(406, 4 * MIN, 'SERVICE_TOKEN', 'SUCCESS', { sa: 91 }, '10.2.7.3', 'okhttp/4.12', 'c-5a10b0c2'),
    login(407, 3 * DAY, 'SERVICE_TOKEN', 'INVALID_KEY', { sa: 91 }, '10.2.7.9', 'okhttp/4.12', 'c-5a10b0c3'),
    login(408, 2 * DAY, 'REFRESH_REUSE', 'REUSED', { user: 12 }, '203.0.113.88', 'Chrome 129, Windows', 'c-9be2c4d0'),
  ].sort((x, y) => y.occurredAt.localeCompare(x.occurredAt));
  return d;
}

/** Which service records a timeline event, for seeded correlation walks. */
function serviceOf(text: string, node: string): string {
  if (text.startsWith('Requested') || text.startsWith('Rollback requested')) return 'control-api';
  if (text.startsWith('Validation') || text.startsWith('Failed')) return 'task-service';
  return `node-agent ${node}`;
}

function appName(applicationId: string): string {
  return db.applications.find(a => a.id === applicationId)?.name ?? 'unknown';
}

function versionOf(releaseId: string): string {
  return db.releases.find(r => r.id === releaseId)?.version ?? '?';
}

const TASK_STATUS: Record<DeploymentState, TaskResponse['status']> = {
  PENDING: 'PENDING', VALIDATING: 'RUNNING', DEPLOYING: 'RUNNING', HEALTHY: 'SUCCEEDED', DEGRADED: 'SUCCEEDED', ROLLED_BACK: 'SUCCEEDED', FAILED: 'FAILED',
};

function seedDeployment(d: Db, spec: SeedDeployment, now: number) {
  const app = d.applications.find(a => a.name === spec.app)!;
  const release = d.releases.find(r => r.applicationId === app.id && r.version === spec.version)!;
  const c = now - spec.ago;
  const node = NODE_FOR_ENV[spec.env]!;
  const token = d.nodes.find(n => n.name === node)?.fencingToken ?? 1;
  const h: TimelineEvent[] = [{ at: iso(c), text: `Requested by ${spec.by}`, status: 'PENDING', actor: spec.by }];
  const reached = (s: DeploymentState) => {
    const order: DeploymentState[] = ['PENDING', 'VALIDATING', 'DEPLOYING', 'HEALTHY'];
    const idx: Record<DeploymentState, number> = { PENDING: 0, VALIDATING: 1, DEPLOYING: 2, HEALTHY: 3, DEGRADED: 3, ROLLED_BACK: 3, FAILED: 2 };
    return idx[spec.status] >= order.indexOf(s);
  };
  if (reached('VALIDATING')) h.push({ at: iso(c + 1.5 * SEC), text: 'Validation started', status: 'VALIDATING' });
  if (reached('DEPLOYING')) h.push({ at: iso(c + 4 * SEC), text: `Deploying to ${node}`, status: 'DEPLOYING' });
  let updated = h[h.length - 1]!.at;
  const taskId = sid(spec.n + 1000);
  const attempt = (n: number, status: Attempt['status'], start: number, end: number | null, message: string, permanent = false): Attempt => ({
    taskId, attempt: n, status, startedAt: iso(start), finishedAt: end === null ? null : iso(end), node, fencingToken: token, message, permanent,
  });
  if (spec.status === 'FAILED') {
    d.attempts.push(
      attempt(1, 'FAILED', c + 1.5 * SEC, c + 31 * SEC, 'Node did not answer within 30 s. TRANSIENT, retried after 4 s.'),
      attempt(2, 'FAILED', c + 35 * SEC, c + 65 * SEC, 'Node did not answer within 30 s. TRANSIENT, retried after 9 s.'),
      attempt(3, 'FAILED', c + 74 * SEC, c + 75 * SEC, 'Image pull denied. PERMANENT: sent to task.work.DLT.', true),
    );
    h.push({ at: iso(c + 75 * SEC), text: 'Failed after 3 attempts: image pull denied', status: 'FAILED' });
    updated = iso(c + 75 * SEC);
  } else if (spec.status === 'DEPLOYING') {
    d.attempts.push(
      attempt(1, 'FAILED', c + 1.5 * SEC, c + 31.5 * SEC, 'Node did not answer within 30 s. TRANSIENT, retried after 4 s.'),
      attempt(2, 'RUNNING', c + 35.5 * SEC, null, 'Starting containers.'),
    );
  } else if (spec.status === 'VALIDATING') {
    d.attempts.push(attempt(1, 'RUNNING', c + 1.5 * SEC, null, 'Checking the release checksum and image.'));
  } else if (spec.status !== 'PENDING') {
    d.attempts.push(attempt(1, 'SUCCEEDED', c + 1.5 * SEC, c + 40 * SEC, 'Health check passed.'));
    h.push({ at: iso(c + 40 * SEC), text: 'Health check passed', status: 'HEALTHY' });
    updated = iso(c + 40 * SEC);
    if (spec.status === 'DEGRADED' || spec.status === 'ROLLED_BACK') {
      const t = Math.min(c + 20 * MIN, now - 2 * MIN);
      h.push({ at: iso(t), text: '1 of 3 instances failing health checks', status: 'DEGRADED' });
      updated = iso(t);
    }
    if (spec.status === 'ROLLED_BACK') {
      const r = Math.min(c + 30 * MIN, now - 1 * MIN);
      h.push({ at: iso(r), text: `Rollback requested by ${spec.by}`, actor: spec.by });
      h.push({ at: iso(r + 40 * SEC), text: 'Rolled back: previous release restored', status: 'ROLLED_BACK' });
      updated = iso(r + 40 * SEC);
      d.tasks.push({ id: sid(spec.n + 2000), deploymentId: sid(spec.n), taskType: 'ROLLBACK', status: 'SUCCEEDED', createdAt: iso(r), updatedAt: iso(r + 40 * SEC) });
      d.attempts.push({ taskId: sid(spec.n + 2000), attempt: 1, status: 'SUCCEEDED', startedAt: iso(r), finishedAt: iso(r + 40 * SEC), node, fencingToken: token, message: 'Previous release restored.', permanent: false });
    }
  }
  d.tasks.push({ id: taskId, deploymentId: sid(spec.n), taskType: 'DEPLOY', status: TASK_STATUS[spec.status], createdAt: iso(c), updatedAt: updated });
  d.deployments.push({
    id: sid(spec.n), applicationId: app.id, releaseId: release.id, environment: spec.env, status: spec.status,
    createdAt: iso(c), updatedAt: updated, requestedBy: spec.by, correlationId: `c-${(0x7f3a91d2 + spec.n).toString(16)}`,
    node, history: h,
  });
}

// ---------- the clock ----------

const PHASES: Array<[number, DeploymentState]> = [[1500, 'VALIDATING'], [4000, 'DEPLOYING'], [9000, 'HEALTHY']];
const FAIL_AT_MS = 12000;
const ROLLBACK_MS = 5000;

function step(cid: string, service: string, text: string, at: number) {
  const list = db.correlation.get(cid) ?? [];
  list.push({ at: iso(at), service, text });
  db.correlation.set(cid, list);
}

function deployTask(dep: DbDeployment) {
  return db.tasks.find(t => t.deploymentId === dep.id && t.taskType === 'DEPLOY')!;
}

function moveTo(dep: DbDeployment, to: DeploymentState, at: number) {
  const node = db.nodes.find(n => n.name === dep.node);
  const token = node?.fencingToken ?? 1;
  const task = deployTask(dep);
  dep.status = to;
  dep.updatedAt = iso(at);
  task.updatedAt = iso(at);
  task.status = TASK_STATUS[to];
  if (to === 'VALIDATING') {
    dep.history.push({ at: iso(at), text: 'Validation started', status: to });
    db.attempts.push({ taskId: task.id, attempt: 1, status: 'RUNNING', startedAt: iso(at), finishedAt: null, node: dep.node, fencingToken: token, message: 'Checking the release checksum and image.', permanent: false });
    step(dep.correlationId, 'task-service', 'DEPLOY task claimed', at);
    step(dep.correlationId, `node-agent ${dep.node}, token ${token}`, 'Attempt 1 started', at);
  } else if (to === 'DEPLOYING') {
    dep.history.push({ at: iso(at), text: `Deploying to ${dep.node}`, status: to });
    const a = db.attempts.find(x => x.taskId === task.id && x.status === 'RUNNING');
    if (a) a.message = 'Starting containers.';
  } else if (to === 'HEALTHY') {
    dep.history.push({ at: iso(at), text: 'Health check passed', status: to });
    const a = db.attempts.find(x => x.taskId === task.id && x.status === 'RUNNING');
    if (a) Object.assign(a, { status: 'SUCCEEDED', finishedAt: iso(at), message: 'Health check passed.' });
    step(dep.correlationId, `node-agent ${dep.node}, token ${token}`, 'TaskSucceeded published to task.events', at);
    step(dep.correlationId, 'query-service', 'deployment_summary updated; dashboard cache evicted', at + 400);
  } else if (to === 'FAILED') {
    const a = db.attempts.find(x => x.taskId === task.id && x.status === 'RUNNING');
    if (a) Object.assign(a, { status: 'FAILED', finishedAt: iso(at - 3000), message: 'Node did not answer within 30 s. TRANSIENT, retried after 1 s.' });
    db.attempts.push({ taskId: task.id, attempt: 2, status: 'FAILED', startedAt: iso(at - 2000), finishedAt: iso(at), node: dep.node, fencingToken: token, message: 'Image pull denied. PERMANENT: sent to task.work.DLT.', permanent: true });
    dep.history.push({ at: iso(at), text: 'Failed after 2 attempts: image pull denied', status: to });
    db.deadLetters.unshift({ taskId: task.id, failedAt: iso(at), work: `${appName(dep.applicationId)} ${versionOf(dep.releaseId)} to ${dep.environment}`, taskType: 'DEPLOY', reason: 'Image pull denied (PERMANENT)', attempts: 2, replayed: false });
    step(dep.correlationId, `node-agent ${dep.node}, token ${token}`, 'Attempt 2 failed: image pull denied (PERMANENT)', at);
    step(dep.correlationId, 'task-service', 'Task DEAD; published to task.work.DLT', at + 100);
  } else if (to === 'ROLLED_BACK') {
    dep.history.push({ at: iso(at), text: 'Rolled back: previous release restored', status: to });
    const rb = db.tasks.find(t => t.deploymentId === dep.id && t.taskType === 'ROLLBACK' && t.status !== 'SUCCEEDED');
    if (rb) {
      Object.assign(rb, { status: 'SUCCEEDED', updatedAt: iso(at) });
      db.attempts.push({ taskId: rb.id, attempt: 1, status: 'SUCCEEDED', startedAt: rb.createdAt, finishedAt: iso(at), node: dep.node, fencingToken: node?.fencingToken ?? 1, message: 'Previous release restored.', permanent: false });
    }
    task.status = 'SUCCEEDED';
    step(dep.correlationId, `node-agent ${dep.node}, token ${token}`, 'Rollback finished', at);
  }
}

/** Advances simulated work to `now`. Every handler calls this first. */
export function tick(now: number = db.now()) {
  for (const dep of db.deployments) {
    if (dep.schedule && (dep.status === 'PENDING' || dep.status === 'VALIDATING' || dep.status === 'DEPLOYING')) {
      const elapsed = now - dep.schedule.start;
      if (dep.schedule.failPermanently) {
        if (dep.status === 'PENDING' && elapsed >= 1500) moveTo(dep, 'VALIDATING', dep.schedule.start + 1500);
        if (dep.status === 'VALIDATING' && elapsed >= 4000) moveTo(dep, 'DEPLOYING', dep.schedule.start + 4000);
        if (dep.status === 'DEPLOYING' && elapsed >= FAIL_AT_MS) moveTo(dep, 'FAILED', dep.schedule.start + FAIL_AT_MS);
      } else {
        for (const [at, state] of PHASES) {
          const order = ['PENDING', 'VALIDATING', 'DEPLOYING', 'HEALTHY'];
          if (elapsed >= at && order.indexOf(dep.status) < order.indexOf(state)) moveTo(dep, state, dep.schedule.start + at);
        }
      }
    }
    if (dep.rollbackAt && now >= dep.rollbackAt + ROLLBACK_MS && (dep.status === 'HEALTHY' || dep.status === 'DEGRADED')) {
      moveTo(dep, 'ROLLED_BACK', dep.rollbackAt + ROLLBACK_MS);
    }
  }
  for (const s of db.sessions) {
    if (s.status === 'STARTING' && now >= s.readyAt) {
      s.status = 'RUNNING';
      s.endpoint = `https://sessions.appfleet.internal/${s.sessionId}`;
      s.lastActivityAt = iso(now);
    }
  }
  for (const p of db.projections) {
    if (p.state === 'REBUILDING' && p.rebuildUntil && now >= p.rebuildUntil) {
      p.state = 'UP_TO_DATE';
      p.lagMs = 600;
      delete p.rebuildUntil;
    }
  }
}

// ---------- writes used by handlers ----------

export function createDeployment(input: { applicationId: string; releaseId: string; environment: string; requestedBy: string; correlationId: string }): DbDeployment {
  const now = db.now();
  const id = uuidv7(now);
  const release = db.releases.find(r => r.id === input.releaseId)!;
  const node = NODE_FOR_ENV[input.environment] ?? 'dev-node-01';
  const dep: DbDeployment = {
    id, applicationId: input.applicationId, releaseId: input.releaseId, environment: input.environment, status: 'PENDING',
    createdAt: iso(now), updatedAt: iso(now), requestedBy: input.requestedBy, correlationId: input.correlationId, node,
    history: [{ at: iso(now), text: `Requested by ${input.requestedBy}`, status: 'PENDING', actor: input.requestedBy }],
    // A release candidate whose image does not exist yet, so the failure path can be seen.
    schedule: { start: now, failPermanently: release.version.includes('-rc') },
  };
  db.deployments.push(dep);
  db.tasks.push({ id: uuidv7(now + 1), deploymentId: id, taskType: 'DEPLOY', status: 'PENDING', createdAt: iso(now), updatedAt: iso(now) });
  step(input.correlationId, 'control-api', 'Deployment requested; deployment, task and audit rows committed; replied 202 Accepted', now);
  step(input.correlationId, 'control-api', 'Outbox poller published to deployment.commands', now + 200);
  return dep;
}

export function recordAudit(row: Omit<AuditEventRow, 'id' | 'at' | 'sourceIp' | 'userAgent'>) {
  db.audit.unshift({ ...row, id: uuidv7(), at: iso(db.now()), sourceIp: '10.2.8.31', userAgent: globalThis.navigator?.userAgent?.slice(0, 40) ?? 'console' });
}

export function summaryRow(dep: DbDeployment): DeploymentSummaryRow {
  const app = db.applications.find(a => a.id === dep.applicationId)!;
  return {
    deploymentId: dep.id, applicationId: app.id, applicationName: app.name, teamId: app.ownerTeamId, teamName: teamName(app.ownerTeamId),
    releaseId: dep.releaseId, releaseVersion: versionOf(dep.releaseId), environment: dep.environment, status: dep.status,
    requestedBy: dep.requestedBy, requestedAt: dep.createdAt, updatedAt: dep.updatedAt,
    taskCount: db.tasks.filter(t => t.deploymentId === dep.id).length,
  };
}

export { appName, versionOf, iso, SEC, MIN, HOUR, DAY };

// ---------- lifecycle ----------

seed(Date.now());

/** Re-seed, for tests. Pass a clock to control time. */
export function resetDb(now: number = Date.now(), clock?: () => number) {
  db = seed(now);
  if (clock) db.now = clock;
}
