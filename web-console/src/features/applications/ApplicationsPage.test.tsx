import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../../test/render';

describe('ApplicationsPage', () => {
  it('shows only the teams the caller may see (data-level filtering)', async () => {
    await renderApp('/applications', { role: 'DEPLOYER' });
    const table = await screen.findByRole('table', { name: 'Applications' });
    expect(within(table).getByText('billing-api')).toBeInTheDocument();
    expect(within(table).queryByText('search-indexer')).not.toBeInTheDocument();
  });

  it('shows every team to an operator', async () => {
    await renderApp('/applications', { role: 'OPERATOR' });
    const table = await screen.findByRole('table', { name: 'Applications' });
    expect(within(table).getByText('search-indexer')).toBeInTheDocument();
  });

  it('filters by the q search parameter', async () => {
    await renderApp('/applications?q=ledger', { role: 'DEPLOYER' });
    const table = await screen.findByRole('table', { name: 'Applications' });
    expect(within(table).getByText('ledger-worker')).toBeInTheDocument();
    expect(within(table).queryByText('billing-api')).not.toBeInTheDocument();
  });

  it('offers registration to a deployer but not to a viewer', async () => {
    const first = await renderApp('/applications', { role: 'DEPLOYER' });
    expect(await screen.findByRole('link', { name: 'Register application' })).toBeInTheDocument();
    first.unmount();
    await renderApp('/applications', { role: 'VIEWER' });
    await screen.findByRole('table', { name: 'Applications' });
    expect(screen.queryByRole('link', { name: 'Register application' })).not.toBeInTheDocument();
  });
});
