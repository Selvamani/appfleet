import type { ReactNode } from 'react';
import { Link } from 'react-router';
import type { ApplicationResponse, DeploymentResponse, DeploymentTimeline, ReleaseResponse } from '../../api/types';
import { Card, CorrelationId, DetailList, Mono, Muted } from '../../components';
import { shortChecksum, whenText } from './deploymentView';

const NEEDS_QUERY = 'Needs query-service (S6)';

/** Facts about one deployment. Node and correlation id come from the timeline (query-service). */
export function DeploymentDetails({ deployment, application, release, timeline, timelineState }: {
  deployment: DeploymentResponse;
  application: ApplicationResponse | undefined;
  release: ReleaseResponse | undefined;
  timeline: DeploymentTimeline | undefined;
  timelineState: 'loading' | 'ready' | 'not-built' | 'error';
}) {
  const fromTimeline = (render: (t: DeploymentTimeline) => ReactNode) => {
    if (timeline) return render(timeline);
    if (timelineState === 'not-built') return <Muted>{NEEDS_QUERY}</Muted>;
    if (timelineState === 'error') return <Muted>Not available</Muted>;
    return <Muted>Loading</Muted>;
  };
  const lastAttempt = timeline?.attempts.reduce<DeploymentTimeline['attempts'][number] | undefined>(
    (latest, a) => (!latest || a.startedAt > latest.startedAt ? a : latest), undefined);

  const items: Array<[ReactNode, ReactNode]> = [
    ['Application', application
      ? <Link to={`/applications/${application.id}`}>{application.name}</Link>
      : <Mono title={deployment.applicationId}>{deployment.applicationId}</Mono>],
    ['Release', release ? <Mono>{release.version}</Mono> : <Muted>Loading</Muted>],
  ];
  if (release) items.push(['Checksum', <Mono title={release.checksum}>{shortChecksum(release.checksum)}</Mono>]);
  items.push(
    ['Environment', deployment.environment],
    ['Node', fromTimeline(t => (t.node
      ? <>{t.node}{lastAttempt && <Muted>, lease token <Mono>{lastAttempt.fencingToken}</Mono></Muted>}</>
      : <Muted>Not assigned yet</Muted>))],
    ['Requested', <>{whenText(deployment.createdAt)}{timeline && <> by {timeline.requestedBy}</>}</>],
    ['Last change', whenText(deployment.updatedAt)],
    ['Deployment id', <Mono>{deployment.id}</Mono>],
    ['Correlation id', fromTimeline(t => <CorrelationId id={t.correlationId} label={false} />)],
  );

  return (
    <Card as="aside" title="Details" titleId="dep-details">
      <DetailList items={items} />
    </Card>
  );
}
