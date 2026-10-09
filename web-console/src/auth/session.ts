import { useSyncExternalStore } from 'react';
import { logout, refreshSession, type TokenResponse } from '../api/auth';
import { apiMode, configureAuth, isApiError, type ApiMode } from '../api/http';
import { decodeJwt, secondsLeft, type AccessClaims } from '../lib/jwt';

/**
 * The signed-in session: the access token and the refresh token of the real identity-service (hybrid mode).
 *
 * Where the tokens live. In memory, in this module. In a development build only, a copy is kept in sessionStorage
 * so that a reload (including Vite's) does not sign you out; production builds never write a token anywhere
 * (plan section 8.7: the refresh token belongs in an HttpOnly cookie, which needs a change in identity-service).
 *
 * Rotation. identity-service uses each refresh token once and treats a second use as theft, revoking the whole
 * session. So there is exactly ONE refresh in flight at a time (refreshNow): a burst of 401s, the proactive timer
 * and a button press all share it. Two parallel refreshes with the same token would log the user out.
 */
export interface Session {
  tokens: TokenResponse;
  email: string;
  claims: AccessClaims;
}

export type RefreshReason = 'expiring' | 'rejected' | 'manual';

export type SessionEvent =
  | { kind: 'refreshed'; reason: RefreshReason; status: number; correlationId: string; usedRefreshToken: string }
  | { kind: 'refresh-failed'; reason: RefreshReason; status: number; correlationId: string; ended: boolean }
  | { kind: 'ended' };

const STORAGE_KEY = 'appfleet.session';
/** Refresh this long before the access token expires. */
const EARLY_SECONDS = 60;

let session: Session | null = null;
let timer: ReturnType<typeof setTimeout> | undefined;
let inFlight: Promise<string | undefined> | null = null;
/** Which refresh is the current one, so a finished refresh clears inFlight only if nothing newer replaced it. */
let flight = 0;
const storeListeners = new Set<() => void>();
const eventListeners = new Set<(event: SessionEvent) => void>();

/** Set by initSession; a parameter so that a test can choose without touching the build-time mode. */
let activeMode: ApiMode = apiMode;

const persistent = (): boolean => import.meta.env.DEV && activeMode === 'hybrid';

function notify() {
  storeListeners.forEach(l => l());
}

function emit(event: SessionEvent) {
  eventListeners.forEach(l => l(event));
}

function persist() {
  if (!persistent()) return;
  try {
    if (session) sessionStorage.setItem(STORAGE_KEY, JSON.stringify({ tokens: session.tokens, email: session.email }));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // no storage: the session simply does not survive a reload
  }
}

function schedule() {
  clearTimeout(timer);
  if (!session) return;
  const left = secondsLeft(session.claims) ?? 0;
  const delayMs = Math.max((left - EARLY_SECONDS) * 1000, 1000);
  timer = setTimeout(() => { void refreshNow('expiring'); }, Math.min(delayMs, 2_000_000_000));
}

function adopt(tokens: TokenResponse, email: string): boolean {
  const decoded = decodeJwt(tokens.accessToken);
  if (!decoded) return false;
  session = { tokens, email, claims: decoded.claims };
  persist();
  schedule();
  notify();
  return true;
}

export const getSession = (): Session | null => session;

export const accessToken = (): string | undefined => session?.tokens.accessToken;

/** Re-renders when a session starts, changes or ends. */
export function useSession(): Session | null {
  return useSyncExternalStore(
    listener => { storeListeners.add(listener); return () => { storeListeners.delete(listener); }; },
    getSession,
    () => null,
  );
}

/** Every refresh and every end of the session, whoever triggered it. The sign-in screen lists them. */
export function onSessionEvent(listener: (event: SessionEvent) => void): () => void {
  eventListeners.add(listener);
  return () => { eventListeners.delete(listener); };
}

export function startSession(tokens: TokenResponse, email: string): boolean {
  return adopt(tokens, email.trim().toLowerCase());
}

/** Forgets the session in this browser. Does not call the server: signOut does. */
export function endSession(): void {
  const had = session !== null;
  clearTimeout(timer);
  session = null;
  inFlight = null;
  persist();
  notify();
  if (had) emit({ kind: 'ended' });
}

/**
 * Uses the refresh token up and swaps in the new pair. Returns the new access token, or undefined when there is
 * none: a 401 from identity-service (the session is over: revoked, expired, or reused) ends the session; a network
 * failure keeps it, because nothing says the token was used.
 */
export function refreshNow(reason: RefreshReason = 'manual'): Promise<string | undefined> {
  if (inFlight) return inFlight;
  const current = session;
  if (!current) return Promise.resolve(undefined);
  const used = current.tokens.refreshToken;
  const id = ++flight;
  const run = (async () => {
    try {
      const res = await refreshSession(used);
      if (session !== current) return undefined;   // signed out, or signed in as someone else, while we waited
      if (!adopt(res.data, current.email)) return undefined;
      emit({ kind: 'refreshed', reason, status: res.status, correlationId: res.correlationId, usedRefreshToken: used });
      return res.data.accessToken;
    } catch (error) {
      const status = isApiError(error) ? error.status : 0;
      const correlationId = isApiError(error) ? error.correlationId : '';
      const ended = status === 401;
      emit({ kind: 'refresh-failed', reason, status, correlationId, ended });
      if (ended && session === current) endSession();
      return undefined;
    } finally {
      if (flight === id) inFlight = null;
    }
  })();
  inFlight = run;
  return run;
}

/** Logs out at the server (best effort), then forgets the session here. Returns the access token that was alive. */
export async function signOut(): Promise<string | undefined> {
  const current = session;
  if (!current) return undefined;
  try {
    await logout(current.tokens.refreshToken);
  } catch {
    // the server could not be told; the session is still closed here
  }
  endSession();
  return current.tokens.accessToken;
}

/**
 * Wires the session into the request layer and restores a development session after a reload.
 * Call once, before the first render. Does nothing in mock mode: the mock identity answers there.
 */
export function initSession(mode: ApiMode = apiMode): void {
  activeMode = mode;
  if (mode !== 'hybrid') {
    configureAuth(undefined);
    return;
  }
  configureAuth({ token: accessToken, refresh: () => refreshNow('rejected') });
  if (!persistent() || session) return;
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const saved = JSON.parse(raw) as { tokens?: TokenResponse; email?: string };
    if (!saved.tokens || !saved.email || !adopt(saved.tokens, saved.email)) return;
    if ((secondsLeft(session!.claims) ?? 0) <= 0) void refreshNow('expiring');   // it expired while the page was closed
  } catch {
    // a damaged copy is ignored
  }
}