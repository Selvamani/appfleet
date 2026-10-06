import type { RouteObject } from 'react-router';
import { AppShell } from './AppShell';
import { RouteError } from './RouteError';
import { NotFoundPage } from './NotFoundPage';
import { RequirePermission } from './RequirePermission';

/**
 * Route table (plan §5). Pages load lazily, one chunk per feature. Screens a role may not open render
 * NotFoundPage, the same page as an unknown address, so the console never confirms what exists.
 */
export const routes: RouteObject[] = [
  {
    path: '/',
    element: <AppShell />,
    errorElement: <RouteError />,
    // Shown while the first screen's code downloads on a deep link (lazy routes).
    hydrateFallbackElement: <p style={{ padding: 'var(--gutter)', color: 'var(--muted)' }}>Loading…</p>,
    children: [
      { index: true, lazy: () => import('../features/dashboard/DashboardPage').then(m => ({ Component: m.DashboardPage })) },
      { path: 'applications', lazy: () => import('../features/applications/ApplicationsPage').then(m => ({ Component: m.ApplicationsPage })) },
      { path: 'applications/new', lazy: () => import('../features/applications/NewApplicationPage').then(m => ({ Component: m.NewApplicationPage })) },
      { path: 'applications/:applicationId', lazy: () => import('../features/applications/ApplicationPage').then(m => ({ Component: m.ApplicationPage })) },
      { path: 'applications/:applicationId/deploy', lazy: () => import('../features/deploy/DeployPage').then(m => ({ Component: m.DeployPage })) },
      { path: 'deployments/:deploymentId', lazy: () => import('../features/deployments/DeploymentPage').then(m => ({ Component: m.DeploymentPage })) },
      { path: 'sessions', lazy: () => import('../features/sessions/SessionsPage').then(m => ({ Component: m.SessionsPage })) },
      {
        path: 'fleet',
        lazy: () => import('../features/fleet/FleetPage').then(m => ({
          Component: () => <RequirePermission permission="fleet:read"><m.FleetPage /></RequirePermission>,
        })),
      },
      {
        path: 'access',
        lazy: () => import('../features/access/AccessPage').then(m => ({
          Component: () => <RequirePermission permission="user:manage"><m.AccessPage /></RequirePermission>,
        })),
      },
      {
        path: 'access/users/:userId',
        lazy: () => import('../features/access/AccessPage').then(m => ({
          Component: () => <RequirePermission permission="user:manage"><m.AccessPage /></RequirePermission>,
        })),
      },
      {
        path: 'audit',
        lazy: () => import('../features/audit/AuditPage').then(m => ({
          Component: () => <RequirePermission permission="audit:read"><m.AuditPage /></RequirePermission>,
        })),
      },
      { path: '*', element: <NotFoundPage /> },
    ],
  },
];
