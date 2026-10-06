import { useEffect, type RefObject } from 'react';
import { isApiError } from '../../api/http';

/**
 * Helpers shared by the application screens and the deploy screen. Kept inside the feature, so the
 * shared component library stays unchanged.
 */

/** "must not be blank" → "Must not be blank." Server messages read as sentences next to a field. */
export function sentence(message: string): string {
  const t = message.trim();
  if (!t) return t;
  const s = t.charAt(0).toUpperCase() + t.slice(1);
  return /[.!?]$/.test(s) ? s : `${s}.`;
}

/** Field messages from a validation-failed ProblemDetail, keyed by field name (plan §8.1). */
export function fieldErrorsOf(error: unknown): Record<string, string> {
  if (!isApiError(error) || error.type !== 'validation-failed') return {};
  const out: Record<string, string> = {};
  for (const e of error.errors) {
    if (!(e.field in out)) out[e.field] = sentence(e.message);
  }
  return out;
}

/** True for an ApiError of one of the given ProblemDetail types. */
export function isProblem(error: unknown, ...types: string[]): boolean {
  return isApiError(error) && types.includes(error.type);
}

/** 501 from an endpoint the live backend does not have yet (hybrid mode). */
export function isNotBuilt(error: unknown): boolean {
  return isProblem(error, 'not-implemented');
}

/**
 * Matches the first invalid control: a field with aria-invalid, or the first enabled control in a
 * choice group (radios, toggle buttons) whose wrapper carries data-invalid="true".
 */
const INVALID = '[aria-invalid="true"], [data-invalid="true"] input:not(:disabled), [data-invalid="true"] button:not(:disabled)';

/**
 * After a failed submit, moves focus to the first invalid control inside `root`.
 * Runs once per trigger object (an error, or a fresh client-side error map), so every failed
 * submit refocuses. Pass null when there is nothing to report.
 */
export function useFocusFirstInvalid(root: RefObject<HTMLElement | null>, trigger: unknown) {
  useEffect(() => {
    if (!trigger) return;
    root.current?.querySelector<HTMLElement>(INVALID)?.focus();
  }, [root, trigger]);
}

/** "sha256:9f2c…e41a": the algorithm, the first and last four hex characters. */
export function shortChecksum(checksum: string): string {
  const [algo, hex] = checksum.includes(':') ? checksum.split(':', 2) as [string, string] : ['', checksum];
  if (hex.length <= 12) return checksum;
  return `${algo ? `${algo}:` : ''}${hex.slice(0, 4)}…${hex.slice(-4)}`;
}

/** "1 deployment", "3 deployments". */
export function plural(n: number, one: string, many = `${one}s`): string {
  return `${n} ${n === 1 ? one : many}`;
}

export const READ_POLL_FAST_MS = 2_000;
export const READ_POLL_LIVE_MS = 5_000;
export const READ_POLL_SETTLED_MS = 30_000;
/** How long after the caller's own write the read side is polled quickly. */
const WRITE_WINDOW_MS = 30_000;

/**
 * Polling for read-model views (what runs where, history): fast for a short while after the
 * caller's own write so the change shows up, every 5 s while work is in flight, else every 30 s.
 */
export function readModelPoll(lastWriteAt: string | null, live: boolean, now: number = Date.now()): number {
  if (lastWriteAt && now - new Date(lastWriteAt).getTime() < WRITE_WINDOW_MS) return READ_POLL_FAST_MS;
  return live ? READ_POLL_LIVE_MS : READ_POLL_SETTLED_MS;
}
