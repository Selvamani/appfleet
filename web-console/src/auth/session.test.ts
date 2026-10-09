import { http, HttpResponse } from 'msw';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { request } from '../api/http';
import { fakeJwt } from '../test/jwt';
import { server } from '../test/server';
import { accessToken, endSession, getSession, initSession, onSessionEvent, refreshNow, signOut, startSession, type SessionEvent } from './session';

function access(jti: string, secondsFromNow = 900) {
  const now = Math.floor(Date.now() / 1000);
  return fakeJwt({ iss: 'appfleet-identity', sub: 'u1', aud: ['appfleet'], jti, iat: now, exp: now + secondsFromNow });
}

function tokens(n: number, secondsFromNow = 900) {
  return { accessToken: access(`jti-${n}`, secondsFromNow), refreshToken: `refresh-${n}`, tokenType: 'Bearer', expiresIn: secondsFromNow };
}

function problem(status: number, slug: string) {
  return HttpResponse.json({ type: `urn:appfleet:problem:${slug}`, title: slug, status, detail: slug },
    { status, headers: { 'Content-Type': 'application/problem+json' } });
}

/** A service that accepts only the access token it was last given, and counts refreshes. */
function fakeServices() {
  const state = { refreshCalls: 0, authorizations: [] as Array<string | null>, current: '' };
  server.use(
    http.get('/api/v1/ping', ({ request: r }) => {
      state.authorizations.push(r.headers.get('Authorization'));
      return r.headers.get('Authorization') === `Bearer ${state.current}` ? HttpResponse.json({ ok: true }) : problem(401, 'unauthorized');
    }),
    http.post('/api/v1/auth/refresh', async ({ request: r }) => {
      state.refreshCalls += 1;
      const body = (await r.json()) as { refreshToken: string };
      if (body.refreshToken !== `refresh-${state.refreshCalls}`) return problem(401, 'unauthorized');   // each token works once
      await new Promise(resolve => setTimeout(resolve, 20));
      const next = tokens(state.refreshCalls + 1);
      state.current = next.accessToken;
      return HttpResponse.json(next);
    }),
    http.post('/api/v1/auth/login', ({ request: r }) => {
      state.authorizations.push(r.headers.get('Authorization'));
      return HttpResponse.json(tokens(1));
    }),
    http.post('/api/v1/auth/logout', () => new HttpResponse(null, { status: 204 })),
  );
  return state;
}

describe('session', () => {
  beforeEach(() => {
    sessionStorage.clear();
    initSession('hybrid');
  });
  afterEach(() => { vi.useRealTimers(); });

  it('holds the session, exposes the token, and forgets it', () => {
    expect(getSession()).toBeNull();
    startSession(tokens(1), ' Ada@Example.io ');
    expect(getSession()?.email).toBe('ada@example.io');
    expect(accessToken()).toBe(tokens(1).accessToken.length ? getSession()!.tokens.accessToken : '');
    expect(getSession()?.claims.sub).toBe('u1');
    endSession();
    expect(getSession()).toBeNull();
    expect(accessToken()).toBeUndefined();
  });

  it('refuses a token it cannot read', () => {
    expect(startSession({ accessToken: 'garbage', refreshToken: 'r', tokenType: 'Bearer', expiresIn: 900 }, 'a@b.io')).toBe(false);
    expect(getSession()).toBeNull();
  });

  it('sends the access token on every request, and no token without a session', async () => {
    const svc = fakeServices();
    await request('/api/v1/ping').catch(() => undefined);
    const first = startSession(tokens(1), 'a@b.io');
    svc.current = getSession()!.tokens.accessToken;
    await request('/api/v1/ping');
    expect(first).toBe(true);
    expect(svc.authorizations[0]).toBeNull();
    expect(svc.authorizations[1]).toBe(`Bearer ${svc.current}`);
  });

  it('does not attach the session token to the sign-in endpoints', async () => {
    const svc = fakeServices();
    startSession(tokens(1), 'a@b.io');
    const { login } = await import('../api/auth');
    await login('a@b.io', 'whatever');
    expect(svc.authorizations).toEqual([null]);
  });

  it('refreshes once on a 401 and repeats the request with the new token', async () => {
    const svc = fakeServices();
    startSession(tokens(1), 'a@b.io');          // the server will not accept this token (current is empty)
    const events: SessionEvent[] = [];
    onSessionEvent(e => events.push(e));
    await expect(request('/api/v1/ping')).resolves.toEqual({ ok: true });
    expect(svc.refreshCalls).toBe(1);
    expect(getSession()?.tokens.refreshToken).toBe('refresh-2');
    expect(events).toEqual([expect.objectContaining({ kind: 'refreshed', reason: 'rejected', usedRefreshToken: 'refresh-1' })]);
  });

  /** The guard that matters: two parallel refreshes with one token would make the service revoke the whole session. */
  it('shares ONE refresh between parallel requests that are all refused', async () => {
    const svc = fakeServices();
    startSession(tokens(1), 'a@b.io');
    const answers = await Promise.all([request('/api/v1/ping'), request('/api/v1/ping'), request('/api/v1/ping')]);
    expect(answers).toHaveLength(3);
    expect(svc.refreshCalls).toBe(1);
  });

  it('does not loop: a second 401 after the retry is the answer', async () => {
    const svc = fakeServices();
    server.use(http.get('/api/v1/always-401', () => problem(401, 'unauthorized')));
    startSession(tokens(1), 'a@b.io');
    await expect(request('/api/v1/always-401')).rejects.toMatchObject({ status: 401 });
    expect(svc.refreshCalls).toBe(1);
  });

  it('ends the session when the refresh is refused, and the original request fails with 401', async () => {
    fakeServices();
    server.use(http.post('/api/v1/auth/refresh', () => problem(401, 'unauthorized')));
    startSession(tokens(1), 'a@b.io');
    const events: SessionEvent[] = [];
    onSessionEvent(e => events.push(e));
    await expect(request('/api/v1/ping')).rejects.toMatchObject({ status: 401 });
    expect(getSession()).toBeNull();
    expect(events.map(e => e.kind)).toEqual(['refresh-failed', 'ended']);
    expect(events[0]).toMatchObject({ kind: 'refresh-failed', ended: true, status: 401 });
  });

  it('keeps the session when the refresh could not reach the server', async () => {
    fakeServices();
    server.use(http.post('/api/v1/auth/refresh', () => HttpResponse.error()));
    startSession(tokens(1), 'a@b.io');
    const token = await refreshNow('manual');
    expect(token).toBeUndefined();
    expect(getSession()).not.toBeNull();
  });

  it('does not retry a request that carries its own bearer token', async () => {
    const svc = fakeServices();
    startSession(tokens(1), 'a@b.io');
    await expect(request('/api/v1/ping', { bearer: 'someone.elses.token' })).rejects.toMatchObject({ status: 401 });
    expect(svc.refreshCalls).toBe(0);
  });

  it('refreshes by itself shortly before the access token expires', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const svc = fakeServices();
    startSession(tokens(1, 100), 'a@b.io');      // 100 s left: the refresh is due at 40 s
    const events: SessionEvent[] = [];
    onSessionEvent(e => events.push(e));
    await vi.advanceTimersByTimeAsync(30_000);
    expect(svc.refreshCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(12_000);
    expect(svc.refreshCalls).toBe(1);
    expect(events[0]).toMatchObject({ kind: 'refreshed', reason: 'expiring' });
  });

  it('signs out at the server and forgets the session, returning the token that was alive', async () => {
    fakeServices();
    let logoutBody: unknown;
    server.use(http.post('/api/v1/auth/logout', async ({ request: r }) => { logoutBody = await r.json(); return new HttpResponse(null, { status: 204 }); }));
    startSession(tokens(1), 'a@b.io');
    const alive = getSession()!.tokens.accessToken;
    expect(await signOut()).toBe(alive);
    expect(logoutBody).toEqual({ refreshToken: 'refresh-1' });
    expect(getSession()).toBeNull();
  });

  it('keeps a development copy in sessionStorage and restores it after a reload', () => {
    startSession(tokens(1), 'a@b.io');
    expect(sessionStorage.getItem('appfleet.session')).toContain('refresh-1');
    const copy = sessionStorage.getItem('appfleet.session')!;
    endSession();
    expect(sessionStorage.getItem('appfleet.session')).toBeNull();
    sessionStorage.setItem('appfleet.session', copy);
    initSession('hybrid');
    expect(getSession()?.email).toBe('a@b.io');
  });

  it('ignores a damaged stored copy', () => {
    sessionStorage.setItem('appfleet.session', '{not json');
    initSession('hybrid');
    expect(getSession()).toBeNull();
  });

  it('does nothing in simulated mode: no token is attached and a 401 is just a 401', async () => {
    initSession('mock');
    const svc = fakeServices();
    startSession(tokens(1), 'a@b.io');
    await expect(request('/api/v1/ping')).rejects.toMatchObject({ status: 401 });
    expect(svc.authorizations).toEqual([null]);
    expect(svc.refreshCalls).toBe(0);
  });
});