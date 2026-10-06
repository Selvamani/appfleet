import { useContext, useEffect, useState, type ReactNode, type Ref } from 'react';
import { Link } from 'react-router';
import { isApiError } from '../api/http';
import { PermissionsContext } from '../auth/PermissionsProvider';
import { cx } from '../lib/cx';
import { describeError } from '../lib/errorText';
import { formatDuration, formatTime } from '../lib/format';
import s from './Feedback.module.css';

type NoticeTone = 'info' | 'warning' | 'success' | 'plain';

/**
 * A message block. warning uses role="alert" (announced at once); success uses role="status".
 */
export function Notice({ tone = 'plain', title, children, actions, ref, focusable }: {
  tone?: NoticeTone;
  title?: ReactNode;
  children?: ReactNode;
  actions?: ReactNode;
  ref?: Ref<HTMLDivElement>;
  /** Lets code move focus to the notice (tabIndex -1), for outcomes that replace the pressed control. */
  focusable?: boolean;
}) {
  const role = tone === 'warning' ? 'alert' : tone === 'success' || tone === 'info' ? 'status' : undefined;
  return (
    <div ref={ref} tabIndex={focusable ? -1 : undefined} className={cx(s.notice, s[tone])} role={role}>
      {title && <p className={s.noticeTitle}>{title}</p>}
      {children && <div className={s.noticeBody}>{children}</div>}
      {actions && <div className={s.noticeActions}>{actions}</div>}
    </div>
  );
}

/** Counts down Retry-After seconds. */
export function useCountdown(seconds: number | null): number {
  const [left, setLeft] = useState(seconds ?? 0);
  useEffect(() => {
    setLeft(seconds ?? 0);
    if (!seconds) return;
    const id = setInterval(() => setLeft(v => (v > 0 ? v - 1 : 0)), 1000);
    return () => clearInterval(id);
  }, [seconds]);
  return left;
}

/**
 * Renders any error from the API layer with the treatment its ProblemDetail type calls for
 * (plan §8.1), plus the correlation id with a link to the audit trail.
 */
export function ErrorNotice({ error, onRetry, retryLabel = 'Try again', context, actions }: {
  error: unknown;
  onRetry?: () => void;
  retryLabel?: string;
  /** Extra actions, for example a Refresh button after a conflict (plan §8.1). */
  actions?: ReactNode;
  /** A sentence that says what was being attempted, for example "Could not load deployments." */
  context?: string;
}) {
  const d = describeError(error);
  const left = useCountdown(d.retryAfter);
  const cid = isApiError(error) ? error.correlationId : null;
  return (
    <Notice
      tone="warning"
      title={context ?? d.title}
      actions={
        <>
          {onRetry && d.retryable && (
            <button type="button" className={s.linkButton} onClick={onRetry} disabled={left > 0}>
              {left > 0 ? `${retryLabel} in ${left} s` : retryLabel}
            </button>
          )}
          {actions}
          {cid && <CorrelationId id={cid} />}
        </>
      }
    >
      {context && <p>{d.title}.</p>}
      <p>{d.body}</p>
    </Notice>
  );
}

export function CorrelationId({ id, label = true }: { id: string; label?: boolean }) {
  const [copied, setCopied] = useState(false);
  // Outside the provider (isolated component tests) the link is shown; inside, only with audit:read.
  const perms = useContext(PermissionsContext);
  const canAudit = perms ? perms.can('audit:read') : true;
  return (
    <span className={s.cid}>
      <span>{label && 'Correlation id '}<code>{id}</code></span>
      <button
        type="button"
        className={s.linkButton}
        onClick={() => {
          void navigator.clipboard?.writeText(id).then(() => setCopied(true), () => setCopied(false));
        }}
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
      {canAudit && <Link to={`/audit?cid=${encodeURIComponent(id)}`}>Find in audit trail</Link>}
    </span>
  );
}

/** Loading placeholder with an accessible label. */
export function Loading({ label = 'Loading' }: { label?: string }) {
  return <p className={s.loading} role="status" aria-live="polite">{label}…</p>;
}

export function EmptyState({ title, children, action }: { title: ReactNode; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className={s.empty}>
      <p className={s.emptyTitle}>{title}</p>
      {children && <div className={s.noticeBody}>{children}</div>}
      {action}
    </div>
  );
}

/**
 * Read-model freshness (FR-5.3). Shows asOf and how far behind it is. Pass `waitingFor` (an ISO time of
 * the caller's own last write) to show "Updating" until the read model has caught up with it.
 */
export function Freshness({ asOf, waitingFor, now = Date.now() }: { asOf: string | undefined; waitingFor?: string | null; now?: number }) {
  if (!asOf) return null;
  const behind = Math.max(0, now - new Date(asOf).getTime());
  const updating = waitingFor ? new Date(asOf).getTime() < new Date(waitingFor).getTime() : false;
  return (
    <span className={cx(s.freshness, updating && s.updating)} title="Reads come from the read model and can be a few seconds behind writes.">
      {updating ? 'Updating: your change is not in this view yet' : `asOf ${formatTime(asOf)} UTC, ${formatDuration(behind)} behind`}
    </span>
  );
}
