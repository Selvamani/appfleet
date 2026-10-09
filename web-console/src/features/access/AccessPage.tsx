import { useCallback, useState } from 'react';
import { useLocation, useParams, useSearchParams } from 'react-router';
import { isPlatformAdmin } from '../../auth/permissions';
import { usePermissions } from '../../auth/usePermissions';
import { Card, Columns, EmptyState, PageHeader } from '../../components';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { useGrants, useUsers } from './accessQueries';
import { RolesCard } from './RolesCard';
import { ServiceAccounts } from './ServiceAccounts';
import { TeamsCard } from './TeamsCard';
import { UserDetail } from './UserDetail';
import { matches, UserList, type PickState } from './UserList';

/**
 * Access. Two kinds of administrator open this page:
 *  - a platform administrator sees users with their grants, every team, the roles, and every team's service accounts;
 *  - an administrator of a team sees that team's members and service accounts, and nothing about other teams.
 * Mounted on /access and /access/users/:userId; the search stays in ?q= across picks. With no user in the address,
 * the first user in the list is shown.
 */
export function AccessPage() {
  useDocumentTitle('Access');
  const { me } = usePermissions();
  const platform = isPlatformAdmin(me);
  const { userId } = useParams();
  const location = useLocation();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';
  const users = useUsers();
  const { byUser } = useGrants();
  const selectedId = userId ?? users.items.find(u => matches(u, q))?.id;

  // A pick in the list moves focus to the user's heading, once per navigation. The intent travels in the
  // location state because /access and /access/users/:userId are separate routes, so this page remounts.
  const picked = (location.state as PickState | null)?.focusDetail === true;
  const [focusedKey, setFocusedKey] = useState<string | null>(null);
  const onFocused = useCallback(() => setFocusedKey(location.key), [location.key]);

  return (
    <>
      <PageHeader
        title="Access"
        subtitle={platform ? 'Who can do what, per team. You administer the platform.' : 'Who can do what in the teams you administer.'}
      />
      {platform && (
        <Columns layout="split">
          <UserList
            q={q}
            onSearch={next => setParams(next ? { q: next } : {}, { replace: true })}
            users={users}
            selectedId={selectedId}
            grants={byUser}
          />
          {selectedId ? (
            <UserDetail
              key={selectedId}
              userId={selectedId}
              grants={byUser.get(selectedId) ?? []}
              focusOnLoad={picked && focusedKey !== location.key}
              onFocused={onFocused}
            />
          ) : (
            <Card>
              <EmptyState title="No user selected">Pick a user to see their sign-in details and grants.</EmptyState>
            </Card>
          )}
        </Columns>
      )}
      <TeamsCard />
      {platform && <RolesCard />}
      <ServiceAccounts />
    </>
  );
}
