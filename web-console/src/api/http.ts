import { randomKey } from '../lib/uuid';

export type ApiMode = 'mock' | 'hybrid';

/** 'mock': MSW answers everything. 'hybrid': built control-api endpoints go to a live control-api. */
export const apiMode: ApiMode = import.meta.env.VITE_API_MODE === 'hybrid' ? 'hybrid' : 'mock';

const PROBLEM_PREFIX = 'urn:appfleet:problem:';

/** Fallback slug when the server sent no ProblemDetail (for example Tomcat's HTML 400). */
function slugForStatus(status: number): string {
  switch (status) {
    case 0: return 'network';
    case 400: return 'malformed-request';
    case 401: return 'unauthenticated';
    case 403: return 'forbidden';
    case 404: return 'not-found';
    case 409: return 'conflict';
    case 422: return 'unprocessable';
    case 429: return 'rate-limited';
    case 501: return 'not-implemented';
    case 503: return 'service-unavailable';
    default: return status >= 500 ? 'internal-error' : 'unknown';
  }
}

export interface FieldError {
  field: string;
  message: string;
}

/**
 * Every non-2xx response becomes one ApiError. Screens switch on `type` (the slug), never on `detail`.
 * See plan §8.1 for the treatment of each slug.
 */
export class ApiError extends Error {
  readonly status: number;
  /** Slug from `urn:appfleet:problem:<slug>`, or a fallback derived from the status. */
  readonly type: string;
  readonly title: string;
  readonly detail: string;
  readonly correlationId: string;
  readonly errors: FieldError[];
  /** Seconds from the Retry-After header, when present. */
  readonly retryAfter: number | null;

  constructor(init: {
    status: number; type: string; title: string; detail: string; correlationId: string;
    errors?: FieldError[]; retryAfter?: number | null;
  }) {
    super(init.detail || init.title);
    this.name = 'ApiError';
    this.status = init.status;
    this.type = init.type;
    this.title = init.title;
    this.detail = init.detail;
    this.correlationId = init.correlationId;
    this.errors = init.errors ?? [];
    this.retryAfter = init.retryAfter ?? null;
  }

  is(...slugs: string[]): boolean {
    return slugs.includes(this.type);
  }
}

export function isApiError(e: unknown): e is ApiError {
  return e instanceof ApiError;
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  body?: unknown;
  query?: Record<string, string | number | boolean | null | undefined>;
  idempotencyKey?: string;
  /**
   * Sent as `Authorization: Bearer <token>` instead of the session's token. The caller owns this token, so a 401 is
   * not retried: the sign-in screen uses it to show exactly what a service says about a token.
   */
  bearer?: string;
  /** Sends no Authorization header and never refreshes: for the sign-in endpoints themselves. */
  anonymous?: boolean;
  signal?: AbortSignal;
}

export interface ApiResponse<T> {
  data: T;
  status: number;
  headers: Headers;
  correlationId: string;
}

function buildUrl(path: string, query?: RequestOptions['query']): string {
  if (!query) return path;
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v !== undefined && v !== null && v !== '') params.set(k, String(v));
  }
  const qs = params.toString();
  return qs ? `${path}?${qs}` : path;
}

async function toApiError(res: Response, sentCorrelationId: string): Promise<ApiError> {
  const correlationId = res.headers.get('X-Correlation-Id') ?? sentCorrelationId;
  const retryHeader = res.headers.get('Retry-After');
  const retryAfter = retryHeader !== null && !Number.isNaN(Number(retryHeader)) ? Number(retryHeader) : null;
  const contentType = res.headers.get('Content-Type') ?? '';
  if (contentType.includes('json')) {
    try {
      const p = (await res.json()) as Record<string, unknown>;
      const rawType = typeof p.type === 'string' ? p.type : '';
      return new ApiError({
        status: res.status,
        type: rawType.startsWith(PROBLEM_PREFIX) ? rawType.slice(PROBLEM_PREFIX.length) : slugForStatus(res.status),
        title: typeof p.title === 'string' ? p.title : res.statusText,
        detail: typeof p.detail === 'string' ? p.detail : '',
        correlationId: typeof p.correlationId === 'string' ? p.correlationId : correlationId,
        errors: Array.isArray(p.errors) ? (p.errors as FieldError[]) : [],
        retryAfter,
      });
    } catch {
      // fall through to the generic error
    }
  }
  return new ApiError({
    status: res.status,
    type: slugForStatus(res.status),
    title: res.statusText || 'Request failed',
    detail: `The server answered ${res.status} without an error body.`,
    correlationId,
    retryAfter,
  });
}

/**
 * What the request layer needs from the session, without importing it (the session imports this file).
 * Installed once at start-up by auth/session.ts; absent in mock mode and in tests that do not sign in.
 */
export interface AuthHooks {
  /** The access token to send, or undefined when nobody is signed in. */
  token(): string | undefined;
  /** A new access token after a 401, one refresh at a time; undefined when there is none to be had. */
  refresh(): Promise<string | undefined>;
}

let authHooks: AuthHooks | undefined;

export function configureAuth(hooks: AuthHooks | undefined): void {
  authHooks = hooks;
}

/**
 * The only function that calls fetch. Sends a fresh X-Correlation-Id on every request and keeps the
 * value the server echoes, so every error can link to its audit trail.
 *
 * With a session it also sends the access token, and on a 401 asks the session for a new one and repeats the
 * request ONCE. A second 401 is the answer.
 */
export function requestRaw<T>(path: string, opts: RequestOptions = {}): Promise<ApiResponse<T>> {
  return send<T>(path, opts, false);
}

async function send<T>(path: string, opts: RequestOptions, retried: boolean): Promise<ApiResponse<T>> {
  const correlationId = randomKey();
  const headers: Record<string, string> = { Accept: 'application/json, application/problem+json', 'X-Correlation-Id': correlationId };
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey;
  const sessionToken = opts.anonymous || opts.bearer ? undefined : authHooks?.token();
  const token = opts.bearer ?? sessionToken;
  if (token) headers.Authorization = `Bearer ${token}`;

  // Absolute URL: same origin in the browser, and required by Node's fetch in tests.
  const url = new URL(buildUrl(path, opts.query), globalThis.location?.origin ?? 'http://localhost').toString();
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? 'GET',
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
      signal: opts.signal,
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === 'AbortError') throw e;
    throw new ApiError({
      status: 0, type: 'network', title: 'Cannot reach the server',
      detail: 'The request did not reach the server. Check your connection, then try again.', correlationId,
    });
  }

  if (res.status === 401 && sessionToken && !retried && authHooks) {
    const fresh = await authHooks.refresh();
    if (fresh && fresh !== sessionToken) return send<T>(path, opts, true);
  }
  if (!res.ok) throw await toApiError(res, correlationId);

  const echoed = res.headers.get('X-Correlation-Id') ?? correlationId;
  const text = res.status === 204 ? '' : await res.text();
  return { data: (text ? JSON.parse(text) : undefined) as T, status: res.status, headers: res.headers, correlationId: echoed };
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  return (await requestRaw<T>(path, opts)).data;
}

/**
 * Plan §8.1: 409 request-in-progress means the same keyed request is still running on the server.
 * Wait for Retry-After (capped) and ask once more with the same Idempotency-Key; the server then
 * replays the first answer. Any other error, or a second in-progress, is passed to the caller.
 */
export async function retryIfInProgress<T>(send: () => Promise<T>, maxWaitSeconds = 5): Promise<T> {
  try {
    return await send();
  } catch (e) {
    if (!isApiError(e) || !e.is('request-in-progress')) throw e;
    const waitSeconds = Math.min(e.retryAfter ?? 1, maxWaitSeconds);
    await new Promise(resolve => setTimeout(resolve, waitSeconds * 1000));
    return send();
  }
}
