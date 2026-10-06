import { delay, http, type HttpResponseResolver } from 'msw';
import type { SessionResponse } from '../../api/types';
import { uuidv7 } from '../../lib/uuid';
import { allows, currentMe, db, iso, ME_ID, recordAudit, tick } from '../db';
import { correlationOf, forbidden, json, notFound, problem } from '../respond';

/** node-agent (planned S5): tool sessions and node drain. Mocked in both modes. */

function handler(resolver: HttpResponseResolver): HttpResponseResolver {
  return async info => {
    await delay();
    tick();
    return resolver(info);
  };
}

const WARM_MS = 1500;
const COLD_MS = 6000;
const MAX_SESSIONS = 3;

function view(s: (typeof db.sessions)[number]): SessionResponse {
  const { ownerId: _owner, readyAt: _ready, ...rest } = s;
  void _owner;
  void _ready;
  return rest;
}

export const agentHandlers = [
  http.get('/api/v1/sessions', handler(({ request }) =>
    json(request, db.sessions.filter(s => s.ownerId === ME_ID && s.status !== 'ENDED').map(view)))),

  http.post('/api/v1/sessions', handler(async ({ request }) => {
    if (!allows('session:use')) return forbidden(request, 'Starting tool sessions needs a role on a team.');
    const body = (await request.json()) as { appImageId?: string };
    const image = db.catalogue.find(c => c.id === body.appImageId);
    if (!image) return problem(request, 422, 'unprocessable', 'Unprocessable request', `Catalogue image ${body.appImageId} does not exist.`);
    const mine = db.sessions.filter(s => s.ownerId === ME_ID && s.status !== 'ENDED');
    if (mine.length >= MAX_SESSIONS) {
      return problem(request, 409, 'conflict', 'Conflict', `You already have ${MAX_SESSIONS} sessions open. End one to start another.`);
    }
    const now = db.now();
    const session = {
      sessionId: uuidv7(now), appImageId: image.id, toolName: image.name, version: image.version, status: 'STARTING' as const,
      startedAt: iso(now), lastActivityAt: iso(now), endpoint: null, startMode: image.warmPool ? 'warm' as const : 'cold' as const,
      ownerId: ME_ID, readyAt: now + (image.warmPool ? WARM_MS : COLD_MS),
    };
    db.sessions.unshift(session);
    recordAudit({ actor: currentMe().username, action: 'SESSION_STARTED', object: `${image.name} ${image.version}`, outcome: 'SUCCESS', correlationId: correlationOf(request) });
    return json(request, { sessionId: session.sessionId, endpoint: null }, { status: 201, headers: { Location: `/api/v1/sessions/${session.sessionId}` } });
  })),

  http.get('/api/v1/sessions/:id', handler(({ request, params }) => {
    const s = db.sessions.find(x => x.sessionId === params.id && x.ownerId === ME_ID);
    return s ? json(request, view(s)) : notFound(request, `Session ${String(params.id)}`);
  })),

  http.delete('/api/v1/sessions/:id', handler(({ request, params }) => {
    const s = db.sessions.find(x => x.sessionId === params.id && x.ownerId === ME_ID);
    if (!s) return notFound(request, `Session ${String(params.id)}`);
    s.status = 'ENDED';
    recordAudit({ actor: currentMe().username, action: 'SESSION_ENDED', object: `${s.toolName} ${s.version}`, outcome: 'SUCCESS', correlationId: correlationOf(request) });
    return json(request, undefined, { status: 204 });
  })),

  http.post('/api/v1/nodes/:id/drain', handler(({ request, params }) => {
    if (!allows('node:drain')) return forbidden(request, 'Draining a node needs OPERATOR.');
    const node = db.nodes.find(n => n.id === params.id);
    if (!node) return notFound(request, `Node ${String(params.id)}`);
    if (node.state === 'DRAINING') return problem(request, 409, 'conflict', 'Conflict', `${node.name} is already draining.`);
    node.state = 'DRAINING';
    recordAudit({ actor: currentMe().username, action: 'NODE_DRAINED', object: node.name, outcome: 'SUCCESS', correlationId: correlationOf(request) });
    return json(request, undefined, { status: 204 });
  })),
];
