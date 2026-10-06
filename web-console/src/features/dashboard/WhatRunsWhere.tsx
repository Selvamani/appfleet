import { Link } from 'react-router';
import type { WhereCell, WhereRow } from '../../api/types';
import { DataTable, Mono, Muted, StatusChip, type Column } from '../../components';
import { cx } from '../../lib/cx';
import { formatWhen } from '../../lib/format';
import s from './dashboard.module.css';

function WhereCellView({ cell, app, env }: { cell: WhereCell | undefined; app: string; env: string }) {
  if (!cell) return <span className={s.notDeployed}>Not deployed</span>;
  return (
    <div className={s.cell}>
      <Link
        to={`/deployments/${cell.deploymentId}`}
        className={cx(s.cellLink, s.anchor)}
        title={`Since ${formatWhen(cell.since)} UTC, requested by ${cell.requestedBy}`}
      >
        <Mono>{cell.releaseVersion}</Mono>{' '}
        <StatusChip status={cell.status} />
        <span className="sr-only">, {app} in {env}</span>
      </Link>
      {cell.latest && (
        <Link to={`/deployments/${cell.latest.deploymentId}`} className={cx(s.latest, s.anchor)}>
          latest: {cell.latest.releaseVersion} {cell.latest.status}
          <span className="sr-only">, {app} in {env}</span>
        </Link>
      )}
    </div>
  );
}

/** Applications down, environments across: the current release and its state in each cell. */
export function WhatRunsWhere({ environments, rows }: { environments: string[]; rows: WhereRow[] }) {
  const columns: Column<WhereRow>[] = [
    {
      key: 'application',
      header: 'Application',
      width: 'minmax(130px, 1.1fr)',
      render: r => (
        <div className={s.appCell}>
          <Link to={`/applications/${r.applicationId}`}><strong>{r.applicationName}</strong></Link>
          <Muted>{r.teamName}</Muted>
        </div>
      ),
    },
    ...environments.map((env): Column<WhereRow> => ({
      key: `env-${env}`,
      header: env,
      width: 'minmax(118px, 1fr)',
      render: r => <WhereCellView cell={r.cells[env]} app={r.applicationName} env={env} />,
    })),
  ];
  return (
    <DataTable
      label="What runs where"
      columns={columns}
      rows={rows}
      rowKey={r => r.applicationId}
      minWidth={130 + environments.length * 125}
      emptyText="No applications to show."
    />
  );
}
