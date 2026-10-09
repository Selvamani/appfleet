import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { server } from '../test/server';
import { ApiError, request, requestRaw, retryIfInProgress } from './http';
import { describeError } from '../lib/errorText';

describe('http', () => {
  it('sends a fresh correlation id on every request', async () => {
    const seen: string[] = [];
    server.use(http.get('/api/v1/ping', ({ request: r }) => {
      seen.push(r.headers.get('X-Correlation-Id') ?? '');
      return HttpResponse.json({ ok: true });
    }));
    await request('/api/v1/ping');
    await request('/api/v1/ping');
    expect(seen[0]).toBeTruthy();
    expect(seen[0]).not.toBe(seen[1]);
  });

  it('sends a bearer token only when one is given', async () => {
    const seen: Array<string | null> = [];
    server.use(http.get('/api/v1/ping', ({ request: r }) => {
      seen.push(r.headers.get('Authorization'));
      return HttpResponse.json({ ok: true });
    }));
    await request('/api/v1/ping');
    await request('/api/v1/ping', { bearer: 'abc.def.ghi' });
    expect(seen).toEqual([null, 'Bearer abc.def.ghi']);
  });

  it('turns a ProblemDetail into an ApiError with the slug as type', async () => {
    server.use(http.post('/api/v1/thing', () => HttpResponse.json({
      type: 'urn:appfleet:problem:conflict', title: 'Conflict', status: 409, detail: 'Already active.', correlationId: 'c-1',
    }, { status: 409, headers: { 'Content-Type': 'application/problem+json' } })));
    const err = await request('/api/v1/thing', { method: 'POST', body: {} }).catch(e => e) as ApiError;
    expect(err).toBeInstanceOf(ApiError);
    expect(err.type).toBe('conflict');
    expect(err.detail).toBe('Already active.');
    expect(err.correlationId).toBe('c-1');
  });

  it('keeps field errors and Retry-After', async () => {
    server.use(http.post('/api/v1/thing', () => HttpResponse.json({
      type: 'urn:appfleet:problem:validation-failed', title: 'Validation failed', status: 400, detail: 'x',
      errors: [{ field: 'version', message: 'must match' }],
    }, { status: 400, headers: { 'Content-Type': 'application/problem+json', 'Retry-After': '3' } })));
    const err = await request('/api/v1/thing', { method: 'POST', body: {} }).catch(e => e) as ApiError;
    expect(err.errors).toEqual([{ field: 'version', message: 'must match' }]);
    expect(err.retryAfter).toBe(3);
  });

  it('falls back to a slug from the status for non-JSON errors', async () => {
    server.use(http.get('/api/v1/html', () => new HttpResponse('<html>Bad Request</html>', { status: 400, headers: { 'Content-Type': 'text/html' } })));
    const err = await request('/api/v1/html').catch(e => e) as ApiError;
    expect(err.type).toBe('malformed-request');
    expect(describeError(err).title).toBe('The request could not be understood');
  });

  it('retries once after Retry-After when the same keyed request is still in progress', async () => {
    let calls = 0;
    server.use(http.post('/api/v1/keyed', () => {
      calls++;
      if (calls === 1) {
        return HttpResponse.json({ type: 'urn:appfleet:problem:request-in-progress', title: 'Request in progress', status: 409, detail: 'Still running.' },
          { status: 409, headers: { 'Content-Type': 'application/problem+json', 'Retry-After': '0' } });
      }
      return HttpResponse.json({ ok: true }, { status: 202 });
    }));
    const result = await retryIfInProgress(() => request<{ ok: boolean }>('/api/v1/keyed', { method: 'POST', body: {}, idempotencyKey: 'k-2' }));
    expect(result).toEqual({ ok: true });
    expect(calls).toBe(2);
  });

  it('does not retry other errors', async () => {
    let calls = 0;
    server.use(http.post('/api/v1/keyed', () => {
      calls++;
      return HttpResponse.json({ type: 'urn:appfleet:problem:conflict', title: 'Conflict', status: 409, detail: 'Active.' },
        { status: 409, headers: { 'Content-Type': 'application/problem+json' } });
    }));
    const err = await retryIfInProgress(() => request('/api/v1/keyed', { method: 'POST', body: {} })).catch(e => e) as ApiError;
    expect(err.type).toBe('conflict');
    expect(calls).toBe(1);
  });

  it('sends the Idempotency-Key header when given and exposes response headers', async () => {
    let key: string | null = null;
    server.use(http.post('/api/v1/deploy', ({ request: r }) => {
      key = r.headers.get('Idempotency-Key');
      return HttpResponse.json({ id: 1 }, { status: 202, headers: { Location: '/api/v1/tasks/t1' } });
    }));
    const res = await requestRaw('/api/v1/deploy', { method: 'POST', body: {}, idempotencyKey: 'k-1' });
    expect(key).toBe('k-1');
    expect(res.status).toBe(202);
    expect(res.headers.get('Location')).toBe('/api/v1/tasks/t1');
  });
});
