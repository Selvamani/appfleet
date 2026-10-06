import type { Ref } from 'react';
import { isApiError } from '../../api/http';
import type { DeploymentState } from '../../api/types';
import { Button, CorrelationId, ErrorNotice, Notice } from '../../components';
import { describeError } from '../../lib/errorText';
import s from './Deployment.module.css';

/**
 * What came of the rollback request: accepted (and later finished), or refused. A conflict or an
 * illegal transition means this view is out of date, so it offers Refresh (plan §8.1); other errors
 * use ErrorNotice. The wrapper takes focus after Confirm, so the outcome is read at once.
 */
export function RollbackOutcome({ accepted, status, error, onRefresh, onRetry, ref }: {
  accepted: boolean;
  status: DeploymentState;
  error: unknown;
  onRefresh: () => void;
  onRetry: () => void;
  ref?: Ref<HTMLDivElement>;
}) {
  let content = null;
  if (accepted) {
    content = status === 'ROLLED_BACK'
      ? <Notice tone="success" title="Rollback finished.">The previous release is restored and the deployment is ROLLED_BACK.</Notice>
      : (
        <Notice tone="success" title="Rollback accepted.">
          A ROLLBACK task is PENDING; the state changes to ROLLED_BACK when it completes.
        </Notice>
      );
  } else if (error) {
    if (isApiError(error) && error.is('conflict', 'illegal-transition', 'concurrent-modification')) {
      const d = describeError(error);
      content = (
        <Notice
          tone="warning"
          title="Could not request the rollback."
          actions={
            <>
              <Button size="sm" onClick={onRefresh}>Refresh</Button>
              <CorrelationId id={error.correlationId} />
            </>
          }
        >
          <p>{d.title}.</p>
          <p>{error.type === 'conflict' ? `${d.body} Refresh to see the current state.` : d.body}</p>
        </Notice>
      );
    } else {
      content = <ErrorNotice error={error} context="Could not request the rollback." onRetry={onRetry} />;
    }
  }
  if (!content) return null;
  return <div ref={ref} tabIndex={-1} className={s.focusTarget}>{content}</div>;
}
