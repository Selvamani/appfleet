import { screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../../test/render';

/** The table row (role="row") that contains `text`. */
function rowWith(table: HTMLElement, text: string): HTMLElement {
  const row = within(table).getByText(text).closest<HTMLElement>('[role="row"]');
  if (!row) throw new Error(`No row contains ${text}`);
  return row;
}

async function pickUser(user: Awaited<ReturnType<typeof renderApp>>['user'], username: string) {
  const list = await screen.findByRole('list', { name: 'Users' });
  await user.click(within(list).getByRole('link', { name: new RegExp(`^${username.replace('.', '\\.')}`) }));
  return screen.findByRole('table', { name: `Grants of ${username}` });
}

describe('AccessPage', () => {
  it('is not found for an operator', async () => {
    await renderApp('/access', { role: 'OPERATOR' });
    expect(await screen.findByRole('heading', { name: 'Page not found' })).toBeInTheDocument();
  });

  it('shows users, the first one selected, and service accounts to an admin', async () => {
    await renderApp('/access', { role: 'ADMIN' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Access' })).toBeInTheDocument();
    const list = await screen.findByRole('list', { name: 'Users' });
    expect(within(list).getByRole('link', { name: /^m\.okafor/ })).toHaveTextContent('DEPLOYER on Payments, VIEWER on Search');
    expect(within(list).getByRole('link', { name: /^r\.lee/ })).toHaveTextContent('Deactivated');
    // No user in the address: the first one ("you") is shown, without a way to deactivate yourself.
    expect(within(list).getByRole('link', { name: /^you/ })).toHaveAttribute('aria-current', 'true');
    expect(await screen.findByRole('table', { name: 'Grants of you' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Deactivate/ })).not.toBeInTheDocument();
    expect(await screen.findByRole('table', { name: 'Service accounts' })).toBeInTheDocument();
  });

  it('selects a user by address and keeps the search', async () => {
    const { user, router } = await renderApp('/access?q=ok', { role: 'ADMIN' });
    const list = await screen.findByRole('list', { name: 'Users' });
    await waitFor(() => expect(within(list).queryByRole('link', { name: /^s\.iyer/ })).not.toBeInTheDocument());
    await user.click(within(list).getByRole('link', { name: /^m\.okafor/ }));

    expect(router.state.location.pathname).toBe('/access/users/0192f3a1-0000-7000-8000-00000000000b');
    expect(router.state.location.search).toBe('?q=ok');
    // A pick moves focus to the user's heading. Query it inside waitFor: with ?q=ok the first match
    // (m.okafor) is already shown before the click, and the route change remounts that heading.
    await waitFor(() => expect(screen.getByRole('heading', { level: 2, name: /^m\.okafor/ })).toHaveFocus());
    expect(within(screen.getByRole('list', { name: 'Users' })).getByRole('link', { name: /^m\.okafor/ })).toHaveAttribute('aria-current', 'true');
  });

  it('revokes a grant after confirming', async () => {
    const { user } = await renderApp('/access', { role: 'ADMIN' });
    const grants = await pickUser(user, 'm.okafor');
    await user.click(within(rowWith(grants, 'Search')).getByRole('button', { name: 'Revoke VIEWER on Search' }));
    await user.click(within(screen.getByRole('group', { name: 'Confirm: Revoke VIEWER on Search' })).getByRole('button', { name: 'Revoke' }));

    const done = await screen.findByText('Revoked. It takes effect within 5 minutes, including tokens already issued.');
    // The row and its button are gone, so the outcome takes focus.
    expect(done.closest('[tabindex="-1"]')).toHaveFocus();
    const after = screen.getByRole('table', { name: 'Grants of m.okafor' });
    expect(within(after).queryByText('Search')).not.toBeInTheDocument();
    expect(within(after).getByText('Payments')).toBeInTheDocument();
    // The list summary follows.
    await waitFor(() => expect(screen.getByRole('link', { name: /^m\.okafor/ })).toHaveTextContent('DEPLOYER on Payments'));
    expect(screen.getByRole('link', { name: /^m\.okafor/ })).not.toHaveTextContent('VIEWER on Search');
  });

  it('adds a grant', async () => {
    const { user } = await renderApp('/access', { role: 'ADMIN' });
    const grants = await pickUser(user, 's.iyer');
    expect(within(grants).queryByText('Payments')).not.toBeInTheDocument();

    await user.selectOptions(screen.getByLabelText('Team'), 'Payments');
    await user.selectOptions(screen.getByLabelText('Role'), 'VIEWER');
    await user.click(screen.getByRole('button', { name: 'Add grant' }));

    expect(await screen.findByText('Granted VIEWER on Payments.')).toBeInTheDocument();
    const row = rowWith(screen.getByRole('table', { name: 'Grants of s.iyer' }), 'Payments');
    expect(within(row).getByText('VIEWER')).toBeInTheDocument();
  });

  it('shows the conflict when the grant already exists', async () => {
    const { user } = await renderApp('/access', { role: 'ADMIN' });
    await pickUser(user, 'm.okafor');
    await user.selectOptions(screen.getByLabelText('Team'), 'Payments');
    await user.selectOptions(screen.getByLabelText('Role'), 'DEPLOYER');
    await user.click(screen.getByRole('button', { name: 'Add grant' }));

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not add the grant.');
    expect(alert).toHaveTextContent('m.okafor already has DEPLOYER on Payments.');
  });

  it('deactivates a user after confirming', async () => {
    const { user } = await renderApp('/access', { role: 'ADMIN' });
    await pickUser(user, 'p.novak');
    await user.click(screen.getByRole('button', { name: 'Deactivate p.novak' }));
    await user.click(within(screen.getByRole('group', { name: 'Confirm: Deactivate p.novak' })).getByRole('button', { name: 'Deactivate' }));

    expect(await screen.findByText(/p\.novak is deactivated\./)).toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 2, name: /^p\.novak/ })).toHaveTextContent('Deactivated');
    expect(await screen.findByRole('button', { name: 'Deactivate p.novak' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Add grant' })).toBeDisabled();
  });

  it('rotates a service-account key and shows the new key once', async () => {
    const { user } = await renderApp('/access', { role: 'ADMIN' });
    const table = await screen.findByRole('table', { name: 'Service accounts' });
    await user.click(within(rowWith(table, 'ci-release-bot')).getByRole('button', { name: 'Rotate key for ci-release-bot' }));
    await user.click(within(screen.getByRole('group', { name: 'Confirm: Rotate key for ci-release-bot' })).getByRole('button', { name: 'Rotate' }));

    const title = await screen.findByText('New key for ci-release-bot');
    await waitFor(() => expect(title.closest('[tabindex="-1"]')).toHaveFocus());
    expect(screen.getByText(/^ak_live_[0-9a-f]{32}$/)).toBeInTheDocument();
    expect(screen.getByText(/Copy this key now\. It is not shown again\. The old key keeps working until \d\d:\d\d:\d\d UTC\./)).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Copy' }));
    expect(await screen.findByRole('button', { name: 'Copied' })).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Hide key' }));
    expect(screen.queryByText(/^ak_live_/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Rotate key for ci-release-bot' })).toHaveFocus();
  });
});
