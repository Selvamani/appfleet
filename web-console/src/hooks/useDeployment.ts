import { useQuery } from '@tanstack/react-query';
import { getDeployment } from '../api/control';
import { isApiError } from '../api/http';
import { qk } from '../api/keys';
import { deploymentPollInterval } from './pollInterval';

/**
 * One deployment, polled by the plan §8.4 policy. Polling pauses while the tab is hidden
 * (TanStack Query's default). Pass rollbackPending after a 202 to the rollback request.
 */
export function useDeployment(id: string, opts: { rollbackPending?: boolean } = {}) {
  return useQuery({
    queryKey: qk.deployment(id),
    queryFn: () => getDeployment(id),
    refetchInterval: query => {
      const error = query.state.error;
      // A 404 or 403 will not change by asking again every 2 s.
      if (isApiError(error) && error.status >= 400 && error.status < 500) return false;
      return deploymentPollInterval(query.state.data?.status, opts.rollbackPending ?? false);
    },
  });
}
