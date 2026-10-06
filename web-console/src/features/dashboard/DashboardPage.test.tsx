import { screen, within } from '@testing-library/react';
import { http } from 'msw';
import { describe, expect, it } from 'vitest';
import type { WhatRunsWhere } from '../../api/types';
import { json, notBuilt } from '../../mocks/respond';
import { renderApp } from '../../test/render';
import { server } from '../../test/server';
import { breakdown } from './StatTiles';

async function recentTable() {
  return screen.findByRole('table', { name: 'Recent deployments' });
}

describe('DashboardPage', () => {
  it('shows a Payments deployer the tiles, the matrix and recent rows for Payments only', async () => {
    await renderApp('/', { role: 'DEPLOYER' });
    expect(await screen.findByRole('heading', { level: 1, name: 'What is happening now' })).toBeInTheDocument();
    expect(await screen.findByText('Deployments and versions across your teams.')).toBeInTheDocument();

    // tiles: two DEPLOYING in Payments, one DEGRADED, 2 of 3 Payments applications healthy in prod
    expect(await screen.findByText('DEPLOYING 2')).toBeInTheDocument();
    expect(screen.getByText('DEGRADED 1')).toBeInTheDocument();
    expect(screen.getByText('2 of 3')).toBeInTheDocument();
    expect(screen.getByText('running now')).toBeInTheDocument();

    const matrix = await screen.findByRole('table', { name: 'What runs where' });
    expect(within(matrix).getByRole('link', { name: 'billing-api' })).toHaveAttribute('href', expect.stringMatching(/^\/applications\//));
    expect(within(matrix).getByRole('link', { name: '2.3.1 HEALTHY, billing-api in prod' })).toHaveAttribute('href', expect.stringMatching(/^\/deployments\//));
    expect(within(matrix).queryByText('search-indexer')).not.toBeInTheDocument();
    expect(within(matrix).getAllByText('Not deployed').length).toBeGreaterThan(0); // nothing in qa for Payments

    const recent = await recentTable();
    expect(within(recent).getAllByText('billing-api').length).toBeGreaterThan(0);
    expect(within(recent).queryByText('query-gateway')).not.toBeInTheDocument();
    expect(within(recent).getAllByRole('link', { name: /^Open / }).length).toBeGreaterThan(0);
  });

  it('shows every team to an operator', async () => {
    await renderApp('/', { role: 'OPERATOR' });
    expect(await screen.findByText('Deployments and versions across all teams.')).toBeInTheDocument();
    expect(await screen.findByText('DEPLOYING 2, PENDING 1')).toBeInTheDocument();
    expect(screen.getByText('4 of 5')).toBeInTheDocument();

    const matrix = await screen.findByRole('table', { name: 'What runs where' });
    expect(within(matrix).getByRole('link', { name: 'search-indexer' })).toBeInTheDocument();
    expect(within(matrix).getByRole('link', { name: 'query-gateway' })).toBeInTheDocument();
    expect(within(matrix).getAllByText('Search').length).toBe(2);

    const recent = await recentTable();
    expect(within(recent).getAllByText('search-indexer').length).toBeGreaterThan(0);
  });

  it('changes the rows and the URL when the state filter changes', async () => {
    const { user, router } = await renderApp('/', { role: 'OPERATOR' });
    await recentTable();

    await user.click(screen.getByRole('button', { name: 'Needs attention' }));
    expect(router.state.location.search).toBe('?status=attention');
    expect(screen.getByRole('button', { name: 'Needs attention' })).toHaveAttribute('aria-pressed', 'true');

    const filtered = await recentTable();
    const rows = within(filtered).getAllByRole('row').slice(1); // first row is the header
    expect(rows).toHaveLength(2);
    expect(within(filtered).getByText('ledger-worker')).toBeInTheDocument();
    expect(within(filtered).getByText('query-gateway')).toBeInTheDocument();
    expect(within(filtered).queryByText('DEPLOYING')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'All' }));
    expect(router.state.location.search).toBe('');
  });

  it('reads the state filter from the URL', async () => {
    await renderApp('/?status=flight', { role: 'DEPLOYER' });
    expect(await screen.findByRole('button', { name: 'In flight' })).toHaveAttribute('aria-pressed', 'true');
    const recent = await recentTable();
    expect(within(recent).getAllByRole('row').slice(1)).toHaveLength(2);
    expect(within(recent).getAllByText('DEPLOYING')).toHaveLength(2);
    expect(within(recent).queryByText('HEALTHY')).not.toBeInTheDocument();
  });

  it('offers deploying to a deployer but not to a viewer', async () => {
    const first = await renderApp('/', { role: 'DEPLOYER' });
    expect(await screen.findByRole('link', { name: 'Deploy an application' })).toHaveAttribute('href', '/applications');
    first.unmount();
    await renderApp('/', { role: 'VIEWER' });
    await recentTable();
    expect(screen.queryByRole('link', { name: 'Deploy an application' })).not.toBeInTheDocument();
  });

  it('links the latest attempt when it is not the release that runs', async () => {
    const body: WhatRunsWhere = {
      asOf: new Date().toISOString(),
      environments: ['dev', 'prod'],
      rows: [{
        applicationId: 'app-1', applicationName: 'billing-api', teamId: 'team-1', teamName: 'Payments',
        cells: {
          prod: {
            deploymentId: 'dep-ok', releaseVersion: '2.4.0', status: 'HEALTHY', since: new Date().toISOString(), requestedBy: 'you',
            latest: { deploymentId: 'dep-failed', releaseVersion: '2.5.0-rc1', status: 'FAILED' },
          },
        },
      }],
    };
    server.use(http.get('/api/v1/dashboard/where', ({ request }) => json(request, body)));
    await renderApp('/', { role: 'DEPLOYER' });
    const matrix = await screen.findByRole('table', { name: 'What runs where' });
    expect(within(matrix).getByRole('link', { name: 'latest: 2.5.0-rc1 FAILED, billing-api in prod' })).toHaveAttribute('href', '/deployments/dep-failed');
    expect(within(matrix).getByText('Not deployed')).toBeInTheDocument();
  });

  it('explains that query-service is not built when the API answers 501', async () => {
    const off = ({ request }: { request: Request }) => notBuilt(request, 'query-service dashboard (S6)');
    server.use(
      http.get('/api/v1/dashboard/overview', off),
      http.get('/api/v1/dashboard/where', off),
      http.get('/api/v1/dashboard/deployments', off),
    );
    await renderApp('/', { role: 'DEPLOYER' });
    expect(await screen.findByText('The dashboard needs query-service')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to applications' })).toHaveAttribute('href', '/applications');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('breakdown', () => {
  it('lists the largest count first and skips zeros', () => {
    expect(breakdown({ PENDING: 1, DEPLOYING: 2, VALIDATING: 0 })).toBe('DEPLOYING 2, PENDING 1');
    expect(breakdown({ FAILED: 1, DEGRADED: 1 })).toBe('DEGRADED 1, FAILED 1');
    expect(breakdown({})).toBe('');
  });
});
