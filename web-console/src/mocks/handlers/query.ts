import { delay, http, type HttpResponseResolver } from 'msw';
import { apiMode } from '../../api/http';
import type { DashboardFilter, DeploymentState, WhereCell, WhereRow } from '../../api/types';
import { allows, db, ENV_ORDER, iso, summaryRow, tick, type DbDeployment } from '../db';
import { forbidden, intParam, json, notBuilt, notFound, page } from '../respond';

/**
 * query-service (planned S6). Reads lag the write side by about 1.5 s, as a projection would:
 * a deployment created in the last 1.5 s is not in these views yet, and every response carries asOf.
 * In hybrid mode the views tied to control-api data answer 501 instead of showing mock data
 * next to live data.
 */
const hybrid = apiMode === 'hybrid';
const PROJECTION_LAG_MS = 1500;

function lagNow() {
  const now = db.now();
  const lag = PROJECTION_LAG_MS + (now % 900);
  return { now, lag, asOf: iso(now - lag) };
}

function read(what: string | null, resolver: HttpResponseResolver): HttpResponseResolver {
  return async info => {
    if (hybrid && what) return notBuilt(info.request, what);
    await delay();
    tick();
    return resolver(info);
  };
}

/** Deployments the read model has caught up with and the caller may see. */
function projected(now: number): DbDeployment[] {
  return db.deployments
    .filter(d => new Date(d.createdAt).getTime() <= now - PROJECTION_LAG_MS)
    .filter(d => {
      const app = db.applications.find(a => a.id === d.applicationId);
      return app && allows('deployment:read', app.ownerTeamId);
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

const GROUPS: Record<DashboardFilter, DeploymentState[]> = {
  flight: ['PENDING', 'VALIDATING', 'DEPLOYING'],
  attention: ['DEGRADED', 'FAILED'],
  finished: ['HEALTHY', 'ROLLED_BACK'],
};

function where(now: number, applicationId?: string): WhereRow[] {
  const deps = projected(now);
  return db.applications
    .filter(a => allows('application:read', a.ownerTeamId) && (!applicationId || a.id === applicationId))
    .sort((a, b) => a.name.localeCompare(b.name))
    .map(app => {
      const cells: Record<string, WhereCell | undefined> = {};
      for (const env of ENV_ORDER) {
        const list = deps.filter(d => d.applicationId === app.id && d.environment === env);
        const latest = list[0];
        if (!latest) continue;
        const active = list.find(d => d.status !== 'FAILED' && d.status !== 'ROLLED_BACK');
        const shown = active ?? latest;
        const s = summaryRow(shown);
        const cell: WhereCell = { deploymentId: shown.id, releaseVersion: s.releaseVersion, status: shown.status, since: shown.updatedAt, requestedBy: shown.requestedBy };
        if (latest !== shown) {
          cell.latest = { deploymentId: latest.id, releaseVersion: summaryRow(latest).releaseVersion, status: latest.status };
        }
        cells[env] = cell;
      }
      return { applicationId: app.id, applicationName: app.name, teamId: app.ownerTeamId, teamName: db.teams.find(t => t.id === app.ownerTeamId)!.name, cells };
    });
}

export const queryHandlers = [
  http.get('/api/v1/dashboard/overview', read('query-service dashboard (S6)', ({ request }) => {
    const { now, asOf } = lagNow();
    const deps = projected(now);
    const count = (states: DeploymentState[]) => {
      const out: Partial<Record<DeploymentState, number>> = {};
      for (const d of deps) if (states.includes(d.status)) out[d.status] = (out[d.status] ?? 0) + 1;
      return out;
    };
    const rows = where(now);
    const withProd = rows.filter(r => r.cells.prod);
    return json(request, {
      asOf,
      inFlight: count(GROUPS.flight),
      attention: count(GROUPS.attention),
      prodHealthy: withProd.filter(r => r.cells.prod?.status === 'HEALTHY').length,
      prodTotal: withProd.length,
      sessionsRunning: db.otherSessionsRunning + db.sessions.filter(s => s.status === 'RUNNING').length,
    });
  })),

  http.get('/api/v1/dashboard/deployments', read('query-service dashboard (S6)', ({ request }) => {
    const { now, asOf } = lagNow();
    const url = new URL(request.url);
    const status = url.searchParams.get('status') as DashboardFilter | null;
    const teamId = url.searchParams.get('teamId');
    const rows = projected(now)
      .filter(d => !status || GROUPS[status]?.includes(d.status))
      .map(summaryRow)
      .filter(r => !teamId || r.teamId === teamId);
    return json(request, { asOf, ...page(rows, r => r.deploymentId, url.searchParams.get('cursor'), intParam(url, 'limit', 20)) });
  })),

  http.get('/api/v1/dashboard/where', read('query-service what-runs-where view (gap 3)', ({ request }) => {
    const { now, asOf } = lagNow();
    const applicationId = new URL(request.url).searchParams.get('applicationId') ?? undefined;
    if (applicationId && !db.applications.some(a => a.id === applicationId && allows('application:read', a.ownerTeamId))) {
      return notFound(request, `Application ${applicationId}`);
    }
    return json(request, { asOf, environments: ENV_ORDER, rows: where(now, applicationId) });
  })),

  http.get('/api/v1/applications/:id/history', read('query-service application history (S6)', ({ request, params }) => {
    const { now, asOf } = lagNow();
    const app = db.applications.find(a => a.id === params.id);
    if (!app || !allows('application:read', app.ownerTeamId)) return notFound(request, `Application ${String(params.id)}`);
    const items = projected(now).filter(d => d.applicationId === app.id);
    const recent = items.filter(d => now - new Date(d.createdAt).getTime() <= 30 * 24 * 3600 * 1000);
    return json(request, {
      asOf,
      last30Days: {
        total: recent.length,
        healthy: recent.filter(d => d.status === 'HEALTHY' || d.status === 'DEGRADED' || d.status === 'ROLLED_BACK').length,
        failed: recent.filter(d => d.status === 'FAILED').length,
        rolledBack: recent.filter(d => d.status === 'ROLLED_BACK').length,
      },
      items: items.slice(0, 20).map(summaryRow),
    });
  })),

  http.get('/api/v1/deployments/:id/timeline', read('query-service deployment timeline (S6)', ({ request, params }) => {
    const { asOf } = lagNow();
    const dep = db.deployments.find(d => d.id === params.id);
    const app = dep && db.applications.find(a => a.id === dep.applicationId);
    if (!dep || !app || !allows('deployment:read', app.ownerTeamId)) return notFound(request, `Deployment ${String(params.id)}`);
    const taskIds = new Set(db.tasks.filter(t => t.deploymentId === dep.id).map(t => t.id));
    const s = summaryRow(dep);
    return json(request, {
      asOf,
      deploymentId: dep.id,
      applicationName: s.applicationName,
      releaseVersion: s.releaseVersion,
      requestedBy: dep.requestedBy,
      correlationId: dep.correlationId,
      node: dep.node,
      events: dep.history,
      attempts: db.attempts.filter(a => taskIds.has(a.taskId)).sort((a, b) => a.startedAt.localeCompare(b.startedAt)),
    });
  })),

  http.get('/api/v1/fleet', read(null, ({ request }) => {
    if (!allows('fleet:read')) return forbidden(request, 'The fleet view needs OPERATOR.');
    const { now, asOf } = lagNow();
    const stuck = db.deployments
      .filter(d => !d.schedule && (d.status === 'DEPLOYING' || d.status === 'VALIDATING') && now - new Date(d.updatedAt).getTime() > 5 * 60_000)
      .map(d => {
        const task = db.tasks.find(t => t.deploymentId === d.id && t.taskType === 'DEPLOY')!;
        const s = summaryRow(d);
        return {
          taskId: task.id, deploymentId: d.id, title: `${s.applicationName} ${s.releaseVersion} to ${d.environment}`, taskType: task.taskType,
          runningSince: d.updatedAt, node: d.node, reason: `No progress for ${Math.round((now - new Date(d.updatedAt).getTime()) / 60_000)} min`,
        };
      });
    return json(request, {
      asOf,
      projectionLagMs: db.projections.find(p => p.name === 'fleet_view')!.lagMs,
      queueWaiting: 37 + db.deployments.filter(d => d.status === 'PENDING').length,
      nodes: db.nodes.map(n => ({ ...n, lastHeartbeatAt: n.state === 'STALE' ? n.lastHeartbeatAt : iso(now - 1000 - (now % 2000)) })),
      stuckTasks: stuck,
    });
  })),

  http.get('/admin/projections', read(null, ({ request }) => {
    if (!allows('fleet:read')) return forbidden(request, 'Projection status needs OPERATOR.');
    return json(request, db.projections.map(({ name, lagMs, state }) => ({ name, lagMs, state })));
  })),

  http.post('/admin/projections/:name/rebuild', read(null, ({ request, params }) => {
    if (!allows('projection:rebuild')) return forbidden(request, 'Rebuilding a projection needs OPERATOR.');
    const p = db.projections.find(x => x.name === params.name);
    if (!p) return notFound(request, `Projection ${String(params.name)}`);
    p.state = 'REBUILDING';
    p.rebuildUntil = db.now() + 4000;
    return json(request, { name: p.name, lagMs: p.lagMs, state: p.state }, { status: 202 });
  })),

  http.get('/api/v1/audit', read(null, ({ request }) => {
    if (!allows('audit:read')) return forbidden(request, 'The audit trail needs audit:read.');
    const { asOf } = lagNow();
    const url = new URL(request.url);
    const f = (k: string) => url.searchParams.get(k)?.trim().toLowerCase() ?? '';
    const actor = f('actor'), action = f('action'), object = f('object'), cid = f('cid');
    const rows = db.audit.filter(r =>
      (!actor || r.actor.toLowerCase().includes(actor)) &&
      (!action || r.action.toLowerCase() === action) &&
      (!object || r.object.toLowerCase().includes(object)) &&
      (!cid || r.correlationId.toLowerCase() === cid));
    return json(request, { asOf, ...page(rows, r => r.id, url.searchParams.get('cursor'), intParam(url, 'limit', 25)) });
  })),

  http.get('/api/v1/audit/correlation/:cid', read(null, ({ request, params }) => {
    if (!allows('audit:read')) return forbidden(request, 'The audit trail needs audit:read.');
    const steps = db.correlation.get(String(params.cid)) ?? [];
    return json(request, [...steps].sort((a, b) => a.at.localeCompare(b.at)));
  })),
];
