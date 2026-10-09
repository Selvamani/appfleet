# web-console: the sign-in screen

Route `/login` (the plan's section 5 reserves it as `LoginPage`, "signed out"). Added 2026-10-07. It is a working screen against the real identity-service, built so that the identity steps I2 to I4 can be **seen**, not only tested.

## What it does

| Control | Calls | What it shows |
|---|---|---|
| Create an account | `POST /api/v1/auth/register` | field errors (400), a conflict on the email (409), "Account created" |
| Sign in | `POST /api/v1/auth/login` | the session card: user id, a live countdown to `exp`, the `jti`, issuer and audience, the **permissions per team** decoded from the token, the header, the refresh token masked |
| Refresh | `POST /api/v1/auth/refresh` | a new `jti` and a new refresh token; the old one is used up |
| Replay the used refresh token | the same call with the token Refresh just used | 401, and the notice that the service revoked the whole family (I3 theft detection) |
| Call control-api with this token | `GET /api/v1/applications` with `Authorization: Bearer` | the status control-api gives (200, or 403 when the token has no grants) |
| Log out | `POST /api/v1/auth/logout` | the session ends; the old access token is kept for the next button |
| Try the logged-out access token on control-api | `GET /api/v1/applications` | **200** while control-api's denylist is off (the window), **401** with `appfleet.security.jwt.denylist.enabled=true` (I4) |

The right-hand panel, "What happened", lists every call with its HTTP status, a one-line summary and the correlation id.

## Real and simulated

Only this screen uses the real identity-service. The yellow-bar role switch, the "you" chip, and every other screen except the control-api ones stay simulated (MSW). In simulated mode the screen explains how to start hybrid mode and keeps its buttons off.

## How it is built

- `src/api/auth.ts` returns the whole response (status and correlation id), because the screen logs each call.
- `src/api/http.ts` gained one option, `bearer`, which sets `Authorization: Bearer <token>`. Nothing else sends it yet; there is no global session.
- `src/lib/jwt.ts` decodes a JWT **without verifying it**: the console has no key and must not trust itself; the server decides what is valid.
- `src/features/login/`: `useLoginSession` (state and calls), `LoginPage`, `SessionCard`, `EventLog`.
- The tokens are kept in the hook's state only: not in `localStorage`, not in a cookie. This is stricter than the plan's section 8.7 (refresh token in an `HttpOnly` cookie), because identity-service currently returns the refresh token in the response body; moving it to a cookie is a decision for the real session layer, not for this screen.

## Tests

`LoginPage.test.tsx` (10 tests, hybrid mode switched on, the identity endpoints stubbed with MSW and a small model of its refresh rules), `jwt.test.ts` (6), and one `http.test.ts` case for the bearer header. The whole console suite: 138 tests, `tsc` and `eslint` clean.

## Checked by hand, 2026-10-07

Headless Chrome drove the real page (Vite hybrid on 5173, identity-service with logout on 8082, control-api on 8081, Postgres and Redis from compose). No uncaught errors in the page.

1. Register with a short password: 400 and the field error; then a valid one: 201 and "Account created".
2. Sign in as a user who is DEPLOYER on a team (the membership inserted by SQL; the admin API is I6): the session card lists `application:create`, `application:read`, `deployment:create`, `deployment:read` for that team, and a countdown from 15:00.
3. Refresh: the `jti` changed. Call control-api: 200.
4. Replay the used refresh token: 401, and the "refresh family was revoked" notice.
5. Log out: 204. The logged-out access token on control-api: **200** with the denylist off, and **401** (`WWW-Authenticate: Bearer error="invalid_token"`) after restarting control-api with the denylist on.

Screenshots: `../identity-service/ui/sign-in-1-signed-out.png`, `sign-in-2-session.png`, `sign-in-3-replayed.png`, `sign-in-4-logged-out-denylist-on.png`.

Note on the evidence: the identity-service used was the scratch build of step I4 (the user's tree had I3 when this ran), against a separate scratch database, so the logout was real but the code behind it is not yet in the repository's `identity-service`.

## Not done

- No global session: no token refresh in the background, no 401 handling across screens, no sign-in gate. This screen is a diagnostic, not the access layer.
- The shell's identity (`usePermissions`, the role switch) is still the mock; connecting it to the token's `teams` claim is the next step toward the plan's section 8.7.
- The refresh token is not in a cookie (see above).

## The global session (added 2026-10-07)

One sign-in now serves the whole console, in hybrid mode.

| Piece | What it does |
|---|---|
| `src/auth/session.ts` | the session store: access token, refresh token, decoded claims; `useSession()`, `startSession`, `endSession`, `signOut`, `refreshNow`, `initSession(mode)` |
| `src/api/http.ts` | attaches `Authorization: Bearer` to every request while a session exists; on a **401** asks the session for a new token and repeats the request **once** (a second 401 is the answer); the sign-in endpoints are `anonymous` and never trigger a refresh |
| `src/auth/sessionMe.ts` | builds `Me` from the token (`teams` and `perms`), so `usePermissions()`, the navigation and `can()` run on the real permissions; `teamsFromSession` for the team lists |
| `src/auth/PermissionsProvider.tsx`, `src/api/identity.ts` | with a session: no request, the token is the answer; without: the simulated identity, as before |
| `src/app/AppShell.tsx` | with a session: your email, "Teams: N" and a **Sign out** button, and the dev role switch steps aside; in hybrid mode without a session: a bar "You are not signed in, so control-api will refuse these calls. Sign in" |

**Rules that matter**

1. **One refresh at a time.** identity-service uses each refresh token once and treats a second use as theft (revokes the whole session). A burst of 401s, the timer that refreshes 60 seconds before expiry, and the Refresh button all share one in-flight refresh. A test sends three refused requests in parallel and asserts exactly one rotation.
2. **A refused refresh ends the session** (revoked, expired, or reused); **a network failure does not**, because nothing says the token was used.
3. **Where the tokens live.** In memory. In a **development** build only, a copy is kept in `sessionStorage` so a reload does not sign you out; production builds never write a token anywhere.
4. **Simulated mode is untouched:** no hooks, no token, the mock identity answers.

**What is real after signing in:** the permissions behind the navigation and the gates, the chips, and every control-api screen (Applications, releases, deployments). **Still simulated:** dashboard and history views, Tool sessions, Fleet, Access, Audit, and the list of users and teams.

**Tests:** 165 in the console (up from 138; one of them is the 423 lockout message added with identity step I5): `session.test.ts` (15: attach, retry once, one shared refresh, no loop, refused refresh ends the session, network failure keeps it, own bearer not retried, refresh before expiry with fake timers, sign-out, dev persistence and restore, damaged copy ignored, simulated mode inert), `sessionMe.test.ts` (5), `AppShell.session.test.tsx` (6: the bar, simulated mode silent, chips and sign-out button, navigation from the token, nothing shown without grants, sign-out lands on `/login`), plus the existing 138. `tsc` and `eslint` clean.

**Checked by hand in headless Chrome (2026-10-07)**, against the live stack (Vite hybrid, identity-service with logout, control-api, Postgres, Redis):

1. Not signed in on `/applications`: the bar, and the list refused (401).
2. Sign in once on `/login`: chips "Teams: 1", `demo@example.io`, "Sign out".
3. Client-side navigation to Applications: the real `demo-app` is listed, with owner "Team 4f0928f2".
4. Reload the page: still signed in, `demo-app` still listed.
5. Tamper with the stored access token and reload: the network shows `GET /api/v1/applications` (bearer) refused, then `POST /api/v1/auth/refresh`, then `GET /api/v1/applications` (bearer) again, and `demo-app` is listed. The console recovered by itself.
6. Sign out from the shell: lands on `/login`, the bar is absent there and back on `/applications`, the stored session is gone.

One uncaught error appeared in that run: `Failed to update a ServiceWorker ... mockServiceWorker.js`, a headless-Chrome service-worker update check racing a navigation (the script is served with 200); it is not from the session code, and the earlier sign-in run had none.

Screenshots: `../identity-service/ui/session-1-not-signed-in.png`, `session-2-applications-real-data.png`.