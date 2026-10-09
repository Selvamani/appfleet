import { Link } from 'react-router';
import type { Grant, UserSummary } from '../../api/types';
import { Card, EmptyState, ErrorNotice, LoadMore, Loading, SearchField, StatusChip } from '../../components';
import { cx } from '../../lib/cx';
import { grantSummary, who, type useUsers } from './accessQueries';
import s from './AccessPage.module.css';

/** Navigation state of a pick in this list: the user's heading takes focus once it shows. */
export interface PickState {
  focusDetail: true;
}
const PICKED: PickState = { focusDetail: true };

/** identity-service lists users by cursor and does not search, so the search box filters the users loaded so far. */
export function matches(u: UserSummary, needle: string): boolean {
  const n = needle.trim().toLowerCase();
  return !n || u.email.toLowerCase().includes(n) || u.displayName.toLowerCase().includes(n);
}

/**
 * Users as links to /access/users/:userId (keeping the search), so a selection is shareable. The
 * selected one carries aria-current.
 */
export function UserList({ q, onSearch, users, selectedId, grants }: {
  q: string;
  onSearch: (q: string) => void;
  users: ReturnType<typeof useUsers>;
  selectedId: string | undefined;
  grants: Map<string, Grant[]>;
}) {
  const search = q ? `?q=${encodeURIComponent(q)}` : '';
  const shown = users.items.filter(u => matches(u, q));
  return (
    <Card title="Users" titleId="users-title">
      <div className={s.listBody}>
        <SearchField label="Search users" placeholder="Search users" value={q} onChange={e => onSearch(e.target.value)} />
        {users.isPending && <Loading label="Loading users" />}
        {users.isError && <ErrorNotice error={users.error} context="Could not load users." onRetry={() => void users.refetch()} />}
        {users.isSuccess && shown.length === 0 && (
          <EmptyState title={q.trim() ? `No user matches "${q.trim()}".` : 'No users yet.'}>
            {q.trim() && users.hasNextPage ? 'Only the users loaded so far are searched. Load more below.' : undefined}
          </EmptyState>
        )}
        {users.isSuccess && shown.length > 0 && (
          <ul className={s.users} aria-labelledby="users-title">
            {shown.map(u => {
              const selected = u.id === selectedId;
              return (
                <li key={u.id}>
                  <Link
                    to={{ pathname: `/access/users/${u.id}`, search }}
                    className={cx(s.user, selected && s.userOn)}
                    aria-current={selected ? 'true' : undefined}
                    state={PICKED}
                  >
                    <span className={s.userText}>
                      <span className={s.userName}>{who(u)}</span>
                      <span className={s.userGrants}>{u.email}</span>
                      <span className={s.userGrants}>{grantSummary(grants.get(u.id))}</span>
                    </span>
                    {u.status === 'DEACTIVATED' && <StatusChip status="DEACTIVATED" label="Deactivated" />}
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
        {users.hasNextPage && (
          <LoadMore hasMore loading={users.isFetchingNextPage} onLoad={() => void users.fetchNextPage()} note="More users load by cursor." />
        )}
      </div>
    </Card>
  );
}
