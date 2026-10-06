import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router';
import { isApiError } from '../../api/http';
import { qk } from '../../api/keys';
import { getDashboardOverview, getWhatRunsWhere, listDashboardDeployments } from '../../api/query';
import type { DashboardPage as DashboardPageData } from '../../api/types';
import { usePermissions } from '../../auth/usePermissions';
import {
  ButtonLink, Card, Columns, EmptyState, ErrorNotice, Freshness, LoadMore, Loading, Notice, PageHeader, Segmented,
} from '../../components';
import { useCursorList } from '../../hooks/useCursorList';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { parseStatus, RecentDeployments, STATUS_OPTIONS, type StatusChoice } from './RecentDeployments';
import { StatTiles } from './StatTiles';
import { WhatRunsWhere } from './WhatRunsWhere';

/** In-flight work moves every few seconds; the read model itself lags by about that much. */
export const DASHBOARD_POLL_MS = 10_000;

/** Hybrid mode: query-service is not built yet, so these reads answer 501 not-implemented. */
function notBuilt(error: unknown): boolean {
  return isApiError(error) && error.type === 'not-implemented';
}

function pollUnlessNotBuilt(query: { state: { error: unknown } }): number | false {
  return notBuilt(query.state.error) ? false : DASHBOARD_POLL_MS;
}

/** The oldest asOf among the views on screen, so the pill never claims more freshness than the page has. */
function oldest(...values: Array<string | undefined>): string | undefined {
  return values.filter((v): v is string => Boolean(v)).sort()[0];
}

export function DashboardPage() {
  useDocumentTitle('Dashboard');
  const { can, teams } = usePermissions();
  const [params, setParams] = useSearchParams();
  const status = parseStatus(params.get('status'));
  const choice: StatusChoice = status ?? 'all';

  const overview = useQuery({ queryKey: qk.dashboardOverview(), queryFn: getDashboardOverview, refetchInterval: pollUnlessNotBuilt });
  const where = useQuery({ queryKey: qk.whatRunsWhere(), queryFn: () => getWhatRunsWhere(), refetchInterval: pollUnlessNotBuilt });
  const recent = useCursorList<DashboardPageData>(
    qk.dashboardDeployments(status),
    cursor => listDashboardDeployments({ cursor, status }),
    { refetchInterval: notBuilt(overview.error) ? false : DASHBOARD_POLL_MS },
  );

  const setStatus = (next: StatusChoice) => {
    setParams(prev => {
      const out = new URLSearchParams(prev);
      if (next === 'all') out.delete('status');
      else out.set('status', next);
      return out;
    });
  };

  const header = (
    <PageHeader
      title="What is happening now"
      subtitle={`Deployments and versions across ${teams === 'all' ? 'all teams' : 'your teams'}.`}
      actions={
        <>
          <Freshness asOf={oldest(overview.data?.asOf, where.data?.asOf, recent.firstPage?.asOf)} />
          {can('deployment:create') && <ButtonLink to="/applications" variant="primary">Deploy an application</ButtonLink>}
        </>
      }
    />
  );

  if ([overview.error, where.error, recent.error].some(notBuilt)) {
    return (
      <>
        {header}
        <Notice
          tone="info"
          title="The dashboard needs query-service"
          actions={<ButtonLink to="/applications">Go to applications</ButtonLink>}
        >
          <p>
            This view reads from query-service, which arrives with slice S6. Until then, start from Applications: registering
            releases and deploying work against the live control-api.
          </p>
        </Notice>
      </>
    );
  }

  return (
    <>
      {header}

      {overview.isPending && <Loading label="Loading the summary" />}
      {overview.isError && <ErrorNotice error={overview.error} context="Could not load the summary." onRetry={() => void overview.refetch()} />}
      {overview.isSuccess && <StatTiles overview={overview.data} />}

      <Columns layout="pair" ratio="minmax(0, 1fr) minmax(0, 1.1fr)">
        <Card title="What runs where" titleId="where-title" aside="Current release per environment">
          {where.isPending && <Loading label="Loading what runs where" />}
          {where.isError && <ErrorNotice error={where.error} context="Could not load what runs where." onRetry={() => void where.refetch()} />}
          {where.isSuccess && where.data.rows.length === 0 && (
            <EmptyState
              title="No applications yet"
              action={can('application:create') && <ButtonLink to="/applications/new">Register an application</ButtonLink>}
            >
              Applications your teams own appear here with the release that runs in each environment.
            </EmptyState>
          )}
          {where.isSuccess && where.data.rows.length > 0 && (
            <WhatRunsWhere environments={where.data.environments} rows={where.data.rows} />
          )}
        </Card>

        <Card
          title="Recent deployments"
          titleId="recent-title"
          aside={<Segmented label="Filter by state" options={STATUS_OPTIONS} value={choice} onChange={setStatus} />}
        >
          {recent.isPending && <Loading label="Loading recent deployments" />}
          {recent.isError && <ErrorNotice error={recent.error} context="Could not load recent deployments." onRetry={() => void recent.refetch()} />}
          {recent.isSuccess && (
            <>
              <RecentDeployments rows={recent.items} status={choice} />
              {recent.items.length > 0 && (
                <LoadMore hasMore={recent.hasNextPage} loading={recent.isFetchingNextPage} onLoad={() => void recent.fetchNextPage()} />
              )}
            </>
          )}
        </Card>
      </Columns>
    </>
  );
}
