import { useEffect, useState } from 'react';
import type { CatalogueImage, SessionResponse } from '../../api/types';
import { formatDuration } from '../../lib/format';

/** Idle reclaim, as the node-agent spec states it. */
export const IDLE_LIMIT_TEXT = 'ends after 30 min idle';

/** Sessions poll every second while one is starting, so RUNNING shows as soon as it happens. */
export const POLL_STARTING_MS = 1_000;
export const POLL_IDLE_MS = 15_000;

export function sessionsPollInterval(sessions: SessionResponse[] | undefined): number {
  return sessions?.some(s => s.status === 'STARTING') ? POLL_STARTING_MS : POLL_IDLE_MS;
}

export function startTimeLabel(warm: boolean): string {
  return warm ? 'Warm pool: ready in under 5 s' : 'Cold start: ready in up to 30 s';
}

export function activityText(session: SessionResponse, now: number): string {
  if (session.status === 'STARTING') return startTimeLabel(session.startMode === 'warm');
  if (session.status === 'RUNNING') {
    const idle = now - Date.parse(session.lastActivityAt);
    return idle < 60_000 ? `Active now, ${IDLE_LIMIT_TEXT}` : `Idle for ${formatDuration(idle)}, ${IDLE_LIMIT_TEXT}`;
  }
  return 'Ended';
}

/** Client-side catalogue filter: name, version or base image. */
export function matchesQuery(image: CatalogueImage, q: string): boolean {
  const needle = q.trim().toLowerCase();
  if (!needle) return true;
  return [image.name, image.version, image.baseImage].some(v => v.toLowerCase().includes(needle));
}

/** The current time, refreshed every `intervalMs`, so relative times ("Idle for 4 min") stay true. */
export function useNow(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}
