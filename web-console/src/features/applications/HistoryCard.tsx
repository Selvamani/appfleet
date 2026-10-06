import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router';
import { qk } from '../../api/keys';
import { getApplicationHistory } from '../../api/query';
import type { ApplicationHistory, DeploymentSummaryRow } from '../../api/types';
import { Card, DataTable, EmptyState, ErrorNotice, Freshness, Loading, Mono, StatusChip, type Column } from '../../components';
import { formatWhen } from '../../lib/format';
import { isLive } from '../../lib/statusTone';
import s from './applications.module.css';
import { NotBuiltNotice } from './notices';
import { isNotBuilt, plural, readModelPoll } from './shared';

function summary(h: ApplicationHistory): string {
  const { total, healthy, failed, rolledBack } = h.last30Days;
  if (total === 0) return 'Last 30 days: no deployments.';
  return `Last 30 days: ${healthy} of ${plural(total, 'deployment')} reached HEALTHY, ${failed} FAILED, ${rolledBack} ROLLED_BACK.`;
}

const columns: Column<DeploymentSummaryRow>[] = [
  { key: 'when', header: 'When (UTC)', width: 'minmax(96px, 1fr)', render: d => formatWhen(d.requestedAt) },
  { key: 'release', header: 'Release', width: 'minmax(80px, 0.8fr)', render: d => <Mono>{d.releaseVersion}</Mono> },
  { key: 'env', header: 'Environment', width: 'minmax(84px, 0.8fr)', render: d => d.environment },
  { key: 'state', header: 'State', width: 'minmax(120px, 1.1fr)', render: d => <StatusChip status={d.status} /> },
  { key: 'by', header: 'By', width: 'minmax(70px, 0.8fr)', render: d => d.requestedBy },
  {
    key: 'open', header: <span className="sr-only">Open</span>, width: 'minmax(48px, 0.5fr)',
    render: d => <Link to={`/deployments/${d.deploymentId}`}>Open{' '}<span className="sr-only">{d.releaseVersion} to {d.environment}</span></Link>,
  },
];

/** Recent deployments of one application, from the query-service read model. */
export function HistoryCard({ applicationId, lastWriteAt }: { applicationId: string; lastWriteAt: string | null }) {
  const history = useQuery({
    queryKey: qk.applicationHistory(applicationId),
    queryFn: () => getApplicationHistory(applicationId),
    refetchInterval: q => readModelPoll(lastWriteAt, (q.state.data?.items ?? []).some(d => isLive(d.status))),
  });

  return (
    <Card
      title="History"
      titleId="history-title"
      aside={history.data && <Freshness asOf={history.data.asOf} waitingFor={lastWriteAt} />}
    >
      <div className={s.cardStack}>
        {history.isPending && <Loading label="Loading history" />}
        {history.isError && (isNotBuilt(history.error)
          ? <NotBuiltNotice what="History" endpoint="GET /api/v1/applications/{id}/history" />
          : <ErrorNotice error={history.error} context="Could not load history." onRetry={() => void history.refetch()} />)}
        {history.isSuccess && (
          <>
            <p className={s.small}>{summary(history.data)}</p>
            {history.data.items.length === 0
              ? <EmptyState title="No deployments yet">Deployments of this application appear here.</EmptyState>
              : (
                <DataTable
                  label="Recent deployments"
                  columns={columns}
                  rows={history.data.items}
                  rowKey={d => d.deploymentId}
                  minWidth={600}
                />
              )}
          </>
        )}
      </div>
    </Card>
  );
}
