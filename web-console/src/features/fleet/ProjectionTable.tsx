import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { qk } from '../../api/keys';
import { listProjections, rebuildProjection } from '../../api/query';
import type { ProjectionStatus } from '../../api/types';
import { usePermissions } from '../../auth/usePermissions';
import { Card, DataTable, EmptyState, ErrorNotice, Loading, Mono, Stack, StatusChip, type Column } from '../../components';
import { formatLag } from './fleetQueries';
import { InlineConfirm } from '../../components';
import s from './FleetPage.module.css';

const STATE_WORDS: Record<ProjectionStatus['state'], string> = { UP_TO_DATE: 'Up to date', REBUILDING: 'Rebuilding' };

export function ProjectionTable() {
  const { can } = usePermissions();
  const queryClient = useQueryClient();
  const projections = useQuery({
    queryKey: qk.projections(),
    queryFn: listProjections,
    // Follow a rebuild closely; otherwise lag changes slowly.
    refetchInterval: query => (query.state.data?.some(p => p.state === 'REBUILDING') ? 1000 : 10_000),
  });
  const rebuild = useMutation({
    mutationFn: (name: string) => rebuildProjection(name),
    onSuccess: updated => {
      queryClient.setQueryData<ProjectionStatus[]>(qk.projections(), list => list?.map(p => (p.name === updated.name ? updated : p)));
    },
  });
  const canRebuild = can('projection:rebuild');

  const columns: Column<ProjectionStatus>[] = [
    { key: 'name', header: 'Projection', width: 'minmax(190px, 1.4fr)', render: p => <Mono>{p.name}</Mono> },
    { key: 'lag', header: 'Lag', width: 'minmax(55px, 0.4fr)', render: p => formatLag(p.lagMs) },
    {
      key: 'state',
      header: 'State',
      width: 'minmax(140px, 1.1fr)',
      render: p => (
        <span className={s.projState}>
          <StatusChip status={p.state} label={STATE_WORDS[p.state]} />
          {p.state === 'REBUILDING' && (
            <span className={s.projNote}>Rebuilding from the earliest offset. Reads show the old data until it finishes.</span>
          )}
        </span>
      ),
    },
  ];
  if (canRebuild) {
    columns.push({
      key: 'action',
      header: <span className={s.hiddenHeader}>Action</span>,
      width: 'minmax(150px, 1fr)',
      render: p => (
        <InlineConfirm
          trigger="Rebuild"
          triggerLabel={`Rebuild ${p.name}`}
          prompt="Rebuild from the start?"
          confirmLabel="Rebuild"
          disabled={p.state === 'REBUILDING'}
          onConfirm={() => rebuild.mutateAsync(p.name)}
        />
      ),
    });
  }

  return (
    <Card title="Read-model projections" titleId="proj-title" aside="Lag is how far reads trail writes.">
      <Stack gap="s">
        {rebuild.isError && <ErrorNotice error={rebuild.error} context={`Could not rebuild ${rebuild.variables ?? 'the projection'}.`} />}
        {projections.isPending && <Loading label="Loading projections" />}
        {projections.isError && (
          <ErrorNotice error={projections.error} context="Could not load projection status." onRetry={() => void projections.refetch()} />
        )}
        {projections.isSuccess && projections.data.length === 0 && <EmptyState title="No projections are registered." />}
        {projections.isSuccess && projections.data.length > 0 && (
          <DataTable label="Read-model projections" columns={columns} rows={projections.data} rowKey={p => p.name} minWidth={560} />
        )}
      </Stack>
    </Card>
  );
}
