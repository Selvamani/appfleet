import { listDeadLetters } from '../../api/tasks';
import { qk } from '../../api/keys';
import { useCursorList } from '../../hooks/useCursorList';

/** The dead-letter list. The page's tile and the table share this one cached query. */
export function useDeadLetters() {
  return useCursorList(qk.deadLetters(), cursor => listDeadLetters(cursor));
}

/** "1.8 s": projection lag is usually under a few seconds, so one decimal says more than formatDuration. */
export function formatLag(ms: number): string {
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${Math.round(ms / 60_000)} min`;
}
