/**
 * The one place that maps a status word to a visual tone. StatusChip is its only consumer;
 * never colour a status anywhere else.
 */
export type Tone = 'progress' | 'settled' | 'attention' | 'ended';

const TONES: Record<string, Tone> = {
  // deployment states
  PENDING: 'progress',
  VALIDATING: 'progress',
  DEPLOYING: 'progress',
  HEALTHY: 'settled',
  DEGRADED: 'attention',
  FAILED: 'attention',
  ROLLED_BACK: 'ended',
  // task statuses
  RUNNING: 'progress',
  SUCCEEDED: 'settled',
  // sessions
  STARTING: 'progress',
  ENDED: 'ended',
  // fleet
  HEARTBEATING: 'settled',
  STALE: 'attention',
  DRAINING: 'ended',
  // audit outcomes
  ACCEPTED: 'settled',
  SUCCESS: 'settled',
  DENIED: 'attention',
  // users, projections, dead letters
  ACTIVE: 'settled',
  DEACTIVATED: 'ended',
  UP_TO_DATE: 'settled',
  REBUILDING: 'progress',
  QUEUED: 'progress',
};

export function statusTone(status: string): Tone {
  return TONES[status] ?? 'ended';
}

/** Deployment states with work still in flight. */
export const LIVE_STATES = ['PENDING', 'VALIDATING', 'DEPLOYING'] as const;

export function isLive(status: string): boolean {
  return (LIVE_STATES as readonly string[]).includes(status);
}

/** Final deployment states: the FSM allows no transition out of these. */
export function isFinal(status: string): boolean {
  return status === 'FAILED' || status === 'ROLLED_BACK';
}
