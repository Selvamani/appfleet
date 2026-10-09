# Appfleet web console

React UI for the Appfleet control plane. It runs entirely on simulated APIs, so it works before most backend services exist, and it can call a running control-api for the endpoints that are built.

Design: [docs/design/ux/web-console-react-plan.md](../docs/design/ux/web-console-react-plan.md). Clickable wireframe it was built from: [docs/design/ux/appfleet-ux-preview.html](../docs/design/ux/appfleet-ux-preview.html).

## Run it

```bash
npm install
npm run dev            # http://localhost:5173, every API simulated in the browser (MSW)
npm run dev:hybrid     # built control-api endpoints go to localhost:8081; the rest stay simulated
npm test               # Vitest + Testing Library, against the same simulated APIs
npm run lint
npm run build          # typecheck, then production build in dist/
```

The yellow development bar switches the signed-in role (VIEWER, DEPLOYER, OPERATOR, ADMIN, AUDITOR). `?as=OPERATOR` in the address does the same. Navigation, actions and visible teams change with the role, because the simulated identity service issues team-scoped permissions the way identity-service will in S4.

## Sign in screen

`/login` (linked from the yellow bar as "Sign in (real identity)") is the one screen wired to the real identity-service: register, sign in, refresh, replay a used refresh token, log out, and call control-api with the access token. It needs hybrid mode and these services running:

```
docker compose up -d postgres redis
# identity-service on 8082:  SPRING_PROFILES_ACTIVE=local, run its jar from the identity-service directory
# control-api on 8081:       SPRING_PROFILES_ACTIVE=local   (add APPFLEET_SECURITY_JWT_DENYLIST_ENABLED=true to see a logged-out token refused)
npm run dev:hybrid
```

Signing in there starts a session for the **whole console** (hybrid mode): every request carries the access token, a 401 triggers one refresh and a retry, the permissions behind the navigation come from the token, and the shell shows Sign out. A development build keeps the session in `sessionStorage` across reloads; a production build never stores a token. Design notes, rules and screenshots: `docs/design/ux/web-console-sign-in.md`.
## Modes

| Mode | control-api endpoints that exist | Everything else |
|---|---|---|
| `mock` (default) | simulated | simulated |
| `hybrid` | passed through MSW to the Vite proxy, then to localhost:8081 | simulated, or 501 for views that would mix simulated and live data (dashboard, history, timeline) |

The proxy table is `proxy.config.ts`, unit-tested in `proxy.config.test.ts`. Two query-service paths sit under control-api prefixes and use regex rules placed first.

## Simulated backend

`src/mocks/db.ts` holds one seeded world and a clock. New deployments move PENDING → VALIDATING → DEPLOYING → HEALTHY in about 9 seconds; billing-api `2.5.0-rc1` fails permanently to show the dead-letter path; rollbacks finish after 5 seconds. Business rules are copied from control-api, including `uq_deployment_active_per_app_env`: an environment with a deployment that is not FAILED or ROLLED_BACK refuses a new one with 409. Read-side views lag writes by about 1.5 seconds and carry `asOf`, like a query-service projection.

Endpoints the backend does not have yet are marked "proposed" in `src/api/*.ts` with the gap number from the plan (§10.1).

## Layout

```
src/
  api/          the only code that calls fetch: http.ts (ApiError, correlation id, Idempotency-Key), one file per service, keys.ts
  auth/         permissions as data: can(permission, teamId), PermissionsProvider, usePermissions
  hooks/        useDeployment (polling policy), useCursorList, useIdempotentSubmit, useDocumentTitle
  components/   shared primitives; StatusChip is the only place a status gets a colour
  app/          router, shell, guards (no access renders the same page as not found)
  features/     one folder per screen
  mocks/        MSW handlers and the simulated backend
  styles/       tokens.css (every colour and size), global.css
  test/         MSW server for Node, renderApp() for full-app tests
```

## Conventions

- Screens switch on `ApiError.type` (the ProblemDetail slug), never on the message text.
- Every request sends a fresh `X-Correlation-Id`; every error notice shows it with a link to the audit trail.
- One `Idempotency-Key` per logical submission (`useIdempotentSubmit`); mutations are never retried automatically.
- Filters live in the URL. Lists page by cursor with "Load older", never page numbers.
- Colours and sizes come from `styles/tokens.css` only. The only media-query breakpoints are 760, 860, 1800 and 2400 px.
