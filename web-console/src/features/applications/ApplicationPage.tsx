import { useQuery } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { useParams } from 'react-router';
import { getApplication } from '../../api/control';
import { listTeams } from '../../api/identity';
import { qk } from '../../api/keys';
import { getWhatRunsWhere } from '../../api/query';
import type { ApplicationResponse, ReleaseResponse } from '../../api/types';
import { usePermissions } from '../../auth/usePermissions';
import {
  Button, ButtonLink, Columns, ErrorNotice, Freshness, Loading, Notice, PageHeader,
} from '../../components';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { isLive } from '../../lib/statusTone';
import s from './applications.module.css';
import { EnvironmentCard } from './EnvironmentCard';
import { HistoryCard } from './HistoryCard';
import { ApplicationNotFound, NotBuiltNotice } from './notices';
import { RegisterReleaseForm } from './RegisterReleaseForm';
import { ReleasesCard } from './ReleasesCard';
import { isNotBuilt, isProblem, readModelPoll } from './shared';

const TOGGLE_ID = 'register-release-toggle';

export function ApplicationPage() {
  const { applicationId = '' } = useParams();
  const app = useQuery({ queryKey: qk.application(applicationId), queryFn: () => getApplication(applicationId) });
  useDocumentTitle(app.data?.name ?? (app.isPending ? 'Application' : undefined));

  if (app.isPending) return <Loading label="Loading application" />;
  if (app.isError) {
    if (isProblem(app.error, 'not-found')) return <ApplicationNotFound />;
    return (
      <>
        <PageHeader crumbs={[{ label: 'Applications', to: '/applications' }, { label: 'Application' }]} title="Application" />
        <ErrorNotice error={app.error} context="Could not load the application." onRetry={() => void app.refetch()} />
      </>
    );
  }
  return <ApplicationDetail key={app.data.id} app={app.data} />;
}

function ApplicationDetail({ app }: { app: ApplicationResponse }) {
  const { me, can } = usePermissions();
  const teams = useQuery({ queryKey: qk.teams(), queryFn: listTeams, staleTime: 10 * 60_000 });
  const teamName = teams.data?.find(t => t.id === app.ownerTeamId)?.name ?? 'the owner team';

  const [formOpen, setFormOpen] = useState(false);
  const [registered, setRegistered] = useState<ReleaseResponse | null>(null);
  const [lastWriteAt, setLastWriteAt] = useState<string | null>(null);
  const returnFocus = useRef(false);

  const where = useQuery({
    queryKey: qk.whatRunsWhere(app.id),
    queryFn: () => getWhatRunsWhere(app.id),
    refetchInterval: q => {
      const cells = Object.values(q.state.data?.rows[0]?.cells ?? {});
      return readModelPoll(lastWriteAt, cells.some(c => c && isLive(c.status)));
    },
  });

  // Closing the release form returns focus to the button that opened it.
  useEffect(() => {
    if (!formOpen && returnFocus.current) {
      returnFocus.current = false;
      document.getElementById(TOGGLE_ID)?.focus();
    }
  }, [formOpen]);

  const permsKnown = me !== undefined;
  const canRelease = can('release:create', app.ownerTeamId);
  const canDeploy = can('deployment:create', app.ownerTeamId);
  const canRollback = can('deployment:rollback', app.ownerTeamId);

  const openForm = () => {
    setRegistered(null);
    setFormOpen(true);
  };
  const closeForm = () => {
    returnFocus.current = true;
    setFormOpen(false);
  };

  const cells = where.data?.rows[0]?.cells ?? {};

  return (
    <>
      <PageHeader
        crumbs={[{ label: 'Applications', to: '/applications' }, { label: app.name }]}
        title={app.name}
        subtitle={app.description ? `${app.description}, owned by ${teamName}` : `Owned by ${teamName}`}
        actions={(canRelease || canDeploy) && (
          <>
            {canRelease && (
              <Button
                id={TOGGLE_ID}
                aria-expanded={formOpen}
                aria-controls={formOpen ? 'register-release' : undefined}
                onClick={() => (formOpen ? closeForm() : openForm())}
              >
                Register release
              </Button>
            )}
            {canDeploy && <ButtonLink to={`/applications/${app.id}/deploy`} variant="primary">Deploy</ButtonLink>}
          </>
        )}
      />

      {permsKnown && !canRelease && !canDeploy && (
        <Notice tone="info">
          <p>View only. Changing {app.name} needs DEPLOYER on {teamName}.</p>
        </Notice>
      )}

      {formOpen && (
        <RegisterReleaseForm
          applicationId={app.id}
          artifactHint={`registry.internal/${teamName.toLowerCase().replace(/\s+/g, '-')}/${app.name}`}
          onCancel={closeForm}
          onRegistered={release => {
            setRegistered(release);
            closeForm();
          }}
        />
      )}

      <section aria-labelledby="environments-title">
        <div className={s.sectionHead}>
          <h2 className={s.h2} id="environments-title">Environments</h2>
          {where.data && <Freshness asOf={where.data.asOf} waitingFor={lastWriteAt} />}
        </div>
        {where.isPending && <Loading label="Loading environments" />}
        {where.isError && (isNotBuilt(where.error)
          ? <NotBuiltNotice what="The current state per environment" endpoint="GET /api/v1/dashboard/where" />
          : <ErrorNotice error={where.error} context="Could not load what runs where." onRetry={() => void where.refetch()} />)}
        {where.isSuccess && (
          <Columns layout="three">
            {where.data.environments.map(env => (
              <EnvironmentCard
                key={env}
                applicationId={app.id}
                env={env}
                cell={cells[env]}
                canDeploy={canDeploy}
                canRollback={canRollback}
                onWrite={() => setLastWriteAt(new Date().toISOString())}
              />
            ))}
          </Columns>
        )}
      </section>

      <Columns layout="pair" ratio="minmax(0,1.4fr) minmax(0,1fr)">
        <ReleasesCard
          applicationId={app.id}
          where={where.data}
          canDeploy={canDeploy}
          canRelease={canRelease}
          registered={registered}
          onRegisterRelease={openForm}
        />
        <HistoryCard applicationId={app.id} lastWriteAt={lastWriteAt} />
      </Columns>
    </>
  );
}
