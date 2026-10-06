import { isApiError } from '../../api/http';
import type { DeploymentResponse, DeploymentState, TaskResponse, TimelineEvent } from '../../api/types';
import type { Step, StepState } from '../../components';
import { deploymentPollInterval, POLL_LIVE_MS, POLL_SETTLED_MS } from '../../hooks/pollInterval';
import { formatWhen } from '../../lib/format';
import { isFinal, isLive } from '../../lib/statusTone';

/** The deployment FSM's happy path, in order. */
export const HAPPY_PATH = ['PENDING', 'VALIDATING', 'DEPLOYING', 'HEALTHY'] as const satisfies readonly DeploymentState[];

/** States off the happy path, shown as "Other outcomes" under the stepper. */
export const OTHER_OUTCOMES = ['FAILED', 'DEGRADED', 'ROLLED_BACK'] as const satisfies readonly DeploymentState[];

/**
 * Stepper states for one deployment. FAILED marks the step it failed in: DEPLOYING when the work got
 * that far (the timeline has a DEPLOYING event, or no timeline is available to say otherwise), else
 * VALIDATING. DEGRADED and ROLLED_BACK passed every step.
 */
export function progressSteps(status: DeploymentState, events?: TimelineEvent[]): Step[] {
  let states: StepState[];
  if (status === 'DEGRADED' || status === 'ROLLED_BACK') {
    states = HAPPY_PATH.map(() => 'done');
  } else if (status === 'FAILED') {
    const failedAt = !events || events.some(e => e.status === 'DEPLOYING') ? 2 : 1;
    states = HAPPY_PATH.map((_, i) => (i < failedAt ? 'done' : i === failedAt ? 'failed' : 'todo'));
  } else {
    const at = HAPPY_PATH.indexOf(status);
    states = HAPPY_PATH.map((_, i) => (i < at ? 'done' : i === at ? 'current' : 'todo'));
  }
  return HAPPY_PATH.map((label, i) => ({ label, state: states[i] ?? 'todo' }));
}

/** A ROLLBACK task that has not finished yet. */
export function isOpenRollback(task: TaskResponse): boolean {
  return task.taskType === 'ROLLBACK' && (task.status === 'PENDING' || task.status === 'RUNNING');
}

/** Why Roll back is unavailable, or null when it is allowed (HEALTHY or DEGRADED, no open rollback). */
export function rollbackBlockedReason(status: DeploymentState, rollbackOpen: boolean): string | null {
  if (isFinal(status)) return 'Not available from a final state.';
  if (isLive(status)) return 'Available once the deployment is HEALTHY or DEGRADED.';
  if (rollbackOpen) return 'A rollback is already requested.';
  return null;
}

/** The header's polling indicator, derived from the same policy the hook polls by. */
export function liveLabel(status: DeploymentState, rollbackPending: boolean): string {
  const interval = deploymentPollInterval(status, rollbackPending);
  if (interval === false) return 'Final state';
  if (interval >= POLL_SETTLED_MS) return `Settled: checks every ${POLL_SETTLED_MS / 1000} s`;
  return `Live: updates every ${POLL_LIVE_MS / 1000} s`;
}

/**
 * The timeline polls with the deployment, and keeps polling at the live rate while its asOf is older
 * than the deployment's last change, so "Updating" clears as soon as the projection catches up
 * (plan §8.5). A 501 (query-service not built) stops it.
 */
export function timelinePollInterval(
  asOf: string | undefined,
  error: unknown,
  deployment: DeploymentResponse | undefined,
  rollbackPending: boolean,
): number | false {
  if (isApiError(error) && error.type === 'not-implemented') return false;
  if (!deployment) return false; // not loaded, or not found: nothing to keep up with yet
  if (asOf && Date.parse(asOf) < Date.parse(deployment.updatedAt)) return POLL_LIVE_MS;
  return deploymentPollInterval(deployment.status, rollbackPending);
}

/** "today at 14:01 UTC" or "1 Oct, 14:01 UTC", for use inside a sentence. */
export function whenText(iso: string): string {
  const when = formatWhen(iso);
  return when.startsWith('Today ') ? `today at ${when.slice(6)} UTC` : `${when} UTC`;
}

/** "sha256:9f2c1a…e41a": enough to compare by eye; the full value goes in a title. */
export function shortChecksum(checksum: string): string {
  return checksum.length > 20 ? `${checksum.slice(0, 13)}…${checksum.slice(-4)}` : checksum;
}

/**
 * Compact task id. UUIDv7 ids start with a timestamp, so ids minted close together share their first
 * eight characters; the last four tell them apart. The full id goes in a title.
 */
export function taskLabel(id: string): string {
  return id.length > 12 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

export function isNotBuilt(error: unknown): boolean {
  return isApiError(error) && error.type === 'not-implemented';
}
