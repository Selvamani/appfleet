import { useState, type FormEvent } from 'react';
import { apiMode, isApiError } from '../../api/http';
import { Button, Card, Columns, ErrorNotice, Notice, PageHeader, Stack, TextField, useCountdown } from '../../components';
import { useDocumentTitle } from '../../hooks/useDocumentTitle';
import { EventLog } from './EventLog';
import { SessionCard } from './SessionCard';
import { useLoginSession, type FormFailure } from './useLoginSession';
import s from './login.module.css';

/** The message for a failed form: field errors by field name, anything else as one sentence. */
function failureOf(failure: FormFailure | null, form: FormFailure['form']) {
  const mine = failure && failure.form === form ? failure.error : null;
  const fields: Record<string, string> = {};
  let general: string | null = null;
  /** Seconds the service asks us to wait (a 423 from the lockout), or null. */
  let lockedFor: number | null = null;
  if (isApiError(mine)) {
    if (mine.type === 'validation-failed') {
      for (const e of mine.errors) fields[e.field] = e.message;
    } else if (mine.type === 'unauthorized') {
      general = 'The email or the password is not right.';
    } else if (mine.type === 'locked') {
      lockedFor = mine.retryAfter ?? 1;
    } else if (mine.type === 'conflict') {
      fields.email = 'That email is already registered.';
    } else {
      general = null;
    }
  }
  return { error: mine, fields, general, lockedFor };
}

/**
 * Sign in (plan section 5, route /login), built against the real identity-service: register, sign in, refresh,
 * replay a used refresh token, log out, and call control-api with the access token. The tokens live in memory only.
 */
export function LoginPage() {
  useDocumentTitle('Sign in');
  const session = useLoginSession();
  const hybrid = apiMode === 'hybrid';

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [newEmail, setNewEmail] = useState('');
  const [newName, setNewName] = useState('');
  const [newPassword, setNewPassword] = useState('');

  const loginFail = failureOf(session.failure, 'sign in');
  const registerFail = failureOf(session.failure, 'register');
  /** Counts down the lockout the service reported. While it runs, signing in is pointless: the right password is refused too. */
  const lockLeft = useCountdown(loginFail.lockedFor);
  const locked = loginFail.lockedFor !== null && lockLeft > 0;

  const onSignIn = (e: FormEvent) => {
    e.preventDefault();
    void session.signIn(email.trim(), password);
  };

  const onRegister = async (e: FormEvent) => {
    e.preventDefault();
    const ok = await session.registerUser({ email: newEmail.trim(), displayName: newName.trim(), password: newPassword });
    if (ok) {
      setEmail(newEmail.trim());
      setPassword('');
      setNewPassword('');
    }
  };

  return (
    <>
      <PageHeader
        title="Sign in"
        subtitle="Register, sign in, refresh, log out and call control-api with the token, against the real identity-service."
      />

      {hybrid && (
        <p className={s.hint}>
          Only this screen uses the real identity-service. The role switch in the yellow bar and the &ldquo;you&rdquo; chip at the top right are still
          simulated, and so is every other screen except the control-api ones.
        </p>
      )}

      {!hybrid && (
        <Notice tone="info" title="Sign-in needs hybrid mode">
          <p>
            This screen talks to the real identity-service. Start it on port 8082 (profile <code>local</code>), start control-api on 8081,
            then run <code>npm run dev:hybrid</code>. In simulated mode nothing answers these endpoints, so the buttons are off.
          </p>
        </Notice>
      )}

      <Columns layout="two">
        <Stack>
          {session.tokens ? (
            <SessionCard
              tokens={session.tokens}
              email={session.email}
              previousRefresh={session.previousRefresh}
              familyRevoked={session.familyRevoked}
              busy={session.busy}
              onRefresh={() => void session.refresh()}
              onReplay={() => void session.replay()}
              onControl={() => void session.callControl(session.tokens!.accessToken, 'control-api')}
              onLogout={() => void session.signOut()}
            />
          ) : (
            <>
              {session.loggedOutAccess && (
                <Card title="You are logged out" titleId="login-after-title">
                  <Stack>
                    <Notice tone="success" title="Session ended">
                      <p>The refresh token is revoked and the access token you had is on the denylist. Try that old access token on control-api:</p>
                    </Notice>
                    <div className={s.actions}>
                      <Button
                        onClick={() => void session.callControl(session.loggedOutAccess!, 'control-api (logged-out token)')}
                        busy={session.busy === 'control-api (logged-out token)'}
                        disabled={session.busy !== null}
                      >
                        Try the logged-out access token on control-api
                      </Button>
                    </div>
                    <p className={s.hint}>
                      If control-api runs with <code>appfleet.security.jwt.denylist.enabled=true</code> the answer is 401. Without it the token
                      still works until it expires: that is the window the denylist closes.
                    </p>
                  </Stack>
                </Card>
              )}

              {session.forcedSignOut && (
                <Notice tone="warning" title="You were signed out">
                  <p>The service refused to refresh your session (it was revoked, it expired, or its refresh token was used twice), so this browser forgot it. Sign in again.</p>
                </Notice>
              )}

              <Card title="Sign in" titleId="login-signin-title">
                <form className={s.form} onSubmit={onSignIn} aria-labelledby="login-signin-title" noValidate>
                  <TextField
                    label="Email"
                    name="email"
                    type="email"
                    autoComplete="username"
                    value={email}
                    onChange={e => setEmail(e.target.value)}
                    error={loginFail.fields.email}
                    required
                  />
                  <TextField
                    label="Password"
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    value={password}
                    onChange={e => setPassword(e.target.value)}
                    error={loginFail.fields.password}
                    required
                  />
                  {loginFail.general && <Notice tone="warning" title="Could not sign in"><p>{loginFail.general}</p></Notice>}
                  {loginFail.lockedFor !== null && (
                    <Notice tone="warning" title="Too many failed attempts">
                      <p>
                        {locked
                          ? `This email is locked for now, even with the right password. Try again in ${lockLeft} ${lockLeft === 1 ? 'second' : 'seconds'}.`
                          : 'The lock has ended. You can try again.'}
                      </p>
                    </Notice>
                  )}
                  {loginFail.error !== null && loginFail.general === null && loginFail.lockedFor === null && Object.keys(loginFail.fields).length === 0 && (
                    <ErrorNotice error={loginFail.error} context="Could not sign in." />
                  )}
                  <div className={s.actions}>
                    <Button type="submit" variant="primary" disabled={!hybrid || locked || session.busy !== null || !email || !password} busy={session.busy === 'sign in'}>
                      Sign in
                    </Button>
                  </div>
                </form>
              </Card>

              <Card title="Create an account" titleId="login-register-title">
                <form className={s.form} onSubmit={e => void onRegister(e)} aria-labelledby="login-register-title" noValidate>
                  <TextField
                    label="Email"
                    name="new-email"
                    type="email"
                    autoComplete="off"
                    value={newEmail}
                    onChange={e => setNewEmail(e.target.value)}
                    error={registerFail.fields.email}
                    required
                  />
                  <TextField
                    label="Display name"
                    name="new-name"
                    autoComplete="off"
                    value={newName}
                    onChange={e => setNewName(e.target.value)}
                    error={registerFail.fields.displayName}
                    required
                  />
                  <TextField
                    label="Password"
                    name="new-password"
                    type="password"
                    autoComplete="new-password"
                    value={newPassword}
                    onChange={e => setNewPassword(e.target.value)}
                    hint="12 to 72 characters, and at most 72 bytes in UTF-8."
                    error={registerFail.fields.password}
                    required
                  />
                  {registerFail.error !== null && Object.keys(registerFail.fields).length === 0 && (
                    <ErrorNotice error={registerFail.error} context="Could not register." />
                  )}
                  {session.registered && (
                    <Notice tone="success" title="Account created">
                      <p>{session.registered.email} is registered. It has no team yet, so its token will carry no permissions (an administrator grants roles; that screen comes with the admin API).</p>
                    </Notice>
                  )}
                  <div className={s.actions}>
                    <Button type="submit" disabled={!hybrid || session.busy !== null || !newEmail || !newName || !newPassword} busy={session.busy === 'register'}>
                      Create account
                    </Button>
                  </div>
                </form>
              </Card>
            </>
          )}
        </Stack>
        <EventLog entries={session.log} />
      </Columns>
    </>
  );
}