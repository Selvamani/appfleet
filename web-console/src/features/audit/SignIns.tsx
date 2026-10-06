import { Link } from 'react-router';
import { listLoginAudit } from '../../api/identity';
import { qk } from '../../api/keys';
import type { LoginAuditRow } from '../../api/types';
import { Card, DataTable, EmptyState, ErrorNotice, LoadMore, Loading, StatusChip, type Column } from '../../components';
import { useCursorList } from '../../hooks/useCursorList';
import { cx } from '../../lib/cx';
import { formatWhen } from '../../lib/format';
import s from './audit.module.css';

const columns: Column<LoginAuditRow>[] = [
  { key: 'time', header: 'Time (UTC)', width: 'minmax(120px, 0.9fr)', render: r => <span className={s.time}>{formatWhen(r.at)}</span> },
  { key: 'user', header: 'User', width: 'minmax(90px, 0.9fr)', render: r => r.username },
  { key: 'outcome', header: 'Outcome', width: 'minmax(100px, 0.8fr)', render: r => <StatusChip status={r.outcome} /> },
  { key: 'ip', header: 'Source IP', width: 'minmax(100px, 0.9fr)', render: r => <span className={s.cid}>{r.sourceIp}</span> },
  { key: 'agent', header: 'User agent', width: 'minmax(120px, 1.2fr)', render: r => <span className={s.object}>{r.userAgent}</span> },
  {
    key: 'cid',
    header: 'Correlation id',
    width: 'minmax(110px, 1fr)',
    render: r => (
      <Link to={`/audit?cid=${encodeURIComponent(r.correlationId)}`} className={cx(s.cid, s.anchor)}>
        {r.correlationId}<span className="sr-only">, show its audit events</span>
      </Link>
    ),
  },
];

/** Sign-in history from identity-service, successful and failed. */
export function SignIns() {
  const logins = useCursorList(qk.loginAudit(), cursor => listLoginAudit(cursor));
  return (
    <Card title="Sign-ins" titleId="signins-title" aside="Newest first, times in UTC">
      {logins.isPending && <Loading label="Loading sign-ins" />}
      {logins.isError && <ErrorNotice error={logins.error} context="Could not load sign-ins." onRetry={() => void logins.refetch()} />}
      {logins.isSuccess && logins.items.length === 0 && <EmptyState title="No sign-ins recorded yet" />}
      {logins.isSuccess && logins.items.length > 0 && (
        <>
          <DataTable label="Sign-ins" columns={columns} rows={logins.items} rowKey={r => r.id} minWidth={760} />
          <LoadMore hasMore={logins.hasNextPage} loading={logins.isFetchingNextPage} onLoad={() => void logins.fetchNextPage()} />
        </>
      )}
    </Card>
  );
}
