import { useMutation, useQueryClient, type InfiniteData } from '@tanstack/react-query';
import { useEffect, useRef } from 'react';
import { isApiError } from '../../api/http';
import { qk } from '../../api/keys';
import { replayDeadLetter } from '../../api/tasks';
import type { CursorPage, DeadLetter } from '../../api/types';
import { usePermissions } from '../../auth/usePermissions';
import {
  Button, Card, DataTable, EmptyState, ErrorNotice, LoadMore, Loading, Mono, Muted, Stack, StatusChip, type Column,
} from '../../components';
import { formatWhen } from '../../lib/format';
import s from './FleetPage.module.css';
import { useDeadLetters } from './fleetQueries';

export function DeadLetterTable() {
  const { can } = usePermissions();
  const queryClient = useQueryClient();
  const list = useDeadLetters();
  const tableRef = useRef<HTMLDivElement>(null);
  const focusReplayed = useRef<string | null>(null);
  const replay = useMutation({
    mutationFn: (item: DeadLetter) => replayDeadLetter(item.taskId),
    // The response is the updated message, so patch it in place instead of refetching every page.
    onSuccess: updated => {
      focusReplayed.current = updated.taskId;
      queryClient.setQueryData<InfiniteData<CursorPage<DeadLetter>>>(qk.deadLetters(), data => data && {
        ...data,
        pages: data.pages.map(p => ({ ...p, items: p.items.map(i => (i.taskId === updated.taskId ? updated : i)) })),
      });
    },
    onError: error => {
      // Already replayed by someone else, or gone: show the current state next to the message.
      if (isApiError(error) && error.is('conflict', 'not-found')) void queryClient.invalidateQueries({ queryKey: qk.deadLetters() });
    },
  });
  const canReplay = can('dlq:replay');

  // The Replay button turns into a chip, so focus follows it there instead of dropping to the page.
  useEffect(() => {
    const id = focusReplayed.current;
    if (!id) return;
    const chip = tableRef.current?.querySelector<HTMLElement>(`[data-replayed="${id}"]`);
    if (chip) {
      focusReplayed.current = null;
      chip.focus();
    }
  });

  const columns: Column<DeadLetter>[] = [
    { key: 'failed', header: 'Failed (UTC)', width: 'minmax(90px, 0.7fr)', render: d => <Mono>{formatWhen(d.failedAt)}</Mono> },
    { key: 'work', header: 'Work', width: 'minmax(170px, 1.6fr)', render: d => d.work },
    { key: 'type', header: 'Task type', width: 'minmax(70px, 0.5fr)', render: d => <Mono>{d.taskType}</Mono> },
    { key: 'reason', header: 'Reason', width: 'minmax(170px, 1.6fr)', render: d => d.reason },
    { key: 'attempts', header: 'Attempts', width: 'minmax(70px, 0.5fr)', align: 'end', render: d => d.attempts },
    {
      key: 'action',
      header: <span className={s.hiddenHeader}>Action</span>,
      width: 'minmax(150px, 1fr)',
      render: d => {
        if (d.replayed) {
          return <span tabIndex={-1} data-replayed={d.taskId}><StatusChip status="QUEUED" label="Replayed, queued" /></span>;
        }
        if (!canReplay) return <Muted>Waiting</Muted>;
        const busy = replay.isPending && replay.variables?.taskId === d.taskId;
        return (
          <Button size="sm" aria-label={`Replay ${d.work}`} busy={busy} disabled={busy} onClick={() => replay.mutate(d)}>
            Replay
          </Button>
        );
      },
    },
  ];

  return (
    <Card title="Dead-letter queue" titleId="dlq-title" aside="Permanent failures stop here until someone replays them.">
      <Stack gap="s">
        {replay.isError && (
          <ErrorNotice error={replay.error} context={`Could not replay ${replay.variables?.work ?? 'the message'}.`} />
        )}
        {list.isPending && <Loading label="Loading dead letters" />}
        {list.isError && <ErrorNotice error={list.error} context="Could not load the dead-letter queue." onRetry={() => void list.refetch()} />}
        {list.isSuccess && list.items.length === 0 && (
          <EmptyState title="The dead-letter queue is empty.">Tasks that fail permanently stop here until someone replays them.</EmptyState>
        )}
        {list.isSuccess && list.items.length > 0 && (
          <div>
            <div ref={tableRef}>
              <DataTable label="Dead-letter queue" columns={columns} rows={list.items} rowKey={d => d.taskId} minWidth={780} />
            </div>
            <LoadMore
              hasMore={list.hasNextPage}
              loading={list.isFetchingNextPage}
              onLoad={() => void list.fetchNextPage()}
              note="Newest first. Older messages load by cursor."
            />
          </div>
        )}
      </Stack>
    </Card>
  );
}
