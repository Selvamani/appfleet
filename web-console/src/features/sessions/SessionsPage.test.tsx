import { screen, waitFor, within } from '@testing-library/react';
import { http } from 'msw';
import { describe, expect, it } from 'vitest';
import { problem } from '../../mocks/respond';
import { server } from '../../test/server';
import { renderApp } from '../../test/render';

async function sessionList() {
  return screen.findByRole('list', { name: 'Your sessions' });
}

function rowOf(list: HTMLElement, tool: string): HTMLElement {
  return within(list).getByText(tool).closest('li')!;
}

describe('SessionsPage', () => {
  it('lists my running sessions with Open links to their endpoints', async () => {
    await renderApp('/sessions');
    expect(screen.getByRole('heading', { level: 1, name: 'Tool sessions' })).toBeInTheDocument();
    const list = await sessionList();
    const row = rowOf(list, 'Java IDE (JDK 21)');
    expect(within(row).getByText('RUNNING')).toBeInTheDocument();
    expect(within(row).getByText('Idle for 4 min, ends after 30 min idle')).toBeInTheDocument();
    const open = within(row).getByRole('link', { name: 'Open Java IDE (JDK 21) in a new tab' });
    expect(open).toHaveAttribute('href', expect.stringMatching(/^https:\/\/sessions\.appfleet\.internal\//));
    expect(open).toHaveAttribute('target', '_blank');
    expect(open).toHaveAttribute('rel', expect.stringContaining('noopener'));
  });

  it('starts a tool: a STARTING row appears, without an Open link yet', async () => {
    const { user } = await renderApp('/sessions');
    await sessionList();
    await user.click(await screen.findByRole('button', { name: 'Start Design suite' }));

    expect(await screen.findByText('Starting Design suite.')).toBeInTheDocument();
    const row = rowOf(await sessionList(), 'Design suite');
    expect(within(row).getByText('STARTING')).toBeInTheDocument();
    expect(within(row).getByText('Cold start: ready in up to 30 s')).toBeInTheDocument();
    expect(within(row).queryByRole('link', { name: /Open/ })).not.toBeInTheDocument();
  });

  it('polls a warm-pool session until it is RUNNING, then offers Open and announces it', async () => {
    const { user } = await renderApp('/sessions');
    await sessionList();
    await user.click(await screen.findByRole('button', { name: 'Start SQL workbench' }));
    const row = () => rowOf(screen.getByRole('list', { name: 'Your sessions' }), 'SQL workbench');
    await waitFor(() => expect(within(row()).getByText('STARTING')).toBeInTheDocument());
    // warm start is 1.5 s in the mock; the list polls every second while a session is STARTING
    await waitFor(() => expect(within(row()).getByText('RUNNING')).toBeInTheDocument(), { timeout: 5000 });
    expect(within(row()).getByRole('link', { name: 'Open SQL workbench in a new tab' })).toBeInTheDocument();
    expect(screen.getByText('SQL workbench is RUNNING and ready to open.')).toBeInTheDocument();
  }, 10_000);

  it('ends a session after an inline confirmation', async () => {
    const { user } = await renderApp('/sessions');
    const list = await sessionList();
    await user.click(within(rowOf(list, 'Java IDE (JDK 21)')).getByRole('button', { name: 'End Java IDE (JDK 21)' }));

    const confirm = screen.getByRole('group', { name: 'End Java IDE (JDK 21)?' });
    expect(confirm).toHaveFocus();
    await user.click(within(confirm).getByRole('button', { name: 'End session' }));

    expect(await screen.findByText('Ended Java IDE (JDK 21).')).toBeInTheDocument();
    expect(within(await sessionList()).queryByText('Java IDE (JDK 21)')).not.toBeInTheDocument();
    expect(within(await sessionList()).getByText('Python data notebook')).toBeInTheDocument();
  });

  it('returns focus to End when the confirmation is cancelled', async () => {
    const { user } = await renderApp('/sessions');
    const list = await sessionList();
    await user.click(within(rowOf(list, 'Python data notebook')).getByRole('button', { name: 'End Python data notebook' }));
    await user.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'End Python data notebook' })).toHaveFocus();
    expect(within(list).getByText('Python data notebook')).toBeInTheDocument();
  });

  it('refuses a fourth session with the 409 message', async () => {
    const { user } = await renderApp('/sessions');
    await sessionList(); // two seeded sessions
    await user.click(await screen.findByRole('button', { name: 'Start Design suite' }));
    await screen.findByText('Starting Design suite.');

    await user.click(screen.getByRole('button', { name: 'Start Vendor planning tool' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Could not start Vendor planning tool.');
    expect(alert).toHaveTextContent('You already have 3 sessions open. End one to start another.');
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'Your sessions' })).getAllByRole('listitem')).toHaveLength(3));
  });

  it('shows the empty state once every session has ended', async () => {
    const { user } = await renderApp('/sessions');
    for (const tool of ['Java IDE (JDK 21)', 'Python data notebook']) {
      await user.click(await screen.findByRole('button', { name: `End ${tool}` }));
      await user.click(screen.getByRole('button', { name: 'End session' }));
      await screen.findByText(`Ended ${tool}.`);
    }
    expect(await screen.findByText('No sessions running.')).toBeInTheDocument();
    expect(screen.getByText('Start a tool from the catalogue.')).toBeInTheDocument();
  });

  it('filters the catalogue by the q search parameter', async () => {
    await renderApp('/sessions?q=sql');
    expect(await screen.findByRole('heading', { level: 3, name: 'SQL workbench' })).toBeInTheDocument();
    expect(screen.queryByRole('heading', { level: 3, name: 'Design suite' })).not.toBeInTheDocument();
    expect(screen.getByRole('searchbox', { name: 'Search the catalogue' })).toHaveValue('sql');
  });

  it('says so when the catalogue is not built (hybrid mode)', async () => {
    server.use(http.get('/api/v1/catalogue/images', ({ request }) =>
      problem(request, 501, 'not-implemented', 'Not implemented', 'GET /api/v1/catalogue/images is not built yet.')));
    await renderApp('/sessions');
    expect(await screen.findByText('The catalogue is not built yet')).toBeInTheDocument();
    // sessions still work
    expect(within(await sessionList()).getByText('Java IDE (JDK 21)')).toBeInTheDocument();
  });
});
