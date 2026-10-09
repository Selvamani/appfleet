import { useCallback, useEffect, useRef, useState } from 'react';
import { login, logout, refreshSession, register, type RegisterRequest, type RegisteredUser } from '../../api/auth';
import { isApiError, requestRaw } from '../../api/http';
import { endSession, onSessionEvent, refreshNow, startSession, useSession } from '../../auth/session';

export type Action = 'register' | 'sign in' | 'refresh' | 'replay' | 'log out' | 'control-api' | 'control-api (logged-out token)';

export interface LogEntry {
  id: number;
  at: string;
  action: Action;
  /** HTTP status, or 0 when the request never reached a server. */
  status: number;
  ok: boolean;
  summary: string;
  correlationId: string;
}

export interface FormFailure {
  form: 'register' | 'sign in';
  error: unknown;
}

/**
 * The state behind the sign-in screen. The tokens are NOT here: they live in the global session (auth/session.ts),
 * which the whole console uses. This hook adds what only this screen needs: the log of calls, the refresh token
 * that Refresh used up (for the replay demonstration), and the form failures.
 *
 * Refreshes made by the session on its own (before expiry, or after a 401 anywhere in the console) show up in the
 * log too, because the session reports every refresh as an event.
 */
export function useLoginSession() {
  const session = useSession();
  const tokens = session?.tokens ?? null;
  const email = session?.email ?? '';
  /** The refresh token that was used up by the last refresh: the one "Replay" sends again. */
  const [previousRefresh, setPreviousRefresh] = useState<string | null>(null);
  const [familyRevoked, setFamilyRevoked] = useState(false);
  /** After a logout: the access token that was alive, so the screen can show what a service says about it. */
  const [loggedOutAccess, setLoggedOutAccess] = useState<string | null>(null);
  /** The server ended the session on its own (a refresh was refused). */
  const [forcedSignOut, setForcedSignOut] = useState(false);
  const [log, setLog] = useState<LogEntry[]>([]);
  const [busy, setBusy] = useState<Action | null>(null);
  const [failure, setFailure] = useState<FormFailure | null>(null);
  const [registered, setRegistered] = useState<RegisteredUser | null>(null);
  const nextId = useRef(1);

  const record = useCallback((action: Action, status: number, ok: boolean, summary: string, correlationId: string) => {
    setLog(entries => [{ id: nextId.current++, at: new Date().toISOString(), action, status, ok, summary, correlationId }, ...entries]);
  }, []);

  useEffect(() => onSessionEvent(event => {
    if (event.kind === 'refreshed') {
      const how = event.reason === 'manual' ? '' : event.reason === 'expiring' ? ' (automatic, before expiry)' : ' (automatic, after a 401)';
      record('refresh', event.status, true, `New access token and a new refresh token; the old refresh token is used up${how}`, event.correlationId);
      setPreviousRefresh(event.usedRefreshToken);
    } else if (event.kind === 'refresh-failed') {
      record('refresh', event.status, false,
        event.ended ? 'Refused: the session is over, so you were signed out' : 'The server could not be reached; the session is kept',
        event.correlationId);
      if (event.ended) setForcedSignOut(true);
    }
  }), [record]);

  /** Runs one call, logs it, and returns the response or the error. Never throws. */
  const run = useCallback(async <T,>(action: Action, call: () => Promise<{ data: T; status: number; correlationId: string }>, summarize: (data: T) => string) => {
    setBusy(action);
    try {
      const res = await call();
      record(action, res.status, true, summarize(res.data), res.correlationId);
      return { res, error: null as unknown };
    } catch (error) {
      if (isApiError(error)) record(action, error.status, false, `${error.title}: ${error.detail}`, error.correlationId);
      else record(action, 0, false, String(error), '');
      return { res: null, error };
    } finally {
      setBusy(null);
    }
  }, [record]);

  const registerUser = useCallback(async (body: RegisterRequest) => {
    setFailure(null);
    setRegistered(null);
    const { res, error } = await run('register', () => register(body), u => `Registered ${u.email}`);
    if (res) setRegistered(res.data);
    else setFailure({ form: 'register', error });
    return res !== null;
  }, [run]);

  const signIn = useCallback(async (address: string, password: string) => {
    setFailure(null);
    const { res, error } = await run('sign in', () => login(address, password), t => `Access token for ${t.expiresIn} s, refresh token issued`);
    if (res) {
      startSession(res.data, address);
      setRegistered(null);
      setPreviousRefresh(null);
      setFamilyRevoked(false);
      setLoggedOutAccess(null);
      setForcedSignOut(false);
    } else {
      setFailure({ form: 'sign in', error });
    }
  }, [run]);

  /** A manual refresh goes through the session's single refresh, like every automatic one, and is logged by its event. */
  const refresh = useCallback(async () => {
    if (!tokens) return;
    setBusy('refresh');
    try {
      await refreshNow('manual');
    } finally {
      setBusy(null);
    }
  }, [tokens]);

  /** Sends the refresh token that the last refresh used up. The service treats that as theft and revokes the whole family. */
  const replay = useCallback(async () => {
    if (!previousRefresh) return;
    const { error } = await run('replay', () => refreshSession(previousRefresh), () => 'Accepted: the used token still worked');
    if (error) setFamilyRevoked(true);
  }, [previousRefresh, run]);

  const signOut = useCallback(async () => {
    if (!tokens) return;
    const { res } = await run('log out', () => logout(tokens.refreshToken), () => 'Session ended: refresh family revoked, access token on the denylist');
    if (res) {
      setLoggedOutAccess(tokens.accessToken);
      setPreviousRefresh(null);
      setFamilyRevoked(false);
      endSession();
    }
  }, [run, tokens]);

  const callControl = useCallback(async (token: string, action: 'control-api' | 'control-api (logged-out token)') => {
    await run(action, () => requestRaw<{ items?: unknown[] }>('/api/v1/applications', { bearer: token, query: { limit: 50 } }),
      page => `Listed ${page.items?.length ?? 0} application(s) on this page`);
  }, [run]);

  return {
    tokens, email, previousRefresh, familyRevoked, loggedOutAccess, forcedSignOut, log, busy, failure, registered,
    registerUser, signIn, refresh, replay, signOut, callControl,
  };
}