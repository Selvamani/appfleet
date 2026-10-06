import { useMutation, useQueryClient } from '@tanstack/react-query';
import { drainNode } from '../../api/agent';
import { isApiError } from '../../api/http';
import { qk } from '../../api/keys';
import type { FleetNode, NodeState } from '../../api/types';
import { usePermissions } from '../../auth/usePermissions';
import { Card, DataTable, ErrorNotice, Mono, Muted, Stack, StatusChip, type Column } from '../../components';
import { formatAgo } from '../../lib/format';
import s from './FleetPage.module.css';
import { InlineConfirm } from '../../components';

const NODE_WORDS: Record<NodeState, string> = {
  HEARTBEATING: 'Heartbeating',
  STALE: 'Stale heartbeat',
  DRAINING: 'Draining',
};

export function NodeTable({ nodes }: { nodes: FleetNode[] }) {
  const { can } = usePermissions();
  const queryClient = useQueryClient();
  const drain = useMutation({
    mutationFn: (node: FleetNode) => drainNode(node.id),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: qk.fleet() }),
    onError: error => {
      // Someone else drained it first: show the current state next to the message.
      if (isApiError(error) && error.is('conflict', 'not-found')) void queryClient.invalidateQueries({ queryKey: qk.fleet() });
    },
  });
  const canDrain = can('node:drain');

  const columns: Column<FleetNode>[] = [
    { key: 'node', header: 'Node', width: 'minmax(110px, 1.2fr)', render: n => <Mono>{n.name}</Mono> },
    { key: 'env', header: 'Environment', width: 'minmax(90px, 0.7fr)', render: n => n.environment },
    { key: 'lease', header: 'Lease holder', width: 'minmax(110px, 1.1fr)', render: n => (n.leaseHolder ? <Mono>{n.leaseHolder}</Mono> : <Muted>None</Muted>) },
    { key: 'token', header: 'Fencing token', width: 'minmax(70px, 0.6fr)', render: n => <Mono>{n.fencingToken}</Mono> },
    { key: 'heartbeat', header: 'Heartbeat', width: 'minmax(80px, 0.7fr)', render: n => formatAgo(n.lastHeartbeatAt) },
    { key: 'sessions', header: 'Sessions', width: 'minmax(70px, 0.6fr)', render: n => `${n.sessionsUsed} of ${n.sessionsCapacity}` },
    { key: 'state', header: 'State', width: 'minmax(140px, 0.9fr)', render: n => <StatusChip status={n.state} label={NODE_WORDS[n.state]} /> },
  ];
  if (canDrain) {
    columns.push({
      key: 'action',
      header: <span className={s.hiddenHeader}>Action</span>,
      width: 'minmax(150px, 1fr)',
      render: n => (
        <InlineConfirm
          trigger="Drain"
          triggerLabel={`Drain ${n.name}`}
          prompt={`Drain ${n.name}?`}
          confirmLabel="Drain"
          disabled={n.state === 'DRAINING'}
          onConfirm={() => drain.mutateAsync(n)}
        />
      ),
    });
  }

  return (
    <Card
      title="Nodes"
      titleId="nodes-title"
      aside="One agent holds each node's lease. Stale writers are rejected by fencing token."
    >
      <Stack gap="s">
        {drain.isError && (
          <ErrorNotice error={drain.error} context={`Could not drain ${drain.variables?.name ?? 'the node'}.`} />
        )}
        <DataTable label="Nodes" columns={columns} rows={nodes} rowKey={n => n.id} minWidth={900} emptyText="No nodes have registered." />
        {canDrain && <Muted as="p">A draining node takes no new sessions. Sessions already running on it finish normally.</Muted>}
      </Stack>
    </Card>
  );
}
