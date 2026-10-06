import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { listServiceAccounts, rotateServiceAccountKey } from '../../api/identity';
import { qk } from '../../api/keys';
import type { RotatedKey, ServiceAccount } from '../../api/types';
import {
  Button, Card, DataTable, EmptyState, ErrorNotice, Loading, Mono, Muted, Notice, Stack, type Column,
} from '../../components';
import { formatAgo, formatDate, formatTime, formatWhen } from '../../lib/format';
import { FocusOnMount, InlineConfirm } from '../../components';
import s from './AccessPage.module.css';

/** The one-time view of a new key. It lives only in this component's state, never in the query cache. */
function IssuedKey({ account, issued, onHide }: { account: string; issued: RotatedKey; onHide: () => void }) {
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null);
  const copy = () => {
    if (!navigator.clipboard) {
      setCopied('failed');
      return;
    }
    navigator.clipboard.writeText(issued.key).then(() => setCopied('yes'), () => setCopied('failed'));
  };
  // Takes focus when it appears, so the Copy button is the next stop for keyboard users.
  return (
    <FocusOnMount>
      <Notice
        tone="success"
        title={`New key for ${account}`}
        actions={
          <>
            <Button size="sm" onClick={copy}>{copied === 'yes' ? 'Copied' : 'Copy'}</Button>
            <Button size="sm" variant="quiet" onClick={onHide}>Hide key</Button>
            {copied === 'failed' && <span>Copying is blocked here. Select the key and copy it by hand.</span>}
          </>
        }
      >
        <code className={s.key}>{issued.key}</code>
        <p>
          Copy this key now. It is not shown again. The old key keeps working until {formatTime(issued.oldKeyValidUntil)} UTC.
        </p>
      </Notice>
    </FocusOnMount>
  );
}

export function ServiceAccounts() {
  const queryClient = useQueryClient();
  const accounts = useQuery({ queryKey: qk.serviceAccounts(), queryFn: listServiceAccounts });
  const [issued, setIssued] = useState<{ account: string; key: RotatedKey } | null>(null);
  const tableRef = useRef<HTMLDivElement>(null);
  const rotate = useMutation({
    mutationFn: (sa: ServiceAccount) => rotateServiceAccountKey(sa.id),
    // Do not keep the secret in the mutation cache after this screen lets go of it.
    gcTime: 0,
    onMutate: () => setIssued(null),
    onSuccess: (key, sa) => {
      setIssued({ account: sa.name, key });
      return queryClient.invalidateQueries({ queryKey: qk.serviceAccounts() });
    },
  });

  const columns: Column<ServiceAccount>[] = [
    { key: 'name', header: 'Account', width: 'minmax(120px, 1fr)', render: a => <Mono><strong>{a.name}</strong></Mono> },
    { key: 'scopes', header: 'Scopes', width: 'minmax(170px, 1.6fr)', render: a => a.scopes.join(', ') },
    { key: 'key', header: 'Key', width: 'minmax(80px, 0.7fr)', render: a => <Mono>{a.keyHint}</Mono> },
    { key: 'created', header: 'Created', width: 'minmax(70px, 0.6fr)', render: a => formatDate(a.createdAt) },
    { key: 'used', header: 'Last used', width: 'minmax(80px, 0.7fr)', render: a => (a.lastUsedAt ? formatAgo(a.lastUsedAt) : <Muted>Never</Muted>) },
    { key: 'rotated', header: 'Rotated', width: 'minmax(90px, 0.8fr)', render: a => (a.rotatedAt ? formatWhen(a.rotatedAt) : <Muted>Never</Muted>) },
    {
      key: 'action',
      header: <span className={s.hiddenHeader}>Action</span>,
      width: 'minmax(160px, 1.1fr)',
      render: a => (
        <InlineConfirm
          trigger="Rotate key"
          triggerLabel={`Rotate key for ${a.name}`}
          prompt="Issue a new key?"
          confirmLabel="Rotate"
          onConfirm={() => rotate.mutateAsync(a)}
          returnFocusAfterConfirm={false}
        />
      ),
    },
  ];

  return (
    <Card title="Service accounts" titleId="sa-title" aside="Machines sign in with scoped keys, never shared secrets.">
      <Stack gap="s">
        {issued && (
          <IssuedKey
            account={issued.account}
            issued={issued.key}
            onHide={() => {
              // The notice and its buttons go away; focus returns to that account's Rotate key button.
              const label = `Rotate key for ${issued.account}`;
              [...(tableRef.current?.querySelectorAll('button') ?? [])].find(b => b.getAttribute('aria-label') === label)?.focus();
              setIssued(null);
              rotate.reset();
            }}
          />
        )}
        {rotate.isError && (
          <ErrorNotice error={rotate.error} context={`Could not rotate the key for ${rotate.variables?.name ?? 'the account'}.`} />
        )}
        {accounts.isPending && <Loading label="Loading service accounts" />}
        {accounts.isError && (
          <ErrorNotice error={accounts.error} context="Could not load service accounts." onRetry={() => void accounts.refetch()} />
        )}
        {accounts.isSuccess && accounts.data.length === 0 && <EmptyState title="No service accounts yet." />}
        {accounts.isSuccess && accounts.data.length > 0 && (
          <div ref={tableRef}>
            <DataTable label="Service accounts" columns={columns} rows={accounts.data} rowKey={a => a.id} minWidth={900} />
          </div>
        )}
      </Stack>
    </Card>
  );
}
