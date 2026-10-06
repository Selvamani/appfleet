# control-api — S4: authentication, authorization and the outbox (plan)

**Spec:** [01-CONTROL-API.md §S4](../../specs/project/01-CONTROL-API.md) — *"the split: what control-api loses and gains"* · Companion specs: [02-IDENTITY-SERVICE.md](../../specs/project/02-IDENTITY-SERVICE.md) (who issues the tokens), [03-TASK-SERVICE.md](../../specs/project/03-TASK-SERVICE.md) (what the outbox feeds) · Predecessor: [control-api-s3-rest.md](control-api-s3-rest.md). **Status: S4.1 to S4.5 done; S4.6 built 2026-10-06.**

S4 in the build guide is three modules at once: control-api gains authentication, authorization and the outbox; **identity-service** is built; **task-service** is extracted. This doc covers **the control-api side only**. identity-service and task-service each get their own plan, because each is a module the size of S3. The order in section 2 is chosen so that control-api can be finished and tested before either of them exists.

## 1. Starting point

What S3 left, and what each item costs S4:

- **No authentication.** `TemporaryOpenSecurityConfig` permits `/api/**`, `/actuator/health`, `/actuator/info` and the docs paths, then `denyAll()`. It is marked TEMPORARY and S4 deletes it.
- **`common-security` is an empty module.** Its `pom.xml` has `spring-boot-starter-security` and `spring-security-oauth2-jose` and a comment describing the intent; there is no Java file. control-api already depends on it.
- **identity-service is a skeleton:** a `pom.xml` and `IdentityServiceApplication`. Nothing issues a token.
- **Three places that stand in for a principal:**
  - `DeploymentController.SYSTEM_ACTOR = "system"`, the `actor` of every audit row.
  - `HeaderTeamResolver` (`X-Team-Id`), the rate-limit key; absent means the shared `anonymous` bucket. The OpenAPI document adds `X-Team-Id` to every operation by hand for it.
  - The idempotency key, `idempotency:v1:deployments:<key>`, which has **no owner**. Today two callers who choose the same key share a record. With authentication that is a leak: caller B can replay caller A's answer, or block it with a 409.
- **`ownerTeamId` is already a plain column** on `application`. The `control` schema has **no User or Team table**, so the spec's "control-api loses the User/Team tables" is a no-op: there is nothing to move. Recorded so it is not looked for.
- **The outbox exists, unused.** `outbox_message` (V1) and `OutboxMessage` plus `OutboxMessageRepository` are in the code. Nothing writes to it, and there is no poller.
- **Kafka is in compose** (KRaft, `task.work` with 6 partitions, DLTs created by `kafka-init`) and `spring-kafka` is on the control-api classpath. There is no Kafka Testcontainer.
- **Problem types for 401 and 403 do not exist.** The matrix in S3 §3.2 has no row for them, and `ProblemKind` and the OpenAPI document have no `bearerAuth` scheme.
- **222 tests**, every web test unauthenticated. Turning authentication on makes all of them need a token.

## 2. Order of work

| Step | What | Depends on | Red run to do first |
|---|---|---|---|
| **S4.1 JWT validation** ([design](control-api-s4-1-jwt-validation.md)) **DONE 2026-10-03** (238 tests green, `mvn verify` green, manual `curl` check passed) | `common-security`: RS256 validation with a configured public key, a `JwtAuthenticationConverter` that maps the token to authorities, 401 and 403 in the problem shape. Delete `TemporaryOpenSecurityConfig`. A test helper that signs tokens with a test key pair | none | with authentication on and no token helper, count the failing tests |
| **S4.2 The principal** ([design](control-api-s4-2-principal.md)) **DONE 2026-10-05** (248 tests green, two-token manual check and Redis key scan passed) | `SYSTEM_ACTOR` becomes the token's `sub`; the rate-limit team comes from the token, not `X-Team-Id`; the idempotency key is scoped to the caller | S4.1 | show caller B replaying caller A's key |
| **S4.3 Method security** ([design](control-api-s4-3-method-security.md)) **DONE 2026-10-05** (274 tests green, red runs and four mutation checks recorded, two-token manual check passed) | permissions, not role names, in `@PreAuthorize`; `@EnableMethodSecurity`; the meta-test that a protected endpoint really answers 403 | S4.1 | annotations without `@EnableMethodSecurity`: nothing is enforced |
| **S4.4 The IDOR** ([design](control-api-s4-4-idor.md)) **DONE 2026-10-05** (325 tests green, exploit seen red then closed, eight mutation checks, V5 index) | **build it first:** the deploy endpoint checks the permission only. The exploit test: a deployer on Team A deploys Team B's application. Then a `PermissionEvaluator` that compares the token's team grants with `Application.ownerTeamId`; the exploit fails with 404 | S4.3 | the exploit test passes (that is the bug) |
| **S4.5 The outbox** ([design](control-api-s4-5-outbox.md), [code](control-api-s4-5-outbox-code.md)) **DONE 2026-10-06** (340 tests green, both wrong designs shown failing, kill -9 kill-test passed) | `OutboxMessage` written in the same transaction as the state change (deployment, rollback); a poller publishes to Kafka, marks `sent_at`, deletes. Kafka Testcontainer. **Kill-test:** stop between commit and publish, restart, the message still goes out | none (can run before S4.1) | a publish inside the transaction, then a rollback: a message is sent for a change that never happened |
| **S4.6 OpenAPI security** ([design](control-api-s4-6-openapi-security.md)) **BUILT 2026-10-06** (346 tests green, four mutation checks seen red; app checked with curl; browser Authorize flow worked, user-reported) | the `bearerAuth` scheme, 401 and 403 on every operation (the two `ProblemKind`s exist since S4.1; `X-Team-Id` leaves the document in S4.2), contract tests updated | S4.1, S4.2 | the contract test fails until the scheme is added |

S4.5 does not need authentication, so it can be built first if Kafka is more interesting than JWTs. After S4.1 to S4.6, **identity-service** (its own plan) replaces the test token helper with real issuance; control-api's tests keep the helper and add one test that proves a token from identity-service is accepted.

## 3. Decisions

1. **control-api first, with test-signed tokens; identity-service afterwards.** The alternative is to build identity-service first so that real tokens exist. Rejected: identity-service is a module of its own (register, login, refresh rotation, JWKS, lockout, audit), and none of it is needed to prove that control-api validates, authorizes and publishes. The identity DoD, "stop identity-service and the request path still authorizes", is also easier to prove when control-api was built to need nothing from it.
2. **A static public key first, JWKS later.** control-api reads the RSA public key (PEM) from a property. The JWKS endpoint and `kid` rotation belong to identity-service. Moving control-api from a static key to a JWKS source is a configuration change in `common-security`, recorded as a follow-up, not S4.1.
3. **Permissions are enforced, roles are bundles.** The spec's sentence, to be able to say: *enforcement checks permissions, never role names, so a new role needs no code change.* control-api's `@PreAuthorize` uses authorities such as `deployment:create`, never `hasRole('DEPLOYER')`. The S4 spec's "the deploy endpoint checks `hasRole('DEPLOYER')` only" is the **deliberate first bug** of S4.4 and is written as the broken version on purpose.
4. **Team-scoped grants in the token.** A compact claim, for example `teams: { "<teamId>": ["deployment:create", "deployment:rollback"] }`. The shape is an open question (section 5, 2). The IDOR check is: the application's `ownerTeamId` must be a key of that map, and the map's entry must contain the permission.
5. **A caller without access gets 404, not 403,** for an object that exists but belongs to another team. This is the S3 decision (§3.2), now applied. A caller who lacks the permission **for the endpoint at all** gets 403.
6. **401 and 403 use the problem shape.** The security filter chain runs before MVC, so `ApiExceptionHandler` never sees them: an `AuthenticationEntryPoint` and an `AccessDeniedHandler` write `application/problem+json` with the `correlationId`, the types `urn:appfleet:problem:unauthorized` and `urn:appfleet:problem:forbidden`, and `WWW-Authenticate: Bearer` on the 401. The `ProblemKind` enum gains both, so the documentation and the handler stay one list (S3.7).
7. **The idempotency key is scoped to the caller:** `idempotency:v1:deployments:<sub>:<key>`. The fingerprint check (S3.5) already stops a different body from reusing a key; this stops a different caller from seeing a record at all. Changing the Redis key format is a compatibility break for any in-flight record; the 30 s and 24 h TTLs bound it, and no migration is needed.
8. **The rate-limit bucket is per team from the token,** with the `anonymous` bucket kept for unauthenticated requests that reach the interceptor (none, once the chain requires a token, except the health endpoints that the interceptor does not cover). `HeaderTeamResolver` is deleted. Which team of several a user acts for is an open question (section 5, 3).
9. **Actuator stays as S3 left it** (`health` and `info` open, the rest denied) until a decision about operations access is made. Not S4.
10. **The outbox poller is a scheduled job inside control-api,** not a Kafka Connect or Debezium setup. Delivery is **at least once**; consumers (task-service) are idempotent by `idempotencyToken` per its spec. The poller must be safe on several instances (`SELECT ... FOR UPDATE SKIP LOCKED`), and that is a test, not an assumption.
11. **No dual write.** The state change and the `outbox_message` row are one transaction. The publish never happens inside it. This is the sentence the kill-test proves.

## 4. What S4 (control-api side) deliberately does not do

- Build identity-service or issue a real token (its own plan).
- Extract task-service or consume `task.work` (its own plan; S4.5 only publishes).
- JWKS fetching and key rotation, the Redis denylist by `jti`, refresh tokens. Identity-service and a follow-up in `common-security`.
- Service-to-service authentication (API keys for node-agent). S5.
- CORS, rate-limit changes beyond the key, per-endpoint costs.
- A Debezium or CDC outbox.
- CSRF: the API is stateless with bearer tokens and keeps CSRF disabled, as `TemporaryOpenSecurityConfig` does today; the reason is to be written down in S4.1.

## 5. Open questions (yours to decide)

1. **Order.** Recommendation in section 3, 1: control-api first with test-signed tokens. Alternative: S4.5 (the outbox) first, because it needs no authentication and the Kafka Testcontainer is its own piece of plumbing. Which first?
2. **The shape of the teams claim.** `teams: {id: [perms]}` as in decision 4, or `roles` per team (`{id: "DEPLOYER"}`) and a role-to-permission map inside control-api? The spec says the token carries *permissions* and warns about the ~1 KB header limit; a map of permissions per team grows with the number of teams. Recommendation: the map of permissions, with a stated limit on teams per token.
3. **Which team does a request act for?** A user in several teams can deploy for any team that grants the permission, so the *target object's* team decides authorization (decision 4). The **rate-limit bucket** needs one key: `sub`, or the owner team of the target, or the first team in the token? Recommendation: `sub`. A user, not a team, is the unit that floods, and the owner team is not known before the handler runs.
4. **Where the public key lives in tests.** One test key pair in `common-security`'s test jar, used by control-api and later by identity-service's tests? Or a key per module? Recommendation: one, in a `common-security` test-fixtures artifact.
5. **The actuator.** Leave as is (decision 9), or require a role for `metrics` now?
6. **Kafka topic for the outbox.** `task.work` (already created, 6 partitions, keyed by deployment id = the per-aggregate order the task-service spec relies on) is the obvious target. Confirm the message key is `aggregate_id`.

## 6. Definition of done for the control-api side of S4

- [ ] S4.1 to S4.6 each have their own design doc and are implemented and green
- [ ] No request is accepted without a valid token except `/actuator/health`, `/actuator/info`; 401 and 403 use the problem shape with a passing shape test each
- [ ] The permission check is by authority, never by role name; the meta-test proves a protected endpoint answers 403
- [ ] The IDOR exploit test was **red against the broken version and green against the fix**, and is kept
- [ ] The idempotency key is scoped to the caller, with a test that caller B cannot see caller A's record
- [ ] The outbox kill-test passes: the message goes out after a restart between commit and publish
- [ ] `TemporaryOpenSecurityConfig`, `HeaderTeamResolver` and the `X-Team-Id` header documentation are gone
- [ ] OpenAPI documents `bearerAuth`, 401 and 403
- [ ] `mvn verify` green with Testcontainers Postgres, Redis and Kafka
