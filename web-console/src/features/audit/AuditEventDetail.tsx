import { useQuery } from '@tanstack/react-query';
import type { Ref } from 'react';
import { qk } from '../../api/keys';
import { getCorrelationWalk } from '../../api/query';
import type { AuditEventRow } from '../../api/types';
import { Card, CorrelationId, DetailList, ErrorNotice, Loading, Mono, Muted, StatusChip } from '../../components';
import { formatDate, formatTime } from '../../lib/format';
import s from './audit.module.css';

/** Every recorded step, across services, that carried one correlation id (FR-6.1). */
function CorrelationWalk({ cid }: { cid: string }) {
  const walk = useQuery({ queryKey: qk.correlation(cid), queryFn: () => getCorrelationWalk(cid) });
  if (walk.isPending) return <Loading label="Loading the steps" />;
  if (walk.isError) return <ErrorNotice error={walk.error} context="Could not load the steps for this correlation id." onRetry={() => void walk.refetch()} />;
  if (walk.data.length === 0) return <Muted as="p">No service recorded a step with this correlation id.</Muted>;
  return (
    <ol className={s.walk} aria-label={`Steps with correlation id ${cid}`}>
      {walk.data.map((step, i) => (
        <li key={`${step.at}-${i}`}>
          <span className={s.walkMeta}>
            <span className={s.time}>{formatTime(step.at)}</span>, {step.service}
          </span>
          <span className={s.walkText}>{step.text}</span>
        </li>
      ))}
    </ol>
  );
}

/** The selected event and the walk of its correlation id. */
export function AuditEventDetail({ event, ref }: { event: AuditEventRow | undefined; ref?: Ref<HTMLDivElement> }) {
  return (
    <div ref={ref} className={s.detailWrap}>
      <Card as="aside" title="Event detail" titleId="audit-event-title">
        {!event && <Muted as="p">Select an event to see its details and every step that carried its correlation id.</Muted>}
        {event && (
          <div className={s.detail}>
            <DetailList
              items={[
                ['Time', <Mono key="t">{`${formatDate(event.at)}, ${formatTime(event.at)} UTC`}</Mono>],
                ['Actor', event.actor],
                ['Action', <Mono key="a">{event.action}</Mono>],
                ['Object', event.object],
                ['Outcome', <StatusChip key="o" status={event.outcome} />],
                ['Source', `${event.sourceIp}, ${event.userAgent}`],
              ]}
            />
            <CorrelationId id={event.correlationId} />
            <h3 className={s.h3}>Everything with {event.correlationId}</h3>
            <CorrelationWalk cid={event.correlationId} />
          </div>
        )}
      </Card>
    </div>
  );
}
