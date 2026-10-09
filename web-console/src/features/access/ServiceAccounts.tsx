import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import {
  addServiceAccountKey, createServiceAccount, disableServiceAccount, listServiceAccounts, revokeServiceAccountKey,
} from '../../api/identity';
import { qk } from '../../api/keys';
import type { ApiKeyView, IssuedKey, Role, ServiceAccount } from '../../api/types';
import {
  Button, Card, DataTable, EmptyState, ErrorNotice, FocusOnMount, InlineConfirm, Loading, Mono, Muted, Notice, SelectField, Stack,
  StatusChip, TextField, type Column,
} from '../../components';
import { formatAgo, formatDate } from '../../lib/format';
import { useRoles } from './accessQueries';
import { useAdministeredTeams } from './TeamsCard';
import s from './AccessPage.module.css';

/** The one-time view of a new key. It lives only in this component's state, never in the query cache. */
function IssuedKeyNotice({ account, issued, onHide }: { account: string; issued: IssuedKey; onHide: () => void }) {
  const [copied, setCopied] = useState<'yes' | 'failed' | null>(null);
  const copy = () => {
    if (!navigator.clipboard) {
      setCopied('failed');
      return;
    }
    navigator.clipboard.writeText(issued.apiKey).then(() => setCopied('yes'), () => setCopied('failed'));
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
        <code className={s.key}>{issued.apiKey}</code>
        <p>Copy this key now. It is not shown again, and nothing can recover it: a lost key is replaced, not looked up.</p>
      </Notice>
    </FocusOnMount>
  );
}

function KeysTable({ account, onRevoke, busy }: { account: ServiceAccount; onRevoke: (key: ApiKeyView) => Promise<unknown>; busy: boolean }) {
  const columns: Column<ApiKeyView>[] = [
    { key: 'prefix', header: 'Key', width: 'minmax(130px, 1fr)', render: k => <Mono>afk_{k.prefix}…</Mono> },
    { key: 'status', header: 'Status', width: 'minmax(90px, 0.6fr)', render: k => <StatusChip status={k.status} label={k.status === 'ACTIVE' ? 'Active' : 'Revoked'} /> },
    { key: 'created', header: 'Created', width: 'minmax(90px, 0.7fr)', render: k => formatDate(k.createdAt) },
    { key: 'used', header: 'Last used', width: 'minmax(90px, 0.7fr)', render: k => (k.lastUsedAt ? formatAgo(k.lastUsedAt) : <Muted>Never</Muted>) },
    {
      key: 'action',
      header: <span className={s.hiddenHeader}>Action</span>,
      width: 'minmax(130px, 0.8fr)',
      render: k => k.status === 'ACTIVE' && (
        <InlineConfirm trigger="Revoke" triggerLabel={`Revoke key ${k.prefix} of ${account.name}`} prompt="Revoke this key?" confirmLabel="Revoke" variant="danger" disabled={busy} onConfirm={() => onRevoke(k)} />
      ),
    },
  ];
  return <DataTable label={`Keys of ${account.name}`} columns={columns} rows={account.keys} rowKey={k => k.id} minWidth={520} />;
}

/**
 * Service accounts of one team: machines that sign in with a scoped API key, never a shared secret. An account holds ONE
 * role in ONE team. A key is exchanged for a 5 minute token; rotation is two steps (add a key, deploy it, revoke the old).
 */
export function ServiceAccounts() {
  const queryClient = useQueryClient();
  const { teams, isLoading } = useAdministeredTeams();
  const { roles, names } = useRoles();
  const [picked, setPicked] = useState('');
  const teamId = picked && teams.some(t => t.id === picked) ? picked : teams[0]?.id ?? '';
  const accounts = useQuery({ queryKey: qk.serviceAccounts(teamId), queryFn: () => listServiceAccounts(teamId), enabled: !!teamId });
  const [issued, setIssued] = useState<{ account: string; key: IssuedKey } | null>(null);
  const [name, setName] = useState('');
  const [role, setRole] = useState<Role>('DEPLOYER');
  const refresh = () => queryClient.invalidateQueries({ queryKey: qk.serviceAccounts(teamId) });

  // A machine must not administer people: identity-service refuses a role that manages users (ADMIN, or one that grants user:manage).
  const assignable = names.filter(r => r !== 'ADMIN' && !roles?.find(x => x.name === r)?.permissions.includes('user:manage'));
  const roleValue = assignable.includes(role) ? role : assignable[0] ?? '';

  const create = useMutation({
    mutationFn: () => createServiceAccount(teamId, name.trim(), roleValue),
    gcTime: 0,     // the response holds the first key
    onMutate: () => setIssued(null),
    onSuccess: created => {
      setIssued({ account: created.account.name, key: created.key });
      setName('');
      return refresh();
    },
  });

  const addKey = useMutation({
    mutationFn: (a: ServiceAccount) => addServiceAccountKey(teamId, a.id),
    gcTime: 0,
    onMutate: () => setIssued(null),
    onSuccess: (key, a) => {
      setIssued({ account: a.name, key });
      return refresh();
    },
  });

  const revoke = useMutation({
    mutationFn: (input: { account: ServiceAccount; key: ApiKeyView }) => revokeServiceAccountKey(teamId, input.account.id, input.key.id),
    onSuccess: refresh,
  });

  const disable = useMutation({
    mutationFn: (a: ServiceAccount) => disableServiceAccount(teamId, a.id),
    onSuccess: refresh,
  });

  const onCreate = (e: FormEvent) => {
    e.preventDefault();
    create.mutate();
  };

  return (
    <Card title="Service accounts" titleId="sa-title" aside="Machines sign in with scoped keys, never shared secrets.">
      <Stack gap="s">
        {isLoading && <Loading label="Loading teams" />}
        {!isLoading && teams.length === 0 && <EmptyState title="You administer no team, so there are no service accounts to manage." />}
        {teams.length > 0 && (
          <SelectField label="Team" value={teamId} onChange={e => { setPicked(e.target.value); setIssued(null); }}>
            {teams.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
          </SelectField>
        )}
        {issued && <IssuedKeyNotice account={issued.account} issued={issued.key} onHide={() => { setIssued(null); create.reset(); addKey.reset(); }} />}
        {addKey.isError && <ErrorNotice error={addKey.error} context={`Could not add a key to ${addKey.variables?.name ?? 'the account'}.`} />}
        {revoke.isError && <ErrorNotice error={revoke.error} context="Could not revoke the key." />}
        {disable.isError && <ErrorNotice error={disable.error} context="Could not disable the account." />}
        {accounts.isPending && teamId && <Loading label="Loading service accounts" />}
        {accounts.isError && <ErrorNotice error={accounts.error} context="Could not load service accounts." onRetry={() => void accounts.refetch()} />}
        {accounts.isSuccess && accounts.data.length === 0 && <EmptyState title="No service accounts in this team yet." />}
        {accounts.isSuccess && accounts.data.map(a => (
          <div key={a.id} className={s.account}>
            <div className={s.accountHead}>
              <h3 className={s.h3}>
                <Mono>{a.name}</Mono> {a.status === 'DISABLED' ? <StatusChip status="DEACTIVATED" label="Disabled" /> : <StatusChip status="ACTIVE" label="Active" />}
              </h3>
              <span className={s.accountMeta}>Role <Mono>{a.role}</Mono> · created {formatDate(a.createdAt)}</span>
              <span className={s.accountActions}>
                <InlineConfirm
                  trigger="Add a key"
                  triggerLabel={`Add a key to ${a.name}`}
                  prompt="Issue a second key?"
                  confirmLabel="Add key"
                  disabled={a.status !== 'ACTIVE'}
                  onConfirm={() => addKey.mutateAsync(a)}
                  returnFocusAfterConfirm={false}
                />
                <InlineConfirm
                  trigger="Disable"
                  triggerLabel={`Disable ${a.name}`}
                  prompt="Disable for good?"
                  confirmLabel="Disable"
                  variant="danger"
                  disabled={a.status !== 'ACTIVE'}
                  onConfirm={() => disable.mutateAsync(a)}
                />
              </span>
            </div>
            <KeysTable account={a} busy={revoke.isPending} onRevoke={key => revoke.mutateAsync({ account: a, key })} />
          </div>
        ))}
        {teamId && (
          <form onSubmit={onCreate} aria-labelledby="new-sa-title">
            <Stack gap="s">
              <h3 className={s.h3} id="new-sa-title">Create a service account</h3>
              {create.isError && <ErrorNotice error={create.error} context="Could not create the service account." />}
              <div className={s.grantForm}>
                <TextField label="Name" hint="Lower case letters, digits and hyphens." value={name} onChange={e => setName(e.target.value)} />
                <SelectField label="Role" value={roleValue} onChange={e => setRole(e.target.value)}>
                  {assignable.map(r => <option key={r} value={r}>{r}</option>)}
                </SelectField>
                <Button type="submit" busy={create.isPending} disabled={create.isPending || name.trim().length < 2 || !roleValue}>Create account</Button>
              </div>
              <Muted as="p">A key for a new account is shown once. Roles that manage users are not offered: a machine must not administer people.</Muted>
            </Stack>
          </form>
        )}
      </Stack>
    </Card>
  );
}
