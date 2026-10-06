import { Link } from 'react-router';
import type { DeploymentTimeline } from '../../api/types';
import { Card, EmptyState, ErrorNotice, Freshness, Loading, StatusChip, Timeline } from '../../components';
import { formatTime } from '../../lib/format';
import s from './Deployment.module.css';

/**
 * Events from the query-service projection. Freshness says "Updating" while the projection has not
 * yet caught up with the deployment's last change (waitingFor), instead of showing old rows as current.
 */
export function DeploymentTimelineCard({ timeline, isPending, error, onRetry, waitingFor, canReadAudit }: {
  timeline: DeploymentTimeline | undefined;
  isPending: boolean;
  error: unknown;
  onRetry: () => void;
  waitingFor: string;
  canReadAudit: boolean;
}) {
  const events = timeline ? [...timeline.events].sort((a, b) => a.at.localeCompare(b.at)) : [];
  return (
    <Card
      title="Timeline"
      titleId="dep-timeline"
      aside={timeline && (
        <>
          <Freshness asOf={timeline.asOf} waitingFor={waitingFor} />
          {canReadAudit && timeline.correlationId && (
            <Link to={`/audit?cid=${encodeURIComponent(timeline.correlationId)}`}>Full audit trail</Link>
          )}
        </>
      )}
    >
      {isPending && <Loading label="Loading the timeline" />}
      {!timeline && Boolean(error) && <ErrorNotice error={error} context="Could not load the timeline." onRetry={onRetry} />}
      {timeline && events.length === 0 && <EmptyState title="No events yet">Events appear as the deployment moves through its states.</EmptyState>}
      {timeline && events.length > 0 && (
        <Timeline
          label="Deployment events"
          items={events.map((e, i) => ({
            key: `${e.at}-${i}`,
            time: <time dateTime={e.at}>{formatTime(e.at)}</time>,
            text: e.text,
            aside: e.status ? <StatusChip status={e.status} /> : null,
          }))}
        />
      )}
      {timeline && Boolean(error) && (
        <p className={s.meta}>The last refresh failed; these events may be out of date.</p>
      )}
    </Card>
  );
}
