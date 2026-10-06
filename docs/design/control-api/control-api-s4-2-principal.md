# control-api — S4.2: the principal replaces the three stand-ins

**Spec:** [01-CONTROL-API.md §S4](../../specs/project/01-CONTROL-API.md) · Step **S4.2** of [control-api-s4-plan.md](control-api-s4-plan.md) · Predecessor: [control-api-s4-1-jwt-validation.md](control-api-s4-1-jwt-validation.md) (the token is validated and the `JwtAuthenticationToken` is on the request) · Related: [control-api-s3-5-idempotency.md](control-api-s3-5-idempotency.md), [control-api-s3-6-rate-limiting.md](control-api-s3-6-rate-limiting.md). **Status: designed 2026-10-03, built and closed 2026-10-05.**

S4.1 made the API refuse a request without a valid token, but nothing yet uses the identity the token carries. Three places still stand in for a caller: a constant, a client-supplied header and an unscoped Redis key. This step replaces all three with the token's `sub` and proves, for each, what was wrong before.

This step still makes **no authorization decision**. It answers *who is calling*, never *what may they do* (S4.3 and S4.4).

## 1. What already exists

- **`DeploymentController.SYSTEM_ACTOR = "system"`** is passed as the `actor` of `requestDeployment` (twice, with and without an idempotency key) and `requestRollback`. It ends up in `audit_event.actor`, a `text NOT NULL` column (V1), so a UUID string needs no migration.
- **`HeaderTeamResolver`** implements `TeamResolver` and reads `X-Team-Id`: absent means the shared `anonymous` bucket, a non-canonical UUID throws `InvalidHeaderException` (a 400 with `errors[0].field` `X-Team-Id`, handled in `ApiExceptionHandler`). Its own comment says it is *spoofable on purpose*.
- **`RateLimitInterceptor`** is registered by `WebConfig` for `/api/**` only, calls `teamResolver.resolve(request)` and `RateLimiter.tryConsume(team)`, which keys Redis as `ratelimit:v1:team:<id>`. Rate limiting is **disabled in `application-test.yml`** and enabled by the tests that need it.
- **The idempotency key** is built in the controller as `"deployments:" + idempotencyKey` and prefixed by `IdempotencyStore` with `idempotency:v1:`. It has **no owner**. `IdempotencyKeys.validate` accepts 1 to 255 printable ASCII characters.
- **The OpenAPI document** adds an optional `X-Team-Id` header to every operation (`ErrorResponseCustomizer`, step 3) and `OpenApiContractTest` asserts it ("operations without an optional X-Team-Id").
- **Tests that name the header:** `RateLimitEndpointsTest`, `IdempotencyRedisDownTest`, `OpenApiContractTest`, `ProblemShapeTest` (the invalid-header probe and its row).
- **The default test token** (`TestAuth.defaultToken()`) has one fixed `sub`, shared by every test.

## 2. Behaviour

| Concern | Before | After S4.2 |
|---|---|---|
| Audit `actor` of a deployment or rollback request | `system` | the token's `sub` (a UUID string) |
| Rate-limit bucket | `X-Team-Id`, or `anonymous` | the token's `sub`: `ratelimit:v1:user:<sub>` |
| Idempotency record | `idempotency:v1:deployments:<key>`, shared by every caller | `idempotency:v1:deployments:<sub>:<key>` |
| `X-Team-Id` | read by the server and documented | **ignored** by the server, removed from the OpenAPI document, its 400 gone |

Observable consequences:

1. Caller B who sends the same `Idempotency-Key` as caller A neither receives A's stored answer nor gets a 422 for a different body: the two keys are different records.
2. A caller cannot widen their rate limit by sending a different `X-Team-Id` on every request.
3. Every `audit_event` row written from a request names the person who made it.

## 3. Decisions

1. **The principal is `Authentication.getName()`, which is the token's `sub`.** `AppfleetJwtAuthenticationConverter` already builds `JwtAuthenticationToken(jwt, authorities, name = sub)`. Controllers take `Authentication authentication` (or `JwtAuthenticationToken`) and pass `authentication.getName()` on. No new `Caller` class: a wrapper that only returns a string is more to read than the string. If S4.4 needs the raw claim it reads `getToken()` there. `getName()` is an opaque string on purpose: service accounts for node-agent (S5) will not have a UUID user id.
2. **The audit actor is the `sub`, not a display name.** The audit trail must survive a user being renamed or deleted, and it must not need a call to identity-service. A reader maps the UUID to a person through identity-service. `"system"` stays a legitimate actor for work that has no request (the S6 reaper); the constant moves out of the controller to where such work appears, or is deleted until then. Recorded in the open questions (section 8, 1).
3. **The rate-limit key is `sub`.** The plan's open question 5.3 recommended it: a *user* is the unit that floods, and the owner team of the target is not known before the handler runs. The interceptor runs inside MVC, after the security filter chain, so `SecurityContextHolder` already holds the authentication. The Redis key prefix changes to `ratelimit:v1:user:`. Old `team` buckets expire on their own (the bucket TTL); nothing needs migrating.
4. **`HeaderTeamResolver`, `TeamResolver` and `InvalidHeaderException` are deleted,** with the `invalidHeader` handler in `ApiExceptionHandler`, the invalid-header probe and row in `ProblemShapeTest`, and the invalid-header case in `RateLimitEndpointsTest`. Nothing else throws `InvalidHeaderException` (the idempotency key has its own exception). A server that ignores a header must not also validate it.
5. **The `anonymous` bucket stays as a defensive fallback.** The interceptor is only registered for `/api/**`, where the chain requires a token, so no request should reach it unauthenticated. If one ever does (a misconfigured chain), it lands in one shared bucket and a warning is logged: it fails closed against flooding rather than throwing a 500. The plan said the same (decision 8). No test can reach the fallback through the real chain; a unit test of the interceptor with an empty security context covers it.
6. **The idempotency key is scoped to the caller: `deployments:<sub>:<key>`.** The fingerprint check (S3.5) already stops a different *body* from reusing a key; this stops a different *caller* from seeing a record at all. Rejected: hashing the sub into the key (hides the owner when reading Redis by hand, saves nothing). The 255-character limit applies to the client's key only; the Redis key may be longer. **The format change orphans in-flight records:** a record stored under the old key is never found again, so a client that retries across the deployment of this change could execute twice. The 30 second and 24 hour TTLs bound it, and nothing is in production, so no migration; the sentence is here so it is a decision and not a surprise.
7. **`X-Team-Id` leaves the OpenAPI document in this step, not in S4.6.** The plan listed it under S4.6, but documenting a header the server ignores is wrong the moment S4.2 lands. `ErrorResponseCustomizer` loses its step 3 and `OpenApiContractTest` loses the optional-header assertion. The plan's S4.6 row is edited to match. The `bearerAuth` scheme and the global 401 and 403 remain S4.6.
8. **The decoder requires `sub`** (decided, section 8, 3). `common-security` gains a presence validator: a token whose `sub` is missing or blank is a 401, like any other invalid token, with the same body. Without it a token with no `sub` would authenticate with a null name, and the audit actor, the rate-limit key and the idempotency scope would all read `null`. It is a `JwtClaimValidator` in the decoder's delegating validator, with a unit test (`JwtSecurityAutoConfigurationTest`, red first against a decoder without it) and a test through the real chain (test 9).
9. **Tests get distinct callers where it matters.** `TestAuth` gains `tokenFor(UUID sub)`. The default token keeps one fixed `sub` (existing tests are about behaviour). Rate limiting stays disabled in the test profile, because one shared `sub` would put the whole suite in one bucket (the S3.6 lesson, with the anonymous bucket). The tests that enable it sign one token per test.

## 4. Tests

### 4.1 Written first, against the current code (the red runs)

| # | Test | Red today because |
|---|---|---|
| 1 | `differentCaller_sameKey_differentBody_isNotRejected` | caller B gets a 422 `idempotency-key-reused` for a key only A used |
| 2 | `differentCaller_sameKey_sameBody_isNotReplayed` | caller B receives A's stored 202 with `Idempotent-Replayed: true` and A's task id: the leak |
| 3 | `sameCaller_sameKey_sameBody_stillReplays` | green today and after; it pins that scoping did not break replay |
| 4 | `rotatingXTeamId_doesNotEscapeTheLimit` | one caller exhausts the bucket, then sends the next request with a fresh `X-Team-Id`: 200 today, must be 429 |
| 5 | `twoCallers_haveIndependentBuckets` | the missing S3.6 case 2, now by token: with the header resolver both callers share `anonymous` |
| 6 | `auditActor_isTheTokenSub` | after a deployment request, `audit_event.actor` is `system` today, must equal the `sub` |
| 7 | `rollbackAudit_actor_isTheTokenSub` | same for `ROLLBACK_REQUESTED` |
| 8 | `xTeamIdHeader_isIgnored` | a request with a malformed `X-Team-Id` is a 400 today, must be 200 |
| 9 | `tokenWithoutSub_is401` (in `JwtAuthenticationTest`; `TestJwt` needs a way to omit `sub`) and `missingSub_rejected` (decoder unit test in `common-security`) | today such a token authenticates (200); must be 401 with the standard body |

Test 2 needs a different outcome after the fix that is not a replay: caller B sending A's exact body hits the existing rule that an application cannot have two active deployments for one environment, so the **expected** answer is the 409 conflict, not a 202. The assertion is "not a replay and not A's task id", not "202".

### 4.2 Unit tests

- **`RateLimitInterceptorTest`:** with an authenticated context the limiter is called with the `sub`; with an empty context it is called with `anonymous` and a warning is logged; with `enabled=false` it is not called.
- **`IdempotencyKeys` scoping:** the key passed to the executor equals `deployments:<sub>:<key>` (the controller test with a captured argument, or a small helper that builds it, tested alone).

### 4.3 Contract

`OpenApiContractTest`: the document has **no** `X-Team-Id` parameter on any operation (the old assertion inverted). The other contract tests are unchanged.

## 5. Risks to check, not assume

- **The interceptor and the security context.** `SecurityContextHolder` is populated by the filter chain before MVC runs. With asynchronous dispatch it is not propagated by default; no endpoint here is async, and test 5 would show a null principal.
- **`getName()` for every token.** It is `sub` only because the converter passes it. S4.1's decoder did not require `sub`, so a token without one produced a null name; decision 8 closes that, and test 9 proves it.
- **Redis key length and characters.** The `sub` is a UUID today. If service accounts later use free-text names, the key could contain `:` and collide across scopes. Decision 1 keeps `getName()` opaque, so S5 must restrict its form or hash it.
- **`ProblemShapeTest`** loses two rows; confirm the shape tests still cover every `ProblemKind` slug after the handler is deleted (the `validation-failed` slug is still produced by bean validation).
- **A shared `sub` in `TestAuth`** hides a bug that only appears with two callers. Tests 1, 2 and 5 are the ones that use two tokens; that is their point.
- **The old `ratelimit:v1:team:*` keys** stay in a long-lived dev Redis until their TTL ends. Harmless; mentioned so nobody wonders.

## 6. Order of work: find it broken first

1. Write tests 1 to 8 against the current code. Record which are red and why (the column above is a prediction, to be checked).
2. **Require `sub`** (decision 8): the validator in `common-security`, its unit test red first against a decoder without it, test 9 green. Reinstall `common-security` (`mvn install`) so control-api sees it.
3. **`sub` as the audit actor** (decision 1 and 2): controller takes the authentication; tests 6 and 7 green.
4. **Idempotency scope** (decision 6): tests 1 and 2 green, test 3 still green. Inspect the Redis key by hand once (`redis-cli --scan --pattern 'idempotency:v1:*'`).
5. **Rate limit by `sub`** (decision 3 and 5): `RateLimitInterceptor` reads the authentication; the prefix becomes `ratelimit:v1:user:`; tests 4 and 5 green; the unit test of 4.2.
6. **Delete the header** (decision 4 and 7): `HeaderTeamResolver`, `TeamResolver`, `InvalidHeaderException`, the handler, the probe rows, the OpenAPI parameter; test 8 and the contract test green.
7. **Update what names the old key:** `docs/design/control-api/control-api-s3-6-rate-limiting.md` (a note at the Redis key line, not a rewrite of history) and the Redis lesson in the concept guide (`js/labs-redis.js`, the `ratelimit:v1:team:` string in the rate-limit lab).
8. `mvn verify`; manual check with two locally signed tokens against the dev stack (two `sub`s, the same `Idempotency-Key`, a Redis scan). Results section.

## 7. Not in S4.2

- Any permission check on an endpoint (S4.3) or the owner-team check (S4.4).
- The `bearerAuth` scheme and the 401 and 403 responses in the OpenAPI document (S4.6).
- Service-to-service identities for node-agent (S5).
- Renaming `rate-limit` configuration keys or the `team` wording in the S3.6 doc beyond what the code change forces.
- Sharing an idempotency record across a team (see section 8, 2).

## 8. Decided 2026-10-03

All five open questions were answered with the recommendation:

1. **The actor value: the `sub` only.** A display name copied into the token and the audit row reads better in a log and goes stale when someone is renamed; the audit trail must survive renames and must not need identity-service.
2. **Idempotency scope: the user (`sub`).** A team-wide key would let two people on one team share a retry, which is not what an idempotency key is for: the key belongs to one client's one request.
3. **The decoder requires `sub`.** Decision 8; a presence validator in `common-security`, a unit test and test 9.
4. **The `anonymous` fallback stays,** with a warning log (decision 5). A broken chain then fails closed against flooding instead of answering 500.
5. **The Redis prefix is renamed** to `ratelimit:v1:user:`. The old `team` keys expire by themselves; the S3.6 doc gets a note and the concept guide's Redis lesson is updated (step 7 of section 6).

## 9. Results

Run 2026-10-05, after steps 5 to 7.

**Code.** `RateLimitInterceptor` takes `AppfleetProperties` and `RateLimiter` only; it reads `SecurityContextHolder`, uses `authentication.getName()` (the `sub`), and falls back to `anonymous` with a warning when there is no authenticated principal. `RateLimiter` prefix is `ratelimit:v1:user:`. `HeaderTeamResolver`, `TeamResolver`, `InvalidHeaderException` and its handler are deleted; `ErrorResponseCustomizer` no longer adds `X-Team-Id`. The 429 detail now says "this caller".

**Tests.**
- Before step 5, `RateLimitEndpointsTest` was run against the old test file: 11 tests, 8 failures (every test shared the default token's bucket). After the rewrite with one caller per test: 8 tests, 0 failures, including `rotatingXTeamId_doesNotEscapeTheLimit` and `xTeamIdHeader_isIgnored`, which were red before the interceptor change (200 instead of 429, 400 instead of 200; recorded 2026-10-03).
- Added `twoCallers_haveIndependentBuckets`; removed `noHeader_sharesAnonymousBucket` and `invalidTeamHeader_is400`; the anonymous fallback moved to `RateLimitInterceptorTest` (5 unit tests: sub key, no authentication, unauthenticated token, denied, disabled). `OpenApiContractTest` now asserts that no operation documents `X-Team-Id`; the `invalidHeader` probe and test left `ProblemShapeTest`.
- `mvn verify`: 248 tests, 0 failures, 2 skipped by design. The Lettuce "Event loop shut down" lines in the log come from the Redis-down test at shutdown, not from a failure.
- Steps 2 to 4 (decoder `sub`, audit actor, idempotency scope) were verified on 2026-10-03.

**Seen red on a scratch copy, 2026-10-05** (the repository copied without `target`, one mutation at a time, the real file restored before the next; reactor run `-pl common-security,control-api -am`, so nothing was installed into `~/.m2`):

| Mutation | Tests that failed |
|---|---|
| M1: the `sub` validator removed from the decoder | `JwtSecurityAutoConfigurationTest.missingSub_rejected` and `blankSub_rejected` (2 of 18); then, with `common-security` tests skipped so the build reaches control-api, `JwtAuthenticationTest.tokenWithoutSub_is401` (1 of 22) |
| M2: idempotency key built as `"deployments:" + idempotencyKey` (no `sub`) | `IdempotencyEndpointsTest`: `differentCaller_sameKey_differentBody_isNotRejected` (tests 1), `differentCaller_sameKey_sameBody_isNotReplayed` (test 2), `redisKey_isScopedToTheCallersSub`, and `claimInProgress_returns409_withRetryAfter` plus one error, which build their Redis key through the scoped helper; 17 tests run, 4 failures and 1 error. `sameCaller_sameKey_sameBody_stillReplays` (test 3) was not among the first failures printed and is expected green; not separately confirmed |
| M3: both actors set to `"system"` | `DeploymentEndpointsTest.auditActor_isTheTokenSub` and `rollbackAudit_actor_isTheTokenSub` (tests 6 and 7), 2 of 26 |

Red from the 2026-10-03 records: tests 4 and 8 (`RateLimitEndpointsTest`: 200 instead of 429, 400 instead of 200). Test 5 (`twoCallers_haveIndependentBuckets`) was written after the interceptor change and was **not** seen red on its own. Whether each test was written before its fix cannot be shown from the working tree; what is shown is that every one of tests 1, 2, 4, 6, 7, 8 and 9 fails when its fix is removed.

**Manual check, 2026-10-05** (jar, profile `local`, capacity 3 through `APPFLEET_RATELIMIT_CAPACITY`, Postgres on 55432 and Redis from compose, tokens signed with `openssl` and the dev private key):
- alice, 5 calls: `200 200 200 429 429`.
- bob, 1 call while alice was empty: `200`. Buckets are independent per `sub`.
- The 429 is `urn:appfleet:problem:rate-limited` with `Retry-After: 1` and the detail "The rate limit for this caller is exhausted. ..."
- `X-Team-Id: not-a-uuid` with bob's token: `200` (was 400 before S4.2). No token: `401`.
- **Redis scan, second run the same day** (default capacity 60, one request with a valid token for `sub` `…cccc` and an `X-Team-Id` header, scan right after): `--scan --pattern 'ratelimit:*'` returned exactly `ratelimit:v1:user:00000000-0000-0000-0000-00000000cccc`, with `tokens` 59, a `ts`, and `PTTL` 59032 ms. No `team:` key exists, so the header created no bucket. The first run's scan was empty only because it came after the bucket's expiry.
- **Not observed:** a rotating `X-Team-Id` in the manual run (my UUID generator failed on Windows; the automated test covers rotation), and the idempotency record `idempotency:v1:deployments:<sub>:<key>` by hand (covered by the four scoping tests, not re-checked live).

**Left alone on purpose.** `labs-redis.js` still describes the S3.6 header resolver in its lab prose (line 689) and the `no X-Team-Id` bucket label (line 725); only the key string changed. `site-backend.js:60` still says rate limiting takes the team from `X-Team-Id`. Outline sync not done yet.

## Definition of done

- [x] Tests 1 to 9 written; the red ones recorded (tests 1, 2, 4, 6, 7, 8, 9 seen red by removing their fix; test 5 not seen red on its own; the write-before-fix order is not provable from the tree, section 9)
- [x] The decoder rejects a token with no or blank `sub` (unit tests seen red without the validator, test 9 through the real chain seen red too; 2026-10-05)
- [x] `audit_event.actor` is the token's `sub` for a deployment and a rollback request (tests 6 and 7 green, red with the actor set to `"system"`)
- [x] The idempotency record is scoped to the caller; caller B cannot see or collide with caller A's record; same-caller replay still works (tests 1 to 3 and `redisKey_isScopedToTheCallersSub` green; tests 1, 2 and the key test red when the `sub` is dropped from the key)
- [x] The rate-limit bucket is the `sub`; rotating `X-Team-Id` no longer escapes it; two callers have independent buckets
- [x] `HeaderTeamResolver`, `TeamResolver` and `InvalidHeaderException` are gone, and no code reads `X-Team-Id` (tests still send the header on purpose, to prove it is ignored)
- [x] The OpenAPI document has no `X-Team-Id`; the contract test says so
- [x] Every other existing test green
- [x] Manual check with two tokens and a Redis scan (rate-limit key seen live; the idempotency record was not inspected by hand, see section 9)
- [x] Results section written; the plan's S4.2 and S4.6 rows updated (S4.2 row annotated 2026-10-05; the S4.6 row already said `X-Team-Id` leaves the document in S4.2)
- [x] `mvn verify` green (248, 2 skipped)
