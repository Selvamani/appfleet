import { isApiError } from '../api/http';

export interface ErrorDescription {
  title: string;
  body: string;
  /** Whether trying the same request again can help. */
  retryable: boolean;
  retryAfter: number | null;
}

/**
 * Plan §8.1: one treatment per ProblemDetail type. Screens that need special handling (field errors,
 * a conflict with a Refresh action) check error.type themselves and fall back to this text.
 */
export function describeError(error: unknown): ErrorDescription {
  if (!isApiError(error)) {
    return { title: 'Something went wrong', body: error instanceof Error ? error.message : 'Unknown error.', retryable: true, retryAfter: null };
  }
  const detail = error.detail;
  const retryAfter = error.retryAfter;
  switch (error.type) {
    case 'network':
      return { title: 'Cannot reach the server', body: detail, retryable: true, retryAfter };
    case 'validation-failed':
      return {
        title: 'Some fields need fixing',
        body: error.errors.length ? error.errors.map(e => `${e.field}: ${e.message}`).join(' ') : detail,
        retryable: false, retryAfter,
      };
    case 'malformed-request':
      return { title: 'The request could not be understood', body: 'This is a fault in the console, not in your input. Report it with the correlation id below.', retryable: false, retryAfter };
    case 'unprocessable':
      return { title: 'The request was refused', body: detail, retryable: false, retryAfter };
    case 'not-found':
      return { title: 'Not found', body: 'It does not exist, or you do not have access to it.', retryable: false, retryAfter };
    case 'forbidden':
      return { title: 'Not allowed', body: detail || 'Your role on this team does not allow this action.', retryable: false, retryAfter };
    case 'unauthenticated':
      return { title: 'Signed out', body: 'Sign in again to continue.', retryable: false, retryAfter };
    case 'illegal-transition':
      return { title: 'Not possible in the current state', body: `${detail} Refresh to see the current state.`, retryable: false, retryAfter };
    case 'concurrent-modification':
      return { title: 'Someone else changed this first', body: 'Refresh to see their change, then decide again.', retryable: false, retryAfter };
    case 'conflict':
      return { title: 'Conflicts with the current state', body: detail, retryable: false, retryAfter };
    case 'request-in-progress':
      return { title: 'Still working on your earlier request', body: 'The same request is being processed. Its result will show shortly.', retryable: true, retryAfter };
    case 'idempotency-key-reused':
      return { title: 'The request changed while it was being sent', body: 'Submit again; the console will send it as a new request.', retryable: true, retryAfter };
    case 'rate-limited':
      return { title: 'Too many requests', body: 'Your team has used its request allowance for the moment.', retryable: true, retryAfter };
    case 'service-unavailable':
      return { title: 'A service is unavailable', body: detail || 'Try again shortly.', retryable: true, retryAfter };
    case 'not-implemented':
      return { title: 'Not built yet', body: detail, retryable: false, retryAfter };
    default:
      return { title: error.title || 'Something went wrong', body: detail || `The server answered ${error.status}.`, retryable: error.status >= 500, retryAfter };
  }
}
