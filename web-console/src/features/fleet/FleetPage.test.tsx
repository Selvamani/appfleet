import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../../test/render';

/** The table row (role="row") that contains `text`. */
function rowWith(table: HTMLElement, text: string): HTMLElement {
  const row = within(table).getByText(text).closest<HTMLElement>('[role="row"]');
  if (!row) throw new Error(`No row contains ${text}`);
  return row;
}

describe('FleetPage', () => {
  it('is not found for a deployer', async () => {
    await renderApp('/fleet', { role: 'DEPLOYER' });
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Fleet and dead-letter queue' })).not.toBeInTheDocument();
  });

  it('shows nodes, tiles, stuck work, dead letters and projections to an operator', async () => {
    await renderApp('/fleet', { role: 'OPERATOR' });
    expect(await screen.findByRole('heading', { name: 'Fleet and dead-letter queue' })).toBeInTheDocument();
    const nodes = await screen.findByRole('table', { name: 'Nodes' });
    expect(within(rowWith(nodes, 'prd-node-02')).getByText('Stale heartbeat')).toBeInTheDocument();
    expect(within(rowWith(nodes, 'prd-node-03')).getByRole('button', { name: 'Drain prd-node-03' })).toBeDisabled();
    expect(screen.getByText('6 of 7')).toBeInTheDocument();
    expect(await screen.findByText('checkout-web 5.12.0 to dev')).toBeInTheDocument();
    expect(await screen.findByRole('table', { name: 'Dead-letter queue' })).toBeInTheDocument();
    expect(await screen.findByRole('table', { name: 'Read-model projections' })).toBeInTheDocument();
  });

  it('drains a node after confirming', async () => {
    const { user } = await renderApp('/fleet', { role: 'OPERATOR' });
    const nodes = await screen.findByRole('table', { name: 'Nodes' });
    await user.click(within(rowWith(nodes, 'dev-node-01')).getByRole('button', { name: 'Drain dev-node-01' }));

    const confirm = screen.getByRole('group', { name: 'Confirm: Drain dev-node-01' });
    const go = within(confirm).getByRole('button', { name: 'Drain' });
    expect(go).toHaveFocus();
    await user.click(go);

    const table = await screen.findByRole('table', { name: 'Nodes' });
    await waitFor(() => expect(within(rowWith(table, 'dev-node-01')).getByText('Draining')).toBeInTheDocument());
    expect(within(rowWith(table, 'dev-node-01')).getByRole('button', { name: 'Drain dev-node-01' })).toBeDisabled();
    // The trigger is disabled now, so focus stays on its wrapper in the same row.
    await waitFor(() => expect(rowWith(table, 'dev-node-01')).toContainElement(document.activeElement as HTMLElement));
  });

  it('cancels a drain with Escape and gives focus back to the trigger', async () => {
    const { user } = await renderApp('/fleet', { role: 'OPERATOR' });
    const nodes = await screen.findByRole('table', { name: 'Nodes' });
    await user.click(within(rowWith(nodes, 'qa-node-01')).getByRole('button', { name: 'Drain qa-node-01' }));
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('group', { name: 'Confirm: Drain qa-node-01' })).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Drain qa-node-01' })).toHaveFocus();
  });

  it('replays a dead letter: the chip replaces the button', async () => {
    const { user } = await renderApp('/fleet', { role: 'OPERATOR' });
    const dlq = await screen.findByRole('table', { name: 'Dead-letter queue' });
    const row = rowWith(dlq, 'search-indexer 1.9.1 to dev');
    await user.click(within(row).getByRole('button', { name: 'Replay search-indexer 1.9.1 to dev' }));

    expect(await within(row).findByText('Replayed, queued')).toBeInTheDocument();
    expect(within(row).queryByRole('button', { name: /Replay/ })).not.toBeInTheDocument();
    await waitFor(() => expect(within(row).getByText('Replayed, queued').parentElement).toHaveFocus());
  });

  it('reclaims the stuck task', async () => {
    const { user } = await renderApp('/fleet', { role: 'OPERATOR' });
    await user.click(await screen.findByRole('button', { name: 'Reclaim and retry checkout-web 5.12.0 to dev' }));

    const done = await screen.findByText('Lease released. The task is back in the queue; another worker will finish it.');
    expect(done.closest('[tabindex="-1"]')).toHaveFocus();
    expect(await screen.findByText('No stuck tasks.')).toBeInTheDocument();
  });

  it('rebuilds a projection after confirming', async () => {
    const { user } = await renderApp('/fleet', { role: 'OPERATOR' });
    const table = await screen.findByRole('table', { name: 'Read-model projections' });
    await user.click(within(rowWith(table, 'task_timeline')).getByRole('button', { name: 'Rebuild task_timeline' }));
    await user.click(within(screen.getByRole('group', { name: 'Confirm: Rebuild task_timeline' })).getByRole('button', { name: 'Rebuild' }));

    const row = rowWith(table, 'task_timeline');
    expect(await within(row).findByText('Rebuilding from the earliest offset. Reads show the old data until it finishes.')).toBeInTheDocument();
    expect(within(row).getByRole('button', { name: 'Rebuild task_timeline' })).toBeDisabled();
  });
});
