import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../../test/render';

/** The table row (role="row") that contains `text`. */
function rowWith(table: HTMLElement, text: string): HTMLElement {
  const row = within(table).getByText(text).closest<HTMLElement>('[role="row"]');
  if (!row) throw new Error(`No row contains ${text}`);
  return row;
}

async function pickUser(user: Awaited<ReturnType<typeof renderApp>>['user'], displayName: string) {
  const list = await screen.findByRole('list', { name: 'Users' });
  await user.click(within(list).getByRole('link', { name: new RegExp(`^${displayName.replace('.', '\\.')}`) }));
  return screen.findByRole('table', { name: `Grants of ${displayName}` });
}

/** The card with this title (cards are regions labelled by their title). */
const card = (name: string) => screen.findByRole('region', { name });

describe('AccessPage', () => {
  it('is not found for an operator', async () => {
    await renderApp('/access', { role: 'OPERATOR' });
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });

  it('shows users, the first one selected, and service accounts to a platform admin', async () => {
    await renderApp('/access', { role: 'ADMIN' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Access' })).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Users' });
    // Grants are read from the members of every team, so the summary fills in as the lists arrive.
    await waitFor(() => expect(within(list).getByRole('link', { name: /^M\. Okafor/ })).toHaveTextContent('DEPLOYER on Payments, VIEWER on Search'));
    expect(within(list).getByRole('link', { name: /^R\. Lee/ })).toHaveTextContent('Deactivated');
    // No user in the address: the first one ("you") is shown, without a way to deactivate yourself.
    expect(within(list).getByRole('link', { name: /^You/ })).toHaveAttribute('aria-current', 'true');
    expect(await screen.findByRole('table', { name: 'Grants of You' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Deactivate/ })).not.toBeInTheDocument();
    expect(await card('Service accounts')).toBeInTheDocument();
  });

  it('selects a user by address and keeps the search', async () => {
    const { user, router } = await renderApp('/access?q=ok', { role: 'ADMIN' });
    const list = await screen.findByRole('list', { name: 'Users' });
    await waitFor(() => expect(within(list).queryByRole('link', { name: /^S\. Iyer/ })).not.toBeInTheDocument());
    await user.click(within(list).getByRole('link', { name: /^M\. Okafor/ }));

    expect(router.state.location.pathname).toBe('/access/users/0192f3a1-0000-7000-8000-00000000000b');
    expect(router.state.location.search).toBe('?q=ok');
    await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: /^M\. Okafor/ })).toHaveFocus());
    expect(within(screen.getByRole('list', { name: 'Users' })).getByRole('link', { name: /^M\. Okafor/ })).toHaveAttribute('aria-current', 'true');
  });

  it('removes a grant after confirming and says the sessions ended', async () => {
    const { user } = await renderApp('/access', { role: 'ADMIN' });
    const grants = await pickUser(user, 'M. Okafor');
    await within(grants).findByText('Search');
    await user.click(within(rowWith(grants, 'Search')).getByRole('button', { name: 'Remove VIEWER on Search' }));
    await user.click(within(screen.getByRole('group', { name: 'Confirm: Remove VIEWER on Search' })).getByRole('button', { name: 'Remove' }));

    const done = await screen.findByText(/^Removed VIEWER on Search\. Their sessions ended\./);
    // The row and its button are gone, so the outcome takes focus.
    expect(done.closest('[tabindex="-1"]')).toHaveFocus();
    const after = screen.getByRole('table', { name: 'Grants of M. Okafor' });
    await waitFor(() => expect(within(after).queryByText('Search')).not.toBeInTheDocument());
    expect(within(after).getByText('Payments')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('link', { name: /^M\. Okafor/ })).toHaveTextContent('DEPLOYER on Payments'));
    expect(screen.getByRole('link', { name: /^M\. Okafor/ })).not.toHaveTextContent('VIEWER on Search');
  });

  it('adds a grant', async () => {
    const { user } = await renderApp('/access', { role: 'ADMIN' });
    const grants = await pickUser(user, 'S. Iyer');
    expect(within(grants).queryByText('Payments')).not.toBeInTheDocument();

    const form = await screen.findByRole('form', { name: 'Add a grant' });
    await user.selectOptions(within(form).getByLabelText('Team'), 'Payments');
    await user.selectOptions(within(form).getByLabelText('Role'), 'VIEWER');
    await user.click(within(form).getByRole('button', { name: 'Add grant' }));

    expect(await screen.findByText('Granted VIEWER on Payments. It shows in their next token.')).toBeInTheDocument();
    const row = rowWith(await screen.findByRole('table', { name: 'Grants of S. Iyer' }), 'Payments');
    expect(within(row).getByLabelText('Role of VIEWER on Payments')).toHaveValue('VIEWER');
  });

  it('changes a role in one team', async () => {
    const { user } = await renderApp('/access', { role: 'ADMIN' });
    const grants = await pickUser(user, 'M. Okafor');
    await user.selectOptions(within(grants).getByLabelText('Role of VIEWER on Search'), 'DEPLOYER');
    await user.click(within(grants).getByRole('button', { name: 'Change VIEWER on Search to DEPLOYER' }));

    expect(await screen.findByText(/^Changed to DEPLOYER on Search\. Their sessions ended\./)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('link', { name: /^M\. Okafor/ })).toHaveTextContent('DEPLOYER on Payments, DEPLOYER on Search'));
  });

  it('deactivates a user after confirming', async () => {
    const { user } = await renderApp('/access', { role: 'ADMIN' });
    await pickUser(user, 'P. Novak');
    await user.click(screen.getByRole('button', { name: 'Deactivate P. Novak' }));
    await user.click(within(screen.getByRole('group', { name: 'Confirm: Deactivate P. Novak' })).getByRole('button', { name: 'Deactivate' }));

    expect(await screen.findByText(/P\. Novak is deactivated\./)).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: /^P\. Novak/ })).toHaveTextContent('Deactivated'));
    expect(await screen.findByRole('button', { name: 'Deactivate P. Novak' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add grant' })).toBeDisabled();
  });

  it('adds a second key to a service account and shows the key once', async () => {
    const { user } = await renderApp('/access', { role: 'ADMIN' });
    const sa = await card('Service accounts');
    await within(sa).findByRole('option', { name: 'Search' });
    await user.selectOptions(within(sa).getByLabelText('Team'), 'Search');
    await user.click(await within(sa).findByRole('button', { name: 'Add a key to ci-release-bot' }));
    await user.click(within(screen.getByRole('group', { name: 'Confirm: Add a key to ci-release-bot' })).getByRole('button', { name: 'Add key' }));

    const title = await screen.findByText('New key for ci-release-bot');
    await waitFor(() => expect(title.closest('[tabindex="-1"]')).toHaveFocus());
    expect(screen.getByText(/^afk_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/)).toBeInTheDocument();
    expect(screen.getByText(/^Copy this key now\. It is not shown again/)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Hide key' }));
    expect(screen.queryByText(/^afk_[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{20,}$/)).not.toBeInTheDocument();
  });
});
