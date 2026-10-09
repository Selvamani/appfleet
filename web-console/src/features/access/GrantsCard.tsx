import { useMutation } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { addMember, changeMemberRole, removeMember } from '../../api/identity';
import type { Grant, Role, UserSummary } from '../../api/types';
import {
  Button, Card, DataTable, DetailList, ErrorNotice, FocusOnMount, InlineConfirm, Mono, Muted, Notice, SelectField, Stack, type Column,
} from '../../components';
import { useTeams } from '../../auth/useTeams';
import { grantText, useRefreshAccess, useRoles } from './accessQueries';
import s from './AccessPage.module.css';

const SESSIONS_ENDED =
  'Their sessions ended. A token already issued stops working at once on identity-service, and in other services when it expires (15 minutes at most).';

/** One role held in one team, with the role as a select that applies on request. */
function RoleCell({ grant, roles, disabled, onApply }: { grant: Grant; roles: Role[]; disabled: boolean; onApply: (role: Role) => Promise<unknown> | void }) {
  const [role, setRole] = useState(grant.role);
  const changed = role !== grant.role;
  return (
    <span className={s.roleCell}>
      <select
        aria-label={`Role of ${grantText(grant)}`}
        value={role}
        disabled={disabled}
        onChange={e => setRole(e.target.value)}
      >
        {[...new Set([grant.role, ...roles])].map(r => <option key={r} value={r}>{r}</option>)}
      </select>
      {changed && (
        <Button size="sm" disabled={disabled} onClick={() => void onApply(role)} aria-label={`Change ${grantText(grant)} to ${role}`}>
          Change
        </Button>
      )}
    </span>
  );
}

/**
 * The roles of one user, one per team (identity-service holds one role per user per team). A role change or a removal ends
 * the user's sessions at once, because their tokens still carry the old permissions.
 */
export function GrantsCard({ user, grants }: { user: UserSummary; grants: Grant[] }) {
  const refresh = useRefreshAccess();
  const { teams } = useTeams();
  const { roles, names } = useRoles();
  const [team, setTeam] = useState('');
  const [role, setRole] = useState<Role>('VIEWER');
  // The outcome of the last write. A removal removes the row (and its button), so its notice takes focus.
  const [done, setDone] = useState<{ text: string; focus: boolean } | null>(null);
  const deactivated = user.status === 'DEACTIVATED';
  const free = teams.filter(t => !grants.some(g => g.teamId === t.id));
  const teamValue = team && free.some(t => t.id === team) ? team : free[0]?.id ?? '';

  const change = useMutation({
    mutationFn: (input: { grant: Grant; role: Role }) => changeMemberRole(input.grant.teamId, user.id, input.role),
    onMutate: () => { setDone(null); remove.reset(); add.reset(); },
    onSuccess: (_member, input) => {
      setDone({ text: `Changed to ${input.role} on ${input.grant.teamName}. ${SESSIONS_ENDED}`, focus: false });
      return refresh(input.grant.teamId);
    },
  });

  const remove = useMutation({
    mutationFn: (g: Grant) => removeMember(g.teamId, user.id),
    onMutate: () => { setDone(null); change.reset(); add.reset(); },
    onSuccess: (_void, g) => {
      setDone({ text: `Removed ${g.role} on ${g.teamName}. ${SESSIONS_ENDED}`, focus: true });
      return refresh(g.teamId);
    },
  });

  const add = useMutation({
    mutationFn: (input: { teamId: string; role: Role }) => addMember(input.teamId, user.id, input.role),
    onMutate: () => { setDone(null); change.reset(); remove.reset(); },
    onSuccess: (_member, input) => {
      setDone({ text: `Granted ${input.role} on ${teams.find(t => t.id === input.teamId)?.name ?? 'the team'}. It shows in their next token.`, focus: false });
      return refresh(input.teamId);
    },
  });

  const onAdd = (e: FormEvent) => {
    e.preventDefault();
    if (teamValue) add.mutate({ teamId: teamValue, role });
  };

  const columns: Column<Grant>[] = [
    { key: 'team', header: 'Team', width: 'minmax(110px, 1fr)', render: g => g.teamName },
    {
      key: 'role',
      header: 'Role',
      width: 'minmax(170px, 1.2fr)',
      render: g => <RoleCell key={`${g.teamId}:${g.role}`} grant={g} roles={names} disabled={deactivated || change.isPending} onApply={r => change.mutateAsync({ grant: g, role: r })} />,
    },
    {
      key: 'action',
      header: <span className={s.hiddenHeader}>Action</span>,
      width: 'minmax(130px, 0.8fr)',
      render: g => (
        <InlineConfirm
          trigger="Remove"
          triggerLabel={`Remove ${grantText(g)}`}
          prompt={`Remove ${g.role}?`}
          confirmLabel="Remove"
          variant="danger"
          disabled={deactivated}
          onConfirm={() => remove.mutateAsync(g)}
        />
      ),
    },
  ];

  return (
    <Card title="Grants" titleId="grants-title" aside="One role per team.">
      <Stack>
        {done && <FocusOnMount enabled={done.focus}><Notice tone="success">{done.text}</Notice></FocusOnMount>}
        {remove.isError && <ErrorNotice error={remove.error} context={`Could not remove ${remove.variables ? grantText(remove.variables) : 'the grant'}.`} />}
        {change.isError && <ErrorNotice error={change.error} context="Could not change the role." />}
        <DataTable
          label={`Grants of ${user.displayName || user.email}`}
          columns={columns}
          rows={grants}
          rowKey={g => g.teamId}
          minWidth={520}
          emptyText={deactivated ? 'No grants.' : 'No grants. This user can sign in but sees no team\'s data.'}
        />

        <form onSubmit={onAdd} aria-labelledby="add-grant-title">
          <Stack gap="s">
            <h3 className={s.h3} id="add-grant-title">Add a grant</h3>
            {deactivated && <Muted as="p">Deactivated users cannot be given new grants.</Muted>}
            {add.isError && <ErrorNotice error={add.error} context="Could not add the grant." />}
            <div className={s.grantForm}>
              <SelectField label="Team" value={teamValue} onChange={e => setTeam(e.target.value)} disabled={deactivated || free.length === 0}>
                {free.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
              </SelectField>
              <SelectField label="Role" value={role} onChange={e => setRole(e.target.value)} disabled={deactivated}>
                {names.map(r => <option key={r} value={r}>{r}</option>)}
              </SelectField>
              <Button type="submit" busy={add.isPending} disabled={deactivated || add.isPending || !teamValue}>Add grant</Button>
            </div>
            {free.length === 0 && !deactivated && <Muted as="p">This user already holds a role in every team.</Muted>}
          </Stack>
        </form>

        <div className={s.roleGuide}>
          <h3 className={s.h3}>What each role can do</h3>
          <Muted as="p">
            Roles are bundles of permissions, held per team. Each role also holds what the roles below it hold
            (VIEWER, DEPLOYER, OPERATOR, ADMIN, in that order). The list shows each role's own permissions.
          </Muted>
          <DetailList items={(roles ?? []).map(r => [<Mono key={r.name}>{r.name}</Mono>, `${r.description}. Own permissions: ${r.permissions.join(', ')}.`])} />
        </div>
      </Stack>
    </Card>
  );
}
