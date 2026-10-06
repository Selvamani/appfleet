import { useQuery } from '@tanstack/react-query';
import { qk } from '../../api/keys';
import { getFleet } from '../../api/query';
import { Columns, ErrorNotice, Freshness, Loading, PageHeader, Pill, Row, StatTile } from '../../components';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { DeadLetterTable } from './DeadLetterTable';
import { formatLag, useDeadLetters } from './fleetQueries';
import { NodeTable } from './NodeTable';
import { ProjectionTable } from './ProjectionTable';
import { StuckTasks } from './StuckTasks';

/**
 * Fleet and dead letters (OPERATOR, ADMIN). Nodes with their lease, fencing token and heartbeat; stuck
 * work to reclaim; the dead-letter queue to replay; projection lag and rebuild. The route guard shows
 * NotFoundPage to everyone else, and the API answers the same way.
 */
export function FleetPage() {
  useDocumentTitle('Fleet and dead letters');
  const fleet = useQuery({ queryKey: qk.fleet(), queryFn: getFleet, refetchInterval: 5000 });
  const deadLetters = useDeadLetters();

  const nodes = fleet.data?.nodes ?? [];
  const heartbeating = nodes.filter(n => n.state !== 'STALE').length;
  const used = nodes.reduce((sum, n) => sum + n.sessionsUsed, 0);
  const capacity = nodes.reduce((sum, n) => sum + n.sessionsCapacity, 0);
  const waiting = deadLetters.items.filter(d => !d.replayed).length;

  return (
    <>
      <PageHeader
        title="Fleet and dead-letter queue"
        subtitle="Nodes, stuck work and failed messages across all teams."
        actions={fleet.data && (
          <Row>
            <Freshness asOf={fleet.data.asOf} />
            <Pill mono title="How far the fleet view trails the events it is built from.">
              projection lag {formatLag(fleet.data.projectionLagMs)}
            </Pill>
          </Row>
        )}
      />

      {fleet.isPending && <Loading label="Loading the fleet" />}
      {fleet.isError && <ErrorNotice error={fleet.error} context="Could not load the fleet." onRetry={() => void fleet.refetch()} />}
      {fleet.data && (
        <>
          <Columns layout="tiles">
            <StatTile label="Nodes heartbeating" value={`${heartbeating} of ${nodes.length}`} detail="within 15 s" />
            <StatTile label="Session slots used" value={`${used} of ${capacity}`} detail={`across ${nodes.length} nodes`} />
            <StatTile label="Work queue" value={fleet.data.queueWaiting} detail="messages waiting" />
            <StatTile
              label="Dead-letter queue"
              value={deadLetters.isSuccess ? `${waiting}${deadLetters.hasNextPage ? '+' : ''}` : '…'}
              detail="messages waiting"
            />
          </Columns>
          <NodeTable nodes={nodes} />
          <StuckTasks tasks={fleet.data.stuckTasks} />
        </>
      )}

      <Columns layout="pair" ratio="minmax(0, 1.5fr) minmax(0, 1fr)">
        <DeadLetterTable />
        <ProjectionTable />
      </Columns>
    </>
  );
}
