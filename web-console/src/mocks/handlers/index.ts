import { agentHandlers } from './agent';
import { controlHandlers } from './control';
import { identityHandlers } from './identity';
import { queryHandlers } from './query';
import { taskHandlers } from './tasks';

/**
 * Order matters where paths overlap: query-service's /applications/:id/history and
 * /deployments/:id/timeline are distinct paths, so MSW matches them exactly.
 */
export const handlers = [...identityHandlers, ...queryHandlers, ...controlHandlers, ...agentHandlers, ...taskHandlers];
