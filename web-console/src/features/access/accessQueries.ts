import { useInfiniteQuery, useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { listMembers, listRoles, listUsers } from '../../api/identity';
import { qk } from '../../api/keys';
import { BUILT_IN_ROLES, type Grant, type Role, type RoleView, type UserSummary } from '../../api/types';
import { isPlatformAdmin } from '../../auth/permissions';
import { usePermissions } from '../../auth/usePermissions';
import { useTeams } from '../../auth/useTeams';

/** Users by cursor. Only a platform administrator may list users; for anyone else the query stays off. */
export function useUsers() {
  const { me } = usePermissions();
  const query = useInfiniteQuery({
    queryKey: qk.users(),
    queryFn: ({ pageParam }) => listUsers(pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: last => last.nextCursor ?? undefined,
    enabled: isPlatformAdmin(me),
  });
  return { ...query, items: query.data?.pages.flatMap(p => p.items) ?? [] };
}

/**
 * The roles that exist. Only a platform administrator may list them (with their permissions); anyone else gets the four
 * seeded names, which is enough to fill a role list, and the real answer comes back from the server on a bad one.
 */
export function useRoles(): { roles: RoleView[] | undefined; names: Role[]; isLoading: boolean } {
  const { me } = usePermissions();
  const platform = isPlatformAdmin(me);
  const query = useQuery({ queryKey: qk.roles(), queryFn: listRoles, enabled: platform, staleTime: 5 * 60_000 });
  const names = useMemo<Role[]>(() => (query.data ? query.data.map(r => r.name) : [...BUILT_IN_ROLES]), [query.data]);
  return { roles: query.data, names, isLoading: platform && query.isPending };
}

/**
 * Every grant of every user, assembled from the members of every team. identity-service has no "grants of this user"
 * endpoint, so a platform administrator's console reads each team's member list and groups by user. Fine for a handful
 * of teams; a real endpoint is the better answer when there are hundreds (listed in the console plan).
 */
export function useGrants(): { byUser: Map<string, Grant[]>; isLoading: boolean; isError: boolean } {
  const { teams, isLoading: teamsLoading } = useTeams();
  const results = useQueries({
    queries: teams.map(t => ({ queryKey: qk.members(t.id), queryFn: () => listMembers(t.id), staleTime: 30_000 })),
  });
  const key = results.map(r => r.dataUpdatedAt).join(',');
  const byUser = useMemo(() => {
    const map = new Map<string, Grant[]>();
    results.forEach((r, i) => {
      const team = teams[i]!;
      r.data?.forEach(m => {
        const list = map.get(m.userId) ?? [];
        list.push({ teamId: team.id, teamName: team.name, role: m.role });
        map.set(m.userId, list);
      });
    });
    return map;
    // `key` stands for the results' contents; the results array itself changes identity on every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [teams, key]);
  return { byUser, isLoading: teamsLoading || results.some(r => r.isPending), isError: results.some(r => r.isError) };
}

/** After a write to a team's members: that team's list and everything derived from it is stale. */
export function useRefreshAccess() {
  const queryClient = useQueryClient();
  return async (teamId?: string) => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: teamId ? qk.members(teamId) : qk.allMembers() }),
      queryClient.invalidateQueries({ queryKey: qk.users() }),
    ]);
  };
}

/** "DEPLOYER on Payments". */
export function grantText(g: Grant): string {
  return `${g.role} on ${g.teamName}`;
}

export function grantSummary(grants: Grant[] | undefined): string {
  return grants?.length ? grants.map(grantText).join(', ') : 'No grants';
}

/** A user's name as the lists show it. */
export function who(u: Pick<UserSummary, 'displayName' | 'email'>): string {
  return u.displayName || u.email;
}
