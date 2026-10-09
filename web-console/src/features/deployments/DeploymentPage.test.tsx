import { screen, waitFor, within } from '@testing-library/react';
import { http } from 'msw';
import { describe, expect, it } from 'vitest';
import { requestRollback } from '../../api/control';
import { sid } from '../../mocks/db';
import { problem } from '../../mocks/respond';
import { server } from '../../test/server';
import { renderApp } from '../../test/render';

const DEPLOYING = sid(202); // billing-api 2.4.0 to staging, Payments
const HEALTHY = sid(204); // billing-api 2.3.1 to prod, Payments
const DEGRADED = sid(211); // ledger-worker 0.18.2 to prod, Payments
const FAILED = sid(217); // query-gateway 3.1.0 to staging, Search

async function stepper() {
  return screen.findByRole('list', { name: 'Deployment progress' });
}

function step(list: HTMLElement, label: string): HTMLElement {
  return within(list).getByText(label).closest('li')!;
}

describe('DeploymentPage', () => {
  it('shows a DEPLOYING deployment as live, with Roll back disabled and the reason', async () => {
    await renderApp(`/deployments/${DEPLOYING}`, { role: 'OPERATOR' });
    expect(await screen.findByRole('heading', { level: 1, name: 'billing-api 2.4.0 to staging DEPLOYING' })).toBeInTheDocument();
    expect(screen.getByText('Live: updates every 2 s')).toBeInTheDocument();

    const steps = await stepper();
    expect(step(steps, 'DEPLOYING')).toHaveAttribute('aria-current', 'step');
    expect(within(step(steps, 'VALIDATING')).getByText('Done')).toBeInTheDocument();
    expect(within(step(steps, 'HEALTHY')).getByText('Not yet')).toBeInTheDocument();

    const button = await screen.findByRole('button', { name: 'Roll back' });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription('Available once the deployment is HEALTHY or DEGRADED.');

    // attempts from the timeline: a transient failure, then the running retry
    const attempts = await screen.findByRole('list', { name: 'Attempts for the DEPLOY task' });
    expect(within(attempts).getByText(/Node did not answer within 30 s/)).toBeInTheDocument();
    expect(within(attempts).getByText('Starting containers.')).toBeInTheDocument();
  });

  it('rolls back a HEALTHY deployment after an inline confirmation, then blocks a second request', async () => {
    const { user } = await renderApp(`/deployments/${HEALTHY}`, { role: 'OPERATOR' });
    expect(await screen.findByText('Settled: checks every 30 s')).toBeInTheDocument();
    const rollBack = await screen.findByRole('button', { name: 'Roll back' });
    await waitFor(() => expect(rollBack).toBeEnabled());

    await user.click(rollBack);
    const confirm = screen.getByRole('group', { name: 'Roll back billing-api 2.3.1 in prod?' });
    expect(confirm).toHaveFocus();

    // Cancel returns focus to Roll back
    await user.click(within(confirm).getByRole('button', { name: 'Cancel' }));
    expect(screen.getByRole('button', { name: 'Roll back' })).toHaveFocus();

    await user.click(screen.getByRole('button', { name: 'Roll back' }));
    await user.click(screen.getByRole('button', { name: 'Confirm rollback' }));

    const accepted = await screen.findByText('Rollback accepted.');
    expect(accepted.closest('[role="status"]')).toHaveTextContent('A ROLLBACK task is PENDING; the state changes to ROLLED_BACK when it completes.');
    // polling switches to the live rate while the rollback is pending
    expect(screen.getByText('Live: updates every 2 s')).toBeInTheDocument();

    const again = screen.getByRole('button', { name: 'Roll back' });
    expect(again).toBeDisabled();
    expect(again).toHaveAccessibleDescription('A rollback is already requested.');
    // the ROLLBACK task appears once the task list is refetched
    const tasks = await screen.findByRole('list', { name: 'Tasks' });
    expect(await within(tasks).findByText('ROLLBACK')).toBeInTheDocument();
  });

  it('shows the conflict with a Refresh action when someone else rolled back first', async () => {
    const { user } = await renderApp(`/deployments/${DEGRADED}`, { role: 'OPERATOR' });
    const rollBack = await screen.findByRole('button', { name: 'Roll back' });
    await waitFor(() => expect(rollBack).toBeEnabled());

    await requestRollback(DEGRADED); // another session asks first; this view has not polled yet

    await user.click(rollBack);
    await user.click(screen.getByRole('button', { name: 'Confirm rollback' }));
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('A rollback is already requested for this deployment.');

    await user.click(within(alert).getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Roll back' })).toHaveAccessibleDescription('A rollback is already requested.'));
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows a FAILED deployment as final, with the permanent attempt and the dead-letter link', async () => {
    await renderApp(`/deployments/${FAILED}`, { role: 'OPERATOR' });
    expect(await screen.findByRole('heading', { level: 1, name: /query-gateway 3\.1\.0 to staging/ })).toBeInTheDocument();
    expect(screen.getByText('Final state')).toBeInTheDocument();

    const steps = await stepper();
    expect(within(step(steps, 'DEPLOYING')).getByText('Failed here')).toBeInTheDocument();
    expect(within(step(steps, 'HEALTHY')).getByText('Not yet')).toBeInTheDocument();

    const button = await screen.findByRole('button', { name: 'Roll back' });
    expect(button).toBeDisabled();
    expect(button).toHaveAccessibleDescription('Not available from a final state.');

    const attempts = await screen.findByRole('list', { name: 'Attempts for the DEPLOY task' });
    expect(within(attempts).getAllByRole('listitem')).toHaveLength(3);
    expect(within(attempts).getByText('Image pull denied. PERMANENT: sent to task.work.DLT.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'View in the dead-letter queue' })).toHaveAttribute('href', '/fleet');
  });

  it('does not offer Roll back to a viewer', async () => {
    await renderApp(`/deployments/${HEALTHY}`, { role: 'VIEWER' });
    await screen.findByRole('heading', { level: 1, name: /billing-api 2\.3\.1 to prod/ });
    await screen.findByRole('list', { name: 'Tasks' });
    expect(screen.queryByRole('button', { name: 'Roll back' })).not.toBeInTheDocument();
  });

  it('answers not found for a deployment the caller may not see', async () => {
    await renderApp(`/deployments/${FAILED}`, { role: 'DEPLOYER' }); // Search team; DEPLOYER is on Payments only
    expect(await screen.findByText('This deployment does not exist, or you do not have access to it.')).toBeInTheDocument();
  });

  it('keeps working from control-api when the timeline is not built (hybrid mode)', async () => {
    server.use(http.get('/api/v1/deployments/:id/timeline', ({ request }) =>
      problem(request, 501, 'not-implemented', 'Not implemented', 'query-service deployment timeline (S6) is not built yet.')));
    await renderApp(`/deployments/${DEPLOYING}`);
    expect(await screen.findByText('Attempts and the timeline need query-service (S6)')).toBeInTheDocument();
    expect(await screen.findByRole('heading', { level: 1, name: 'billing-api 2.4.0 to staging DEPLOYING' })).toBeInTheDocument();
    expect(screen.getByText(/^Requested today at|^Requested \d/)).toBeInTheDocument();
    expect(step(await stepper(), 'DEPLOYING')).toHaveAttribute('aria-current', 'step');
    const tasks = await screen.findByRole('list', { name: 'Tasks' });
    expect(within(tasks).getByText('DEPLOY')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Timeline' })).not.toBeInTheDocument();
  });
});
