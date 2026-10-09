import { screen, waitFor, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fakeJwt } from '../../test/jwt';
import { renderApp } from '../../test/render';
import { server } from '../../test/server';

// The screen reads apiMode when it renders, so a test can flip it. The module-level handlers keep the mode they loaded with.
const mode = vi.hoisted(() => ({ value: 'hybrid' as 'mock' | 'hybrid' }));
vi.mock('../../api/http', async importOriginal => {
  const real = await importOriginal<typeof import('../../api/http')>();
  return { ...real, get apiMode() { return mode.value; } };
});

const TEAM = '00000000-0000-0000-0000-0000000000b1';
const PASSWORD = 'correct horse battery';

function problem(status: number, slug: string, title: string, detail: string, extra: Record<string, unknown> = {}) {
  return HttpResponse.json(
    { type: `urn:appfleet:problem:${slug}`, title, status, detail, correlationId: `cid-${slug}`, ...extra },
    { status, headers: { 'Content-Type': 'application/problem+json' } },
  );
}

const DEFAULT_TEAMS = { [TEAM]: ['deployment:create', 'deployment:read'] };

/** teams null means the user has no grants: the claim is then absent, as the real issuer does. */
function access(jti: string, teams: Record<string, string[]> | null) {
  const now = Math.floor(Date.now() / 1000);
  return fakeJwt({ iss: 'appfleet-identity', sub: 'user-1', aud: ['appfleet'], jti, iat: now, exp: now + 900, ...(teams ? { teams } : {}) });
}

/** A tiny identity-service: it remembers which refresh tokens were used, like the real one. */
function identity(opts: { teams?: Record<string, string[]> | null } = {}) {
  const used = new Set<string>();
  const revoked = new Set<string>();
  let n = 0;
  const pair = () => {
    n += 1;
    return { accessToken: access(`jti-${n}`, opts.teams === undefined ? DEFAULT_TEAMS : opts.teams), tokenType: 'Bearer', expiresIn: 900, refreshToken: `refresh-token-${n}-`.padEnd(43, 'x') };
  };
  let live = '';
  const seen: { authorization: string | null }[] = [];
  server.use(
    http.post('/api/v1/auth/register', async ({ request }) => {
      const b = (await request.json()) as { email: string; displayName: string; password: string };
      if (b.email === 'taken@x.io') return problem(409, 'conflict', 'Conflict', 'That email is already registered');
      if (b.password.length < 12) return problem(400, 'validation-failed', 'Validation failed', 'The request body is not valid', { errors: [{ field: 'password', message: 'size must be between 12 and 72' }] });
      return HttpResponse.json({ id: 'user-1', email: b.email, displayName: b.displayName }, { status: 201 });
    }),
    http.post('/api/v1/auth/login', async ({ request }) => {
      const b = (await request.json()) as { password: string };
      if (b.password !== PASSWORD) return problem(401, 'unauthorized', 'Unauthorized', 'Invalid credentials');
      const p = pair();
      live = p.refreshToken;
      return HttpResponse.json(p);
    }),
    http.post('/api/v1/auth/refresh', async ({ request }) => {
      const { refreshToken } = (await request.json()) as { refreshToken: string };
      if (refreshToken !== live || used.has(refreshToken) || revoked.has(refreshToken)) {
        if (used.has(refreshToken)) revoked.add(live);
        return problem(401, 'unauthorized', 'Unauthorized', 'Invalid refresh token');
      }
      used.add(refreshToken);
      const p = pair();
      live = p.refreshToken;
      return HttpResponse.json(p);
    }),
    http.post('/api/v1/auth/logout', () => new HttpResponse(null, { status: 204 })),
    http.get('/api/v1/applications', ({ request }) => {
      seen.push({ authorization: request.headers.get('Authorization') });
      return HttpResponse.json({ items: [{ id: 'a1' }, { id: 'a2' }], nextCursor: null });
    }),
  );
  return { seen };
}

async function signIn(user: Awaited<ReturnType<typeof renderApp>>['user'], password = PASSWORD) {
  await user.type(await screen.findByLabelText('Email', { selector: 'input[name="email"]' }), 'ada@example.io');
  await user.type(screen.getByLabelText('Password', { selector: 'input[name="password"]' }), password);
  await user.click(screen.getByRole('button', { name: 'Sign in' }));
}

describe('Sign in screen', () => {
  beforeEach(() => { mode.value = 'hybrid'; });

  it('explains that it needs hybrid mode, and keeps the buttons off, in simulated mode', async () => {
    mode.value = 'mock';
    await renderApp('/login');
    expect(await screen.findByText('Sign-in needs hybrid mode')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled();
  });

  it('signs in and shows what the access token says', async () => {
    identity({ teams: { [TEAM]: ['deployment:create', 'deployment:read'] } });
    const { user } = await renderApp('/login');
    await signIn(user);

    const session = (await screen.findByRole('heading', { name: 'Session' })).closest('section')!;
    expect(within(session).getByText('ada@example.io')).toBeInTheDocument();
    expect(within(session).getByText('jti-1')).toBeInTheDocument();
    expect(within(session).getByText(`team ${TEAM}`)).toBeInTheDocument();
    expect(within(session).getByText('deployment:create')).toBeInTheDocument();
    expect(within(session).getByRole('timer')).toHaveTextContent(/^1[45]:\d\d$/);
    expect(within(session).getByText(/^refres\u2026 \(43 characters/)).toBeInTheDocument();
    expect(session.textContent).not.toContain('xxxxxxxxxx');   // the refresh token is masked
    expect(screen.getByText('Access token for 900 s, refresh token issued')).toBeInTheDocument();
  });

  it('says so when the token carries no grants', async () => {
    identity({ teams: null });
    const { user } = await renderApp('/login');
    await signIn(user);
    expect(await screen.findByText('No grants')).toBeInTheDocument();
  });

  it('shows a wrong password without opening a session, and logs the 401', async () => {
    identity();
    const { user } = await renderApp('/login');
    await signIn(user, 'not the password');
    expect(await screen.findByText('The email or the password is not right.')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Session' })).not.toBeInTheDocument();
    const log = screen.getByRole('list', { name: 'What happened' });
    expect(within(log).getByLabelText('Status 401')).toBeInTheDocument();
    expect(within(log).getByText('correlation id cid-unauthorized')).toBeInTheDocument();
  });

  it('shows a lockout with the seconds to wait, keeps sign-in off while it runs, and logs the 423', async () => {
    identity();
    server.use(http.post('/api/v1/auth/login', () => HttpResponse.json(
      { type: 'urn:appfleet:problem:locked', title: 'Locked', status: 423, detail: 'Too many failed sign-in attempts. Try again later.', correlationId: 'cid-locked' },
      { status: 423, headers: { 'Content-Type': 'application/problem+json', 'Retry-After': '30' } },
    )));
    const { user } = await renderApp('/login');
    await signIn(user);
    expect(await screen.findByText('Too many failed attempts')).toBeInTheDocument();
    expect(screen.getByText(/This email is locked for now, even with the right password\. Try again in 30 seconds\./)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeDisabled();
    expect(screen.queryByRole('heading', { name: 'Session' })).not.toBeInTheDocument();
    const log = screen.getByRole('list', { name: 'What happened' });
    expect(within(log).getByLabelText('Status 423')).toBeInTheDocument();
  });

  it('refreshes: a new token id, and the log says the old refresh token is used up', async () => {
    identity();
    const { user } = await renderApp('/login');
    await signIn(user);
    await screen.findByText('jti-1');
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    expect(await screen.findByText('jti-2')).toBeInTheDocument();
    expect(screen.queryByText('jti-1')).not.toBeInTheDocument();
    expect(screen.getByText(/the old refresh token is used up/)).toBeInTheDocument();
  });

  it('offers the replay only after a refresh, and shows the family being revoked', async () => {
    identity();
    const { user } = await renderApp('/login');
    await signIn(user);
    await screen.findByText('jti-1');
    expect(screen.getByRole('button', { name: 'Replay the used refresh token' })).toBeDisabled();

    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await screen.findByText('jti-2');
    await user.click(screen.getByRole('button', { name: 'Replay the used refresh token' }));

    expect(await screen.findByText('The refresh family was revoked')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Replay the used refresh token' })).toBeDisabled();
    // the newest token died with the family
    await user.click(screen.getByRole('button', { name: 'Refresh' }));
    await waitFor(() => expect(within(screen.getByRole('list', { name: 'What happened' })).getAllByLabelText('Status 401')).toHaveLength(2));
  });

  it('calls control-api with the access token as a bearer token', async () => {
    const { seen } = identity();
    const { user } = await renderApp('/login');
    await signIn(user);
    await screen.findByText('jti-1');
    await user.click(screen.getByRole('button', { name: 'Call control-api with this token' }));
    expect(await screen.findByText('Listed 2 application(s) on this page')).toBeInTheDocument();
    expect(seen).toHaveLength(1);
    expect(seen[0].authorization).toMatch(/^Bearer .+\..+\..+$/);
  });

  it('logs out, closes the session, and keeps the old access token for the denylist check', async () => {
    const { seen } = identity();
    const { user } = await renderApp('/login');
    await signIn(user);
    await screen.findByText('jti-1');
    await user.click(screen.getByRole('button', { name: 'Log out' }));

    expect(await screen.findByText('You are logged out')).toBeInTheDocument();
    expect(screen.queryByRole('heading', { name: 'Session' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try the logged-out access token on control-api' }));
    expect(await screen.findByText('Listed 2 application(s) on this page')).toBeInTheDocument();
    expect(seen).toHaveLength(1);
  });

  it('shows the field errors of a failed registration, and a conflict on the email', async () => {
    identity();
    const { user } = await renderApp('/login');
    await user.type(await screen.findByLabelText('Email', { selector: 'input[name="new-email"]' }), 'new@example.io');
    await user.type(screen.getByLabelText('Display name'), 'New User');
    await user.type(screen.getByLabelText('Password', { selector: 'input[name="new-password"]' }), 'short');
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('size must be between 12 and 72')).toBeInTheDocument();

    await user.clear(screen.getByLabelText('Email', { selector: 'input[name="new-email"]' }));
    await user.type(screen.getByLabelText('Email', { selector: 'input[name="new-email"]' }), 'taken@x.io');
    await user.clear(screen.getByLabelText('Password', { selector: 'input[name="new-password"]' }));
    await user.type(screen.getByLabelText('Password', { selector: 'input[name="new-password"]' }), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('That email is already registered.')).toBeInTheDocument();
  });

  it('registers, and fills the sign-in email', async () => {
    identity();
    const { user } = await renderApp('/login');
    await user.type(await screen.findByLabelText('Email', { selector: 'input[name="new-email"]' }), 'new@example.io');
    await user.type(screen.getByLabelText('Display name'), 'New User');
    await user.type(screen.getByLabelText('Password', { selector: 'input[name="new-password"]' }), PASSWORD);
    await user.click(screen.getByRole('button', { name: 'Create account' }));
    expect(await screen.findByText('Account created')).toBeInTheDocument();
    expect(screen.getByLabelText('Email', { selector: 'input[name="email"]' })).toHaveValue('new@example.io');
  });
});