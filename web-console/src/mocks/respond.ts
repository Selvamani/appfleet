import { HttpResponse } from 'msw';
import type { FieldError } from '../api/http';

export function correlationOf(request: Request): string {
  return request.headers.get('X-Correlation-Id') ?? 'c-mock';
}

/** JSON success response that echoes the correlation id, like CorrelationIdFilter does. */
export function json(request: Request, body: unknown, init: { status?: number; headers?: Record<string, string> } = {}) {
  return new HttpResponse(body === undefined ? null : JSON.stringify(body), {
    status: init.status ?? 200,
    headers: {
      'Content-Type': 'application/json',
      'X-Correlation-Id': correlationOf(request),
      ...init.headers,
    },
  });
}

/** RFC 7807 ProblemDetail in control-api's exact shape (ApiExceptionHandler). */
export function problem(
  request: Request,
  status: number,
  slug: string,
  title: string,
  detail: string,
  extra: { errors?: FieldError[]; retryAfter?: number } = {},
) {
  const cid = correlationOf(request);
  const body: Record<string, unknown> = {
    type: `urn:appfleet:problem:${slug}`,
    title,
    status,
    detail,
    instance: new URL(request.url).pathname,
    correlationId: cid,
  };
  if (extra.errors) body.errors = extra.errors;
  const headers: Record<string, string> = { 'Content-Type': 'application/problem+json', 'X-Correlation-Id': cid };
  if (extra.retryAfter !== undefined) headers['Retry-After'] = String(extra.retryAfter);
  return new HttpResponse(JSON.stringify(body), { status, headers });
}

export const notFound = (request: Request, what: string) =>
  problem(request, 404, 'not-found', 'Not found', `${what} not found.`);

/** Proposed S4 behaviour for a visible object the caller may not change. */
export const forbidden = (request: Request, detail: string) =>
  problem(request, 403, 'forbidden', 'Forbidden', detail);

/** Hybrid mode: an endpoint the live backend does not have yet. */
export const notBuilt = (request: Request, what: string) =>
  problem(request, 501, 'not-implemented', 'Not implemented', `${what} is not built yet. See docs/design/ux/web-console-react-plan.md §10.1.`);

/** Cursor pages over an array already in display order. The cursor is the last item's id, base64url. */
export function page<T>(items: T[], idOf: (t: T) => string, cursor: string | null, limit: number) {
  let start = 0;
  if (cursor) {
    const lastId = atob(cursor.replace(/-/g, '+').replace(/_/g, '/'));
    const idx = items.findIndex(i => idOf(i) === lastId);
    start = idx >= 0 ? idx + 1 : items.length;
  }
  const slice = items.slice(start, start + limit);
  const more = start + limit < items.length;
  const last = slice[slice.length - 1];
  const nextCursor = more && last ? btoa(idOf(last)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') : null;
  return { items: slice, nextCursor };
}

export function intParam(url: URL, name: string, fallback: number): number {
  const v = Number(url.searchParams.get(name));
  return Number.isFinite(v) && v > 0 ? v : fallback;
}
