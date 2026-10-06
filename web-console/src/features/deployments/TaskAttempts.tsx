import { Link } from 'react-router';
import type { Attempt, TaskResponse } from '../../api/types';
import { Card, EmptyState, ErrorNotice, LoadMore, Loading, Mono, StatusChip } from '../../components';
import { formatTime } from '../../lib/format';
import { taskLabel } from './deploymentView';
import s from './Deployment.module.css';

export interface TaskListState {
  items: TaskResponse[];
  isPending: boolean;
  isError: boolean;
  error: unknown;
  hasNextPage: boolean;
  isFetchingNextPage: boolean;
  refetch: () => void;
  fetchNextPage: () => void;
}

/**
 * Tasks from control-api, each with its attempts from the query-service timeline. Attempts are
 * omitted (not shown as empty) when the timeline is not available.
 */
export function TaskAttempts({ tasks, attempts, canSeeDeadLetters }: {
  tasks: TaskListState;
  /** undefined while the timeline is loading or not available. */
  attempts: Attempt[] | undefined;
  canSeeDeadLetters: boolean;
}) {
  return (
    <Card title="Tasks and attempts" titleId="dep-tasks">
      {tasks.isPending && <Loading label="Loading tasks" />}
      {tasks.isError && <ErrorNotice error={tasks.error} context="Could not load the tasks." onRetry={tasks.refetch} />}
      {!tasks.isPending && !tasks.isError && tasks.items.length === 0 && (
        <EmptyState title="No tasks yet">The DEPLOY task appears here once control-api has recorded it.</EmptyState>
      )}
      {tasks.items.length > 0 && (
        <ul className={s.tasks} aria-label="Tasks">
          {tasks.items.map(task => (
            <TaskBox
              key={task.id}
              task={task}
              attempts={attempts?.filter(a => a.taskId === task.id)}
              canSeeDeadLetters={canSeeDeadLetters}
            />
          ))}
        </ul>
      )}
      {tasks.hasNextPage && (
        <LoadMore
          hasMore
          loading={tasks.isFetchingNextPage}
          onLoad={tasks.fetchNextPage}
          note="Oldest first. More tasks load by cursor."
        />
      )}
    </Card>
  );
}

function TaskBox({ task, attempts, canSeeDeadLetters }: { task: TaskResponse; attempts: Attempt[] | undefined; canSeeDeadLetters: boolean }) {
  const deadLettered = attempts?.some(a => a.permanent) ?? false;
  return (
    <li className={s.task}>
      <div className={s.taskHead}>
        <div className={s.taskName}>
          <strong>{task.taskType}</strong>
          <span className={s.meta}>task <Mono title={task.id}>{taskLabel(task.id)}</Mono></span>
        </div>
        <StatusChip status={task.status} />
      </div>

      {attempts && attempts.length === 0 && (
        <p className={s.meta}>
          {task.status === 'PENDING' ? 'Waiting for a worker to pick this up.' : 'No attempts recorded for this task.'}
        </p>
      )}
      {attempts && attempts.length > 0 && (
        <ol className={s.attempts} aria-label={`Attempts for the ${task.taskType} task`}>
          {[...attempts].sort((a, b) => a.attempt - b.attempt).map(a => (
            <li key={a.attempt} className={s.attempt}>
              <span className={s.attemptLabel}>Attempt {a.attempt}</span>
              <StatusChip status={a.status} />
              <div className={s.attemptBody}>
                <span className={s.attemptMeta}>
                  <Mono>{formatTime(a.startedAt)}</Mono> UTC, {a.node}, fencing token <Mono>{a.fencingToken}</Mono>
                </span>
                <span className={s.message}>{a.message}</span>
              </div>
            </li>
          ))}
        </ol>
      )}
      {deadLettered && (
        <p className={s.dlq}>
          {canSeeDeadLetters
            ? <Link to="/fleet">View in the dead-letter queue</Link>
            : <span className={s.meta}>A permanent failure stops retries. Operators can replay it from the dead-letter queue.</span>}
        </p>
      )}
    </li>
  );
}
