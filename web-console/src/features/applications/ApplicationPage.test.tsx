import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { describe, expect, it } from 'vitest';
import { sid } from '../../mocks/db';
import { renderApp } from '../../test/render';
import { server } from '../../test/server';

const BILLING = sid(20);
const SEARCH_INDEXER = sid(23);

/** The environment card whose heading is `env`. */
async function envCard(env: string) {
  const heading = await screen.findByRole('heading', { level: 3, name: env });
  return heading.closest('section') as HTMLElement;
}

function notBuilt(path: string) {
  return http.get(path, () => HttpResponse.json(
    { type: 'urn:appfleet:problem:not-implemented', title: 'Not implemented', status: 501, detail: 'Not built yet.', correlationId: 'c-test' },
    { status: 501, headers: { 'Content-Type': 'application/problem+json' } },
  ));
}

describe('ApplicationPage', () => {
  it('shows each environment, the releases and the history', async () => {
    await renderApp(`/applications/${BILLING}`);
    expect(await screen.findByRole('heading', { level: 1, name: 'billing-api' })).toBeInTheDocument();
    expect(await screen.findByText('Invoices and payment intents API, owned by Payments')).toBeInTheDocument();

    const prod = await envCard('prod');
    expect(within(prod).getByText('2.3.1')).toBeInTheDocument();
    expect(within(prod).getByText('HEALTHY')).toBeInTheDocument();
    expect(within(prod).getByText(/A new deployment to prod is refused while this one is active\. Roll it back first\./)).toBeInTheDocument();
    expect(within(prod).getByRole('link', { name: 'Deploy to prod' })).toHaveAttribute('href', `/applications/${BILLING}/deploy?env=prod`);

    const qa = await envCard('qa');
    expect(within(qa).getByText('Nothing deployed yet')).toBeInTheDocument();
    expect(within(qa).getByRole('link', { name: 'Deploy to qa' })).toBeInTheDocument();

    const releases = await screen.findByRole('table', { name: 'Releases' });
    expect(within(releases).getByText('2.4.0', { selector: 'code' })).toBeInTheDocument();
    expect(within(releases).getByText('registry.internal/payments/billing-api:2.4.0')).toBeInTheDocument();
    expect(within(releases).getByRole('link', { name: 'Deploy 2.4.0' })).toHaveAttribute('href', `/applications/${BILLING}/deploy?release=${sid(103)}`);

    const history = await screen.findByRole('table', { name: 'Recent deployments' });
    expect(within(history).getAllByRole('row').length).toBeGreaterThan(1);
    expect(screen.getByText(/^Last 30 days: \d+ of \d+ deployments reached HEALTHY, \d+ FAILED, \d+ ROLLED_BACK\.$/)).toBeInTheDocument();
  });

  it('registers a release and confirms it', async () => {
    const { user } = await renderApp(`/applications/${BILLING}`);
    await user.click(await screen.findByRole('button', { name: 'Register release' }));
    const form = await screen.findByRole('form', { name: 'Register a release' });
    expect(within(form).getByRole('textbox', { name: 'Version' })).toHaveFocus();
    await user.type(within(form).getByRole('textbox', { name: 'Version' }), '2.6.0');
    await user.type(within(form).getByRole('textbox', { name: 'Artifact reference' }), 'registry.internal/payments/billing-api:2.6.0');
    await user.type(within(form).getByRole('textbox', { name: 'Checksum' }), `sha256:${'ab'.repeat(32)}`);
    await user.click(within(form).getByRole('button', { name: 'Register release' }));

    expect(await screen.findByText('Release 2.6.0 registered. It cannot be changed.')).toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'Register a release' })).not.toBeInTheDocument();
    const releases = await screen.findByRole('table', { name: 'Releases' });
    expect(await within(releases).findByText('2.6.0', { selector: 'code' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Register release' })).toHaveFocus();
  });

  it('shows the field error for a bad checksum', async () => {
    const { user } = await renderApp(`/applications/${BILLING}`);
    await user.click(await screen.findByRole('button', { name: 'Register release' }));
    const form = await screen.findByRole('form', { name: 'Register a release' });
    await user.type(within(form).getByRole('textbox', { name: 'Version' }), '2.6.0');
    await user.type(within(form).getByRole('textbox', { name: 'Artifact reference' }), 'registry.internal/payments/billing-api:2.6.0');
    const checksum = within(form).getByRole('textbox', { name: 'Checksum' });
    await user.type(checksum, 'sha256:not-a-hash');
    await user.click(within(form).getByRole('button', { name: 'Register release' }));

    await waitFor(() => expect(checksum).toHaveAttribute('aria-invalid', 'true'));
    expect(checksum).toHaveAccessibleDescription(/Must match "sha256:\[0-9a-f\]\{64\}"\./);
    expect(checksum).toHaveFocus();
    expect(within(form).getByRole('textbox', { name: 'Version' })).not.toHaveAttribute('aria-invalid');
  });

  it('puts a duplicate version (409) on the version field', async () => {
    const { user } = await renderApp(`/applications/${BILLING}`);
    await user.click(await screen.findByRole('button', { name: 'Register release' }));
    const form = await screen.findByRole('form', { name: 'Register a release' });
    await user.type(within(form).getByRole('textbox', { name: 'Version' }), '2.4.0');
    await user.type(within(form).getByRole('textbox', { name: 'Artifact reference' }), 'registry.internal/payments/billing-api:2.4.0');
    await user.type(within(form).getByRole('textbox', { name: 'Checksum' }), `sha256:${'cd'.repeat(32)}`);
    await user.click(within(form).getByRole('button', { name: 'Register release' }));

    expect(await within(form).findByText(/^Release 2\.4\.0 already exists for billing-api\./)).toBeInTheDocument();
    expect(within(form).getByRole('textbox', { name: 'Version' })).toHaveFocus();
  });

  it('accepts a rollback of a HEALTHY deployment', async () => {
    const { user } = await renderApp(`/applications/${BILLING}`);
    const prod = await envCard('prod');
    await user.click(within(prod).getByRole('button', { name: 'Roll back 2.3.1 in prod' }));
    expect(await within(prod).findByText('Rollback accepted. A ROLLBACK task is PENDING; the state changes when it runs.')).toBeInTheDocument();
    expect(within(prod).getByRole('button', { name: 'Rollback requested 2.3.1 in prod' })).toBeDisabled();
  });

  it('offers no roll back while a deployment is in flight', async () => {
    await renderApp(`/applications/${BILLING}`);
    const staging = await envCard('staging');
    expect(within(staging).getByText('DEPLOYING')).toBeInTheDocument();
    expect(within(staging).queryByRole('button', { name: /roll back/i })).not.toBeInTheDocument();
    expect(within(staging).getByText(/Roll back is possible once it is HEALTHY or DEGRADED\./)).toBeInTheDocument();
  });

  it('is view only for a viewer', async () => {
    await renderApp(`/applications/${BILLING}`, { role: 'VIEWER' });
    expect(await screen.findByText('View only. Changing billing-api needs DEPLOYER on Payments.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Register release' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'Deploy' })).not.toBeInTheDocument();
    const prod = await envCard('prod');
    expect(within(prod).queryByRole('button', { name: /roll back/i })).not.toBeInTheDocument();
    expect(within(prod).getByRole('link', { name: 'Open deployment in prod' })).toBeInTheDocument();
  });

  it('answers not found for another team\'s application', async () => {
    await renderApp(`/applications/${SEARCH_INDEXER}`, { role: 'DEPLOYER' });
    expect(await screen.findByRole('heading', { level: 1, name: 'Application not found' })).toBeInTheDocument();
    expect(screen.getByText('This application does not exist, or you do not have access to it.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to applications' })).toHaveAttribute('href', '/applications');
  });

  it('names the missing endpoints when the backend has not built them (hybrid mode)', async () => {
    server.use(
      notBuilt('/api/v1/applications/:id/releases'),
      notBuilt('/api/v1/dashboard/where'),
      notBuilt('/api/v1/applications/:id/history'),
    );
    await renderApp(`/applications/${BILLING}`);
    expect(await screen.findByText('The release list is not available yet')).toBeInTheDocument();
    expect(await screen.findByText('The current state per environment is not available yet')).toBeInTheDocument();
    expect(await screen.findByText('History is not available yet')).toBeInTheDocument();
    expect(screen.getByText('GET /api/v1/dashboard/where')).toBeInTheDocument();
    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument();
  });
});
