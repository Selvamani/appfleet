import { Link } from 'react-router';
import { listLoginAudit } from '../../api/identity';
import { qk } from '../../api/keys';
import type { LoginAuditRow } from '../../api/types';
import { Card, DataTable, EmptyState, ErrorNotice, LoadMore, Loading, StatusChip, type Column } from '../../components';
import { useCursorList } from '../../hooks/useCursorList';
import { cx } from '../../lib/cx';
import { formatWhen } from '../../lib/format';
import s from './audit.module.css';

const EVENT_TEXT: Record<string, string> = {
  LOGIN: 'Sign-in',
  REFRESH_REUSE: 'Refresh token reused',
  SERVICE_TOKEN: 'Service account key',
};

/** SUCCESS is the only good answer; every other outcome is a refusal, and the row says which kind (the caller never saw it). */
const tone = (r: LoginAuditRow) => (r.outcome === 'SUCCESS' ? 'SUCCESS' : 'FAILED');

const columns: Column<LoginAuditRow>[] = [
  { key: 'time', header: 'Time (UTC)', width: 'minmax(120px, 0.9fr)', render: r => <span className={s.time}>{formatWhen(r.occurredAt)}</span> },
  { key: 'event', header: 'Event', width: 'minmax(120px, 0.9fr)', render: r => EVENT_TEXT[r.event] ?? r.event },
  {
    key: 'who',
    header: 'Who',
    width: 'minmax(150px, 1.2fr)',
    render: r => r.email ?? (r.serviceAccountId ? <span className={s.object}>service account {r.serviceAccountId.slice(0, 8)}</span> : r.userId ? <span className={s.object}>user {r.userId.slice(0, 8)}</span> : 'unknown'),
  },
  { key: 'outcome', header: 'Outcome', width: 'minmax(130px, 1fr)', render: r => <StatusChip status={tone(r)} label={r.outcome.replace(/_/g, ' ').toLowerCase()} /> },
  { key: 'ip', header: 'Source IP', width: 'minmax(100px, 0.9fr)', render: r => <span className={s.cid}>{r.ip ?? ''}</span> },
  { key: 'agent', header: 'User agent', width: 'minmax(120px, 1.2fr)', render: r => <span className={s.object}>{r.userAgent ?? ''}</span> },
  {
    key: 'cid',
    header: 'Correlation id',
    width: 'minmax(110px, 1fr)',
    render: r => r.correlationId && (
      <Link to={`/audit?cid=${encodeURIComponent(r.correlationId)}`} className={cx(s.cid, s.anchor)}>
        {r.correlationId}<span className="sr-only">, show its audit events</span>
      </Link>
    ),
  },
];

/** The login audit of identity-service: sign-ins, refresh-token reuse and key exchanges, refused ones included. Platform administrators only. */
export function SignIns() {
  const logins = useCursorList(qk.loginAudit(), cursor => listLoginAudit(cursor));
  return (
    <Card title="Sign-ins" titleId="signins-title" aside="Newest first, times in UTC. The refusals say why; the caller only ever sees a 401 or a 423.">
      {logins.isPending && <Loading label="Loading sign-ins" />}
      {logins.isError && <ErrorNotice error={logins.error} context="Could not load sign-ins." onRetry={() => void logins.refetch()} />}
      {logins.isSuccess && logins.items.length === 0 && <EmptyState title="No sign-ins recorded yet" />}
      {logins.isSuccess && logins.items.length > 0 && (
        <>
          <DataTable label="Sign-ins" columns={columns} rows={logins.items} rowKey={r => r.id} minWidth={900} />
          <LoadMore hasMore={logins.hasNextPage} loading={logins.isFetchingNextPage} onLoad={() => void logins.fetchNextPage()} />
        </>
      )}
    </Card>
  );
}
