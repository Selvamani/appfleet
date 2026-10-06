import { DEPLOYMENT_STATES, type DashboardOverview, type DeploymentState } from '../../api/types';
import { Columns, StatTile } from '../../components';

type Counts = Partial<Record<DeploymentState, number>>;

function total(counts: Counts): number {
  return Object.values(counts).reduce<number>((sum, n) => sum + (n ?? 0), 0);
}

/** "DEPLOYING 2, PENDING 1": largest first, ties in FSM order. */
export function breakdown(counts: Counts): string {
  return DEPLOYMENT_STATES
    .map(state => [state, counts[state] ?? 0] as const)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || DEPLOYMENT_STATES.indexOf(a[0]) - DEPLOYMENT_STATES.indexOf(b[0]))
    .map(([state, n]) => `${state} ${n}`)
    .join(', ');
}

/** The four numbers at the top of the dashboard. */
export function StatTiles({ overview }: { overview: DashboardOverview }) {
  const inFlight = total(overview.inFlight);
  const attention = total(overview.attention);
  return (
    <Columns layout="tiles">
      <StatTile label="In flight" value={inFlight} detail={inFlight ? breakdown(overview.inFlight) : 'Nothing is deploying'} />
      <StatTile label="Needs attention" value={attention} detail={attention ? breakdown(overview.attention) : 'Nothing is degraded or failed'} />
      <StatTile
        label="Healthy in prod"
        value={`${overview.prodHealthy} of ${overview.prodTotal}`}
        detail={overview.prodTotal === 1 ? 'application in prod' : 'applications in prod'}
      />
      <StatTile label="Tool sessions" value={overview.sessionsRunning} detail="running now" />
    </Columns>
  );
}
