import { screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { renderApp } from '../../test/render';

async function eventList() {
  return screen.findByRole('list', { name: 'Audit events' });
}

describe('AuditPage', () => {
  it('is not found for a deployer', async () => {
    await renderApp('/audit', { role: 'DEPLOYER' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Page not found' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Audit trail' })).not.toBeInTheDocument();
  });

  it('shows an auditor the events, newest first, with the read model freshness', async () => {
    await renderApp('/audit', { role: 'AUDITOR' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Audit trail' })).toBeInTheDocument();
    expect(screen.getByText('Who did what, when, to what. Append-only.')).toBeInTheDocument();
    const list = await eventList();
    expect(within(list).getByRole('button', { name: /GRANT_REVOKED/ })).toHaveAttribute('aria-pressed', 'false');
    expect(within(list).getAllByRole('button', { name: /DENIED/ }).length).toBeGreaterThan(0);
    expect(screen.getByText(/^asOf /)).toBeInTheDocument();
    expect(screen.getByText('Select an event to see its details and every step that carried its correlation id.')).toBeInTheDocument();
  });

  it('shows the selected event and walks its correlation id', async () => {
    const { user } = await renderApp('/audit', { role: 'AUDITOR' });
    const list = await eventList();
    const row = within(list).getByRole('button', { name: /GRANT_REVOKED/ });
    await user.click(row);
    expect(row).toHaveAttribute('aria-pressed', 'true');

    const detail = screen.getByRole('complementary', { name: 'Event detail' });
    expect(within(detail).getByText('m.okafor, DEPLOYER on Search')).toBeInTheDocument();
    expect(within(detail).getByText('10.2.1.5, Firefox 131, Windows')).toBeInTheDocument();
    expect(within(detail).getByRole('heading', { level: 3, name: 'Everything with c-2d19c0f8' })).toBeInTheDocument();
    const walk = await within(detail).findByRole('list', { name: 'Steps with correlation id c-2d19c0f8' });
    expect(within(walk).getByText(/Grant removed; live tokens for m.okafor added to the denylist/)).toBeInTheDocument();
    expect(within(walk).getByText(/identity-service/)).toBeInTheDocument();
  });

  it('preselects the event a ?cid= link points at', async () => {
    await renderApp('/audit?cid=c-0be3f5a1', { role: 'AUDITOR' });
    const list = await eventList();
    const rows = within(list).getAllByRole('button');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveAttribute('aria-pressed', 'true');
    expect(rows[0]).toHaveTextContent('ROLLBACK_REQUESTED');
    expect(screen.getByLabelText('Correlation id')).toHaveValue('c-0be3f5a1');

    const walk = await screen.findByRole('list', { name: 'Steps with correlation id c-0be3f5a1' });
    expect(within(walk).getAllByRole('listitem')).toHaveLength(3);
    expect(within(walk).getByText('ROLLBACK task created')).toBeInTheDocument();
  });

  it('applies filters on submit, keeps them in the URL, and clears them', async () => {
    const { user, router } = await renderApp('/audit', { role: 'AUDITOR' });
    await eventList();

    await user.type(screen.getByLabelText('Actor'), 'admin.t');
    expect(router.state.location.search).toBe(''); // not applied until submitted
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(router.state.location.search).toBe('?actor=admin.t');

    const list = await eventList();
    const rows = within(list).getAllByRole('button');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toHaveTextContent('GRANT_REVOKED');

    await user.selectOptions(screen.getByLabelText('Action'), 'LOGIN_FAILED');
    await user.click(screen.getByRole('button', { name: 'Apply filters' }));
    expect(new URLSearchParams(router.state.location.search).get('action')).toBe('LOGIN_FAILED');
    expect(await screen.findByText('No events match these filters')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Clear' }));
    expect(router.state.location.search).toBe('');
    expect(screen.getByLabelText('Actor')).toHaveValue('');
    expect(await eventList()).toBeInTheDocument();
  });

  it('shows sign-ins in their own view', async () => {
    const { user, router } = await renderApp('/audit', { role: 'AUDITOR' });
    await eventList();
    await user.click(screen.getByRole('button', { name: 'Sign-ins' }));
    expect(router.state.location.search).toBe('?view=signins');
    expect(screen.getByRole('button', { name: 'Sign-ins' })).toHaveAttribute('aria-pressed', 'true');

    const table = await screen.findByRole('table', { name: 'Sign-ins' });
    expect(within(table).getAllByText('curl/8.9')).toHaveLength(2);
    expect(within(table).getAllByText('FAILED')).toHaveLength(2);
    expect(within(table).getByRole('link', { name: 'c-e4c1d7b0, show its audit events' })).toHaveAttribute('href', '/audit?cid=c-e4c1d7b0');
  });
});
