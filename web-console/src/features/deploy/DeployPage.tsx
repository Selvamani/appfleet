import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { getApplication, listEnvironments, listReleases, requestDeployment } from '../../api/control';
import { isApiError, retryIfInProgress } from '../../api/http';
import { qk, READ_SIDE } from '../../api/keys';
import { getWhatRunsWhere } from '../../api/query';
import type { ApplicationResponse, CreateDeploymentRequest, WhereCell } from '../../api/types';
import { usePermissions } from '../../auth/usePermissions';
import { useTeams } from '../../auth/useTeams';
import {
  Button, ButtonLink, Card, Columns, EmptyState, ErrorNotice, Fieldset, Freshness, LoadMore, Loading, Mono, Notice,
  PageHeader, RadioCard, Row, StatusChip, TextField, ToggleCard,
} from '../../components';
import { useCursorList } from '../../hooks/useCursorList';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { useIdempotentSubmit } from '../../hooks/useIdempotentSubmit';
import { formatDate } from '../../lib/format';
import { isFinal, isLive } from '../../lib/statusTone';
import { ApplicationNotFound, ProblemNotice } from '../applications/notices';
import {
  fieldErrorsOf, isNotBuilt, isProblem, readModelPoll, shortChecksum, useFocusFirstInvalid,
} from '../applications/shared';
import s from './deploy.module.css';

type Param = 'release' | 'env';

export function DeployPage() {
  const { applicationId = '' } = useParams();
  const app = useQuery({ queryKey: qk.application(applicationId), queryFn: () => getApplication(applicationId) });
  useDocumentTitle(app.data ? `Deploy ${app.data.name}` : app.isPending ? 'New deployment' : undefined);

  if (app.isPending) return <Loading label="Loading application" />;
  if (app.isError) {
    if (isProblem(app.error, 'not-found')) return <ApplicationNotFound />;
    return (
      <>
        <PageHeader crumbs={[{ label: 'Applications', to: '/applications' }, { label: 'New deployment' }]} title="New deployment" />
        <ErrorNotice error={app.error} context="Could not load the application." onRetry={() => void app.refetch()} />
      </>
    );
  }
  return <DeployForm key={app.data.id} app={app.data} />;
}

/** What the review line says about the chosen environment's current deployment. */
function replaces(env: string, version: string, cell: WhereCell | undefined): string {
  if (!cell) return 'Replaces nothing.';
  if (isFinal(cell.status)) return `Nothing is active in ${env}; the last deployment there (${cell.releaseVersion}) is ${cell.status}.`;
  if (cell.releaseVersion === version) return `${env} already runs ${version}; deploying again runs the same release again.`;
  return `Replaces ${cell.releaseVersion}.`;
}

function DeployForm({ app }: { app: ApplicationResponse }) {
  const { me, can } = usePermissions();
  const queryClient = useQueryClient();
  const [params, setParams] = useSearchParams();
  const formRef = useRef<HTMLFormElement>(null);
  const [clientErrors, setClientErrors] = useState<Record<string, string> | null>(null);
  const [writtenAt, setWrittenAt] = useState<string | null>(null);

  const { nameOf } = useTeams();
  const teamName = nameOf(app.ownerTeamId);
  const releases = useCursorList(qk.releases(app.id), cursor => listReleases(app.id, cursor));
  const environments = useQuery({ queryKey: qk.environments(), queryFn: listEnvironments, staleTime: 10 * 60_000 });
  const where = useQuery({
    queryKey: qk.whatRunsWhere(app.id),
    queryFn: () => getWhatRunsWhere(app.id),
    refetchInterval: q => {
      const cells = Object.values(q.state.data?.rows[0]?.cells ?? {});
      return readModelPoll(writtenAt, cells.some(c => c && isLive(c.status)));
    },
  });

  // Hybrid mode: without the list endpoints, the caller types the release id and environment name.
  const releaseFallback = isNotBuilt(releases.error);
  const envFallback = isNotBuilt(environments.error);

  const releaseParam = params.get('release') ?? '';
  const envParam = params.get('env') ?? '';
  // A choice in the URL counts even before the lists load; the server checks it either way.
  const releaseId = releaseParam.trim() || (releaseFallback ? '' : releases.items[0]?.id ?? '');
  const selectedRelease = releases.items.find(r => r.id === releaseId);
  const versionOf = (id: string) => releases.items.find(r => r.id === id)?.version ?? id;
  const envNames = environments.data?.map(e => e.name) ?? [];
  const env = envFallback || !environments.isSuccess || envNames.includes(envParam.trim()) ? envParam.trim() : '';
  const cells = where.data?.rows[0]?.cells ?? {};
  const cell = env ? cells[env] : undefined;

  const canDeploy = can('deployment:create', app.ownerTeamId);
  const { idempotencyKey, renew } = useIdempotentSubmit(`${app.id}|${releaseId}|${env}`);
  const deploy = useMutation({
    mutationFn: (body: CreateDeploymentRequest) => retryIfInProgress(() => requestDeployment(body, idempotencyKey)),
    onSuccess: () => {
      setWrittenAt(new Date().toISOString());
      void queryClient.invalidateQueries({ queryKey: READ_SIDE });
    },
    onError: error => {
      if (isProblem(error, 'idempotency-key-reused')) renew();
    },
  });
  useFocusFirstInvalid(formRef, deploy.error ?? clientErrors);

  const setParam = (key: Param, value: string) => {
    setClientErrors(null);
    if (deploy.isError) deploy.reset();
    setParams(prev => {
      const next = new URLSearchParams(prev);
      if (value) next.set(key, value);
      else next.delete(key);
      return next;
    }, { replace: true });
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    const missing: Record<string, string> = {};
    if (!releaseId) missing.releaseId = releaseFallback ? 'Enter a release id.' : 'Choose a release.';
    if (!env) missing.environment = envFallback ? 'Enter an environment name.' : 'Choose an environment.';
    if (Object.keys(missing).length) {
      if (deploy.isError) deploy.reset();
      setClientErrors(missing);
      return;
    }
    setClientErrors(null);
    deploy.mutate({ applicationId: app.id, releaseId, environment: env });
  };

  const fieldErrors = { ...fieldErrorsOf(deploy.error), ...clientErrors };
  const unmappedValidation = isApiError(deploy.error) && deploy.error.type === 'validation-failed'
    && deploy.error.errors.some(e => e.field !== 'releaseId' && e.field !== 'environment');
  const accepted = deploy.isSuccess ? deploy.data : undefined;
  const conflict = isProblem(deploy.error, 'conflict');
  const activeCell = cell && !isFinal(cell.status) && cell.deploymentId !== accepted?.accepted.deploymentId ? cell : undefined;
  const whereKnown = where.isSuccess;

  const header = (
    <PageHeader
      crumbs={[
        { label: 'Applications', to: '/applications' },
        { label: app.name, to: `/applications/${app.id}` },
        { label: 'New deployment' },
      ]}
      title={`Deploy ${app.name}`}
      subtitle="Choose a release and an environment."
    />
  );

  const legend = (text: string, error: string | undefined) => (
    <>
      {text}
      {error && <span className={s.legendError}>{error}</span>}
    </>
  );

  // ---- release choice ----
  let releaseSection: ReactNode;
  if (releaseFallback) {
    releaseSection = (
      <TextField
        label="Release id"
        className={s.mono}
        value={releaseParam}
        onChange={e => setParam('release', e.target.value)}
        hint="The release list (GET /api/v1/applications/{id}/releases) is not built yet, so enter the id of a release registered for this application."
        error={fieldErrors.releaseId}
        autoComplete="off"
        spellCheck={false}
      />
    );
  } else {
    releaseSection = (
      <div data-invalid={fieldErrors.releaseId ? 'true' : undefined}>
        <Fieldset legend={legend('Release', fieldErrors.releaseId)}>
          {releases.isPending && <Loading label="Loading releases" />}
          {releases.isError && <ErrorNotice error={releases.error} context="Could not load releases." onRetry={() => void releases.refetch()} />}
          {releases.isSuccess && releases.items.length === 0 && (
            <EmptyState
              title="No releases yet"
              action={<ButtonLink size="sm" to={`/applications/${app.id}`}>Go to {app.name}</ButtonLink>}
            >
              Register a release on the application page first.
            </EmptyState>
          )}
          {releases.items.length > 0 && (
            <div className={s.releaseList}>
              {releases.items.map(r => (
                <RadioCard key={r.id} name="release" value={r.id} checked={r.id === releaseId} onChange={v => setParam('release', v)}>
                  <strong><Mono>{r.version}</Mono></strong>{' '}
                  <Mono title={r.checksum}>{shortChecksum(r.checksum)}</Mono>{' '}
                  <span className={s.releaseMeta}>registered {formatDate(r.createdAt)}</span>
                </RadioCard>
              ))}
              {releases.hasNextPage && (
                <LoadMore
                  hasMore
                  loading={releases.isFetchingNextPage}
                  onLoad={() => void releases.fetchNextPage()}
                  note="Newest first."
                />
              )}
            </div>
          )}
        </Fieldset>
      </div>
    );
  }

  // ---- environment choice ----
  let envSection: ReactNode;
  if (envFallback) {
    envSection = (
      <TextField
        label="Environment name"
        value={envParam}
        onChange={e => setParam('env', e.target.value)}
        hint="The environment list (GET /api/v1/environments) is not built yet, so enter its name, for example staging."
        error={fieldErrors.environment}
        autoComplete="off"
        spellCheck={false}
      />
    );
  } else {
    envSection = (
      <div data-invalid={fieldErrors.environment ? 'true' : undefined}>
        <Fieldset legend={legend('Environment', fieldErrors.environment)}>
          {environments.isPending && <Loading label="Loading environments" />}
          {environments.isError && (
            <ErrorNotice error={environments.error} context="Could not load environments." onRetry={() => void environments.refetch()} />
          )}
          {environments.isSuccess && (
            <div className={s.envs}>
              {envNames.map(name => {
                const c = cells[name];
                return (
                  <ToggleCard key={name} pressed={env === name} onClick={() => setParam('env', name)}>
                    <span className={s.envName}>{name}</span>{' '}
                    <span className={s.cellLine}>
                      {!whereKnown && <span className={s.small}>Current state unknown</span>}
                      {whereKnown && c && <><Mono>{c.releaseVersion}</Mono>{' '}<StatusChip status={c.status} /></>}
                      {whereKnown && !c && <span className={s.small}>Nothing deployed</span>}
                    </span>
                  </ToggleCard>
                );
              })}
            </div>
          )}
          {where.data && (
            <p className={s.freshLine}>
              <span>Current state comes from the read model.</span>
              <Freshness asOf={where.data.asOf} waitingFor={writtenAt} />
            </p>
          )}
          {where.isError && !isNotBuilt(where.error) && (
            <ErrorNotice error={where.error} context="Could not load what runs in each environment." onRetry={() => void where.refetch()} />
          )}
        </Fieldset>
      </div>
    );
  }

  // ---- review ----
  const version = selectedRelease?.version ?? releaseId;
  const review = releaseId && env
    ? (
      <>
        <b>Review:</b> {app.name} <Mono>{version}</Mono> to {env}. {whereKnown ? replaces(env, version, cell) : ''}
      </>
    )
    : <>Choose a release and an environment to review the deployment.</>;

  return (
    <>
      {header}
      <Columns layout="two" className={s.limit}>
        <Card>
          <form ref={formRef} className={s.form} onSubmit={onSubmit} noValidate aria-label="Deployment form">
            {me !== undefined && !canDeploy && (
              <Notice tone="info">
                <p>You can view releases but not deploy. Deploying {app.name} needs DEPLOYER on {teamName}.</p>
              </Notice>
            )}

            {releaseSection}
            {envSection}

            <Notice>
              <p>{review}</p>
            </Notice>

            {activeCell && !conflict && (
              <Notice
                tone="warning"
                title={`${env} already has an active deployment`}
                actions={<Link to={`/deployments/${activeCell.deploymentId}`}>Open the active deployment</Link>}
              >
                <p>
                  {app.name} <Mono>{activeCell.releaseVersion}</Mono> is {activeCell.status} in {env}. Only one deployment per
                  application and environment can be active, and a HEALTHY one counts, so this request will be refused.
                </p>
                <p>
                  {isLive(activeCell.status)
                    ? 'It can be rolled back once it is HEALTHY or DEGRADED. Until then, choose another environment.'
                    : 'Roll it back first, or choose another environment.'}
                </p>
              </Notice>
            )}

            {accepted && deploy.variables && (
              <Notice
                tone="success"
                title={accepted.replayed ? 'Already accepted' : 'Accepted'}
                actions={
                  <ButtonLink size="sm" variant="primary" to={`/deployments/${accepted.accepted.deploymentId}`}>
                    Follow progress
                  </ButtonLink>
                }
              >
                <p>
                  {app.name} <Mono>{versionOf(deploy.variables.releaseId)}</Mono> to {deploy.variables.environment} is {accepted.accepted.status}.
                </p>
                <p>Deployment <Mono>{accepted.accepted.deploymentId}</Mono>, task <Mono>{accepted.accepted.taskId}</Mono></p>
                <p>
                  {accepted.replayed
                    ? 'Already accepted: this is the same deployment as before. Submitting the same request again never deploys twice.'
                    : 'Submitting the same request again returns this deployment. It never deploys twice.'}
                </p>
              </Notice>
            )}

            {deploy.isError && (
              <DeployError
                error={deploy.error}
                activeDeploymentId={cell && !isFinal(cell.status) ? cell.deploymentId : undefined}
                unmappedValidation={unmappedValidation}
                onRetry={() => { if (deploy.variables) deploy.mutate(deploy.variables); }}
              />
            )}

            <Row>
              <Button type="submit" variant="primary" disabled={!canDeploy || deploy.isPending} busy={deploy.isPending}>
                Deploy
              </Button>
              <ButtonLink to={`/applications/${app.id}`}>{accepted ? `Back to ${app.name}` : 'Cancel'}</ButtonLink>
            </Row>
            <p className={s.small}>Safe to retry: if the connection drops, submit again. The same request never deploys twice.</p>
          </form>
        </Card>

        <Card as="aside" title="After you submit" titleId="after-submit-title">
          <ol className={s.steps}>
            <li><b>Accepted at once.</b> You get a deployment id right away; the work runs in the background.</li>
            <li><b>Clear states.</b> PENDING, then VALIDATING, DEPLOYING and HEALTHY; or FAILED with a reason.</li>
            <li><b>Short failures retry by themselves.</b> Permanent ones stop and go to the operators&apos; queue.</li>
            <li><b>Roll back in one click</b> once the deployment is HEALTHY or DEGRADED.</li>
          </ol>
        </Card>
      </Columns>
    </>
  );
}

/** Plan §8.1 treatment of every way a deployment request can be refused. */
function DeployError({ error, activeDeploymentId, unmappedValidation, onRetry }: {
  error: unknown;
  activeDeploymentId: string | undefined;
  unmappedValidation: boolean;
  onRetry: () => void;
}) {
  if (isProblem(error, 'conflict')) {
    return (
      <ProblemNotice
        error={error}
        title="Not started: conflict"
        actions={activeDeploymentId && <Link to={`/deployments/${activeDeploymentId}`}>Open the active deployment</Link>}
      >
        {isApiError(error) && error.detail && <p>{error.detail}</p>}
        <p>Nothing was deployed. Roll back the active deployment first, or choose another environment.</p>
      </ProblemNotice>
    );
  }
  if (isProblem(error, 'forbidden')) return <ProblemNotice error={error} title="Not allowed" />;
  if (isProblem(error, 'unprocessable')) return <ProblemNotice error={error} title="The request was refused" />;
  if (isProblem(error, 'idempotency-key-reused')) {
    return (
      <ProblemNotice error={error} title="The request changed while it was being sent">
        <p>Nothing was deployed. Submit again; the console now sends it as a new request.</p>
      </ProblemNotice>
    );
  }
  if (isProblem(error, 'validation-failed')) {
    return unmappedValidation ? <ErrorNotice error={error} /> : null;
  }
  return (
    <ErrorNotice
      error={error}
      context="The deployment request did not complete."
      onRetry={onRetry}
      retryLabel="Submit again"
    />
  );
}
