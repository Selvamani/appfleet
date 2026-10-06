# control-api — S4.3: method security, permissions on every endpoint

**Spec:** [01-CONTROL-API.md §S4](../../specs/project/01-CONTROL-API.md) · Step **S4.3** of [control-api-s4-plan.md](control-api-s4-plan.md) · Predecessors: [control-api-s4-1-jwt-validation.md](control-api-s4-1-jwt-validation.md) (the token becomes authorities; the 403 handler exists), [control-api-s4-2-principal.md](control-api-s4-2-principal.md) (the caller is known). **Status: designed 2026-10-05, all open questions decided (section 8), built and closed 2026-10-05.**

After S4.2 the API knows who is calling, and any valid token can call every endpoint: authentication is on, authorization is not. This step makes each endpoint require one **permission** and proves that the requirement is enforced, not merely written down.

This step is **endpoint-level only**. It answers *may this caller use this kind of endpoint at all*. It does not answer *may this caller touch this particular application*; that is S4.4, and the gap between the two is deliberate (section 7).

## 1. What already exists

- **The authorities.** `AppfleetJwtAuthenticationConverter` turns the `perms` list and every value of the `teams` map into `SimpleGrantedAuthority` with **no prefix**: a token with `teams: {A: [deployment:create], B: [application:read]}` carries the two authorities `deployment:create` and `application:read`, with the team they came from thrown away. So `hasAuthority('deployment:create')` is true if the permission is held for **any** team. That is correct for S4.3 and is exactly what S4.4 breaks.
- **The 403 path.** `ProblemAccessDeniedHandler` writes the problem body. `ApiExceptionHandler.rethrowSecurity` rethrows `AccessDeniedException` and `AuthenticationException` so the filter chain's `ExceptionTranslationFilter` answers instead of the catch-all advice (the S4.1 trap). Test 19 in `JwtAuthenticationTest` proves it on a throwaway endpoint.
- **No enforcement.** There is no `@EnableMethodSecurity` in main code and no `@PreAuthorize` on any real controller. The only use of either is the throwaway endpoint in `JwtAuthenticationTest`, which carries its own `@EnableMethodSecurity`.
- **`SecurityConfig`** requires `authenticated()` for `/api/**` and `denyAll()` for anything not listed.
- **The default test token** (`TestAuth.defaultToken()`) holds five permissions on one team: `application:read`, `application:create`, `deployment:create`, `deployment:rollback`, `deployment:read`. The existing suite therefore keeps passing when the checks arrive.
- **`JwtAuthenticationTest` test 18** (`tokenWithNoPermissions_authenticates`) says a token with no grants gets 200 on a GET "because no authority check exists until S4.3". It becomes false in this step and is rewritten.

## 2. Behaviour

Eleven operations, one permission each:

| Operation | Permission |
|---|---|
| `POST /api/v1/applications` | `application:create` |
| `GET /api/v1/applications` | `application:read` |
| `GET /api/v1/applications/{id}` | `application:read` |
| `POST /api/v1/applications/{id}/releases` | `application:create` (section 8, 1) |
| `GET /api/v1/applications/{id}/releases/{releaseId}` | `application:read` |
| `POST /api/v1/deployments` | `deployment:create` |
| `GET /api/v1/deployments/{id}` | `deployment:read` |
| `POST /api/v1/deployments/{id}/rollback` | `deployment:rollback` |
| `GET /api/v1/deployments/{id}/tasks` | `deployment:read` |
| `GET /api/v1/deployments/{id}/tasks/by-offset` | `deployment:read` |
| `GET /api/v1/tasks/{id}` | `deployment:read` |

| Request | Answer |
|---|---|
| no token, bad token | 401 (unchanged, S4.1) |
| valid token without the operation's permission | **403** `urn:appfleet:problem:forbidden`, problem shape, `correlationId` |
| valid token with the permission | the operation's normal answer |

Consequences:

1. A role name is never an authority. A token that carries `DEPLOYER` or `ROLE_DEPLOYER` and none of the five permissions gets 403 everywhere. `deployment:*` is not a wildcard: it is a string that matches nothing.
2. A new endpoint without a permission cannot be added silently: the meta-test (section 4.1, test 6) fails until it declares one.

## 3. Decisions

1. **`@PreAuthorize("hasAuthority('<permission>')")` on each controller method,** as the plan says. Rejected: `requestMatchers(...).hasAuthority(...)` in `SecurityConfig`. It would run in the filter chain before MVC and would not need a proxy, but it moves each rule away from the method it protects and repeats the URL patterns. The price of the annotation is in section 5 (the order of binding and checking).
2. **`@EnableMethodSecurity` goes on `SecurityConfig` in control-api,** not in `common-security`. Which beans are protected is an application decision; the library validates tokens and nothing more. The throwaway endpoint's own `@EnableMethodSecurity` in `JwtAuthenticationTest` is removed (a second enabling would register the advisors twice).
3. **Permissions are literal strings in the annotations.** A `Permissions` constants class would need a SpEL `T(...)` reference in every annotation to be used; a literal is greppable and reads as the sentence it is. The meta-test, not a constants class, is what keeps the strings honest: it checks every handler declares one, and the matrix test checks that each one means what section 2 says.
4. **`hasAuthority`, never `hasRole`.** `hasRole('X')` silently looks for `ROLE_X`; the plan's decision 3 is that role names are never checked. The meta-test asserts the expression starts with `hasAuthority(`.
5. **The class-level default is not used.** One `@PreAuthorize` on a controller class would protect every method added later with the same permission, which is the wrong default (a read permission would guard a write). Each method says its own.
6. **403, not 404, for a missing permission.** The plan's decision 5 is the split: no permission for the *endpoint at all* is 403; an object that belongs to another team is 404 (S4.4). This step only produces the first.
7. **Controllers become proxies.** Method security wraps the controller bean in a CGLIB proxy. The controllers are non-final with constructor injection, so nothing changes; recorded because a `final` class or method would silently not be protected (the matrix test would show it).
8. **Actuator, Swagger and the OpenAPI document stay as S3 and S4.1 left them.** The `/api/**` rule is unchanged; this step adds a second lock behind it.

## 4. Tests

### 4.1 Written first, against the current code (the red runs)

A new `PermissionEnforcementTest` extends `WebIntegrationTest`. `TestAuth` gains `tokenWith(String... permissions)` (one team, exactly those permissions); `tokenWithout(String permission)` is the default five minus one.

| # | Test | Red today because |
|---|---|---|
| 1 | `everyOperation_withoutItsPermission_is403` (11 rows: method, path, required permission) | the token holds the other four permissions and the call succeeds: 200, 201, 202 or 404 instead of 403 |
| 2 | `everyOperation_withOnlyItsPermission_isNot403` (the same 11 rows, token with exactly one permission) | green today and after; it pins that the check is not too strict, and that each row names the *right* permission rather than just *a* permission |
| 3 | `forbidden_onARealEndpoint_hasProblemShape` | `type` `urn:appfleet:problem:forbidden`, `status` 403, `correlationId`, `application/problem+json`, on `POST /deployments`; today a 202 |
| 4 | `tokenWithNoPermissions_is403` (replaces `JwtAuthenticationTest` test 18) | today 200 |
| 5 | `roleNamesAndWildcards_arePermissionsOfNothing` | a token with `perms: [DEPLOYER, ROLE_DEPLOYER, deployment:*]` and no real permission: 403 on `POST /deployments`; today 202 |
| 6 | `everyApiHandler_declaresOnePermission` (meta-test) | iterates `RequestMappingHandlerMapping.getHandlerMethods()`, keeps patterns under `/api/`, requires a merged `@PreAuthorize` whose expression is `hasAuthority('...')`, and requires the set of handlers to equal the 11 rows of tests 1 and 2 (a new endpoint fails here until it has a row). Today: 11 handlers without the annotation |
| 7 | `noPermission_withInvalidBody_answer` | **characterization, not a prediction.** A caller without `deployment:create` sends a `POST /deployments` body that fails `@Valid`. Spring binds and validates the arguments before it invokes the proxied method, so the expected answer is a 400, not a 403 (section 5, 1). Run it, record what happens, pin it with a comment saying why |

Tests 1 and 2 are parameterized with **valid** requests for the 403-versus-success comparison to mean anything: a `POST /deployments` needs a body that passes `@Valid`, and `{id}` paths need an id (a random UUID is fine for the 403 case, and a 404 is an acceptable "not 403" for the success case). `TestFixtures` already builds a valid deployment request.

### 4.2 Unit tests

None new. `AppfleetJwtAuthenticationConverterTest` (S4.1) already covers how a token becomes authorities.

### 4.3 What happens to existing tests

- `TestAuth.defaultToken()` holds all five permissions: every test that uses the default stays green. That is checked, not assumed (step 4 of section 6).
- `JwtAuthenticationTest` test 18 is rewritten as test 4 above; the throwaway forbidden endpoint stays (it proves the 403 handler without depending on a real endpoint) minus its `@EnableMethodSecurity`.
- Tests that sign their own token with a narrower permission set (for example `team(id, "application:read")` against a GET) are checked against the matrix; a POST with only a read permission would now be a 403.

## 5. Risks to check, not assume

1. **Binding runs before the check.** For `@Valid @RequestBody` and `@Min` on request parameters, Spring resolves and validates arguments, then calls the method, and the security advice wraps the *call*. So a caller with no permission who sends a malformed body may get a 400 and learn the field rules. Test 7 records what actually happens. If it is a 400, the options are the filter-chain rule (decision 1, rejected) or accepting it: no data is read or changed, and the same caller can read the OpenAPI document anyway. The test pins the observed order so a change is noticed.
2. **The annotation is ignored without `@EnableMethodSecurity`.** This is the plan's red run: remove it and tests 1, 4, 5 and 6's annotation-presence part show what "written but not enforced" looks like. Test 6 passes in that state (the annotation is there); only tests 1, 4 and 5 catch the missing enablement. That is why both kinds of test exist.
3. **Proxy gaps.** A call from one method of a controller to another method of the same controller skips the proxy. No controller does that today; recorded for later.
4. **Exception translation.** `AccessDeniedException` thrown from inside the controller proxy reaches `ApiExceptionHandler` first. `rethrowSecurity` hands it on; if that handler were removed or narrowed, a missing permission would turn into a 500 (the S4.1 trap). Test 3 is the guard.
5. **A permission of the wrong kind on a row.** Marking `GET /deployments/{id}/tasks` with `deployment:create` instead of `deployment:read` passes test 6 and test 1. Test 2 (only the required permission, expect not 403) is what catches it, and only because the token has *one* permission.
6. **Lists leak across teams.** `GET /applications` returns every application whatever the caller's team, and the permission check cannot change that. Not S4.3 (section 7).

## 6. Order of work: find it broken first

1. Write tests 1 to 7 and `TestAuth.tokenWith`/`tokenWithout`. Run against the current code and record which are red and why (the column above is a prediction). Test 7 is run and its answer recorded.
2. **The plan's red run:** put the five-line `@PreAuthorize` annotations on the controllers **without** `@EnableMethodSecurity`. Run: tests 1, 4 and 5 stay red, test 6 goes green. This is the table of "annotations present, nothing enforced" for the Results.
3. Add `@EnableMethodSecurity` to `SecurityConfig`; remove the one from `JwtAuthenticationTest`. Tests 1 to 6 green.
4. Run the whole suite. Fix tests that signed a narrow token (section 4.3). Rewrite `JwtAuthenticationTest` test 18. `mvn verify`.
5. Mutation checks on a scratch copy, one change at a time: (a) change one row's annotation to the wrong permission, test 2 goes red; (b) change `hasAuthority` to `hasRole` on one method, test 6 or 5 goes red; (c) delete one annotation, test 6 goes red; (d) make a controller method `final`, test 1 goes red.
6. Manual check against the dev stack with two locally signed tokens: one with only `deployment:read`, one with all five. `curl` `GET /deployments/{id}` (both pass the check), `POST /deployments` (one 403, one 202) and read the 403 body.
7. Update the plan row, the S4 plan's DoD, the concepts guide (`sec-jwt` lesson: authorization), the Outline pages. Results section.

## 7. Not in S4.3

- **The owner-team check.** A token with `deployment:create` for team B can deploy team A's application: the converter discards which team granted the permission, and no endpoint compares the application's `ownerTeamId` with the token. That is the **S4.4 exploit, and it works after this step.** Writing its failing-for-the-right-reason test is the first act of S4.4.
- **Filtering lists by team** (`GET /applications`, and the 404-for-other-teams rule on single reads): S4.4.
- **`bearerAuth`, 401 and 403 in the OpenAPI document:** S4.6. After S4.3 the real answers include a 403 the document does not yet list; S4.6's contract test is what closes it.
- **Roles and role-to-permission mapping:** identity-service. control-api reads permissions only.
- **Per-permission audit of denials** (who was refused what): a later concern; the access log carries the 403 and the `correlationId` today.
- **Method security on service methods** (defence in depth below the controller): not needed while controllers are the only callers.

## 8. Decided 2026-10-05

All four open questions were answered with the recommendation:

1. **Releases use `application:create` and `application:read`.** A release is part of the application aggregate, and a sixth permission would also change identity-service's seed. Revisit if a role must publish releases without creating applications.
2. **Task history needs no permission of its own.** `deployment:read` covers a deployment, its tasks and `GET /tasks/{id}`.
3. **The 400-before-403 order is accepted if test 7 confirms it,** and the test pins it with a comment. The filter-chain `requestMatchers` rules stay rejected (decision 1); if the order ever matters, adding them as a second lock is the way, with a test that the two lists agree.
4. **One matrix, inside `PermissionEnforcementTest`,** used by tests 1, 2 and 6, so the three cannot drift apart.

## 9. Results

### 9.1 Red run 1, 2026-10-05: `PermissionEnforcementTest` against the code with no enforcement

27 tests run (11 + 11 parameterized rows, plus tests 3 to 7), **15 failures**, exactly the prediction:

- **Test 1**, all 11 rows red: the answer was 2xx or 404 instead of 403 (for example `Status expected:<403> but was:<202>`, `<201>`, `<200>`).
- **Test 3** (problem shape on `POST /deployments`), **test 4** (no permissions on `GET /applications`) and **test 5** (`DEPLOYER`, `ROLE_DEPLOYER`, `deployment:*`: a 202 where a 403 is required) red.
- **Test 6** (meta-test) red: the 11 handlers listed as "has no @PreAuthorize", which also shows the table of operations and the real handler mappings agree on the set of 11.
- **Test 2**, all 11 rows green (nothing is enforced, so nothing is refused) and **test 7** green (the invalid body is a 400 because validation runs first; it only becomes informative once enforcement exists).

### 9.2 Red run 2, 2026-10-05: the annotations without `@EnableMethodSecurity`

The eleven `@PreAuthorize("hasAuthority('...')")` annotations were on the controllers; `@EnableMethodSecurity` was not. 27 tests, **14 failures**:

- **Test 6 green:** the meta-test saw every handler declare its permission and the set equal to the table. It cannot tell that nothing is enforced.
- **Tests 1 (all 11 rows), 3, 4 and 5 red:** `Status expected:<403>` but 202 (3 times), 201 (once), 200 (twice) and 404 (eight times; the 404s come from random ids on rows that reach the handler). Written, not enforced: the annotations are ignored.
- Tests 2 and 7 green, as before.

The difference between run 1 and run 2 is one test: test 6. That is why both kinds of test exist (risk 2): the annotation-presence test passes while enforcement is absent; only the behaviour tests catch it.

### 9.3 Enforcement on, 2026-10-05

`@EnableMethodSecurity` added to `SecurityConfig`; the copy in `JwtAuthenticationTest` removed. `PermissionEnforcementTest`: **27 of 27 green.** Test 7 (invalid body, no permission) is a **400**, as predicted: Spring validates the body before it calls the proxied method, so the check never ran. Pinned with a comment (decision 3 of section 8).

Full `mvn verify` after that: 275 tests, **2 failures**, both a token with no permissions calling `GET /applications`:

- `tokenWithNoPermissions_authenticates` (test 18, expected): deleted; `PermissionEnforcementTest.tokenWithNoPermissions_is403` replaces it.
- `withinClockSkew_passes_beyondItFails` (**not predicted**): its first assertion used `user()` with no grants and expected 200. Fixed with `.perm("application:read")`. The section 4.3 prediction listed only tests that sign their own token with a narrower set; a token with *none* is the same case. The 90 s assertion stays 401, because authentication fails before any permission check.

After both fixes: `mvn verify` **274 tests, 0 failures, 2 skipped by design** (`common-security` 41, `fleet-audit-starter` 3).

### 9.4 Mutation checks, scratch copy, 2026-10-05

The repository copied without `target`, one change to `DeploymentController` at a time, the real file restored before the next, `PermissionEnforcementTest` run through the reactor (`-pl common-security,control-api -am`, nothing installed into `~/.m2`):

| Mutation | Failed | Reading |
|---|---|---|
| (a) `deployment:read` replaced by `deployment:create` on the annotation lines. The three methods share that exact line, so **three** rows changed (`GET /deployments/{id}`, `/tasks`, `/tasks/by-offset`), not one | test 6 (the table no longer matches); test 1 rows 7, 9, 10 (a token that holds `deployment:create` now passes); test 2 rows 7, 9, 10 (a token with only `deployment:read` is refused). 7 of 27 | the wrong permission is caught by all three kinds of test, which is what the matrix exists for |
| (b) `hasRole('deployment:rollback')` on the rollback method | test 6 (expression is not `hasAuthority(...)`); test 2 row 8 (only-the-permission token is refused, `hasRole` looks for `ROLE_deployment:rollback`). Test 1 stayed green. 2 of 27 | a role check hides from the "without" test and shows in the "only" test and the meta-test: why both exist |
| (c) annotation deleted on the rollback method | test 6; test 1 row 8. 2 of 27 | |
| (d) `final` on `requestRollback` | test 1 row 8 only. Test 6 stayed green (the annotation is there; CGLIB cannot override a final method, so the advice never runs). 1 of 27 | decision 7 and risk 2 shown: only the behaviour test catches a method that is not proxied |

### 9.5 Manual check, 2026-10-05

The jar built by the last `mvn verify` (enforcement on), profile `local`, Postgres on 55432 and Redis from compose, two tokens signed with `openssl` and the dev private key: a **read-only** caller (`deployment:read` only) and an **all-five** caller. The ids are random, so a 404 means "the permission check passed and the object does not exist".

| Request | read-only | all-five |
|---|---|---|
| `GET /deployments/{id}` | 404 (passed the check) | 404 |
| `POST /deployments/{id}/rollback` | **403** | 404 (passed the check) |
| `GET /applications?limit=1` | **403** | 200 |
| `POST /deployments` with body `{}` | **400** (validation runs first, the pinned order) | not sent |
| any request without a token | 401 | |

The 403 body: status 403, `Content-Type: application/problem+json`, `type` `urn:appfleet:problem:forbidden`, `title` `Forbidden`, `detail` "You do not have permission to perform this action", the request path as `instance`, and a `correlationId`. No `WWW-Authenticate` header was in the filtered output. No deployment or application row was written by this check.

### 9.6 What is true after S4.3, and what is not

- Every `/api/**` operation needs one permission, and a caller without it gets a 403 problem; a role name or `deployment:*` authorises nothing.
- A caller with `deployment:create` on **any** team can still deploy **any** team's application, and `GET /applications` still returns every team's applications. The converter keeps no team with the permission. That is the S4.4 exploit; the S4.4 design starts by writing its failing test.
- A caller who lacks the permission and sends an invalid body learns the validation rules (a 400) before the 403.
- The OpenAPI document does not list the 403 yet (S4.6).
- Not done in this step: the "table row with no endpoint" half of test 6's red run (an `Op` that matches no handler).

Concepts guide and Outline pages updated on 2026-10-05.

## Definition of done

- [x] Tests 1 to 7 written first; the red ones recorded, including the "annotations without `@EnableMethodSecurity`" run (sections 9.1 and 9.2)
- [x] Every one of the 11 operations answers 403 with the problem shape when the permission is missing, and is not 403 with exactly that permission (tests 1, 2, 3)
- [x] `@EnableMethodSecurity` is on `SecurityConfig`; the duplicate in `JwtAuthenticationTest` is gone
- [x] The meta-test fails when an endpoint has no `hasAuthority(...)` and when the matrix and the handlers differ (red in run 1, and in mutations (a) to (c); the "handlers differ the other way" case, a table row with no endpoint, was not run)
- [x] No `hasRole` or role string anywhere in control-api; a role name or a wildcard authorises nothing (test 5)
- [x] The answer of test 7 (invalid body, no permission) is recorded and pinned: 400
- [x] Mutation checks (a) to (d) seen red on a scratch copy (with the caveat on (a) in section 9.4)
- [x] `JwtAuthenticationTest` test 18 replaced; every other existing test green after one unpredicted fix (`withinClockSkew_passes_beyondItFails`)
- [x] Manual check with two tokens (section 9.5)
- [x] Results written; the plan's S4.3 row, the concepts guide and the Outline pages updated
- [x] `mvn verify` green (274, 2 skipped)
