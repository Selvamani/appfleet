import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { getApplication, getRelease, listDeploymentTasks, requestRollback } from '../../api/control';
import { isApiError } from '../../api/http';
import { qk } from '../../api/keys';
import { getDeploymentTimeline } from '../../api/query';
import type { DeploymentResponse } from '../../api/types';
import { usePermissions } from '../../auth/usePermissions';
import {
  ButtonLink, Card, Columns, ErrorNotice, Loading, Notice, PageHeader, Pill, Stack, StatusChip, type Crumb,
} from '../../components';
import { deploymentPollInterval } from '../../hooks/pollInterval';
import { useCursorList } from '../../hooks/useCursorList';
import { useDeployment } from '../../hooks/useDeployment';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { DeploymentDetails } from './DeploymentDetails';
import { DeploymentProgress } from './DeploymentProgress';
import { DeploymentTimelineCard } from './DeploymentTimelineCard';
import {
  isNotBuilt, isOpenRollback, liveLabel, rollbackBlockedReason, timelinePollInterval, whenText,
} from './deploymentView';
import { RollbackControl } from './RollbackControl';
import { RollbackOutcome } from './RollbackOutcome';
import { TaskAttempts } from './TaskAttempts';
import s from './Deployment.module.css';

/**
 * Deployment timeline (preview screen 4). Status comes from control-api and polls by the plan §8.4
 * policy; tasks from control-api; attempts and events from the query-service timeline, which in
 * hybrid mode answers 501 while the rest keeps working.
 */
export function DeploymentPage() {
  const { deploymentId = '' } = useParams();
  // Keyed by id: a requested rollback or an open confirmation belongs to one deployment.
  return <DeploymentView key={deploymentId} id={deploymentId} />;
}

function DeploymentView({ id }: { id: string }) {
  const qc = useQueryClient();
  const { can } = usePermissions();
  const [rollbackRequested, setRollbackRequested] = useState(false);

  // Tasks poll with the deployment. Its last known status is read from the cache, which useDeployment
  // below keeps current (and re-renders this component whenever it changes). No status yet (loading,
  // or not found): no polling.
  const cachedStatus = qc.getQueryData<DeploymentResponse>(qk.deployment(id))?.status;
  const tasks = useCursorList(qk.deploymentTasks(id), cursor => listDeploymentTasks(id, cursor), {
    refetchInterval: cachedStatus ? deploymentPollInterval(cachedStatus, rollbackRequested) : false,
  });
  const rollbackOpen = tasks.items.some(isOpenRollback);
  const rollbackPending = rollbackRequested || rollbackOpen;

  const dep = useDeployment(id, { rollbackPending });
  const deployment = dep.data;
  const status = deployment?.status;
  const appId = deployment?.applicationId ?? '';
  const releaseId = deployment?.releaseId ?? '';

  const app = useQuery({
    queryKey: qk.application(appId),
    queryFn: () => getApplication(appId),
    enabled: appId !== '',
    staleTime: 5 * 60_000,
  });
  const release = useQuery({
    queryKey: [...qk.releases(appId), releaseId],
    queryFn: () => getRelease(appId, releaseId),
    enabled: appId !== '' && releaseId !== '',
    staleTime: Infinity, // releases are immutable once registered
  });
  const timeline = useQuery({
    queryKey: qk.timeline(id),
    queryFn: () => getDeploymentTimeline(id),
    refetchInterval: q => timelinePollInterval(q.state.data?.asOf, q.state.error, deployment, rollbackPending),
  });
  const timelineNotBuilt = isNotBuilt(timeline.error);

  // When the status moves, the tasks and the timeline moved with it: fetch them now rather than at
  // their next poll (which stops altogether once the state is final). Announce the change.
  const seenStatus = useRef(status);
  const [announcement, setAnnouncement] = useState('');
  useEffect(() => {
    const before = seenStatus.current;
    seenStatus.current = status;
    if (!before || !status || before === status) return;
    setAnnouncement(`The deployment is now ${status}.`);
    void qc.invalidateQueries({ queryKey: qk.deploymentTasks(id) });
    void qc.invalidateQueries({ queryKey: qk.timeline(id) });
  }, [status, id, qc]);

  const outcomeRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<HTMLDivElement>(null);
  const rollback = useMutation({
    mutationFn: () => requestRollback(id),
    onSuccess: () => {
      setRollbackRequested(true);
      void qc.invalidateQueries({ queryKey: qk.deploymentTasks(id) });
      void qc.invalidateQueries({ queryKey: qk.timeline(id) });
    },
  });
  // Move focus to the outcome once the request has an answer, so it is read at once.
  useEffect(() => {
    if (rollback.status === 'success' || rollback.status === 'error') outcomeRef.current?.focus();
  }, [rollback.status]);

  const refresh = async () => {
    await Promise.all([dep.refetch(), tasks.refetch(), timeline.refetch()]);
    rollback.reset();
    actionsRef.current?.focus();
  };

  const appName = app.data?.name ?? timeline.data?.applicationName;
  const version = release.data?.version ?? timeline.data?.releaseVersion;
  useDocumentTitle(deployment && appName && version ? `${appName} ${version} to ${deployment.environment}` : undefined);

  if (isApiError(dep.error) && dep.error.type === 'not-found') return <DeploymentNotFound />;

  const crumbs: Crumb[] = [
    { label: 'Dashboard', to: '/' },
    ...(appId ? [{ label: appName ?? 'Application', to: `/applications/${appId}` }] : []),
    { label: 'Deployment' },
  ];

  if (!deployment || !status) {
    return (
      <>
        <PageHeader title="Deployment" crumbs={crumbs} />
        {dep.isPending && <Loading label="Loading the deployment" />}
        {dep.isError && <ErrorNotice error={dep.error} context="Could not load the deployment." onRetry={() => void dep.refetch()} />}
      </>
    );
  }

  const title = appName && version ? `${appName} ${version} to ${deployment.environment}` : `Deployment to ${deployment.environment}`;
  const mayRollBack = app.data ? can('deployment:rollback', app.data.ownerTeamId) : false;
  const blockedReason = rollbackBlockedReason(status, rollbackOpen || (rollbackRequested && status !== 'ROLLED_BACK'));

  return (
    <>
      <PageHeader
        crumbs={crumbs}
        title={title}
        // The space keeps the heading's accessible name "... to staging DEPLOYING" (PageHeader joins title and status).
        status={<>{' '}<StatusChip status={status} /></>}
        subtitle={
          <>
            Requested {timeline.data ? `by ${timeline.data.requestedBy}, ` : ''}{whenText(deployment.createdAt)}
            <span className={s.live}><Pill>{liveLabel(status, rollbackPending)}</Pill></span>
          </>
        }
        actions={mayRollBack && (
          <div ref={actionsRef} tabIndex={-1} className={s.focusTarget}>
            <RollbackControl
              question={`Roll back ${appName ?? 'this application'}${version ? ` ${version}` : ''} in ${deployment.environment}?`}
              blockedReason={blockedReason}
              onConfirm={() => rollback.mutateAsync().catch(() => undefined)}
            />
          </div>
        )}
      />
      <p className="sr-only" aria-live="polite">{announcement}</p>

      {dep.isError && (
        <ErrorNotice error={dep.error} context="Could not refresh the deployment. The state below may be out of date." onRetry={() => void dep.refetch()} />
      )}
      <RollbackOutcome
        ref={outcomeRef}
        accepted={rollback.isSuccess}
        status={status}
        error={rollback.error}
        onRefresh={() => void refresh()}
        onRetry={() => rollback.mutate()}
      />

      <DeploymentProgress status={status} events={timeline.data?.events} />

      {timelineNotBuilt && (
        <Notice tone="info" title="Attempts and the timeline need query-service (S6)">
          Status, tasks and details come from control-api and stay current.
        </Notice>
      )}

      <Columns layout="two">
        <Stack gap="l">
          <TaskAttempts
            tasks={{
              items: tasks.items,
              isPending: tasks.isPending,
              isError: tasks.isError,
              error: tasks.error,
              hasNextPage: tasks.hasNextPage,
              isFetchingNextPage: tasks.isFetchingNextPage,
              refetch: () => void tasks.refetch(),
              fetchNextPage: () => void tasks.fetchNextPage(),
            }}
            attempts={timeline.data?.attempts}
            canSeeDeadLetters={can('fleet:read')}
          />
          {!timelineNotBuilt && (
            <DeploymentTimelineCard
              timeline={timeline.data}
              isPending={timeline.isPending}
              error={timeline.error}
              onRetry={() => void timeline.refetch()}
              waitingFor={deployment.updatedAt}
              canReadAudit={can('audit:read')}
            />
          )}
        </Stack>
        <DeploymentDetails
          deployment={deployment}
          application={app.data}
          release={release.data}
          timeline={timeline.data}
          timelineState={timeline.data ? 'ready' : timelineNotBuilt ? 'not-built' : timeline.isError ? 'error' : 'loading'}
        />
      </Columns>
    </>
  );
}

function DeploymentNotFound() {
  useDocumentTitle('Deployment not found');
  return (
    <>
      <PageHeader title="Deployment not found" crumbs={[{ label: 'Dashboard', to: '/' }, { label: 'Deployment' }]} />
      <Card>
        <Stack gap="m">
          <p>This deployment does not exist, or you do not have access to it.</p>
          <div><ButtonLink to="/">Back to the dashboard</ButtonLink></div>
        </Stack>
      </Card>
    </>
  );
}
