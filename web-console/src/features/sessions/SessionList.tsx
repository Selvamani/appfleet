import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { endSession, listMySessions } from '../../api/agent';
import { qk } from '../../api/keys';
import type { SessionResponse } from '../../api/types';
import { Button, ButtonLink, Card, EmptyState, ErrorNotice, Loading, Mono, Notice, StatusChip } from '../../components';
import { activityText, sessionsPollInterval, useNow } from './sessionView';
import s from './Sessions.module.css';

/** The caller's open sessions (proposed GET /api/v1/sessions), with Open and End. */
export function SessionList() {
  const qc = useQueryClient();
  const now = useNow(15_000);
  const sessions = useQuery({
    queryKey: qk.sessions(),
    queryFn: listMySessions,
    refetchInterval: q => sessionsPollInterval(q.state.data),
  });

  const [ended, setEnded] = useState<SessionResponse | null>(null);
  const outcomeRef = useRef<HTMLDivElement>(null);
  const end = useMutation({
    mutationFn: (session: SessionResponse) => endSession(session.sessionId),
    onMutate: () => setEnded(null),
    // Wait for the list, so the row is gone when the confirmation appears.
    onSuccess: async (_none, session) => {
      void qc.invalidateQueries({ queryKey: qk.dashboardOverview() });
      await qc.invalidateQueries({ queryKey: qk.sessions() });
      setEnded(session);
    },
    // A 404 means it has ended already (for example idle reclaim): the list is out of date.
    onError: () => void qc.invalidateQueries({ queryKey: qk.sessions() }),
  });
  // The row that held focus is gone (or its request failed): move focus to the outcome.
  useEffect(() => {
    if (ended || end.isError) outcomeRef.current?.focus();
  }, [ended, end.isError]);

  // Announce a session that has become RUNNING; its chip changes silently otherwise.
  const seen = useRef<Map<string, SessionResponse['status']> | null>(null);
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    if (!sessions.data) return;
    const before = seen.current;
    seen.current = new Map(sessions.data.map(x => [x.sessionId, x.status]));
    if (!before) return;
    const ready = sessions.data.filter(x => x.status === 'RUNNING' && before.get(x.sessionId) === 'STARTING');
    if (ready.length) setAnnouncement(ready.map(x => `${x.toolName} is RUNNING and ready to open.`).join(' '));
  }, [sessions.data]);

  const items = sessions.data ?? [];
  return (
    <Card title="Your sessions" titleId="sessions-title">
      <p className="sr-only" aria-live="polite">{announcement}</p>
      {(ended || end.isError) && (
        <div ref={outcomeRef} tabIndex={-1} className={s.focusTarget}>
          {ended && <Notice tone="success" title={`Ended ${ended.toolName}.`}>Its container is being removed.</Notice>}
          {end.isError && (
            <ErrorNotice
              error={end.error}
              context={`Could not end ${end.variables?.toolName ?? 'the session'}.`}
              onRetry={() => end.variables && end.mutate(end.variables)}
            />
          )}
        </div>
      )}

      {sessions.isPending && <Loading label="Loading your sessions" />}
      {sessions.isError && !sessions.data && (
        <ErrorNotice error={sessions.error} context="Could not load your sessions." onRetry={() => void sessions.refetch()} />
      )}
      {sessions.isSuccess && items.length === 0 && (
        <EmptyState title="No sessions running.">Start a tool from the catalogue.</EmptyState>
      )}
      {items.length > 0 && (
        <ul className={s.sessions} aria-labelledby="sessions-title">
          {items.map(session => (
            <SessionRow
              key={session.sessionId}
              session={session}
              now={now}
              ending={end.isPending && end.variables?.sessionId === session.sessionId}
              onEnd={() => end.mutateAsync(session).catch(() => undefined)}
            />
          ))}
        </ul>
      )}
      <p className={s.note}>
        Sessions end after 30 minutes without activity, so shared capacity stays free. Each session is a
        private container that only you can open.
      </p>
    </Card>
  );
}

function SessionRow({ session, now, ending, onEnd }: {
  session: SessionResponse;
  now: number;
  ending: boolean;
  onEnd: () => Promise<unknown>;
}) {
  const endpoint = session.status === 'RUNNING' ? session.endpoint : null;
  return (
    <li className={s.session}>
      <span className={s.toolName}>{session.toolName}</span>
      <span><span className="sr-only">Version </span><Mono>{session.version}</Mono></span>
      <span><StatusChip status={session.status} /></span>
      <span className={s.activity}>{activityText(session, now)}</span>
      <div className={s.actions}>
        <EndControl
          toolName={session.toolName}
          ending={ending}
          onConfirm={onEnd}
          before={endpoint && (
            <ButtonLink
              to={endpoint}
              target="_blank"
              rel="noopener noreferrer"
              size="sm"
              variant="primary"
              aria-label={`Open ${session.toolName} in a new tab`}
            >
              Open
            </ButtonLink>
          )}
        />
      </div>
    </li>
  );
}

/**
 * End, with an inline confirmation. Opening it moves focus to the question; Cancel returns focus to End.
 * `before` (Open) hides while the confirmation is showing, so the row stays short.
 */
function EndControl({ toolName, ending, onConfirm, before }: {
  toolName: string;
  ending: boolean;
  onConfirm: () => Promise<unknown>;
  before?: ReactNode;
}) {
  const [confirming, setConfirming] = useState(false);
  const groupRef = useRef<HTMLDivElement>(null);
  const endWrapRef = useRef<HTMLSpanElement>(null);
  const returnFocus = useRef(false);
  const questionId = useId();

  useEffect(() => {
    if (confirming) {
      groupRef.current?.focus();
    } else if (returnFocus.current) {
      returnFocus.current = false;
      endWrapRef.current?.querySelector('button')?.focus();
    }
  }, [confirming]);

  if (confirming || ending) {
    return (
      <div ref={groupRef} className={s.confirm} role="group" aria-labelledby={questionId} tabIndex={-1}>
        <span id={questionId} className={s.question}>End {toolName}?</span>
        <Button
          size="sm"
          variant="danger"
          busy={ending}
          disabled={ending}
          onClick={() => void onConfirm().finally(() => setConfirming(false))}
        >
          {ending ? 'Ending' : 'End session'}
        </Button>
        <Button
          size="sm"
          disabled={ending}
          onClick={() => {
            returnFocus.current = true;
            setConfirming(false);
          }}
        >
          Cancel
        </Button>
      </div>
    );
  }
  return (
    <>
      {before}
      <span ref={endWrapRef}>
        <Button size="sm" aria-label={`End ${toolName}`} onClick={() => setConfirming(true)}>End</Button>
      </span>
    </>
  );
}
