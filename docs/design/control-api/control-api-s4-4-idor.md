# control-api — S4.4: the IDOR, built first and then closed

**Spec:** [01-CONTROL-API.md §S4](../../specs/project/01-CONTROL-API.md) — *"Build the IDOR first: the deploy endpoint checks the permission only. Write the exploit test — deployer on Team A deploys Team B's application. Then add the object-level check and watch the exploit fail"* · Step **S4.4** of [control-api-s4-plan.md](control-api-s4-plan.md) · Predecessors: [control-api-s4-3-method-security.md](control-api-s4-3-method-security.md) (one permission per endpoint; section 9.6 names this gap), [control-api-s4-1-jwt-validation.md](control-api-s4-1-jwt-validation.md) (the `teams` claim). **Status: designed 2026-10-05, all open questions decided (section 8), built and closed 2026-10-05.**

After S4.3 a caller needs the right *kind* of permission for an endpoint. Nothing yet asks whether the caller holds it for **this object's team**. A user who may deploy for the Payments team can deploy the Search team's application, read its deployments, roll them back and list it. That is an insecure direct object reference (IDOR): the caller names an object by id, and the server trusts the id.

This step first **proves the hole with failing tests against the S4.3 code**, then closes it, and keeps the tests.

## 1. What already exists

- **The hole's cause, in one line.** `AppfleetJwtAuthenticationConverter` flattens `teams: {A: [deployment:create], B: [deployment:read]}` into the two authorities `deployment:create` and `deployment:read`, and forgets which team granted which. `hasAuthority('deployment:create')` is therefore true for an object of *any* team. The token itself is fine: the raw claim is still on `JwtAuthenticationToken.getToken()`.
- **`Application.ownerTeamId`** (UUID, no `Team` table) is the only ownership fact. A `Deployment` reaches it through `deployment.application`, a `Task` through `task.deployment.application`, a `Release` through `release.application`. Environments have no owner and are not part of this step.
- **No endpoint compares anything with the token's teams.** Services take `String actor` (S4.2) and know nothing else about the caller.
- **404 is already the S3 rule for "not found",** and the plan's decision 5 says a caller must not be able to tell *another team's object* from *no such object*. Body references that do not resolve are **422** (S3.3), for example `POST /deployments` with an unknown `applicationId`.
- **The default test token** holds all five permissions on one team, `TestAuth.TEAM`. `TestFixtures.fixture()` creates every application with a **random** `ownerTeamId`, and several tests create applications through the API with random owners. After this step those objects belong to a team the test caller is not in (section 5, 1).
- **`GET /applications`** returns every application, cursor-paged by id (`findAllByOrderByIdAsc`, `findByIdGreaterThanOrderByIdAsc`).
- **`TaskService.requireDeployment`** answers `existsById` and nothing else; `GET /tasks/{id}` loads the task with no look at its deployment.

## 2. Behaviour

The rule, one sentence: **a caller may perform an action on an object only if the token grants that permission for the object's owning team, or grants it globally.**

"Grants for a team" is `teams[<ownerTeamId>]` containing the permission. "Globally" is the token's `perms` list containing it (the S4.1 "global role" case: a platform operator). Both are read from the validated token, never from the request.

| Operation | Needs (for the object's team) | Not allowed, because the object is another team's |
|---|---|---|
| `POST /applications` | `application:create` for the **body's** `ownerTeamId` | **403**: nothing exists yet to hide |
| `GET /applications` | `application:read` | **filtered**: the page holds only applications of teams that grant it, a caller with no team sees an empty page, not an error |
| `GET /applications/{id}` | `application:read` | **404**, the same answer as for an id that does not exist |
| `POST /applications/{id}/releases` | `application:create` | **404** |
| `GET /applications/{id}/releases/{releaseId}` | `application:read` | **404** |
| `POST /deployments` | `deployment:create` for the application's team | **422**, the same answer and message as an unknown `applicationId` (body references are 422, S3.3) |
| `GET /deployments/{id}` | `deployment:read` | **404** |
| `POST /deployments/{id}/rollback` | `deployment:rollback` | **404** |
| `GET /deployments/{id}/tasks`, `/tasks/by-offset` | `deployment:read` | **404** |
| `GET /tasks/{id}` | `deployment:read` | **404** |

Unchanged from S4.3: a caller with **no grant of the permission anywhere** is still refused at the endpoint with a 403 before any object is loaded. The two checks stack: first "may you use this kind of endpoint at all" (403), then "may you touch this object" (404, 422 or filter).

Consequences:

1. A caller cannot learn that an object exists in another team: the answer for it is byte-for-byte the answer for an id that was never used (apart from the id and the correlation id that every problem carries).
2. A denied request has **no side effect**: no `deployment`, `task`, `audit_event` or `release` row, no idempotency record that outlives the attempt.
3. The owner check runs **before** any state check. A rollback of another team's deployment that is already rolled back is a 404, not a 409 (a 409 would confirm the object exists and show its state).

## 3. Decisions

1. **One rule, written once, in a small `TeamAccess` bean,** called from the service methods after they load the object. The rule is the sentence in section 2; the bean reads the `JwtAuthenticationToken` from `SecurityContextHolder` (like the rate-limit interceptor does since S4.2), so no service signature changes. It exposes: *may I do `permission` on a team* (boolean), *which teams grant `permission`* (for the list filter, or "all" for a global grant), and *require it or throw the exception I am given*. A caller that is not a `JwtAuthenticationToken` is denied.
2. **Not `PermissionEvaluator` with `@PreAuthorize("hasPermission(...)")`, the spec's wording, as the primary mechanism.** An evaluator returns a boolean, so a refusal is an `AccessDeniedException` and a **403**: it says "this object is not yours", which confirms the object exists. Turning that 403 into a 404 needs an `AuthorizationDeniedHandler` that re-derives *why* it was denied, which is more machinery than the rule it protects. The alternative is kept in section 8, 1 and is cheap to add later *on top of* `TeamAccess` (an evaluator that calls it) if the interview vocabulary matters more than the 404.
3. **The owner is read with one cheap query, not by loading the aggregate for the check.** Where a service already loads the object (`requestRollback`, `get`), the check uses it. Where it only asked `existsById` (the task history endpoints) or loaded a leaf (`GET /tasks/{id}`), a repository query returns just the owning team id: `select d.application.ownerTeamId from Deployment d where d.id = :id`, and the same through `t.deployment.application` for a task. `findDetailById` gains `application` in its entity graph so `GET /deployments/{id}` stays **one joined select** (the S3.3 measurement is re-checked, section 5, 3).
4. **The check is in the service layer, not the controller.** The service has the object; a controller would have to load it a second time. The price is that a new service method can forget the check, which is why section 4.4 is a matrix test over every operation and not a hope.
5. **Body references answer 422, creation answers 403, path ids answer 404.** Each is the answer that already existed for the "does not resolve" case of that shape, so the denied path adds no new status. `POST /applications` is 403 because the caller is naming a team they would be creating something *for*, and no object exists to hide.
6. **A global `perms` grant applies to every team.** It is the only way a platform operator is not a member of every team. A token without `perms` (every test token so far) is unaffected. The unit test table includes a global grant and a `perms` entry that is *not* the required permission.
7. **The list filters, never errors.** `GET /applications` adds `where owner_team_id in (:teams)` to the existing cursor queries; a global grant removes the filter. The cursor still orders by id and must stay stable.
8. **A denied request is logged at INFO,** with `sub`, permission, object type and id, and the correlation id, and never in the response. It is the trail a security reviewer wants; it is not an alert (an attacker can make it noisy, so it is not WARN).
9. **The exploit tests stay,** renamed by what they now prove. The red run is the deliverable of the first step: the same tests fail against S4.3 and pass against S4.4.

## 4. Tests

New helpers: `TestAuth.tokenFor(UUID sub, Map<UUID, List<String>> teams)` (and a variant with global `perms`), and `TestFixtures.fixtureFor(UUID teamId)` (an application owned by that team). Two fixed team ids in the test: `TEAM_A` and `TEAM_B`.

### 4.1 The exploit, written first, against the S4.3 code (the red run)

A new `ObjectAuthorizationTest` extends `WebIntegrationTest`. Each test creates the object for team B, then calls as a caller who holds the **needed permission, for team A only**.

| # | Test | Red today because |
|---|---|---|
| 1 | `deployer_ofTeamA_cannotDeploy_teamBsApplication` | `POST /deployments` answers **202** and writes a deployment; must be 422, with no `deployment`, `task` or `audit_event` row |
| 2 | `reader_ofTeamA_cannotRead_teamBsDeployment` | `GET /deployments/{id}` is 200 with the whole body; must be 404 |
| 3 | `deployer_ofTeamA_cannotRollback_teamBsDeployment` | `POST .../rollback` answers 202 and records a ROLLBACK task; must be 404, no task row |
| 4 | `reader_ofTeamA_cannotRead_teamBsTaskHistory` (both forms) and `cannotRead_teamBsTask` | 200; must be 404 |
| 5 | `reader_ofTeamA_cannotRead_teamBsApplication` and its release | 200; must be 404 |
| 6 | `creator_ofTeamA_cannotAddRelease_toTeamBsApplication` | 201; must be 404, no release row |
| 7 | `creator_ofTeamA_cannotCreateApplication_forTeamB` | `POST /applications` with `ownerTeamId` = B answers 201; must be 403, no application row |
| 8 | `list_showsOnlyTheCallersTeams` | `GET /applications` includes team B's application; must not |
| 9 | `permissionHeldForAnotherTeam_doesNotCount` | the flattening case itself: a token with `{A: [deployment:create], B: [deployment:read]}` deploys B's application. Today 202 (A's permission is accepted for B); must be 422. Reading B's deployment must still work (200) |
| 10 | `deniedAnswer_isIndistinguishableFromMissing` | for GET deployment, GET application, rollback: the status, `type`, `title` and `detail` with the id replaced are equal for team B's object and for an id that never existed |
| 11 | `ownerCheck_runsBeforeStateChecks` | a deployment of team B that is already ROLLED_BACK, rollback requested by team A: **404**, not 409 (today the 409 shows its state) |

Tests 12 and 13 are green today and after (they pin that the fix did not break the owner's own access); test 14 is red today like test 8:

| # | Test | |
|---|---|---|
| 12 | `sameTeam_canDoEverything_itsPermissionsAllow` | the same operations as 1 to 8, as a caller who holds the permissions for **the object's own team**: the normal 200, 201, 202 |
| 13 | `globalPerms_applyToEveryTeam` | a token with `perms: [deployment:create]` and no `teams` deploys team B's application: 202. Red today only in the sense that it is green for the wrong reason; kept as the pin for decision 6 |
| 14 | `callerWithOnlyAnEmptyTeam_seesAnEmptyList_notAnError` (red today, see 9.1) | `GET /applications` with `application:read` held only for a team that owns no application: 200 and an empty page, not an error (a caller with the permission nowhere is still the S4.3 403) |

### 4.2 `TeamAccessTest` (unit, no Spring)

A table, run against a hand-built `JwtAuthenticationToken`: permission held for the object's team (yes); held for another team only (no); held globally (yes); a **different** permission held for the object's team (no); `teams` claim missing, empty, or of the wrong type (no, no exception); `perms` of the wrong type (no); `sub` present but no token (`AnonymousAuthenticationToken`, a non-JWT token) (no); the teams-with-permission set for the list filter; a global grant returns "all".

### 4.3 What happens to existing tests

- `TestFixtures.fixture()` and the tests that create applications through the API (`ApplicationEndpointsTest`, `ApplicationPaginationTest`, `IdempotencyEndpointsTest`, and others) use a **random** owner; the default token's team is `TestAuth.TEAM`. They are changed to create the application for `TestAuth.TEAM`, **before** the check is wired, so the red count in step 4 of section 6 is only the new behaviour. This is the S4.1 lesson again: turning a check on in a suite that never had one is most of the work.
- `ApplicationPaginationTest` counts pages of applications; with the list filtered by team it must create its rows for `TestAuth.TEAM` and keep other tests' rows (other owners) out of its counts. Its `TRUNCATE application CASCADE` cleanup stays.
- `PermissionEnforcementTest`'s operations table (S4.3) uses random ids and expects "not 403" from a token with only the permission: a 404 stays acceptable. Its `POST /applications` row sends a random `ownerTeamId` and a token for `TestAuth.TEAM`: it becomes a 403 and the row's body must use `TestAuth.TEAM`. Test 2 of that class compares only against 401 and 403, so the 403 from the new rule would be a false pass; the row is fixed instead of the assertion.
- `JwtAuthenticationTest` and the S3 web tests that use only the default token are unaffected once the fixtures are on `TestAuth.TEAM`.

### 4.4 The matrix

`CrossTeamMatrixTest`: one table of the 11 operations (the same table as S4.3's), each called with an object of team B by a caller who holds the permission **only for team A**, with the expected status of section 2 (422, 404, 403, or filtered). One test per row, plus the meta-check that the table has the same 11 operations as the handler mappings. A new endpoint without a row fails the meta-check; a new endpoint with a row but no owner check fails its row. This is the guard for decision 4.

## 5. Risks to check, not assume

1. **The suite cost.** Expect many failures when the check is wired because every fixture app belongs to a random team. The count before and after the fixture fix is recorded.
2. **SpEL is not used, so no wrapping surprise;** but the S4.3 annotations stay on the controller methods and run first. A caller without the permission anywhere never reaches the owner check; a test pins that the 403 still wins over a 404 for a missing permission.
3. **`GET /deployments/{id}` must stay one joined select.** `DeploymentEndpointsTest` or the SQL log is re-checked after `application` joins the entity graph. If a second statement appears, the graph is wrong.
4. **The task history endpoints are the hot path** (S3.4, 250,000 tasks for one deployment). The added owner query is a primary-key lookup with two joins on small tables; measure the by-offset page 10,000 and the cursor first page once against the S3.4 seed and record the numbers, or record that the S3.4 benchmark was not repeated.
5. **The list query and its index.** `owner_team_id in (...)` with a cursor on `id` must not become a sequential scan on a large table. Check V1 for an index on `application(owner_team_id)` and read `EXPLAIN` once; if absent, add it in a migration (V5) with a test that the migration applies.
6. **Idempotency.** The Redis record is written only after the service call succeeds (S3.5); a denied deployment request is a 422 and must leave no record that a later, permitted request would replay. Test 1 asserts the key is absent or released.
7. **Enumeration through side channels.** A different status, body, `Retry-After` or measurable timing would defeat decision 2. The body and status are tested (test 10); timing is **not** tested and is recorded as a known limit (a missing id and a foreign id both cost one primary-key query, which is close, not equal).
8. **Rate limiting is by `sub`,** so one caller scanning ids hits their own bucket; nothing here changes it. Recorded because the scan is the realistic attack.
9. **A `Release` of another application.** `POST /deployments` already checks that the release belongs to the application; the owner check is on the application only. The release check stays as it is (422).

## 6. Order of work: find it broken first

1. Write `TestAuth.tokenFor(sub, teams)` and `TestFixtures.fixtureFor(team)`, then tests 1 to 14 of 4.1. Run against the S4.3 code. **Record which are red and why**; this is the exploit. Tests 12 to 14 are expected green.
2. Move the existing fixtures and API-created applications onto `TestAuth.TEAM` (4.3). `mvn verify` green with the new red tests excluded or `@Disabled` with a reason, so the suite shows only what step 1 proved.
3. `TeamAccess` and its table test (4.2), red first against an empty class or a rule that ignores the team (a "returns true" version).
4. Wire one operation at a time, running its exploit test after each: `POST /applications`, application and release reads and release creation, `POST /deployments`, `GET /deployments/{id}` and the rollback, task history, `GET /tasks/{id}`, then the list filter. Re-enable the tests as they go green.
5. The matrix (4.4). Mutation checks on a scratch copy, one change at a time: (a) remove the check from one service method, its matrix row goes red; (b) make `TeamAccess` accept any team's grant (the flattening bug again), test 9 and the unit table go red; (c) move the owner check after the state check in `requestRollback`, test 11 goes red; (d) drop the filter from the list, test 8 goes red; (e) read `perms` as "team grants", test 13 or the unit table goes red.
6. `mvn verify`. Re-check risks 3 to 5 and record the numbers.
7. Manual check on the dev stack with two tokens for two teams: create an application as team A through the API, then read, deploy and roll back as team B and compare the answer with an id that does not exist. Read the audit table for the denied attempts (none).
8. Docs: plan row, concepts guide (`sec-idor`), Outline. Results section.

## 7. Not in S4.4

- **Teams as data.** There is still no `Team` table; `ownerTeamId` stays a plain column and the token is the only membership source. A removed member keeps access until the token expires (15 minutes); the denylist and short lifetimes are identity-service's.
- **Environments.** `Environment` has no owner; any caller may name any environment in a deployment. A per-environment permission (production versus staging) is a later question, not this IDOR.
- **Moving an application to another team,** and ownership transfer.
- **`bearerAuth`, 401 and 403 in the OpenAPI document** (S4.6); this step adds one more 403 (`POST /applications`) the document does not yet list.
- **Timing equalisation** (risk 7) and **audit of denials as events** (decision 8 only logs).
- **The outbox** (S4.5), which needs no authentication.

## 8. Decided 2026-10-05

All six open questions were answered with the recommendation:

1. **`TeamAccess` in the services is the mechanism.** It gives the 404 the plan promises without extra machinery. A `PermissionEvaluator` that delegates to `TeamAccess` can be added later if the `hasPermission` wording is wanted; it is not part of S4.4.
2. **`POST /applications` for a team the caller is not in is a 403:** the caller supplies the team, and nothing exists to hide.
3. **`POST /deployments` with another team's application is a 422** with the existing message, the answer for an unknown application (S3.3).
4. **A global `perms` grant applies to every team,** tested (test 13 and the unit table).
5. **A denied request is logged at INFO,** never in the response.
6. **A V5 index on `application(owner_team_id)` only if `EXPLAIN` on the seed data shows a sequential scan** (step 6 of section 6).

7. **Revisited after the measurement of 9.7:** the condition of 6 is not met literally (21 rows), but a 200,000-row experiment shows a primary-key walk of 7 to 10 ms against 0.03 to 0.2 ms with an index. **Decided: add V5** (answered 2026-10-05; section 9.9).

## 9. Results

### 9.1 The exploit, run against the S4.3 code, 2026-10-05

`ObjectAuthorizationTest`, 14 tests, `TestAuth` and `TestFixtures` helpers added, nothing else changed: **12 red (11 failures, 1 error), 2 green**. Every denial the doc promises is, today, a success:

| Test | Today's answer | Required |
|---|---|---|
| 1 `deployer_ofTeamA_cannotDeploy_teamBsApplication` | **202** | 422 |
| 2 `reader_ofTeamA_cannotRead_teamBsDeployment` | **200** | 404 |
| 3 `deployer_ofTeamA_cannotRollback_teamBsDeployment` | **202** (a ROLLBACK task is recorded) | 404 |
| 4 `reader_ofTeamA_cannotRead_teamBsTaskHistory_orTask` | **200** | 404 |
| 5 `reader_ofTeamA_cannotRead_teamBsApplication_orItsRelease` | **200** | 404 |
| 6 `creator_ofTeamA_cannotAddRelease_toTeamBsApplication` | **201** | 404 |
| 7 `creator_ofTeamA_cannotCreateApplication_forTeamB` | red (the first assertion failed; the status was not captured in the summary) | 403 |
| 8 `list_showsOnlyTheCallersTeams` | team B's application is in the list | absent |
| 9 `permissionHeldForAnotherTeam_doesNotCount` | **202**: team A's `deployment:create` was accepted for team B's application, the flattening bug itself | 422 |
| 10 `deniedAnswer_isIndistinguishableFromMissing` | **error, not a clean failure:** the foreign `GET /deployments/{id}` returns a 200 deployment body, which has no `$.detail`, so the `shape` helper threw `PathNotFoundException`. Red for the right reason, through the wrong mechanism; the helper is to be made tolerant of a non-problem body | equal shapes |
| 11 `ownerCheck_runsBeforeStateChecks` | **409**: the illegal-transition answer shows that team B's deployment exists and is already rolled back | 404 |
| 14 `callerWithOnlyAnEmptyTeam_seesAnEmptyList_notAnError` | the page is not empty (every team's applications) | empty |

Green, as predicted: test 12 (`sameTeam_canDoEverything_itsPermissionsAllow`) and test 13 (`globalPerms_applyToEveryTeam`).

Two corrections to the prediction in section 4.1: test 14 is **red** today (the list is unfiltered, the same reason as test 8), not green; and test 10 is an **error**, not a failure. Tests 12 and 13 pin the owner's own access and the global grant, as intended.

### 9.2 The suite after the fixture move, before any check, 2026-10-05

Step 2 of section 6: `TestFixtures.fixture()` and every API-created application now use `TestAuth.TEAM` (`ApplicationEndpointsTest` in five places, `ApplicationPaginationTest`, the new-application row of `PermissionEnforcementTest`), and the `shape` helper of `ObjectAuthorizationTest` tolerates a non-problem body. Full `mvn verify -Dmaven.test.failure.ignore=true`: **288 tests, 12 failures, 0 errors, 2 skipped by design**; the 12 failures are exactly the 12 red tests of 9.1, all in `ObjectAuthorizationTest` (test 10 now fails cleanly, not with an error). Every other test is green, which shows the move cost nothing by itself.

Deviation from section 6, step 2: the 12 red tests are **not** `@Disabled`. They stay red and visible as the progress tracker for step 4; `-Dmaven.test.failure.ignore=true` is used until they pass.

### 9.3 `TeamAccess` and its table test, 2026-10-05

`TeamScope` (record: `all`, `teams`, `contains`) and `TeamAccess` (`allows`, `scopeFor`, `require`) in `io.appfleet.control.security`; `TeamAccessTest`, 13 tests. **Red first** against a deliberately wrong `TeamAccess` that ignores the team (the S4.3 flattening: `allows` always true, `scopeFor` always every team): **10 of 13 failed**; the 3 green ones were the cases the wrong version gets right (the object's own team, a global permission, a global scope). Then the real rule: **13 of 13 green**.

Details of the rule as built: a `perms` entry equal to the permission is a global grant; otherwise the `teams` map is read, a key counts only if it is a canonical UUID (a lenient form such as `1-1-1-1-1` is ignored), and its value must be a list containing the permission as a string (non-string entries are ignored, a wrong type is ignored without an exception). Anything that is not a `JwtAuthenticationToken`, including a `TestingAuthenticationToken` whose authorities contain the permission, is denied. A null owner is denied.

Gap against decision 8: `require` logs `sub`, permission and the owner **team** at INFO; the object type and id are not in the line, because `require` does not know them.

### 9.4 Wiring, 2026-10-05

Step 4 of section 6, in two groups, each followed by a full `mvn verify -Dmaven.test.failure.ignore=true`:

| After | Tests | Failures |
|---|---|---|
| fixtures on `TestAuth.TEAM`, nothing wired (9.2) | 288 | 12, all in `ObjectAuthorizationTest` |
| `TeamAccess` added to the 13-test unit table (9.3) | 301 | 12, the same |
| group 1: applications, releases, `POST /applications` (403), the list filter | 301 | **10**: 5, 6, 7 green as predicted; 8 and 14 stayed red, and `concurrentCreate_sameName_oneCreated_oneConflict` newly red |
| two repairs (below) | 301 | **7**, exactly the deployment group |
| group 2: deployments, rollback, task history, `GET /tasks/{id}` | 301 | **0**, 2 skipped by design |

Two things went wrong in group 1, both found by the red tests:

- **The list was still unfiltered.** `ApplicationService.list` had the early return for "no team" but still ran `findAllByOrderByIdAsc`. Found by turning on the SQL log for test 14: `select … from control.application a1_0 order by a1_0.id` with no `owner_team_id` condition. The filter branch was then applied.
- **A step 2 miss.** `concurrentCreate_sameName_oneCreated_oneConflict` still created its application with a random owner; with the check wired it got a 403. Changed to `TestAuth.TEAM`. It had passed in step 2 only because nothing was checked yet.

Group 2 changes: `DeploymentService` (`requestDeployment` 422 with the unknown-application message, `requestRollback` checks before the state checks, `get`), `TaskService` (history and `GET /tasks/{id}`), `DeploymentRepository.findOwnerTeamIdById` and `TaskRepository.findOwnerTeamIdById` (one projection query each, no aggregate loaded), and `application` added to the `findDetailById` entity graph.

### 9.5 Mutation checks, scratch copy, 2026-10-05

The repository copied without `target`, one change at a time, the real files restored before the next; `ObjectAuthorizationTest` and `TeamAccessTest` run through the reactor:

| Mutation | Failed |
|---|---|
| (a) owner check removed from `TaskService.get` | `reader_ofTeamA_cannotRead_teamBsTaskHistory_orTask` only (1 of 14) |
| (b) the flattening bug put back: `allows` true if **any** team grants the permission | 10 of 14 `ObjectAuthorizationTest` (every exploit test except the list ones and the two green pins) and 3 of 13 `TeamAccessTest` (`permissionHeldOnlyForAnotherTeam_isDenied`, `aDifferentPermissionForTheObjectsTeam_isDenied`, `require_throws…`) |
| (c) the rollback owner check moved after the state checks | `ownerCheck_runsBeforeStateChecks` only (1 of 14) |
| (d) the list filter dropped (`if (true)` for the global branch) | `list_showsOnlyTheCallersTeams` and `callerWithOnlyAnEmptyTeam_seesAnEmptyList_notAnError` (2 of 14) |
| (e) global `perms` ignored | `globalPerms_applyToEveryTeam` (1 of 14) and `scopeFor_aGlobalGrantIsEveryTeam`, `globalPerm_appliesToEveryTeam` (2 of 13) |

Each mutation is caught by the test written for it, and (b), the original bug, by both the integration tests and the unit table.

### 9.6 The cross-team matrix, 2026-10-05

`CrossTeamMatrixTest`: 11 operations, each run once against another team's objects (the documented denial) and once against the caller's own (the normal answer), plus a meta-check that the table and the real `/api` handler mappings are the same set: **23 tests, all green**. Own-team answers: 201, 200, 200, 201, 200, 202, 200, 202, 200, 200, 200; foreign answers: 403, 200 (filtered), 404, 404, 404, 422, 404, 404, 404, 404, 404.

Seen red on a scratch copy:

| Mutation | Failed |
|---|---|
| (f) owner check removed from `ApplicationService.getRelease` | `anotherTeamsObject_getsTheDocumentedDenial` for `GET .../releases/{releaseId}` (200 instead of 404); 1 of 23 |
| (g) owner check removed from `requestRollback` | the `POST .../rollback` foreign row (202 instead of 404); 1 of 23 |
| (h) the `tasks/by-offset` row deleted from the table, standing for an endpoint added without a row | `theTableCoversEveryApiHandler`, naming `GET /api/v1/deployments/{id}/tasks/by-offset`; 1 of 21 |

A trap in the method, recorded because it can fake a result: the first run of (h) also showed the rollback row failing. That was **stale compiled output** from (g): the source was restored with its old timestamp, (h) changed only a test file, and Maven reported "Nothing to compile" for main, so the mutated class from (g) stayed. The clean rerun (the restored file touched) failed only the meta-check. The earlier mutation series of 9.5 and S4.3 are not affected, because each mutation there changed a main file and forced a recompile of the module; the rule for later scratch runs is to touch every restored file.

The row for `GET /applications` is 200 on both sides (the list filters, it never denies), so it cannot catch a missing filter; `list_showsOnlyTheCallersTeams` is that guard. The row exists so the meta-check sees the handler.

### 9.7 Risks 3 to 5, measured, 2026-10-05

**Risk 3, the SQL of the reads.** With `org.hibernate.SQL` at DEBUG and the correlation id in the log line, one request is one id: `GET /deployments/{id}` is **one statement**, `select … from control.deployment d1_0 join control.application a1_0 on a1_0.id=d1_0.application_id join control.environment e1_0 on e1_0.id=d1_0.environment_id where d1_0.id=?`. The history endpoints are **two**: the owner projection (`deployment` joined to `application`, selecting the owner team only) and the page of tasks. Read-only requests in the run: 3 with one statement, 4 with two.

**Risk 4, the history endpoints against the S3.4 seed** (1,200,101 tasks; the benchmark deployment of `seed-app-01`, 464,862 tasks; jar on profile `local`; 15 sequential `curl` calls each, median of wall time including `curl` start-up; the caller holds `deployment:read` for the owning team):

| Request | Median |
|---|---|
| `GET /deployments/{id}` | 12.3 ms |
| `GET /deployments/{id}/tasks?limit=20` (cursor, first page) | 13.5 ms |
| `GET /deployments/{id}/tasks/by-offset?page=10000&size=20` | 24.9 ms |

S3.4 recorded HTTP 24.4 ms for the deep offset page and 9.2 ms for the keyset page. The deep offset page is unchanged (24.9 against 24.4). The cursor page is about 4 ms slower (13.5 against 9.2), but that is **not** the cost of the owner query alone: S3.4 predates authentication, so the difference also holds the RS256 verification and the permission checks of S4.1 to S4.3. The owner lookup is a primary-key read; its own cost was not isolated.

**Risk 5, the list query and an index.** `application` has only `application_pkey` and `uq_application_name`. The seed has 21 applications over 21 teams, where a sequential scan is correct, so `EXPLAIN` on it proves nothing. A controlled experiment instead, in a rolled-back transaction: a temporary table of 200,000 applications over 2,000 teams, a caller with 3 teams, `order by id limit 21`:

| | Plan | Time |
|---|---|---|
| no index on `owner_team_id`, first page | walks `at_pkey` and discards 14,747 rows | 7.3 ms |
| no index, one team, cursor page far from the start | walks `at_pkey`, discards 39,884 rows | 10.4 ms |
| index `(owner_team_id, id)`, first page, 3 teams | bitmap scan of 300 rows, top-N sort | 0.19 ms |
| index `(owner_team_id, id)`, one team, cursor page | index-only scan | 0.03 ms |

This is the S3.4 shape again: not a sequential scan, a primary-key walk that filters, and its cost grows with the table. Decision 6 of section 8 said "add the index only if the plan on the seed data is a sequential scan"; that condition is **not met literally** (21 rows). The evidence argues for the index anyway; see section 8, 7.

### 9.8 Manual check, two teams, 2026-10-05

The jar of the last build (profile `local`, Postgres on 55432 and Redis from compose), tokens signed with `openssl`: an **owner** token (`deployment:read`, `deployment:rollback`, `application:read` for the benchmark deployment's team) and an **other** token (`deployment:read` for a different team):

- Owner: `GET /deployments/{id}`, the cursor page and the deep offset page answer 200. The owner's application list returned **1 item** (their one application) out of the 21 in the database.
- Other team: `GET /deployments/{id}`, `/tasks` and `/tasks/by-offset` answer **404**.
- The 404 for the foreign deployment and for an id that does not exist have the same `type`, `title`, `status` and `detail` pattern; only the id and the correlation id differ.
- Two lines `Team access denied: sub=… permission=…` were logged at INFO for the other caller (the correlation id is in the log line pattern). `audit_event` holds **0** rows for either caller.
- **Not run:** the other team's application list. The probe used a token without `application:read`, which is a 403 with no `items`; the filter is covered by `list_showsOnlyTheCallersTeams` and `callerWithOnlyAnEmptyTeam_seesAnEmptyList_notAnError`. A foreign rollback and the `POST` operations were not run by hand either; the matrix test covers them.

### 9.9 The V5 index, 2026-10-05

Asked and answered 2026-10-05: add it. `ApplicationOwnerIndexTest` (one test, reads `pg_indexes`) was written first and run on a scratch copy **without** the migration: **red**, `EmptyResultDataAccessException: Incorrect result size: expected 1, actual 0`. Then `V5__add_application_owner_team_index.sql`, `CREATE INDEX idx_application_owner_team_id ON application (owner_team_id, id);` (same style as V4): **green**. The dev database receives it the next time the jar starts (Flyway).

### 9.10 Closed, 2026-10-05

`mvn verify`: **325 tests, 0 failures, 2 skipped by design** (`common-security` 41, `fleet-audit-starter` 3, control-api 325 of which 14 exploit tests, 13 `TeamAccess`, 23 matrix, 1 index).

What is true after S4.4:

- A permission counts only for the team that granted it (or globally in `perms`). The S4.3 gap of section 9.6 of that doc is closed: team A's `deployment:create` no longer deploys team B's application.
- Another team's object answers like a missing one (404, or 422 for a body reference); creating an application for a team you are not in is a 403; the application list is filtered.
- The owner check runs before the state checks, and a denied request writes no row and no audit event.

What is not, and where it goes:

- **Teams are still only a claim.** There is no `Team` table; a user removed from a team keeps access until the token expires (15 minutes). Identity-service.
- **Environments have no owner.** Any caller may name any environment in a deployment.
- **The OpenAPI document does not list the new 403** (`POST /applications`) or the S4.3 ones (S4.6).
- **Timing** of a missing id versus a foreign id is not equalised or tested.
- **The denial log line** carries `sub`, the permission and the owner team, not the object type and id (decision 8 asked for both).
- The failure count of the existing suite with random owners was not measured: the fixtures were moved before the check was wired (9.2), so the red count showed only the new behaviour.

## Definition of done

- [x] Tests 1 to 14 written first and run against the S4.3 code; the exploit (tests 1 to 9, 11) recorded red, with the answers (9.1; 12 red, 2 green)
- [x] A caller with the permission for team A only cannot deploy, read, roll back, add a release to, or list team B's objects; the answers are 422, 404, 403 or filtered as in section 2
- [x] The answer for a foreign object equals the answer for a missing one, apart from ids (test 10)
- [x] A denied request writes no row and leaves no idempotency record (test 1, risk 6)
- [x] `TeamAccess` has its table test, red first, with the global, wrong-type and non-JWT cases
- [x] The cross-team matrix covers every operation and fails for a new endpoint without a row (4.4)
- [x] Mutation checks (a) to (e) seen red on a scratch copy (9.5), plus (f) to (h) for the matrix (9.6)
- [x] The permission held for another team no longer counts (test 9); a global grant still does (test 13)
- [x] `GET /deployments/{id}` is still one joined select; the task history and list cost re-measured (9.7)
- [x] Existing tests moved onto `TestAuth.TEAM` (the failure count with random owners was not measured, see 9.10)
- [x] Manual check with two teams (9.8; the other team's list and the POST operations were not run by hand)
- [x] Results written; the plan's S4.4 row, the concepts guide and the Outline pages updated
- [x] `mvn verify` green (325, 2 skipped)
