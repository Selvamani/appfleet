import { useEffect, useState } from 'react';
import type { TokenResponse } from '../../api/auth';
import { Button, Card, DetailList, ErrorNotice, Notice, Pill } from '../../components';
import { cx } from '../../lib/cx';
import { decodeJwt, secondsLeft } from '../../lib/jwt';
import s from './login.module.css';
import type { Action } from './useLoginSession';

function useNow(intervalMs = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

function clock(totalSeconds: number): string {
  const m = Math.floor(totalSeconds / 60);
  const sec = totalSeconds % 60;
  return `${m}:${String(sec).padStart(2, '0')}`;
}

function maskToken(token: string): string {
  return `${token.slice(0, 6)}\u2026 (${token.length} characters; the rest stays hidden)`;
}

/** The signed-in state: what the access token says, and the buttons that exercise the service. */
export function SessionCard({ tokens, email, previousRefresh, familyRevoked, busy, onRefresh, onReplay, onControl, onLogout }: {
  tokens: TokenResponse;
  email: string;
  previousRefresh: string | null;
  familyRevoked: boolean;
  busy: Action | null;
  onRefresh: () => void;
  onReplay: () => void;
  onControl: () => void;
  onLogout: () => void;
}) {
  const now = useNow();
  const decoded = decodeJwt(tokens.accessToken);
  if (!decoded) {
    return (
      <Card title="Session">
        <ErrorNotice error={new Error('The access token could not be read as a JWT.')} />
      </Card>
    );
  }
  const { claims, header } = decoded;
  const left = secondsLeft(claims, now);
  const teams = Object.entries(claims.teams ?? {});
  const global = claims.perms ?? [];
  const aud = Array.isArray(claims.aud) ? claims.aud.join(', ') : claims.aud ?? '';

  return (
    <Card title="Session" titleId="login-session-title">
      <div className={s.claims}>
        <DetailList
          items={[
            ['Signed in as', email],
            ['User id (sub)', <span key="sub" className={s.tokenText}>{claims.sub}</span>],
            [
              'Access token expires in',
              left === null ? 'no exp claim' : (
                <span key="exp" className={cx(s.countdown, left <= 0 && s.countdownExpired)} role="timer" aria-live="off">
                  {left > 0 ? clock(left) : 'expired'}
                </span>
              ),
            ],
            ['Token id (jti)', <span key="jti" className={s.tokenText}>{claims.jti}</span>],
            ['Issuer / audience', `${claims.iss ?? ''} / ${aud}`],
            ['Refresh token', <span key="rt" className={s.tokenText}>{maskToken(tokens.refreshToken)}</span>],
          ]}
        />

        <h3>Permissions in this token</h3>
        {teams.length === 0 && global.length === 0 ? (
          <Notice tone="info" title="No grants">
            <p>This user holds no role on any team, so the token carries no permissions. control-api will answer 403 to everything that needs one.</p>
          </Notice>
        ) : (
          <>
            {global.length > 0 && (
              <div className={s.teamBlock}>
                <span className={s.teamId}>every team</span>
                <div className={s.perms}>{global.map(p => <Pill key={p} mono>{p}</Pill>)}</div>
              </div>
            )}
            {teams.map(([teamId, perms]) => (
              <div key={teamId} className={s.teamBlock}>
                <span className={s.teamId}>team {teamId}</span>
                <div className={s.perms}>{perms.map(p => <Pill key={p} mono>{p}</Pill>)}</div>
              </div>
            ))}
          </>
        )}

        <h3>Header</h3>
        <pre className={s.raw}>{JSON.stringify(header, null, 2)}</pre>
      </div>

      {familyRevoked && (
        <Notice tone="warning" title="The refresh family was revoked">
          <p>The replay was refused and the service revoked every refresh token of this session, including the newest one. Refresh will now answer 401; the access token above still works until it expires, unless a service checks the denylist.</p>
        </Notice>
      )}

      <div className={cx(s.actions, s.sessionActions)}>
        <Button variant="primary" onClick={onRefresh} busy={busy === 'refresh'} disabled={busy !== null}>Refresh</Button>
        <Button onClick={onReplay} busy={busy === 'replay'} disabled={busy !== null || previousRefresh === null || familyRevoked}>
          Replay the used refresh token
        </Button>
        <Button onClick={onControl} busy={busy === 'control-api'} disabled={busy !== null}>Call control-api with this token</Button>
        <Button variant="danger" onClick={onLogout} busy={busy === 'log out'} disabled={busy !== null}>Log out</Button>
      </div>
      <p className={s.hint}>
        Refresh uses the refresh token up and returns a new pair. Replay sends the token Refresh just used up: the service answers 401 and
        revokes the whole session. Log out ends the session and puts this access token on the denylist.
      </p>
    </Card>
  );
}