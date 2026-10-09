# web-console — React port of the UX preview, the plan

**Source:** [appfleet-ux-preview.html](appfleet-ux-preview.html) (open in a browser) · **Requirements:** [06-BUSINESS-REQUIREMENTS.md](../../specs/project/06-BUSINESS-REQUIREMENTS.md) · **API conventions:** [control-api-s3-rest.md](../control-api/control-api-s3-rest.md) · **Status: plan, not yet implemented. No React code exists.**

The UX preview is a clickable wireframe of eight screens. It will be rebuilt as a React application. This doc fixes what carries over from the preview, the stack, the component and route structure, how each screen gets its data, and the order of work against the backend slices. Each phase in section 9 gets its own short design doc before it is built, the same discipline as control-api.

## 1. Scope

In scope:

- A single-page React app, `web-console`, implementing the eight preview screens and the screens the preview is missing (section 10.2).
- Calling the existing REST APIs through a dev proxy, and through nginx in docker compose later.

Not in scope:

- Backend changes. Endpoints the UI needs but that do not exist are listed in section 10.1 as gaps. Each one is decided in its owning service's design doc, not here.
- A design system or visual design pass. The wireframe's look is a placeholder.

**Scope change to confirm.** [06-BUSINESS-REQUIREMENTS.md §5](../../specs/project/06-BUSINESS-REQUIREMENTS.md) and the "What NOT to build" list in SPRING-PROJECT.md both say *no UI*. Building `web-console` reverses that. See question 1 in section 11.

## 2. What carries over from the preview, and what does not

| Carries over | Does not carry over |
|---|---|
| The eight screens, their flows and their states (409 conflict, 202 accepted, rollback rules, not-found for no access) | The `innerHTML` template strings and the global `state` object |
| The copy: every message, warning and empty state | The `data-act` click delegation and manual focus restore |
| Design tokens: the `:root` custom properties and the type scale | The yellow preview bar. It becomes a dev-only role switch (section 8.8) |
| Breakpoints and responsive layout (section 8.9) | Hash routing (`#fleet`). React uses real paths (section 5) |
| Sample data. It becomes MSW fixtures, reshaped to the real DTOs (section 7) | Sample data field names. The preview uses arrays; fixtures use the DTO records |
| Accessibility choices: real `<button>`, labels, `aria-pressed`, `aria-current` | — |

Rule: the preview is the **spec for behaviour and copy**, not code to port line by line.

## 3. Stack

Use the current stable major of each at scaffold time, and check before pinning.

| Concern | Choice | Why |
|---|---|---|
| Build | Vite, React, TypeScript (`strict`) | Fast dev server with a built-in proxy (section 4.2). Plain SPA, no server rendering needed for an internal console |
| Routing | React Router | Nested layouts match the shell + page structure. Route params replace the preview's hash routes |
| Server state | TanStack Query | Polling while a deployment is in flight (`refetchInterval`), cursor pages (`useInfiniteQuery`), cache invalidation after mutations. This is most of the app's state |
| Client state | `useState` plus URL search params | Filters live in the URL so links are shareable. No Redux: there is almost no client-only state |
| Styling | CSS Modules plus one global `tokens.css` | The preview's CSS moves over almost unchanged. No runtime cost, no new vocabulary |
| API types | `openapi-typescript`, generated from control-api's OpenAPI (S3.7) | Types follow the Java records. Until S3.7, hand-write them in one `api/types.ts` |
| API mocking | MSW (Mock Service Worker) | The UI can be built ahead of each backend slice against the preview's sample data, and the same handlers serve the tests |
| Unit and component tests | Vitest, React Testing Library | Same runner as Vite |
| End-to-end | Playwright, for two or three flows only | Deploy → follow → roll back; role gating; 409 conflict |
| Lint | ESLint with `eslint-plugin-jsx-a11y`, Prettier | Keeps the preview's accessibility from regressing |

Rejected: Tailwind (rewrites every class in the preview for no behavioural gain), Redux (no client state worth it), Next.js (no server rendering need; adds a Node server to the deployment).

## 4. Repo placement and build

### 4.1 Layout

A new top-level folder `web-console/`, beside `control-api/`. It is an npm project, not a Maven module.

```
web-console/
  src/
    app/          AppShell, router, providers (QueryClient, auth)
    api/          http.ts (fetch wrapper), types.ts, one file per service: control.ts, query.ts, identity.ts, sessions.ts
    components/   primitives shared by every page (section 6.2)
    features/     one folder per screen: dashboard/, applications/, deployments/, sessions/, fleet/, access/, audit/
    mocks/        MSW handlers + fixtures (from the preview's sample data)
    styles/       tokens.css, global.css
  e2e/            Playwright
```

### 4.2 Dev proxy

No API gateway exists, and "What NOT to build" rules one out. In dev, the Vite proxy routes by path:

| Path | Service | Port |
|---|---|---|
| `/api/v1/applications`, `/api/v1/deployments`, `/api/v1/tasks`, `/api/v1/catalogue` | control-api | 8081 |
| `/api/v1/auth`, `/api/v1/users`, `/api/v1/teams`, `/api/v1/roles`, `/api/v1/service-accounts`, `/api/v1/audit/logins` | identity-service | 8082 |
| `/api/v1/sessions` | node-agent | 8084+ |
| `/api/v1/dashboard`, `/api/v1/fleet`, `/admin/projections` | query-service | 8085 |
| `/api/v1/dlq` | task-service | not fixed in the spec |

**Collision to handle:** query-service owns `/api/v1/applications/{id}/history` and `/api/v1/deployments/{id}/timeline`, which sit under control-api's prefixes. These two need regex rules placed before the prefix rules (`^/api/v1/applications/[^/]+/history`, `^/api/v1/deployments/[^/]+/timeline`). Plain prefix matching sends them to the wrong service. Write a proxy test for both.

In docker compose (phase 6), nginx serves the built `dist/` and applies the same routing table.

## 5. Routes

| Preview | Preview hash | React route | Page | Who sees it |
|---|---|---|---|---|
| 1 Dashboard | `#dashboard` | `/` | `DashboardPage` | everyone, filtered to their teams |
| — | — | `/applications` | `ApplicationsPage` (missing from the preview) | everyone |
| 2 Application detail | `#application` | `/applications/:applicationId` | `ApplicationPage` | everyone with a grant on the owning team |
| 3 New deployment | `#deploy` | `/applications/:applicationId/deploy` | `DeployPage` | `deployment:create` on the owning team |
| 4 Deployment timeline | `#deployment` | `/deployments/:deploymentId` | `DeploymentPage` | everyone with a grant on the owning team |
| 5 Tool sessions | `#sessions` | `/sessions` | `SessionsPage` | everyone |
| 6 Fleet and DLQ | `#fleet` | `/fleet` | `FleetPage` | OPERATOR, ADMIN |
| 7 Access | `#access` | `/access`, `/access/users/:userId` | `AccessPage` | ADMIN |
| 8 Audit trail | `#audit` | `/audit?actor=&action=&cid=…` | `AuditPage` | `audit:read` |
| — | — | `/login` | `LoginPage` (missing from the preview) | signed out |
| — | — | `*` | `NotFoundPage` | — |

Rules:

- **No access and no such page render the same `NotFoundPage`.** This matches the API decision in [control-api-s3-rest.md §3.2](../control-api/control-api-s3-rest.md): a caller without permission gets 404, so the UI never confirms what exists.
- Filters (dashboard status, audit filters) live in search params, not component state.
- The dashboard row "Open" link becomes a plain link to `/deployments/:id`. The preview's trick of copying row data into shared state goes away; the page fetches by id.

## 6. Components

### 6.1 Layout

| Preview CSS | Component | Notes |
|---|---|---|
| `.shell` | `AppShell` | Sidebar plus content column. The router outlet renders inside it |
| `.side`, `.nav` | `SideNav` | Items filtered by `usePermissions()`. Active item via `NavLink`, which sets `aria-current` |
| `.top` | `TopBar` | Search, team-scope pill, user pill |
| `.head`, `.crumb`, `.h1`, `.sub` | `PageHeader` | Props: `title`, `subtitle`, `breadcrumbs`, `actions` |
| `.card`, `.cardhead` | `Card` | Props: `title`, `aside`, `children` |
| `.wide-2`, `.two`, `.split`, `.three`, `.tiles` | `Columns` | One component with a `layout` prop instead of five classes |

### 6.2 Primitives

| Preview CSS | Component | Props and rules |
|---|---|---|
| `.btn` `.pri` `.sm` `.on` | `Button`, `ButtonLink` | `variant: 'default' \| 'primary'`, `size`, `pressed`. A link styled as a button stays an `<a>` |
| `.chip` + `CHIP` map | `StatusChip` | `status`, optional `label`. **The status-to-tone map lives in one module (`statusTone.ts`)** and `StatusChip` is its only consumer |
| `.pill` | `Pill` | — |
| `.card` + `.tile-val` | `StatTile` | `label`, `value`, `detail` |
| `.rows`, `.row`, `.th`, `--cols`, `--minw` | `DataTable` | `columns: { key, header, width, render }[]`, `rows`, `minWidth`, optional `onSelect` (renders rows as `<button aria-pressed>`, as in Access and Audit). `width` takes the preview's `minmax(…)` strings unchanged |
| `.note`, `.warn`, `.okbox` | `Notice` | `tone: 'info' \| 'warning' \| 'success'`. Warning uses `role="alert"`, success uses `role="status"` |
| `.field`, `.lbl` | `TextField`, `SelectField` | Always a `<label>`. Shows server field errors (section 8.1) |
| `.opt` | `RadioCard` | Native radio inside a label |
| `.envbtn` | `ToggleCard` | `<button aria-pressed>` |
| `.steps`, `.step-*` | `Stepper` | `steps`, `current`, `failedAt` |
| `.timeline` | `Timeline` | — |
| `.dl` | `DetailList` | `items: [term, value][]` |
| `.empty` | `EmptyState`, `NotFoundPage` | — |
| — | `Freshness` | Renders the read model's `asOf` and lag (section 8.5) |

### 6.3 Feature components

| Screen | Components |
|---|---|
| Dashboard | `StatTiles`, `WhatRunsWhere`, `RecentDeployments` (status filter + `DataTable` + "Load older") |
| Applications | `ApplicationList`, `EnvironmentCard`, `ReleaseTable`, `RegisterReleaseForm`, `ApplicationHistory` |
| Deploy | `DeployForm` (`RadioCard` releases, `ToggleCard` environments, review, conflict warning), `AfterSubmitHelp` |
| Deployment | `DeploymentProgress` (`Stepper` + other outcomes), `TaskAttempts`, `DeploymentTimeline`, `DeploymentDetails`, `RollbackButton` |
| Sessions | `SessionList`, `CatalogueGrid`, `CatalogueSearch` |
| Fleet | `NodeTable`, `StuckTasks`, `DeadLetterTable`, `ProjectionTable` |
| Access | `UserList`, `UserDetail`, `GrantTable`, `AddGrantForm`, `EffectivePermissions`, `ServiceAccountTable` |
| Audit | `AuditFilters`, `AuditEventTable`, `CorrelationWalk` |

### 6.4 Hooks

| Hook | Does |
|---|---|
| `usePermissions()` | `can(permission, teamId?)`, `role`, `teams`. Read from the access token's claims (section 8.7) |
| `useDeployment(id)` | `GET /deployments/{id}` with the polling policy in section 8.4 |
| `useCursorList(key, fetchPage)` | Wraps `useInfiniteQuery` for every `?cursor=` endpoint |
| `useIdempotentSubmit()` | Holds one `Idempotency-Key` per logical submission (section 8.3) |

## 7. Data: what each screen calls

"Exists" was checked against the controllers on this branch.

| Screen | Needs | Endpoint | Status |
|---|---|---|---|
| Dashboard | tiles, recent deployments, filters | `GET /api/v1/dashboard/deployments?cursor=&status=&teamId=` | query-service, S6 |
| Dashboard | what runs where | none in any spec | **gap** |
| Applications | list | `GET /api/v1/applications?cursor=&limit=` | exists |
| Application detail | application | `GET /api/v1/applications/{id}` | exists |
| Application detail | releases of one application | only `GET /api/v1/applications/{id}/releases/{releaseId}` | **gap: no list** |
| Application detail | current release and state per environment | none | **gap** (query-service read model) |
| Application detail | history, success rate | `GET /api/v1/applications/{id}/history` | query-service, S6 |
| Register release | create | `POST /api/v1/applications/{id}/releases` | exists |
| Deploy | environments to choose from | none (environment is a free string in `CreateDeploymentRequest`) | **gap** |
| Deploy | submit | `POST /api/v1/deployments` + `Idempotency-Key` → 202 `DeploymentAccepted {deploymentId, taskId, status}` | exists |
| Deployment | deployment | `GET /api/v1/deployments/{id}` → `DeploymentResponse` | exists |
| Deployment | tasks | `GET /api/v1/deployments/{id}/tasks?cursor=` | exists |
| Deployment | attempts per task | none in control-api (Attempt is owned by task-service) | **gap** |
| Deployment | timeline | `GET /api/v1/deployments/{id}/timeline` | query-service, S6 |
| Deployment | roll back | `POST /api/v1/deployments/{id}/rollback` → 202 `RollbackAccepted` | exists |
| Sessions | catalogue | `GET /api/v1/catalogue/images` | control-api spec, not built |
| Sessions | start, read, end one session | `POST`, `GET /{id}`, `DELETE /{id}` on `/api/v1/sessions` | node-agent, S5 |
| Sessions | list my sessions | none (spec has `GET /{id}` only) | **gap** |
| Fleet | nodes, heartbeats, sessions | `GET /api/v1/fleet` | query-service, S6 |
| Fleet | drain a node | none (`node:drain` permission exists, endpoint does not) | **gap** |
| Fleet | dead-letter list | none | **gap** |
| Fleet | replay | `POST /api/v1/dlq/{taskId}/replay` | task-service, S7 |
| Fleet | projection lag, rebuild | lag: none; rebuild: `POST /admin/projections/{name}/rebuild` | **gap** for lag; rebuild S6 |
| Access | users, roles, teams, grants | `/api/v1/users`, `/roles`, `/teams`, `POST /teams/{id}/members` | identity-service, S4 |
| Access | service accounts | `POST /service-accounts` (create only) | **gap: list and rotate** |
| Audit | sign-in events | `GET /api/v1/audit/logins?cursor=` | identity-service, S4 |
| Audit | all other audit events, by correlation id | none | **gap** |

Fixture rule: MSW fixtures use the exact DTO shapes above (`DeploymentResponse`, `TaskResponse`, `ApplicationResponse`, `ReleaseResponse`), with UUIDv7 ids. Where the endpoint is a gap, the fixture shape is a proposal and is marked so in the fixture file.

## 8. Cross-cutting behaviour

### 8.1 Errors

All services return RFC 7807 `ProblemDetail`. `api/http.ts` turns every non-2xx into one `ApiError { status, type, title, detail, correlationId, errors? }`. Screens switch on `type`, never on `detail` text.

| `type` slug | UI treatment |
|---|---|
| `validation-failed` | Map `errors[]` onto form fields by `field`; focus the first one |
| `malformed-request` | Generic "something went wrong" notice with the correlation id. It is a client bug |
| `unprocessable` | Inline warning with `detail` |
| `not-found` | `NotFoundPage` for a page load; inline notice for an action |
| `illegal-transition`, `conflict`, `concurrent-modification` | Inline warning plus a "Refresh" action that refetches the resource |
| `request-in-progress` | Retry automatically once after `Retry-After`, keeping the same idempotency key |
| `idempotency-key-reused` | Treat as a client bug: new key, report it |
| `rate-limited` | Disable the submit button and count down `Retry-After` |
| `service-unavailable` | Banner with retry after `Retry-After` |

### 8.2 Correlation id

The fetch wrapper sends `X-Correlation-Id` (a fresh UUID) on every request and keeps the value the server echoes. Every error notice shows it with a copy button and a link to `/audit?cid=…`. This is the UI half of FR-6.1.

### 8.3 Idempotency

`useIdempotentSubmit()` creates one key per logical submission and reuses it for every retry of that submission. Changing any form input creates a new key. This is what makes the preview's copy true: "Submitting the same request again returns this deployment. It will not deploy twice." The mutation has TanStack Query's automatic retry turned off; retries go through the hook only.

### 8.4 Polling

`useDeployment(id)` polls `GET /deployments/{id}`:

| State | Interval |
|---|---|
| PENDING, VALIDATING, DEPLOYING, or a rollback requested | 2 s |
| HEALTHY, DEGRADED | 30 s (these can still change) |
| FAILED, ROLLED_BACK | stop (final in the FSM) |

Polling pauses while the tab is hidden. When the server supports it, this moves to the read side; the hook's interface does not change.

### 8.5 Read-model staleness

Every query-service response carries `asOf`. `Freshness` shows it. After a write to control-api, a page that reads from query-service shows "Updating…" until `asOf` is later than the write, instead of showing the old value as current. This is FR-5.3 in the UI.

### 8.6 Cursor pagination

Every `?cursor=` list uses `useCursorList` with a "Load older" button, as in the preview. No page numbers. The offset endpoint (`/tasks/by-offset`) exists only for the benchmark and is never called by the UI.

### 8.7 Authentication and permissions (from S4)

- Access token in memory only. Refresh token in an `HttpOnly`, `Secure`, `SameSite=Strict` cookie set by identity-service, rotated on every refresh. The token is not stored in `localStorage`, where any script on the page can read it.
- `usePermissions()` reads the scoped grants from the access token's claims.
- **UI gating is convenience, not security.** Hiding a button never replaces the server check. The IDOR exercise in S4 is the reason this rule is written down.
- A revoked grant (NFR-6, under 5 min) shows up as a 404 from the API. The UI then refetches the token and its permissions.

### 8.8 Role preview in development

The preview's "Preview as" becomes a dev-only switch: in MSW mode, `?as=OPERATOR` makes the mock identity handler issue a token with that role. It is compiled out of production builds.

### 8.9 Responsive layout

Target: 1366 to 2560 px wide (laptop, Full HD, 2K), still usable on a phone. The values below come from the preview and were checked in headless Chrome at 1366, 1920 and 2560.

| Breakpoint | Change |
|---|---|
| `< 760px` | Sidebar becomes a horizontal scrolling bar |
| `< 860px` | Two-column layouts (`two`, `split`) stack |
| `>= 1800px` (Full HD) | Root font 15px; paired sections sit side by side (`wide-2`) |
| `>= 2400px` (2K) | Root font 16px |

All sizes in `tokens.css` and the CSS modules are `rem`, so the root font size scales the whole UI. CSS custom properties cannot be used inside media queries, so the four breakpoint values are written as constants in one file, `styles/breakpoints.css`, and copied nowhere else. Tables keep a `minWidth` and scroll sideways inside their card instead of squashing columns.

## 9. Order of work

Each phase follows the backend slice it depends on, so the UI never blocks a backend slice. Phase 1 needs no backend at all.

| Phase | After | Builds | Done when |
|---|---|---|---|
| **P1 Foundation** | nothing | Scaffold, `tokens.css`, primitives, `AppShell`, router, MSW fixtures from the preview, all eight screens on MSW | Screenshots match the preview at 1366, 1920 and 2560 |
| **P2 control-api live** | S3.7 (OpenAPI) | Generated types, `http.ts` (correlation id, `ApiError`), applications list and detail, register release, deploy with idempotency, deployment detail with tasks, polling and rollback | Deploy → follow → rollback works against a running control-api |
| **P3 Identity** | S4 | `LoginPage`, token handling, `usePermissions`, route guards, Access screen, sign-in audit | IDOR check: a Payments DEPLOYER gets `NotFoundPage` for a Search application |
| **P4 Sessions and fleet** | S5 | Sessions screen, fleet nodes | Launch → Starting → Running against a running node-agent |
| **P5 Read side** | S6 | Dashboard, application history, deployment timeline, `Freshness`, projection rebuild | Dashboard reads from query-service and shows `asOf` |
| **P6 Operations** | S7 | DLQ replay, nginx in compose, Playwright in CI | `docker compose up` serves the console |

## 10. What the preview exposed

### 10.1 Backend gaps

Each needs a decision in its owning service's design doc. The recommendation is the smallest endpoint that serves the screen.

1. **Releases of an application** — control-api: `GET /api/v1/applications/{id}/releases?cursor=`. Needed in P2.
2. **Environments** — control-api: `GET /api/v1/environments`. Today environment is a free string. A UI cannot offer a free string as a picker. Needed in P2.
3. **What runs where, and current state per environment** — query-service: one read model keyed by (application, environment), the window-function query from S1 ("latest deployment per app per env") as its source. Needed in P5.
4. **Attempts per task** — task-service owns `Attempt`. Either task-service exposes `GET /api/v1/tasks/{id}/attempts`, or query-service projects attempts into `task_timeline` (already in its spec). Recommendation: query-service, so the UI does not call task-service directly.
5. **My sessions** — node-agent: `GET /api/v1/sessions` (the caller's own). Needed in P4.
6. **Drain a node** — node-agent or control-api: `POST /api/v1/nodes/{id}/drain`.
7. **Dead-letter list** — task-service: `GET /api/v1/dlq?cursor=`, next to the replay endpoint.
8. **Projection lag** — query-service: expose the existing Micrometer gauge through a small read endpoint, or show it from actuator.
9. **Service accounts: list and rotate** — identity-service.
10. **Audit read side** — no service serves audit reads except sign-ins. Recommendation: query-service projects audit events and serves `GET /api/v1/audit?actor=&action=&cid=&cursor=`.
11. **Upgrading an environment is refused** (found while building the console, 2026-10-02). `uq_deployment_active_per_app_env` in `V1__init.sql` covers every status except FAILED and ROLLED_BACK, so a HEALTHY deployment blocks any new deployment to the same environment with 409. The only way to ship 2.4.0 over a HEALTHY 2.3.1 today is to roll 2.3.1 back first, which means downtime. Options for control-api's next design doc: a SUPERSEDED final state that the new deployment's success moves the old one into, or narrowing the index to the in-flight states (PENDING, VALIDATING, DEPLOYING). The console's simulated backend copies today's rule exactly and explains it on the deploy screen.

### 10.2 Screens the preview does not have

- Sign-in, sign-out, session expired (P3).
- Applications list and create application (P2).
- Profile and password change (FR-3.5, P3).
- Rate-limited (429) and service-unavailable (503) states on every form (P2).

## 11. Open questions (yours to decide)

Each has a recommendation so the answer can be one word.

1. **Scope.** A UI is listed as out of scope. Recommendation: allow it as a separate track. Run P1 now on MSW, and start each later phase only after its backend slice is green. Update §5 of the business requirements to say "a thin console, built after the API it calls".
2. **Who writes the React code.** Recommendation: same workflow as control-api. A short design doc per phase, you implement, I review and run it.
3. **Repo location.** Recommendation: top-level `web-console/`, an npm project outside the Maven reactor.
4. **Styling.** Recommendation: CSS Modules plus `tokens.css` (section 3).
5. **Token storage.** Recommendation: access token in memory, refresh token in an `HttpOnly` cookie (section 8.7). This needs identity-service to set the cookie; settle it in the S4 doc.
6. **Routing in compose.** Recommendation: nginx with the section 4.2 table. A Spring Cloud Gateway is listed under "What NOT to build".

### Decisions taken (2026-10-02)

The user answered question 2 differently from the recommendation: Claude writes the UI code on its own; backend code still follows the user-implements workflow. The other five recommendations were taken as they stand: the UI track runs now on simulated APIs (1), in `web-console/` (3), with CSS Modules and tokens (4); token storage (5) and nginx (6) are settled when S4 and S7 arrive.

Versions at scaffold time: React 19.3, React Router 8.4, TanStack Query 5.104, Vite 8.3, MSW 3.0, Vitest 5.0, TypeScript 6.0 (7.0 exists, but typescript-eslint supports up to 6.0), ESLint 9 (eslint-plugin-jsx-a11y supports up to 9).

Two refinements to sections above:

- **Two modes, not one.** `mock` simulates every API. `hybrid` sends the built control-api endpoints to a running control-api and keeps simulating identity, node-agent and task-service. Read-side views that would put simulated rows next to live ones (dashboard, application history, deployment timeline, gaps 1 to 3) answer 501 in hybrid mode, and each screen says which service it is waiting for.
- **The development role switch stays in a mock-mode production build**, so a built `dist/` can be shown without any backend. It is absent from a hybrid build.

## 12. Definition of done for P1

- [x] `web-console/` scaffolded; `npm run dev`, `npm test` and `npm run build` pass (in this working tree; a fresh-clone run is still to do)
- [x] `tokens.css` holds every colour, size and the type scale from the preview; no hex values in component CSS (checked by grep)
- [x] Every shared primitive has a test (`src/components/components.test.tsx`, plus the feature tests that use them)
- [x] All eight screens render on MSW handlers shaped like the real DTOs, plus Applications list and Register application
- [x] Unknown route and no-permission route both render `NotFoundPage` (tested for fleet, access, audit)
- [x] Dev role switch (`?as=`) works; kept in mock-mode builds by decision (see Decisions taken), absent from hybrid builds
- [x] Screenshots checked at 390, 1366, 1920 and 2560
- [x] `eslint-plugin-jsx-a11y` passes with no disabled rules

### Results (2026-10-02)

- 121 tests in 18 files green, stable over repeated runs; typecheck, lint and production build clean. One chunk per screen.
- `request-in-progress` is retried once after Retry-After with the same key (`retryIfInProgress` in `src/api/http.ts`), as section 8.1 asks; the simulated backend keeps a new key IN_PROGRESS for 400 ms so the path is exercised.
- Hybrid mode checked against a live control-api on the dev database (local profile): the applications list, an application, a real HEALTHY deployment with its tasks paged by cursor, and a rejected `POST /applications` whose 400 `validation-failed` lands on the Name field. No rows were written. The gap endpoints answered 501 and each screen named the missing service.
- More gaps found while building, for the owning services' docs:
  - The read model does not say a rollback is pending, so after a reload Roll back is offered again (the API's 409 handles it). Proposal: `rollbackRequested` on the where view.
  - `DeploymentResponse` carries no `requestedBy`, so in hybrid mode the deployment subtitle has no name.
  - The fleet view has no dead-letter count; the audit read has no time-range filter; sign-in history has no `asOf`.
  - Under gap 11's rule, a "latest FAILED next to an older active deployment" cell cannot occur, so that UI path is only covered by a stubbed test.

## 13. Integration with identity-service and control-api (2026-10-07)

The console now speaks the real identity model (one role per user per team, roles as data, the eight real permissions) and
works against the live identity-service and control-api in hybrid mode. Mock mode mirrors the same shapes and rules, so
one console serves both.

What changed:

1. Screen-level permissions are answered by the eight real permissions (`REAL` in `auth/permissions.ts`). The audit trail
   and the user list belong to platform administrators (`user:manage` in the platform team).
2. New Account screen at `/account`: rename, password change (ends every session, so the console signs out), user id (an
   administrator needs it to add the user to a team), teams with the permissions in the token.
3. Access screen rewritten: users with grants (derived from the members of each team), grants per team with role change and
   removal, teams and members, roles, service accounts per team with keys shown once.
4. Sign-ins view of the audit trail reads `/api/v1/audit/logins` (event, who, outcome, source IP).
5. Hybrid mode: with a real sign-in, identity calls pass through to identity-service; without one the simulation answers.
6. Mock rollback needs OPERATOR, as in control-api.

Verified live (headless Chrome, real jars): sign in, dashboard and fleet gaps shown honestly, Access and Audit against the
real data, Account, register application, register release, deploy (202, PENDING), the same request again ("already
accepted", same deployment), deployment page with the PENDING step and the disabled Roll back. 169 tests pass.

Known gaps, all on the backend side:

1. No list endpoints for releases, environments and deployments: the deploy page asks for the release id and environment name.
2. Team names are visible to platform administrators only; everyone else sees `Team <8 characters of the id>`.
3. Deployments stay PENDING until task-service and node-agent exist.
4. Dashboard, history, timeline and fleet need query-service.
