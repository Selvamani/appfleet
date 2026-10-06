import { useMutation, useQueryClient } from '@tanstack/react-query';
import { isApiError } from '../../api/http';
import { qk } from '../../api/keys';
import { reclaimTask } from '../../api/tasks';
import type { StuckTask } from '../../api/types';
import { usePermissions } from '../../auth/usePermissions';
import { Button, Card, EmptyState, ErrorNotice, Mono, Notice, Stack, StatusChip } from '../../components';
import { formatTime } from '../../lib/format';
import { FocusOnMount } from '../../components';
import s from './FleetPage.module.css';

export function StuckTasks({ tasks }: { tasks: StuckTask[] }) {
  const { can } = usePermissions();
  const queryClient = useQueryClient();
  const reclaim = useMutation({
    mutationFn: (task: StuckTask) => reclaimTask(task.taskId),
    onSuccess: (_data, task) => Promise.all([
      queryClient.invalidateQueries({ queryKey: qk.fleet() }),
      queryClient.invalidateQueries({ queryKey: qk.deployment(task.deploymentId) }),
      queryClient.invalidateQueries({ queryKey: qk.timeline(task.deploymentId) }),
    ]),
    onError: error => {
      if (isApiError(error) && error.is('conflict', 'not-found')) void queryClient.invalidateQueries({ queryKey: qk.fleet() });
    },
  });
  const canReclaim = can('task:reclaim');

  return (
    <Card title="Stuck tasks" titleId="stuck-title" aside="Running tasks with no progress for more than 5 minutes.">
      <Stack gap="s">
        {reclaim.isSuccess && (
          // The task leaves the list, and its button with it, so focus moves to the outcome.
          <FocusOnMount>
            <Notice tone="success">Lease released. The task is back in the queue; another worker will finish it.</Notice>
          </FocusOnMount>
        )}
        {reclaim.isError && (
          <ErrorNotice error={reclaim.error} context={`Could not reclaim ${reclaim.variables?.title ?? 'the task'}.`} />
        )}
        {tasks.length === 0 ? (
          <EmptyState title="No stuck tasks.">Tasks that stop making progress show here, with a way to hand them to another worker.</EmptyState>
        ) : (
          <ul className={s.stuckList} aria-labelledby="stuck-title">
            {tasks.map(t => {
              const busy = reclaim.isPending && reclaim.variables?.taskId === t.taskId;
              return (
                <li key={t.taskId} className={s.stuck}>
                  <div className={s.stuckText}>
                    <p className={s.stuckTitle}>
                      <strong>{t.title}</strong>
                      <Mono>{t.taskType}</Mono>
                      <StatusChip status="RUNNING" label="Running" />
                    </p>
                    <p className={s.stuckMeta}>
                      Running since {formatTime(t.runningSince)} UTC on <Mono>{t.node}</Mono>. {t.reason}.
                    </p>
                  </div>
                  {canReclaim && (
                    <Button
                      size="sm"
                      aria-label={`Reclaim and retry ${t.title}`}
                      busy={busy}
                      disabled={reclaim.isPending}
                      onClick={() => reclaim.mutate(t)}
                    >
                      Reclaim and retry
                    </Button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </Stack>
    </Card>
  );
}
