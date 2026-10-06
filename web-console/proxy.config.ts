/**
 * Dev proxy routing table (docs/design/ux/web-console-react-plan.md §4.2).
 * Used only in hybrid mode; in mock mode MSW answers in the browser before a request leaves it.
 *
 * Order matters: Vite tries keys in insertion order. Keys starting with '^' are regular expressions,
 * every other key is a path prefix. The two query-service routes that sit under control-api prefixes
 * must come first, or prefix matching sends them to control-api.
 */
export const SERVICES = {
  control: 'http://localhost:8081',
  identity: 'http://localhost:8082',
  task: 'http://localhost:8083',
  agent: 'http://localhost:8084',
  query: 'http://localhost:8085',
} as const;

export type Service = keyof typeof SERVICES;

export const ROUTES: ReadonlyArray<readonly [string, Service]> = [
  ['^/api/v1/applications/[^/]+/history', 'query'],
  ['^/api/v1/deployments/[^/]+/timeline', 'query'],
  ['/api/v1/dashboard', 'query'],
  ['/api/v1/fleet', 'query'],
  ['/admin/projections', 'query'],
  ['/api/v1/audit/logins', 'identity'],
  ['/api/v1/audit', 'query'],
  ['/api/v1/applications', 'control'],
  ['/api/v1/deployments', 'control'],
  ['/api/v1/tasks', 'control'],
  ['/api/v1/catalogue', 'control'],
  ['/api/v1/environments', 'control'],
  ['/api/v1/auth', 'identity'],
  ['/api/v1/users', 'identity'],
  ['/api/v1/teams', 'identity'],
  ['/api/v1/roles', 'identity'],
  ['/api/v1/service-accounts', 'identity'],
  ['/api/v1/sessions', 'agent'],
  ['/api/v1/nodes', 'agent'],
  ['/api/v1/dlq', 'task'],
];

/** Same matching rule Vite's proxy uses, so the table can be unit-tested. */
export function serviceFor(path: string): Service | undefined {
  for (const [key, service] of ROUTES) {
    const hit = key.startsWith('^') ? new RegExp(key).test(path) : path.startsWith(key);
    if (hit) return service;
  }
  return undefined;
}

export function viteProxy(): Record<string, { target: string; changeOrigin: boolean }> {
  return Object.fromEntries(ROUTES.map(([key, service]) => [key, { target: SERVICES[service], changeOrigin: true }]));
}
