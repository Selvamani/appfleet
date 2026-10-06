import { QueryClient } from '@tanstack/react-query';
import { isApiError } from '../api/http';

/**
 * Retry reads only when retrying can help: network failures and 5xx (not 501, which means "not built").
 * Never retry mutations automatically; idempotent resubmits go through useIdempotentSubmit (plan §8.3).
 */
export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 5_000,
        retry: (count, error) => {
          if (!isApiError(error)) return count < 2;
          const transient = error.status === 0 || (error.status >= 500 && error.status !== 501);
          return transient && count < 2;
        },
      },
      mutations: { retry: false },
    },
  });
}
