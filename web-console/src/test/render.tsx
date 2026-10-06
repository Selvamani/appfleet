import { QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { createQueryClient } from '../app/queryClient';
import { routes } from '../app/routes';
import type { Role } from '../api/types';
import { PermissionsProvider } from '../auth/PermissionsProvider';
import { setDevRole } from '../mocks/devRole';

/**
 * Renders the whole app (shell, route table, guards, providers) at `path`, against the MSW handlers.
 * Pick the signed-in role with `role`. Returns the router so tests can assert on navigation.
 */
export async function renderApp(path: string, opts: { role?: Role } = {}) {
  setDevRole(opts.role ?? 'DEPLOYER');
  const client = createQueryClient();
  client.setDefaultOptions({ queries: { ...client.getDefaultOptions().queries, retry: false } });
  const router = createMemoryRouter(routes, { initialEntries: [path] });
  const user = userEvent.setup();
  const utils = render(
    <QueryClientProvider client={client}>
      <PermissionsProvider>
        <RouterProvider router={router} />
      </PermissionsProvider>
    </QueryClientProvider>,
  );
  // wait for the shell (and the signed-in user) before handing over
  await screen.findByRole('navigation', { name: 'Main' });
  return { ...utils, router, user, client };
}
