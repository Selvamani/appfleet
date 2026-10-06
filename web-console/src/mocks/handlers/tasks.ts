import { delay, http, type HttpResponseResolver } from 'msw';
import { allows, currentMe, db, recordAudit, tick } from '../db';
import { correlationOf, forbidden, json, notFound, page, problem } from '../respond';

/** task-service (planned S4, S7): dead letters, replay, stale-claim reclaim. Mocked in both modes. */

function handler(resolver: HttpResponseResolver): HttpResponseResolver {
  return async info => {
    await delay();
    tick();
    return resolver(info);
  };
}

export const taskHandlers = [
  http.get('/api/v1/dlq', handler(({ request }) => {
    if (!allows('fleet:read')) return forbidden(request, 'The dead-letter queue needs OPERATOR.');
    const url = new URL(request.url);
    return json(request, page(db.deadLetters, d => d.taskId, url.searchParams.get('cursor'), 25));
  })),

  http.post('/api/v1/dlq/:taskId/replay', handler(({ request, params }) => {
    if (!allows('dlq:replay')) return forbidden(request, 'Replaying dead letters needs OPERATOR.');
    const item = db.deadLetters.find(d => d.taskId === params.taskId);
    if (!item) return notFound(request, `Dead letter ${String(params.taskId)}`);
    if (item.replayed) return problem(request, 409, 'conflict', 'Conflict', 'This message was already replayed and is back in task.work.');
    item.replayed = true;
    recordAudit({ actor: currentMe().username, action: 'DLQ_REPLAYED', object: `task ${item.taskId.slice(0, 8)}, ${item.work}`, outcome: 'SUCCESS', correlationId: correlationOf(request) });
    return json(request, item);
  })),

  http.post('/api/v1/dlq/stuck/:taskId/reclaim', handler(({ request, params }) => {
    if (!allows('task:reclaim')) return forbidden(request, 'Reclaiming tasks needs OPERATOR.');
    const task = db.tasks.find(t => t.id === params.taskId);
    const dep = task && db.deployments.find(d => d.id === task.deploymentId);
    if (!task || !dep) return notFound(request, `Task ${String(params.taskId)}`);
    if (dep.schedule || (dep.status !== 'DEPLOYING' && dep.status !== 'VALIDATING')) {
      return problem(request, 409, 'conflict', 'Conflict', 'This task is not stuck any more.');
    }
    // The stale claim is released; another worker picks the task up and finishes the deployment.
    dep.schedule = { start: db.now() - 4000, failPermanently: false };
    recordAudit({ actor: currentMe().username, action: 'TASK_RECLAIMED', object: `task ${task.id.slice(0, 8)} on ${dep.node}`, outcome: 'SUCCESS', correlationId: correlationOf(request) });
    return json(request, undefined, { status: 204 });
  })),
];
