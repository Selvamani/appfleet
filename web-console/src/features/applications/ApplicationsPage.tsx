import { useQuery } from '@tanstack/react-query';
import { Link, useSearchParams } from 'react-router';
import { listApplications } from '../../api/control';
import { listTeams } from '../../api/identity';
import { qk } from '../../api/keys';
import type { ApplicationResponse } from '../../api/types';
import { usePermissions } from '../../auth/usePermissions';
import {
  ButtonLink, Card, DataTable, EmptyState, ErrorNotice, LoadMore, Loading, PageHeader, SearchField, type Column,
} from '../../components';
import { useCursorList } from '../../hooks/useCursorList';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { formatDate, shortId } from '../../lib/format';

/**
 * Reference feature: the pattern every screen follows.
 *  - data through api/* functions and qk keys, never fetch() here
 *  - cursor lists through useCursorList + LoadMore
 *  - errors through ErrorNotice, loading through Loading, nothing-yet through EmptyState
 *  - actions gated with can(), knowing the API enforces the same rule
 *  - filters in the URL (useSearchParams), so links are shareable
 */
export function ApplicationsPage() {
  useDocumentTitle('Applications');
  const { can } = usePermissions();
  const [params, setParams] = useSearchParams();
  const q = params.get('q') ?? '';

  const apps = useCursorList(qk.applications(), cursor => listApplications(cursor));
  const teams = useQuery({ queryKey: qk.teams(), queryFn: listTeams, staleTime: 10 * 60_000 });
  // Unknown ids happen in hybrid mode (live applications, simulated teams): show a short id, not a blank.
  const teamName = (id: string) => (teams.data ? teams.data.find(t => t.id === id)?.name ?? `Team ${shortId(id)}` : '…');

  const needle = q.trim().toLowerCase();
  const rows = apps.items.filter(a => !needle || a.name.includes(needle) || (a.description ?? '').toLowerCase().includes(needle));

  const columns: Column<ApplicationResponse>[] = [
    { key: 'name', header: 'Application', width: 'minmax(160px, 1.2fr)', render: a => <Link to={`/applications/${a.id}`}><strong>{a.name}</strong></Link> },
    { key: 'team', header: 'Owner team', width: 'minmax(110px, 0.7fr)', render: a => teamName(a.ownerTeamId) },
    { key: 'description', header: 'Description', width: 'minmax(200px, 2fr)', render: a => a.description ?? '' },
    { key: 'created', header: 'Registered', width: 'minmax(90px, 0.6fr)', render: a => formatDate(a.createdAt) },
  ];

  return (
    <>
      <PageHeader
        title="Applications"
        subtitle="Every application your teams own. Open one to see what runs in each environment."
        actions={can('application:create') && <ButtonLink to="/applications/new" variant="primary">Register application</ButtonLink>}
      />
      <Card
        title="All applications"
        titleId="apps-title"
        aside={
          <SearchField
            label="Filter applications"
            placeholder="Filter by name or description"
            value={q}
            onChange={e => setParams(e.target.value ? { q: e.target.value } : {}, { replace: true })}
          />
        }
      >
        {apps.isPending && <Loading label="Loading applications" />}
        {apps.isError && <ErrorNotice error={apps.error} context="Could not load applications." onRetry={() => void apps.refetch()} />}
        {apps.isSuccess && apps.items.length === 0 && (
          <EmptyState
            title="No applications yet"
            action={can('application:create') && <ButtonLink to="/applications/new">Register the first one</ButtonLink>}
          >
            Applications your teams register appear here.
          </EmptyState>
        )}
        {apps.isSuccess && apps.items.length > 0 && (
          <>
            <DataTable
              label="Applications"
              columns={columns}
              rows={rows}
              rowKey={a => a.id}
              minWidth={620}
              emptyText={`No application matches "${q}".`}
            />
            <LoadMore
              hasMore={apps.hasNextPage}
              loading={apps.isFetchingNextPage}
              onLoad={() => void apps.fetchNextPage()}
              note="Oldest first. More load by cursor."
            />
          </>
        )}
      </Card>
    </>
  );
}
