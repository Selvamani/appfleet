import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { requestRollback } from '../../api/control';
import { qk, READ_SIDE } from '../../api/keys';
import type { WhereCell } from '../../api/types';
import { Button, ButtonLink, Card, ErrorNotice, Mono, Notice, Row, StatusChip } from '../../components';
import { formatAgo, formatWhen } from '../../lib/format';
import { isFinal, isLive } from '../../lib/statusTone';
import s from './applications.module.css';
import { ProblemNotice } from './notices';
import { isProblem } from './shared';

/**
 * One environment of one application: the current deployment from the read model, the links to
 * open it or deploy over it, and roll back while it is HEALTHY or DEGRADED.
 */
export function EnvironmentCard({ applicationId, env, cell, canDeploy, canRollback, onWrite }: {
  applicationId: string;
  env: string;
  cell: WhereCell | undefined;
  canDeploy: boolean;
  canRollback: boolean;
  /** Called after an accepted write, so the page polls the read side until the change shows. */
  onWrite: () => void;
}) {
  const queryClient = useQueryClient();
  const rollback = useMutation({
    mutationFn: (deploymentId: string) => requestRollback(deploymentId),
    onSuccess: accepted => {
      onWrite();
      void queryClient.invalidateQueries({ queryKey: READ_SIDE });
      void queryClient.invalidateQueries({ queryKey: qk.deployment(accepted.deploymentId) });
      void queryClient.invalidateQueries({ queryKey: qk.deploymentTasks(accepted.deploymentId) });
    },
  });
  const deployHref = `/applications/${applicationId}/deploy?env=${encodeURIComponent(env)}`;

  const heading = <h3 className={s.h3}>{env}</h3>;

  if (!cell) {
    return (
      <Card className={s.envCard}>
        <div className={s.envHead}>{heading}</div>
        <p className={s.nothing}>Nothing deployed yet</p>
        {canDeploy && (
          <div className={s.envFoot}>
            <Row><ButtonLink size="sm" to={deployHref}>Deploy to {env}</ButtonLink></Row>
          </div>
        )}
      </Card>
    );
  }

  const active = !isFinal(cell.status);
  const rollbackable = cell.status === 'HEALTHY' || cell.status === 'DEGRADED';
  const accepted = rollback.isSuccess && rollback.data.deploymentId === cell.deploymentId && rollbackable;
  const refresh = () => {
    rollback.reset();
    void queryClient.invalidateQueries({ queryKey: qk.whatRunsWhere(applicationId) });
  };

  return (
    <Card className={s.envCard}>
      <div className={s.envHead}>
        {heading}
        <StatusChip status={cell.status} />
      </div>
      <div>
        <div className={s.version}>{cell.releaseVersion}</div>
        <p className={s.small}>
          Changed <time dateTime={cell.since} title={`${formatWhen(cell.since)} UTC`}>{formatAgo(cell.since)}</time>, requested by {cell.requestedBy}
        </p>
        {cell.latest && (
          <p className={`${s.small} ${s.inline}`}>
            <span>Latest request:</span>
            <Mono>{cell.latest.releaseVersion}</Mono>
            <StatusChip status={cell.latest.status} />
            <Link to={`/deployments/${cell.latest.deploymentId}`}>
              Open{' '}<span className="sr-only">the latest deployment to {env}</span>
            </Link>
          </p>
        )}
      </div>

      {accepted && (
        <Notice tone="success">
          <p>Rollback accepted. A ROLLBACK task is PENDING; the state changes when it runs.</p>
        </Notice>
      )}
      {rollback.isError && (isProblem(rollback.error, 'conflict', 'illegal-transition')
        ? (
          <ProblemNotice
            error={rollback.error}
            title="Roll back was refused"
            actions={<Button size="sm" variant="quiet" onClick={refresh}>Refresh</Button>}
          />
        )
        : <ErrorNotice error={rollback.error} context="Roll back was not accepted." onRetry={() => rollback.mutate(cell.deploymentId)} />)}

      <div className={s.envFoot}>
        <Row>
          <ButtonLink size="sm" to={`/deployments/${cell.deploymentId}`}>
            Open deployment{' '}<span className="sr-only">in {env}</span>
          </ButtonLink>
          {canDeploy && <ButtonLink size="sm" to={deployHref}>Deploy to {env}</ButtonLink>}
          {canRollback && rollbackable && (
            <Button
              size="sm"
              onClick={() => rollback.mutate(cell.deploymentId)}
              disabled={rollback.isPending || accepted}
              busy={rollback.isPending}
            >
              {accepted ? 'Rollback requested' : 'Roll back'}
              {' '}<span className="sr-only">{cell.releaseVersion} in {env}</span>
            </Button>
          )}
        </Row>
        {active && (
          <p className={s.small}>
            A new deployment to {env} is refused while this one is active.{' '}
            {rollbackable && 'Roll it back first.'}
            {isLive(cell.status) && 'Roll back is possible once it is HEALTHY or DEGRADED.'}
          </p>
        )}
        {!active && <p className={s.small}>Nothing is active in {env}, so a new deployment can start.</p>}
      </div>
    </Card>
  );
}
