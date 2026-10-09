import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { getSession, startSession } from '../auth/session';
import { fakeJwt } from '../test/jwt';
import { renderApp } from '../test/render';
import { server } from '../test/server';

// AppShell reads apiMode when it renders, so a test can flip it.
const mode = vi.hoisted(() => ({ value: 'hybrid' as 'mock' | 'hybrid' }));
vi.mock('../api/http', async importOriginal => {
  const real = await importOriginal<typeof import('../api/http')>();
  return { ...real, get apiMode() { return mode.value; } };
});

const TEAM = '00000000-0000-0000-0000-0000000000b1';

function signInAs(teams: Record<string, string[]> | undefined, email = 'ada@example.io') {
  const now = Math.floor(Date.now() / 1000);
  const accessToken = fakeJwt({ iss: 'appfleet-identity', sub: 'user-1', aud: ['appfleet'], jti: 'j1', iat: now, exp: now + 900, ...(teams ? { teams } : {}) });
  startSession({ accessToken, refreshToken: 'refresh-1', tokenType: 'Bearer', expiresIn: 900 }, email);
}

describe('the shell with a real session', () => {
  beforeEach(() => { mode.value = 'hybrid'; });

  it('tells you that you are not signed in, with a link, on any screen but the sign-in screen', async () => {
    const { router } = await renderApp('/applications');
    expect(await screen.findByText(/You are not signed in, so control-api will refuse these calls/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Sign in' })).toHaveAttribute('href', '/login');
    await router.navigate('/login');
    await waitFor(() => expect(screen.queryByText(/You are not signed in/)).not.toBeInTheDocument());
  });

  it('says nothing about signing in in simulated mode', async () => {
    mode.value = 'mock';
    await renderApp('/applications');
    expect(screen.queryByText(/You are not signed in/)).not.toBeInTheDocument();
  });

  it('shows who you are and how many teams the token names, and offers to sign out', async () => {
    signInAs({ [TEAM]: ['application:read', 'deployment:read'] });
    await renderApp('/applications');
    const top = screen.getByRole('button', { name: 'Sign out' }).parentElement!;
    expect(within(top).getByText('ada@example.io')).toBeInTheDocument();
    expect(within(top).getByText('Teams: 1')).toBeInTheDocument();
    expect(screen.queryByText(/You are not signed in/)).not.toBeInTheDocument();
    expect(screen.getByText(/the role switch is off, and permissions come from your access token/)).toBeInTheDocument();
  });

  it('builds the navigation from the permissions in the token, not from the simulated role', async () => {
    signInAs({ [TEAM]: ['application:read', 'deployment:read'] });
    await renderApp('/applications');
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).getByRole('link', { name: 'Applications' })).toBeInTheDocument();
    expect(within(nav).getByRole('link', { name: 'Dashboard' })).toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Access' })).not.toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Audit trail' })).not.toBeInTheDocument();
  });

  it('shows no screens that need a permission the token does not carry', async () => {
    signInAs(undefined);
    await renderApp('/login');
    const nav = screen.getByRole('navigation', { name: 'Main' });
    expect(within(nav).queryByRole('link', { name: 'Applications' })).not.toBeInTheDocument();
    expect(within(nav).queryByRole('link', { name: 'Dashboard' })).not.toBeInTheDocument();
  });

  it('signs out: tells the service, forgets the session, and lands on the sign-in screen', async () => {
    signInAs({ [TEAM]: ['application:read'] });
    let logoutBody: unknown;
    server.use(http.post('/api/v1/auth/logout', async ({ request }) => { logoutBody = await request.json(); return new HttpResponse(null, { status: 204 }); }));
    const { user, router } = await renderApp('/applications');
    await user.click(screen.getByRole('button', { name: 'Sign out' }));
    await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
    expect(logoutBody).toEqual({ refreshToken: 'refresh-1' });
    expect(getSession()).toBeNull();
    expect(screen.queryByRole('button', { name: 'Sign out' })).not.toBeInTheDocument();
    expect(await screen.findByRole('heading', { level: 1, name: 'Sign in' })).toBeInTheDocument();
  });
});