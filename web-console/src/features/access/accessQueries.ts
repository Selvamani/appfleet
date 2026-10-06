import { keepPreviousData, useInfiniteQuery, useQueryClient } from '@tanstack/react-query';
import { listUsers } from '../../api/identity';
import { qk } from '../../api/keys';
import type { Grant, UserSummary } from '../../api/types';
import { usePermissions } from '../../auth/usePermissions';

/** Prefix of every user list, whatever its search text (qk.users(q) adds q as the last part). */
export const ALL_USER_LISTS = qk.users().slice(0, 2);

/**
 * Users matching q, by cursor. Like useCursorList, plus keepPreviousData so the list stays on screen
 * while the next search runs instead of flashing a loading line on every keystroke.
 */
export function useUserSearch(q: string) {
  const needle = q.trim();
  const query = useInfiniteQuery({
    queryKey: qk.users(needle),
    queryFn: ({ pageParam }) => listUsers(needle || undefined, pageParam),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: last => last.nextCursor ?? undefined,
    placeholderData: keepPreviousData,
  });
  return { ...query, items: query.data?.pages.flatMap(p => p.items) ?? [] };
}

/**
 * After a write that returns the user: put the answer in the cache and refresh every user list. When the
 * user is the signed-in one, their own permissions changed too.
 */
export function useApplyUser() {
  const queryClient = useQueryClient();
  const { me } = usePermissions();
  return (updated: UserSummary) => {
    queryClient.setQueryData(qk.user(updated.id), updated);
    return Promise.all([
      queryClient.invalidateQueries({ queryKey: ALL_USER_LISTS }),
      updated.id === me?.id ? queryClient.invalidateQueries({ queryKey: qk.me() }) : undefined,
    ]);
  };
}

/** "OPERATOR on all teams" for a grant on every team, "DEPLOYER on Payments" otherwise. */
export function grantText(g: Grant): string {
  return `${g.role} on ${g.teamId ? g.teamName : 'all teams'}`;
}

export function grantSummary(grants: Grant[]): string {
  return grants.length ? grants.map(grantText).join(', ') : 'No grants';
}
