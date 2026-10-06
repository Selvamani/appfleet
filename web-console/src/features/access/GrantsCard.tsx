import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState, type FormEvent } from 'react';
import { isApiError } from '../../api/http';
import { grantRole, listTeams, revokeRole } from '../../api/identity';
import { qk } from '../../api/keys';
import type { Grant, Role, UserSummary } from '../../api/types';
import {
  Button, Card, DataTable, DetailList, ErrorNotice, Mono, Muted, Notice, SelectField, Stack, type Column,
} from '../../components';
import { formatWhen } from '../../lib/format';
import { FocusOnMount, InlineConfirm } from '../../components';
import { grantText, useApplyUser } from './accessQueries';
import s from './AccessPage.module.css';

const ROLES: Role[] = ['VIEWER', 'DEPLOYER', 'OPERATOR', 'ADMIN', 'AUDITOR'];
/** Path value for a grant on every team (the API cannot carry null in a path). */
const ALL_TEAMS = 'all';

const ROLE_MEANING: Array<[Role, string]> = [
  ['VIEWER', 'Reads the team\'s applications, releases and deployments, and starts tool sessions.'],
  ['DEPLOYER', 'Everything VIEWER can, plus deploys, registers releases and rolls back for that team.'],
  ['OPERATOR', 'Everything DEPLOYER can, plus runs the fleet: drains nodes, reclaims stuck tasks, replays dead letters.'],
  ['ADMIN', 'Everything OPERATOR can, plus manages access: users, grants and service-account keys.'],
  ['AUDITOR', 'Reads the audit trail. Nothing else, so it is usually held with VIEWER.'],
];

function teamLabel(g: Grant): string {
  return g.teamId ? g.teamName : 'All teams';
}

export function GrantsCard({ user }: { user: UserSummary }) {
  const queryClient = useQueryClient();
  const applyUser = useApplyUser();
  const teams = useQuery({ queryKey: qk.teams(), queryFn: listTeams, staleTime: 10 * 60_000 });
  const [team, setTeam] = useState('');
  const [role, setRole] = useState<Role>('VIEWER');
  // The outcome of the last write. A revoke removes the row (and its button), so its notice takes focus.
  const [done, setDone] = useState<{ text: string; focus: boolean } | null>(null);
  const deactivated = user.status === 'DEACTIVATED';
  const teamValue = team || teams.data?.[0]?.id || ALL_TEAMS;

  const refreshOnConflict = (error: unknown) => {
    // The grant list changed under us: show the current one next to the message.
    if (isApiError(error) && error.is('conflict', 'not-found')) void queryClient.invalidateQueries({ queryKey: qk.user(user.id) });
  };

  const revoke = useMutation({
    mutationFn: (g: Grant) => revokeRole(g.teamId ?? ALL_TEAMS, user.id, g.role),
    onMutate: () => { setDone(null); grant.reset(); },
    onSuccess: updated => {
      setDone({ text: 'Revoked. It takes effect within 5 minutes, including tokens already issued.', focus: true });
      return applyUser(updated);
    },
    onError: refreshOnConflict,
  });

  const grant = useMutation({
    mutationFn: (input: { teamId: string; role: Role }) => grantRole(input.teamId, user.id, input.role),
    onMutate: () => { setDone(null); revoke.reset(); },
    onSuccess: (updated, input) => {
      const name = input.teamId === ALL_TEAMS ? 'all teams' : teams.data?.find(t => t.id === input.teamId)?.name ?? 'the team';
      setDone({ text: `Granted ${input.role} on ${name}.`, focus: false });
      return applyUser(updated);
    },
    onError: refreshOnConflict,
  });

  const onAdd = (e: FormEvent) => {
    e.preventDefault();
    grant.mutate({ teamId: teamValue, role });
  };

  const columns: Column<Grant>[] = [
    { key: 'team', header: 'Team', width: 'minmax(90px, 1fr)', render: teamLabel },
    { key: 'role', header: 'Role', width: 'minmax(90px, 0.8fr)', render: g => <Mono>{g.role}</Mono> },
    { key: 'by', header: 'Granted by', width: 'minmax(80px, 0.8fr)', render: g => g.grantedBy },
    { key: 'at', header: 'Granted', width: 'minmax(90px, 0.8fr)', render: g => formatWhen(g.grantedAt) },
    {
      key: 'action',
      header: <span className={s.hiddenHeader}>Action</span>,
      width: 'minmax(150px, 1.1fr)',
      render: g => (
        <InlineConfirm
          trigger="Revoke"
          triggerLabel={`Revoke ${grantText(g)}`}
          prompt={`Revoke ${g.role}?`}
          confirmLabel="Revoke"
          variant="danger"
          disabled={deactivated}
          onConfirm={() => revoke.mutateAsync(g)}
        />
      ),
    },
  ];

  return (
    <Card title="Grants" titleId="grants-title" aside="A role applies to one team, or to all teams.">
      <Stack>
        {done && <FocusOnMount enabled={done.focus}><Notice tone="success">{done.text}</Notice></FocusOnMount>}
        {revoke.isError && (
          <ErrorNotice error={revoke.error} context={`Could not revoke ${revoke.variables ? grantText(revoke.variables) : 'the grant'}.`} />
        )}
        <DataTable
          label={`Grants of ${user.username}`}
          columns={columns}
          rows={user.grants}
          rowKey={g => `${g.teamId ?? ALL_TEAMS}:${g.role}`}
          minWidth={560}
          emptyText={deactivated ? 'No grants.' : 'No grants. This user can sign in but sees no team\'s data.'}
        />

        <form onSubmit={onAdd} aria-labelledby="add-grant-title">
          <Stack gap="s">
            <h3 className={s.h3} id="add-grant-title">Add a grant</h3>
            {deactivated && <Muted as="p">Deactivated users cannot be given new grants.</Muted>}
            {grant.isError && <ErrorNotice error={grant.error} context="Could not add the grant." />}
            <div className={s.grantForm}>
              <SelectField label="Team" value={teamValue} onChange={e => setTeam(e.target.value)} disabled={deactivated}>
                {teams.data?.map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                <option value={ALL_TEAMS}>All teams</option>
              </SelectField>
              <SelectField label="Role" value={role} onChange={e => setRole(e.target.value as Role)} disabled={deactivated}>
                {ROLES.map(r => <option key={r} value={r}>{r}</option>)}
              </SelectField>
              <Button type="submit" busy={grant.isPending} disabled={deactivated || grant.isPending}>Add grant</Button>
            </div>
          </Stack>
        </form>

        <div className={s.roleGuide}>
          <h3 className={s.h3}>What each role can do</h3>
          <Muted as="p">Roles are bundles of permissions, held per team. A grant on all teams applies to every team, including new ones.</Muted>
          <DetailList items={ROLE_MEANING.map(([r, text]) => [<Mono key={r}>{r}</Mono>, text])} />
        </div>
      </Stack>
    </Card>
  );
}
