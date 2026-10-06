import { Link } from 'react-router';
import type { DashboardFilter, DeploymentSummaryRow } from '../../api/types';
import { DataTable, Mono, StatusChip, type Column } from '../../components';
import { formatWhen } from '../../lib/format';
import s from './dashboard.module.css';

export type StatusChoice = DashboardFilter | 'all';

export const STATUS_OPTIONS: Array<{ value: StatusChoice; label: string }> = [
  { value: 'all', label: 'All' },
  { value: 'flight', label: 'In flight' },
  { value: 'attention', label: 'Needs attention' },
  { value: 'finished', label: 'Finished' },
];

const FILTERS: readonly string[] = ['flight', 'attention', 'finished'] satisfies DashboardFilter[];

/** The ?status= value, or undefined for "all" (also for anything unknown). */
export function parseStatus(value: string | null): DashboardFilter | undefined {
  return value !== null && FILTERS.includes(value) ? (value as DashboardFilter) : undefined;
}

const EMPTY_TEXT: Record<StatusChoice, string> = {
  all: 'No deployments yet.',
  flight: 'Nothing is in flight right now.',
  attention: 'Nothing needs attention right now.',
  finished: 'No finished deployments yet.',
};

/** Newest deployments first, one row each, with a link to the deployment's own page. */
export function RecentDeployments({ rows, status }: { rows: DeploymentSummaryRow[]; status: StatusChoice }) {
  const columns: Column<DeploymentSummaryRow>[] = [
    { key: 'time', header: 'Time (UTC)', width: 'minmax(120px, 0.9fr)', render: r => <span className={s.time}>{formatWhen(r.requestedAt)}</span> },
    {
      key: 'application',
      header: 'Application',
      width: 'minmax(120px, 1.3fr)',
      render: r => <Link to={`/applications/${r.applicationId}`}>{r.applicationName}</Link>,
    },
    { key: 'release', header: 'Release', width: 'minmax(72px, 0.7fr)', render: r => <Mono>{r.releaseVersion}</Mono> },
    { key: 'environment', header: 'Environment', width: 'minmax(84px, 0.7fr)', render: r => r.environment },
    { key: 'state', header: 'State', width: 'minmax(118px, 1fr)', render: r => <StatusChip status={r.status} /> },
    { key: 'by', header: 'Requested by', width: 'minmax(84px, 0.8fr)', render: r => <span className={s.by}>{r.requestedBy}</span> },
    {
      key: 'open',
      header: <span className={s.anchor}><span className="sr-only">Deployment</span></span>,
      width: 'minmax(48px, 0.4fr)',
      render: r => (
        <Link to={`/deployments/${r.deploymentId}`} className={s.anchor}>
          Open{' '}<span className="sr-only">{r.applicationName} {r.releaseVersion} to {r.environment}</span>
        </Link>
      ),
    },
  ];
  return (
    <DataTable
      label="Recent deployments"
      columns={columns}
      rows={rows}
      rowKey={r => r.deploymentId}
      minWidth={760}
      emptyText={EMPTY_TEXT[status]}
    />
  );
}
