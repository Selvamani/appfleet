import type { DeploymentState, TimelineEvent } from '../../api/types';
import { Card, StatusChip, Stepper } from '../../components';
import { OTHER_OUTCOMES, progressSteps } from './deploymentView';
import s from './Deployment.module.css';

/** The FSM's happy path as a stepper, plus the outcomes off that path with the current one marked. */
export function DeploymentProgress({ status, events }: { status: DeploymentState; events?: TimelineEvent[] }) {
  return (
    <Card title="Progress" titleId="dep-progress">
      <Stepper label="Deployment progress" steps={progressSteps(status, events)} />
      <div className={s.outcomes}>
        <span className={s.meta} id="dep-outcomes">Other outcomes:</span>
        <ul className={s.outcomeList} aria-labelledby="dep-outcomes">
          {OTHER_OUTCOMES.map(outcome => (
            <li key={outcome}>
              {outcome === status ? (
                <>
                  <StatusChip status={outcome} />
                  <span className={s.meta}>current</span>
                </>
              ) : (
                <span className={s.offChip}>{outcome}</span>
              )}
            </li>
          ))}
        </ul>
      </div>
    </Card>
  );
}
