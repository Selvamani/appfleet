import { delay, http, passthrough, type HttpResponseResolver } from 'msw';
import { apiMode } from '../../api/http';
import type { CreateApplicationRequest, CreateDeploymentRequest, CreateReleaseRequest, DeploymentAccepted, RollbackAccepted } from '../../api/types';
import { uuidv7 } from '../../lib/uuid';
import { allows, appName, createDeployment, currentMe, db, iso, recordAudit, teamName, tick, versionOf } from '../db';
import { correlationOf, forbidden, intParam, json, notBuilt, notFound, page, problem } from '../respond';

/**
 * control-api. Built endpoints pass through to a live control-api in hybrid mode; gaps answer 501 there.
 * Validation rules and messages follow the Java request records and ApiExceptionHandler.
 */
const hybrid = apiMode === 'hybrid';

function built(resolver: HttpResponseResolver): HttpResponseResolver {
  return async info => {
    if (hybrid) return passthrough();
    await delay();
    tick();
    return resolver(info);
  };
}

function gap(what: string, resolver: HttpResponseResolver): HttpResponseResolver {
  return async info => {
    if (hybrid) return notBuilt(info.request, what);
    await delay();
    tick();
    return resolver(info);
  };
}

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const VERSION = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
const CHECKSUM = /^sha256:[0-9a-f]{64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY = /^[\x21-\x7e]{1,255}$/;
const ACTIVE = (status: string) => status !== 'FAILED' && status !== 'ROLLED_BACK';
/** How long a new key stays IN_PROGRESS: a copy arriving sooner gets 409 request-in-progress, as in S3.5. */
const IN_PROGRESS_MS = 400;

const visibleApp = (id: string) => {
  const app = db.applications.find(a => a.id === id);
  return app && allows('application:read', app.ownerTeamId) ? app : undefined;
};

function validationFailed(request: Request, errors: Array<{ field: string; message: string }>) {
  return problem(request, 400, 'validation-failed', 'Validation failed', 'One or more fields are invalid.', { errors });
}

function fingerprint(body: CreateDeploymentRequest): string {
  return JSON.stringify([body.applicationId, body.releaseId, body.environment]);
}

export const controlHandlers = [
  http.get('/api/v1/applications', built(({ request }) => {
    const url = new URL(request.url);
    const limit = intParam(url, 'limit', 20);
    if (limit > 100) return validationFailed(request, [{ field: 'limit', message: 'must be less than or equal to 100' }]);
    const items = db.applications.filter(a => allows('application:read', a.ownerTeamId)).sort((a, b) => a.id.localeCompare(b.id));
    return json(request, page(items, a => a.id, url.searchParams.get('cursor'), limit));
  })),

  http.post('/api/v1/applications', built(async ({ request }) => {
    const body = (await request.json()) as Partial<CreateApplicationRequest>;
    const errors = [];
    if (!body.name || !NAME.test(body.name)) errors.push({ field: 'name', message: 'must match "[a-z0-9][a-z0-9-]{0,62}"' });
    if (body.description && body.description.length > 1000) errors.push({ field: 'description', message: 'size must be between 0 and 1000' });
    if (!body.ownerTeamId) errors.push({ field: 'ownerTeamId', message: 'must not be null' });
    if (errors.length) return validationFailed(request, errors);
    if (!db.teams.some(t => t.id === body.ownerTeamId)) return problem(request, 422, 'unprocessable', 'Unprocessable request', `Team ${body.ownerTeamId} does not exist.`);
    if (!allows('application:create', body.ownerTeamId)) return forbidden(request, `Registering an application needs DEPLOYER on ${teamName(body.ownerTeamId!)}.`);
    if (db.applications.some(a => a.name === body.name)) {
      return problem(request, 409, 'conflict', 'Conflict', `An application named ${body.name} already exists.`);
    }
    const app = { id: uuidv7(), name: body.name!, description: body.description ?? null, ownerTeamId: body.ownerTeamId!, createdAt: iso(db.now()) };
    db.applications.push(app);
    recordAudit({ actor: currentMe().username, action: 'APPLICATION_CREATED', object: app.name, outcome: 'SUCCESS', correlationId: correlationOf(request) });
    return json(request, app, { status: 201, headers: { Location: `/api/v1/applications/${app.id}` } });
  })),

  http.get('/api/v1/applications/:id', built(({ request, params }) => {
    const app = visibleApp(String(params.id));
    return app ? json(request, app) : notFound(request, `Application ${String(params.id)}`);
  })),

  http.get('/api/v1/applications/:id/releases', gap('GET /api/v1/applications/{id}/releases (gap 1)', ({ request, params }) => {
    const app = visibleApp(String(params.id));
    if (!app) return notFound(request, `Application ${String(params.id)}`);
    const url = new URL(request.url);
    const items = db.releases.filter(r => r.applicationId === app.id).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return json(request, page(items, r => r.id, url.searchParams.get('cursor'), intParam(url, 'limit', 50)));
  })),

  http.post('/api/v1/applications/:id/releases', built(async ({ request, params }) => {
    const app = visibleApp(String(params.id));
    if (!app) return notFound(request, `Application ${String(params.id)}`);
    const body = (await request.json()) as Partial<CreateReleaseRequest>;
    const errors = [];
    if (!body.version || body.version.length > 64 || !VERSION.test(body.version)) errors.push({ field: 'version', message: 'must match "[A-Za-z0-9][A-Za-z0-9._+-]*" and be at most 64 characters' });
    if (!body.artifactRef?.trim() || body.artifactRef.length > 512) errors.push({ field: 'artifactRef', message: 'must not be blank' });
    if (!body.checksum || !CHECKSUM.test(body.checksum)) errors.push({ field: 'checksum', message: 'must match "sha256:[0-9a-f]{64}"' });
    if (errors.length) return validationFailed(request, errors);
    if (!allows('release:create', app.ownerTeamId)) return forbidden(request, `Registering a release needs DEPLOYER on ${teamName(app.ownerTeamId)}.`);
    if (db.releases.some(r => r.applicationId === app.id && r.version === body.version)) {
      return problem(request, 409, 'conflict', 'Conflict', `Release ${body.version} already exists for ${app.name}. Releases cannot be changed once registered.`);
    }
    const release = { id: uuidv7(), applicationId: app.id, version: body.version!, artifactRef: body.artifactRef!, checksum: body.checksum!, createdAt: iso(db.now()) };
    db.releases.push(release);
    recordAudit({ actor: currentMe().username, action: 'RELEASE_REGISTERED', object: `${app.name} ${release.version}`, outcome: 'SUCCESS', correlationId: correlationOf(request) });
    return json(request, release, { status: 201, headers: { Location: `/api/v1/applications/${app.id}/releases/${release.id}` } });
  })),

  http.get('/api/v1/applications/:id/releases/:releaseId', built(({ request, params }) => {
    const app = visibleApp(String(params.id));
    const release = app && db.releases.find(r => r.id === params.releaseId && r.applicationId === app.id);
    return release ? json(request, release) : notFound(request, `Release ${String(params.releaseId)}`);
  })),

  http.get('/api/v1/environments', gap('GET /api/v1/environments (gap 2)', ({ request }) => json(request, db.environments))),

  http.post('/api/v1/deployments', built(async ({ request }) => {
    const key = request.headers.get('Idempotency-Key');
    if (key !== null && !IDEMPOTENCY_KEY.test(key)) {
      return validationFailed(request, [{ field: 'Idempotency-Key', message: 'Must be 1 to 255 printable ASCII characters, without spaces.' }]);
    }
    const body = (await request.json()) as Partial<CreateDeploymentRequest>;
    const errors = [];
    if (!body.applicationId || !UUID.test(body.applicationId)) errors.push({ field: 'applicationId', message: 'must not be null' });
    if (!body.releaseId || !UUID.test(body.releaseId)) errors.push({ field: 'releaseId', message: 'must not be null' });
    if (!body.environment?.trim() || body.environment.length > 63) errors.push({ field: 'environment', message: 'must not be blank' });
    if (errors.length) return validationFailed(request, errors);
    const req = body as CreateDeploymentRequest;

    if (key) {
      const prior = db.idempotency.get(key);
      if (prior) {
        if (prior.fingerprint !== fingerprint(req)) {
          return problem(request, 422, 'idempotency-key-reused', 'Idempotency key reused',
            'This Idempotency-Key was already used with a different request body. Use a new key for a different request.');
        }
        if (db.now() < prior.completesAt) {
          return problem(request, 409, 'request-in-progress', 'Request in progress',
            'A request with this Idempotency-Key is still being processed. Retry shortly to get its result.', { retryAfter: 1 });
        }
        const dep = db.deployments.find(d => d.id === prior.deploymentId)!;
        const replay: DeploymentAccepted = { deploymentId: dep.id, taskId: prior.taskId, status: 'PENDING' };
        return json(request, replay, { status: 202, headers: { Location: `/api/v1/tasks/${prior.taskId}`, 'Idempotent-Replayed': 'true' } });
      }
    }

    const app = db.applications.find(a => a.id === req.applicationId);
    if (!app) return problem(request, 422, 'unprocessable', 'Unprocessable request', `Application ${req.applicationId} does not exist.`);
    if (!allows('application:read', app.ownerTeamId)) return notFound(request, `Application ${req.applicationId}`);
    if (!allows('deployment:create', app.ownerTeamId)) return forbidden(request, `Deploying ${app.name} needs DEPLOYER on ${teamName(app.ownerTeamId)}.`);
    const release = db.releases.find(r => r.id === req.releaseId);
    if (!release || release.applicationId !== app.id) {
      return problem(request, 422, 'unprocessable', 'Unprocessable request', `Release ${req.releaseId} does not belong to application ${app.name}.`);
    }
    if (!db.environments.some(e => e.name === req.environment)) {
      return problem(request, 422, 'unprocessable', 'Unprocessable request', `Environment ${req.environment} does not exist.`);
    }
    const active = db.deployments.find(d => d.applicationId === app.id && d.environment === req.environment && ACTIVE(d.status));
    if (active) {
      recordAudit({ actor: currentMe().username, action: 'DEPLOYMENT_REQUESTED', object: `${app.name} ${release.version} to ${req.environment}`, outcome: 'DENIED', correlationId: correlationOf(request) });
      return problem(request, 409, 'conflict', 'Conflict',
        `${app.name} already has an active deployment in ${req.environment} (${versionOf(active.releaseId)}, ${active.status}). Only one deployment per application and environment can be active.`);
    }

    const dep = createDeployment({ applicationId: app.id, releaseId: release.id, environment: req.environment, requestedBy: currentMe().username, correlationId: correlationOf(request) });
    const task = db.tasks.find(t => t.deploymentId === dep.id)!;
    if (key) db.idempotency.set(key, { fingerprint: fingerprint(req), deploymentId: dep.id, taskId: task.id, completesAt: db.now() + IN_PROGRESS_MS });
    recordAudit({ actor: currentMe().username, action: 'DEPLOYMENT_REQUESTED', object: `${app.name} ${release.version} to ${req.environment}`, outcome: 'ACCEPTED', correlationId: correlationOf(request) });
    const accepted: DeploymentAccepted = { deploymentId: dep.id, taskId: task.id, status: 'PENDING' };
    return json(request, accepted, { status: 202, headers: { Location: `/api/v1/tasks/${task.id}`, 'Idempotent-Replayed': 'false' } });
  })),

  http.get('/api/v1/deployments/:id', built(({ request, params }) => {
    const dep = db.deployments.find(d => d.id === params.id);
    if (!dep || !visibleApp(dep.applicationId)) return notFound(request, `Deployment ${String(params.id)}`);
    const { id, applicationId, releaseId, environment, status, createdAt, updatedAt } = dep;
    return json(request, { id, applicationId, releaseId, environment, status, createdAt, updatedAt });
  })),

  http.post('/api/v1/deployments/:id/rollback', built(({ request, params }) => {
    const dep = db.deployments.find(d => d.id === params.id);
    const app = dep && visibleApp(dep.applicationId);
    if (!dep || !app) return notFound(request, `Deployment ${String(params.id)}`);
    if (!allows('deployment:rollback', app.ownerTeamId)) return forbidden(request, `Rolling back ${app.name} needs DEPLOYER on ${teamName(app.ownerTeamId)}.`);
    if (dep.status !== 'HEALTHY' && dep.status !== 'DEGRADED') {
      return problem(request, 409, 'illegal-transition', 'Illegal state transition', `Cannot roll back a deployment in state ${dep.status}.`);
    }
    if (db.tasks.some(t => t.deploymentId === dep.id && t.taskType === 'ROLLBACK' && (t.status === 'PENDING' || t.status === 'RUNNING'))) {
      return problem(request, 409, 'conflict', 'Conflict', 'A rollback is already requested for this deployment.');
    }
    const now = db.now();
    const task = { id: uuidv7(now), deploymentId: dep.id, taskType: 'ROLLBACK', status: 'PENDING' as const, createdAt: iso(now), updatedAt: iso(now) };
    db.tasks.push(task);
    dep.rollbackAt = now;
    dep.history.push({ at: iso(now), text: `Rollback requested by ${currentMe().username}`, actor: currentMe().username });
    recordAudit({ actor: currentMe().username, action: 'ROLLBACK_REQUESTED', object: `${appName(dep.applicationId)} ${versionOf(dep.releaseId)} in ${dep.environment}`, outcome: 'ACCEPTED', correlationId: correlationOf(request) });
    const body: RollbackAccepted = { deploymentId: dep.id, taskId: task.id };
    return json(request, body, { status: 202, headers: { Location: `/api/v1/tasks/${task.id}` } });
  })),

  http.get('/api/v1/deployments/:id/tasks', built(({ request, params }) => {
    const dep = db.deployments.find(d => d.id === params.id);
    if (!dep || !visibleApp(dep.applicationId)) return notFound(request, `Deployment ${String(params.id)}`);
    const url = new URL(request.url);
    const items = db.tasks.filter(t => t.deploymentId === dep.id).sort((a, b) => a.id.localeCompare(b.id));
    return json(request, page(items, t => t.id, url.searchParams.get('cursor'), intParam(url, 'limit', 20)));
  })),

  http.get('/api/v1/tasks/:id', built(({ request, params }) => {
    const task = db.tasks.find(t => t.id === params.id);
    const dep = task && db.deployments.find(d => d.id === task.deploymentId);
    if (!task || !dep || !visibleApp(dep.applicationId)) return notFound(request, `Task ${String(params.id)}`);
    return json(request, task);
  })),

  http.get('/api/v1/catalogue/images', gap('GET /api/v1/catalogue/images (planned catalogue module)', ({ request }) => json(request, db.catalogue))),
];
