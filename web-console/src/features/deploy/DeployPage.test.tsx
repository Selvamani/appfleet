import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, describe, expect, it } from 'vitest';
import { sid } from '../../mocks/db';
import { renderApp } from '../../test/render';
import { server } from '../../test/server';

const BILLING = sid(20);
/** billing-api 2.4.0 in the seed data. */
const RELEASE_240 = sid(103);
const deployPath = (query = '') => `/applications/${BILLING}/deploy${query}`;

function problem(status: number, slug: string, detail: string) {
  return HttpResponse.json(
    { type: `urn:appfleet:problem:${slug}`, title: slug, status, detail, correlationId: 'c-test' },
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

/** The success notice whose title is `title`. */
async function acceptedPanel(title: 'Accepted' | 'Already accepted', timeout = 1000) {
  const heading = await screen.findByText(title, {}, { timeout });
  return heading.closest('[role="status"]') as HTMLElement;
}

afterEach(() => server.events.removeAllListeners());

describe('DeployPage', () => {
  it('deploys billing-api 2.4.0 to qa and links to its progress', async () => {
    const { user } = await renderApp(deployPath());
    await user.click(await screen.findByRole('radio', { name: /^2\.4\.0\s/ }));
    await user.click(await screen.findByRole('button', { name: /^qa\s/ }));
    expect(screen.getByRole('button', { name: /^qa\s/ })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByText(/Replaces nothing\./)).toBeInTheDocument();
    expect(screen.queryByText('qa already has an active deployment')).not.toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: 'Deploy' }));
    const panel = await acceptedPanel('Accepted');
    expect(panel).toHaveTextContent('billing-api 2.4.0 to qa is PENDING.');
    expect(within(panel).getByRole('link', { name: 'Follow progress' })).toHaveAttribute(
      'href', expect.stringMatching(/^\/deployments\/[0-9a-f-]{36}$/),
    );
  });

  it('keeps release and environment in the URL', async () => {
    const { user, router } = await renderApp(deployPath(`?release=${RELEASE_240}&env=dev`));
    expect(await screen.findByRole('radio', { name: /^2\.4\.0\s/ })).toBeChecked();
    expect(await screen.findByRole('button', { name: /^dev\s/ })).toHaveAttribute('aria-pressed', 'true');
    await user.click(screen.getByRole('button', { name: /^qa\s/ }));
    expect(router.state.location.search).toBe(`?release=${RELEASE_240}&env=qa`);
  });

  it('replays the same request with the same key instead of deploying twice', async () => {
    const keys: Array<string | null> = [];
    server.events.on('request:start', ({ request }) => {
      if (request.method === 'POST' && new URL(request.url).pathname === '/api/v1/deployments') {
        keys.push(request.headers.get('Idempotency-Key'));
      }
    });
    const { user } = await renderApp(deployPath(`?release=${RELEASE_240}&env=qa`));
    const deploy = await screen.findByRole('button', { name: 'Deploy' });
    await user.click(deploy);
    const first = await acceptedPanel('Accepted');
    const firstId = within(first).getByRole('link', { name: 'Follow progress' }).getAttribute('href');

    // Resubmitting at once hits the key while it is still IN_PROGRESS: the server answers 409
    // request-in-progress with Retry-After 1, the console waits and asks again, and gets the replay.
    await user.click(deploy);
    const again = await acceptedPanel('Already accepted', 3000);
    expect(again).toHaveTextContent('Already accepted: this is the same deployment as before. Submitting the same request again never deploys twice.');
    expect(within(again).getByRole('link', { name: 'Follow progress' })).toHaveAttribute('href', firstId);
    expect(keys).toHaveLength(3);
    expect(keys[0]).toBeTruthy();
    expect(new Set(keys).size).toBe(1);
  });

  it('warns before submit when prod has an active deployment, then shows the 409', async () => {
    const { user } = await renderApp(deployPath('?env=prod'));
    const warning = await screen.findByText('prod already has an active deployment');
    const notice = warning.closest('[role="alert"]') as HTMLElement;
    expect(notice).toHaveTextContent('billing-api 2.3.1 is HEALTHY in prod.');
    expect(notice).toHaveTextContent('a HEALTHY one counts');
    expect(within(notice).getByRole('link', { name: 'Open the active deployment' })).toHaveAttribute('href', `/deployments/${sid(204)}`);

    await user.click(screen.getByRole('button', { name: 'Deploy' }));
    const conflict = (await screen.findByText('Not started: conflict')).closest('[role="alert"]') as HTMLElement;
    expect(conflict).toHaveTextContent('billing-api already has an active deployment in prod (2.3.1, HEALTHY).');
    expect(within(conflict).getByRole('link', { name: 'Open the active deployment' })).toHaveAttribute('href', `/deployments/${sid(204)}`);
    // The correlation id is shown; the audit-trail link only appears for roles with audit:read.
    expect(conflict).toHaveTextContent('Correlation id');
    expect(within(conflict).queryByRole('link', { name: 'Find in audit trail' })).not.toBeInTheDocument();
    expect(screen.queryByText('prod already has an active deployment')).not.toBeInTheDocument();
  });

  it('asks for an environment when none is chosen', async () => {
    const { user } = await renderApp(deployPath());
    await screen.findByRole('radio', { name: /^2\.4\.0\s/ });
    await screen.findByRole('button', { name: /^dev\s/ });
    await user.click(screen.getByRole('button', { name: 'Deploy' }));
    expect(await screen.findByText('Choose an environment.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^dev\s/ })).toHaveFocus();
  });

  it('renews the key and asks to submit again after idempotency-key-reused', async () => {
    const keys: Array<string | null> = [];
    let calls = 0;
    server.use(http.post('/api/v1/deployments', ({ request }) => {
      keys.push(request.headers.get('Idempotency-Key'));
      calls += 1;
      if (calls === 1) return problem(422, 'idempotency-key-reused', 'This Idempotency-Key was already used with a different request body.');
      return HttpResponse.json({ deploymentId: sid(999), taskId: sid(998), status: 'PENDING' }, { status: 202, headers: { 'Idempotent-Replayed': 'false' } });
    }));
    const { user } = await renderApp(deployPath(`?release=${RELEASE_240}&env=qa`));
    const deploy = await screen.findByRole('button', { name: 'Deploy' });
    await user.click(deploy);
    expect(await screen.findByText(/Submit again; the console now sends it as a new request\./)).toBeInTheDocument();
    await user.click(deploy);
    await acceptedPanel('Accepted');
    expect(keys[1]).not.toBe(keys[0]);
  });

  it('shows a viewer the reason and a disabled Deploy button', async () => {
    await renderApp(deployPath('?env=qa'), { role: 'VIEWER' });
    expect(await screen.findByText('You can view releases but not deploy. Deploying billing-api needs DEPLOYER on Payments.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Deploy' })).toBeDisabled();
    expect(await screen.findByRole('radio', { name: /^2\.4\.0\s/ })).toBeInTheDocument();
  });

  it('falls back to typed ids when releases and environments are not built (hybrid mode)', async () => {
    const notBuilt = () => problem(501, 'not-implemented', 'Not built yet.');
    server.use(
      http.get('/api/v1/applications/:id/releases', notBuilt),
      http.get('/api/v1/environments', notBuilt),
      http.get('/api/v1/dashboard/where', notBuilt),
    );
    const { user } = await renderApp(deployPath());
    await user.type(await screen.findByRole('textbox', { name: 'Release id' }), RELEASE_240);
    await user.type(screen.getByRole('textbox', { name: 'Environment name' }), 'qa');
    await user.click(screen.getByRole('button', { name: 'Deploy' }));
    const panel = await acceptedPanel('Accepted');
    expect(panel).toHaveTextContent(`to qa is PENDING.`);
  });

  it('answers not found for an unknown application', async () => {
    await renderApp('/applications/0192f3a1-0000-7000-8000-00000000ffff/deploy');
    expect(await screen.findByRole('heading', { level: 1, name: 'Application not found' })).toBeInTheDocument();
  });

  it('marks the field the server rejects', async () => {
    server.use(http.post('/api/v1/deployments', () => HttpResponse.json(
      { type: 'urn:appfleet:problem:validation-failed', title: 'Validation failed', status: 400, detail: 'One or more fields are invalid.', correlationId: 'c-test', errors: [{ field: 'environment', message: 'must not be blank' }] },
      { status: 400, headers: { 'Content-Type': 'application/problem+json' } },
    )));
    const { user } = await renderApp(deployPath(`?release=${RELEASE_240}&env=qa`));
    await user.click(await screen.findByRole('button', { name: 'Deploy' }));
    expect(await screen.findByText('Must not be blank.')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByRole('button', { name: /^dev\s/ })).toHaveFocus());
  });
});
