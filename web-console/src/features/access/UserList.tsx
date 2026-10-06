import { Link } from 'react-router';
import type { UserSummary } from '../../api/types';
import { Card, EmptyState, ErrorNotice, LoadMore, Loading, SearchField, StatusChip } from '../../components';
import { cx } from '../../lib/cx';
import { grantSummary, useUserSearch } from './accessQueries';
import s from './AccessPage.module.css';

/** Navigation state of a pick in this list: the user's heading takes focus once it shows. */
export interface PickState {
  focusDetail: true;
}
const PICKED: PickState = { focusDetail: true };

/**
 * Users as links to /access/users/:userId (keeping the search), so a selection is shareable. The
 * selected one carries aria-current.
 */
export function UserList({ q, onSearch, users, selectedId }: {
  q: string;
  onSearch: (q: string) => void;
  users: ReturnType<typeof useUserSearch>;
  selectedId: string | undefined;
}) {
  const search = q ? `?q=${encodeURIComponent(q)}` : '';
  return (
    <Card title="Users" titleId="users-title">
      <div className={s.listBody}>
        <SearchField label="Search users" placeholder="Search users" value={q} onChange={e => onSearch(e.target.value)} />
        {users.isPending && <Loading label="Loading users" />}
        {users.isError && <ErrorNotice error={users.error} context="Could not load users." onRetry={() => void users.refetch()} />}
        {users.isSuccess && users.items.length === 0 && (
          <EmptyState title={q.trim() ? `No user matches "${q.trim()}".` : 'No users yet.'} />
        )}
        {users.isSuccess && users.items.length > 0 && (
          <ul className={s.users} aria-labelledby="users-title">
            {users.items.map((u: UserSummary) => {
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
                      <span className={s.userName}>{u.username}</span>
                      <span className={s.userGrants}>{grantSummary(u.grants)}</span>
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
