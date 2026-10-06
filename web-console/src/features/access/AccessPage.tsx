import { useCallback, useState } from 'react';
import { useLocation, useParams, useSearchParams } from 'react-router';
import { Card, Columns, EmptyState, PageHeader } from '../../components';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { useUserSearch } from './accessQueries';
import { ServiceAccounts } from './ServiceAccounts';
import { UserDetail } from './UserDetail';
import { UserList, type PickState } from './UserList';

/**
 * Access (ADMIN). Users and their per-team grants on the left and right, service-account keys below.
 * Mounted on /access and /access/users/:userId; the search stays in ?q= across picks. With no user in the
 * address, the first user in the list is shown.
 */
export function AccessPage() {
  useDocumentTitle('Access');
  const { userId } = useParams();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const users = useUserSearch(q);
  const selectedId = userId ?? users.items[0]?.id;

  // A pick in the list moves focus to the user's heading, once per navigation. The intent travels in the
  // location state because /access and /access/users/:userId are separate routes, so this page remounts.
  const picked = (location.state as PickState | null)?.focusDetail === true;
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const onFocused = useCallback(() => setFocusedKey(location.key), [location.key]);

  return (
    <>
      <PageHeader title="Access" subtitle="Who can do what, per team." />
      <Columns layout="split">
        <UserList
          q={q}
          onSearch={next => setParams(next ? { q: next } : {}, { replace: true })}
          users={users}
          selectedId={selectedId}
        />
        {selectedId ? (
          <UserDetail
            key={selectedId}
            userId={selectedId}
            focusOnLoad={picked && focusedKey !== location.key}
            onFocused={onFocused}
          />
        ) : (
          <Card>
            <EmptyState title="No user selected">Pick a user to see their sign-in details and grants.</EmptyState>
          </Card>
        )}
      </Columns>
      <ServiceAccounts />
    </>
  );
}
