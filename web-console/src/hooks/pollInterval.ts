import type { DeploymentState } from '../api/types';

/** Polling policy for one deployment (plan §8.4). */
export const POLL_LIVE_MS = 2_000;
export const POLL_SETTLED_MS = 30_000;

/**
 * 2 s while work is in flight or a rollback is waiting, 30 s while HEALTHY or DEGRADED (they can
 * still change), and no polling once FAILED or ROLLED_BACK, which the FSM never leaves.
 */
export function deploymentPollInterval(status: DeploymentState | undefined, rollbackPending = false): number | false {
  if (status === undefined) return POLL_LIVE_MS;
  if (status === 'FAILED' || status === 'ROLLED_BACK') return false;
  if (rollbackPending) return POLL_LIVE_MS;
  if (status === 'HEALTHY' || status === 'DEGRADED') return POLL_SETTLED_MS;
  return POLL_LIVE_MS;
}
