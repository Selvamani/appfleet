# control-api — S3: REST + Redis, the plan

**Spec:** [01-CONTROL-API.md §S3](../../specs/project/01-CONTROL-API.md) · Slice **S3** · Port **8081** · Schema **`control`** · Package root `io.appfleet.control`

Companion: [control-api.md](control-api.md) (index and S0), [control-api-s2-lazy-initialization.md](control-api-s2-lazy-initialization.md) (`open-in-view` is off, so controllers must receive fully loaded data), [control-api-s2-lineage-and-projection.md](control-api-s2-lineage-and-projection.md) (`DeploymentListView`), [control-api-s2-optimistic-lock.md](control-api-s2-optimistic-lock.md) (conflict policy this slice turns into a status code), [../../specs/project/00-BUILD-GUIDE.md](../../specs/project/00-BUILD-GUIDE.md) (shared conventions). **Status: plan, not yet implemented. No S3 code exists.**

S3 is seven checklist items, each big enough to hide a real design decision. This doc does not design all seven in detail. It fixes the order, the decisions that cut across every endpoint, and the questions only you can answer. Each step below gets its own design doc *immediately before* it is built, the same discipline as S2. Designing all of S3 up front would be speculation about code that does not exist.

## 1. Starting point

What exists:

- `spring-boot-starter-web`, `-validation`, `-data-redis`, `-actuator` are already in `control-api/pom.xml`. Redis 7 is in `docker-compose.yml`.
- The service layer is a set of demonstration methods (`DeploymentService.createBroken`, `create`, `createRiskyDefault`, and so on). `create` **always throws by design** (the audit-survival test). There is **no real "create a deployment" method**.
- Records `DeploymentSummary(id, status, taskCount)` and interface projection `DeploymentListView` exist as read models.
- `spring.jpa.open-in-view: false`.

What is missing, found by looking at the tree, not assumed:

- **No controller of any kind.**
- **No `X-Correlation-Id` handling.** The build guide says correlation is "decided once in Slice 0". It was never built here. It is a prerequisite for the error shape, because the error body carries the correlation id.
- **No `springdoc` dependency** (needed for the OpenAPI item).
- **No Redis Testcontainer in tests.** Idempotency and rate limiting need a real Redis.
- **No application or release write methods.** `POST /applications` and `POST /applications/{id}/releases` have nothing to call except raw repositories.
- **Spring Security is active with its defaults** (found by probing the running app, see [control-api-s3-1-foundations.md §8](control-api-s3-1-foundations.md)): every request outside `/actuator/health` returns 401. S3.1 adds a temporary open chain, removed in S4.
- **Startup noise:** Spring Data Redis logs an INFO per JPA repository ("could not safely identify store assignment"). Harmless, but it means the app has not told Spring Data that Redis is not a repository store. Fix in step 1 with `spring.data.redis.repositories.enabled: false`, and verify the messages go away.

## 2. Order of work

Ordered by dependency, simplest first, so each step builds on something already proven.

| Step | Checklist items | Needs first | Own doc |
|---|---|---|---|
| **S3.1 Foundations** | `ProblemDetail` advice, correlation id filter, error-shape tests, Redis property fix | nothing | yes |
| **S3.2 Applications and releases** | `POST /applications` (201 + `Location`), `POST /applications/{id}/releases`, `GET /applications?cursor=&limit=`, Bean Validation, hand mapping | S3.1 | yes |
| **S3.3 Deployments** | `POST /deployments` (202), `GET /deployments/{id}`, `POST /deployments/{id}/rollback` (202), conflicts as 409 | S3.1, a real create method in `DeploymentService` | yes |
| **S3.4 Task history and pagination** | `GET /deployments/{id}/tasks?cursor=`, an offset twin endpoint, the page-10,000 benchmark | S3.3, **seed volume** | yes |
| **S3.5 Idempotency keys** | Redis `SET NX` with TTL, replay, in-flight 409, concurrent-POST test | S3.3, Redis Testcontainer | yes |
| **S3.6 Rate limiting** | token bucket per team in Redis, 429 + `Retry-After` | S3.5 (same Redis plumbing) | yes |
| **S3.7 OpenAPI** | springdoc, grouped, errors documented | all endpoints | short |

Why this order:

- S3.1 first, because every later endpoint fails through the advice. Writing it after the controllers means retrofitting every error path.
- Applications and releases before deployments: they are plain CRUD with no state machine, so they validate the whole stack (JSON, validation, `Location`, cursor) on the easy case.
- Pagination benchmark is separated from the endpoints on purpose. It needs **1M+ tasks**, and the seed generator is the S1 exercise that was **parked**. The benchmark step is where it must be un-parked. Flagged again in section 5.
- Idempotency before rate limiting: both use Redis and both need a Redis Testcontainer, so the plumbing is built once.

## 3. Decisions that apply to every endpoint

Decided here so the seven steps do not re-argue them.

### 3.1 Error shape

One shape, RFC 7807 `ProblemDetail`, for every failure. The advice extends `ResponseEntityExceptionHandler`, so standard Spring MVC exceptions (malformed JSON, missing parameter, unsupported media type, method not allowed) also come out in the same shape, not as Boot's default error JSON. Verify that: the spec's "one shape" requirement fails if a single MVC exception escapes it.

Fields on every error body:

| Field | Value |
|---|---|
| `type` | `urn:appfleet:problem:<slug>`, for example `urn:appfleet:problem:illegal-transition` |
| `title` | short, stable per `type` |
| `status` | HTTP status |
| `detail` | human sentence for this occurrence |
| `instance` | the request path |
| `correlationId` | extension, value of `X-Correlation-Id` |
| `errors` | extension, **only** on validation failures: list of `{field, message}` |

`type` is the stable contract clients switch on. `detail` is free text and may change.

### 3.2 Status code matrix

| Situation | Status | `type` slug |
|---|---|---|
| Malformed JSON, wrong field type, missing required header | 400 | `malformed-request` |
| Bean Validation failure on a well-formed body | 400 | `validation-failed` |
| Well-formed, valid, but the domain rejects it (for example a release that belongs to a different application) | 422 | `unprocessable` |
| Id does not exist | 404 | `not-found` |
| Illegal state transition (`IllegalStateException` from `Deployment.transitionTo`) | 409 | `illegal-transition` |
| Optimistic-lock failure (`ObjectOptimisticLockingFailureException`) | 409 | `concurrent-modification` |
| Unique violation (duplicate application name) or the active-deployment partial index | 409 | `conflict` |
| In-flight duplicate idempotency key | 409 + `Retry-After` | `request-in-progress` |
| Idempotency key reused with a different request body (added in S3.5) | 422 | `idempotency-key-reused` |
| Backing service unreachable, for example Redis for a keyed request (added in S3.5) | 503 + `Retry-After` | `service-unavailable` |
| Rate limit empty | 429 + `Retry-After` | `rate-limited` |

The 400-versus-422 rule, stated so it can be applied without judgement: **400 means the request could not be understood or does not satisfy its own schema; 422 means the request is fine on its face and the server refuses it on domain grounds.** 409 always means "your request is fine, the current state of the resource conflicts with it". Three different causes share 409, so `type` must distinguish them.

The 404-versus-403 information-leak point does not apply yet, because there is no authentication until S4. Decision recorded now for S4: **a caller who lacks permission on an object gets 404, not 403**, so the API does not confirm the object exists.

The optimistic-lock policy from [control-api-s2-optimistic-lock.md](control-api-s2-optimistic-lock.md) (fail fast, no automatic retry) is what makes that 409 correct. The `detail` should tell the client to re-read and retry deliberately.

### 3.3 Layout

Controllers and DTOs live next to their domain in a `web` subpackage. Cross-cutting web code lives in one shared package:

```
io.appfleet.control.application.web     ApplicationController, CreateApplicationRequest, ApplicationResponse
io.appfleet.control.deployment.web      DeploymentController, CreateDeploymentRequest, DeploymentResponse
io.appfleet.control.task.web            TaskController, TaskResponse
io.appfleet.control.web                 ApiExceptionHandler, CorrelationIdFilter, CursorCodec, ProblemTypes
```

The rule that keeps this honest: **services and repositories never depend on HTTP.** They may import pure data records (`ApplicationResponse`, `CursorPage`) and pure helpers (`CursorCodec`) that live in a `..web` package, because those have no Spring MVC or servlet types. They must never import controllers, the exception advice, `HttpServletRequest`, `ResponseEntity` or any other Spring MVC type. Controllers depend on services, never the reverse, and entities never appear in a controller signature. (The first wording of this rule, "nothing under `..web` is imported by a service", contradicted the design itself and was corrected during S3.2.)

### 3.4 DTOs and mapping

All request and response types are records. **Hand mapping**, no MapStruct: with around six response types, a static factory (`DeploymentResponse.from(...)`) per type is less machinery than an annotation processor and is trivial to test. Revisit if the count grows past what is comfortable to maintain by hand. The spec allows either.

Because `open-in-view` is off, **every mapping happens inside a service method that returns already-built DTOs or fully loaded data**, never in the controller against a lazy entity. `listSummaries()` is the existing example of the pattern.

### 3.5 Cursor pagination

- The cursor is opaque: base64url of the last returned id. Clients never parse it. It is not signed, since it carries no secret, and a tampered cursor is just a different (valid) position or a 400.
- Keyset on `id` alone: `where id > :cursor order by id limit :limit + 1`. **IDs are UUIDv7, which sort by creation time**, so `id` order is also chronological order and is stable under concurrent inserts, because new rows always sort after the cursor. This is the payoff of the UUIDv7 convention.
- Fetch `limit + 1` rows. If `limit + 1` come back, there is a next page. Return `limit` rows and `nextCursor`. If not, `nextCursor` is null.
- `limit` has a default and a hard maximum (proposed 20 and 100). Out of range gives 400 `validation-failed`.
- The offset twin (`?page=&size=`) exists **only** for the benchmark in S3.4, and is documented as not recommended.

### 3.6 Testing

Per the build guide, boundary-crossing tests are `@SpringBootTest` with Testcontainers. Web tests use the full context and MockMvc (or Boot's newer test client, whichever the installed Boot version provides; check, do not assume) against Testcontainers Postgres, plus Redis from S3.5.

Error-shape test: one parameterized test with a row per `type` slug, asserting `status`, `type`, `title`, `instance`, presence of `correlationId`, and `errors` only where expected. Slugs that are hard to trigger through real endpoints (optimistic lock, in-flight idempotency) are triggered through a small **test-only controller** registered in a `@TestConfiguration`. The advice is what is under test, not the endpoint.

Shared boilerplate: the Testcontainers block is now in many test classes. S3 adds a Redis container. **Extract an abstract base with shared static containers before S3.5**, so Spring caches one context and the suite does not start a container per class. Recommended in the earlier docs, now due.

## 4. What S3 deliberately does not do

- **No authentication or authorisation.** Those are S4. Until then there is no caller identity, which is why the audit actor is an open question below.
- **No outbox, no Kafka publishing, no events.** Those are S4 and S6. `POST /deployments` writes state and an audit row, and nothing is published.
- **No saga and no worker.** Nothing picks up a `PENDING` task, so a deployment created in S3 stays `PENDING`. That is expected.
- **No `current_status` maintenance.** S6's `AFTER_COMMIT` listener owns it.

## 5. Open questions (yours to decide)

Each has a recommendation so the answer can be one word.

1. **`Location` for `POST /deployments`.** The spec says `Location: /tasks/{id}`, but the endpoint list has no `GET /tasks/{id}`. A 202 with a `Location` that 404s is a broken contract. Recommendation: add a minimal `GET /api/v1/tasks/{id}` in S3.3 (id, status, deployment id, timestamps). Alternative: point `Location` at the deployment. **Answered in S3.3: recommendation taken.**
2. **What does `POST /deployments/{id}/rollback` do in S3?** There is no saga yet. Recommendation: validate that a rollback is legal from the current state (only `HEALTHY` or `DEGRADED`; otherwise 409), record a `ROLLBACK` task in `PENDING`, return 202, and **do not** change the deployment's status. The status change belongs to whatever executes the task (S5 and S6). Alternative: transition straight to `ROLLED_BACK`, which is legal from those two states, but that makes the 202 a lie because nothing was actually rolled back. **Answered in S3.3: recommendation taken.**
3. **Audit actor.** `AuditEvent` needs an actor and there is no caller identity yet. Recommendation: a constant `"system"` now, replaced by the authenticated principal in S4. Alternative: an `X-Actor` header, which is spoofable and would need to be thrown away in S4. **Answered in S3.3: recommendation taken.**
4. **A real create method.** `POST /deployments` needs a service method that creates the `Deployment` (`PENDING`), a `DEPLOY` `Task` (`PENDING`) and an audit row in one transaction, and returns both ids. Recommendation: a **new** method (say `requestDeployment`) and leave the demonstration methods alone, since their tests document the S2 lessons. **Answered in S3.3: recommendation taken (`DeploymentService.requestDeployment`).**
5. **The parked seed generator.** The page-10,000 benchmark needs 1M+ tasks. Recommendation: un-park the S1 seed generator at the start of S3.4, not before. **Answered in S3.4: recommendation taken; S1 exercise 4 was done in the same step.**
6. **Hand mapping versus MapStruct.** Recommendation in 3.4 is hand mapping.

## 6. Definition of done for S3

- [x] S3.1 to S3.7 each have their own design doc and are implemented and green
- [ ] `ProblemDetail` for every failure, one shape, with a passing shape test per `type`
- [x] Every endpoint documented in OpenAPI including error shapes ([control-api-s3-7-openapi.md](control-api-s3-7-openapi.md) §11)
- [x] Two concurrent identical `POST /deployments` with one idempotency key create exactly one deployment ([control-api-s3-5-idempotency.md](control-api-s3-5-idempotency.md) §11.3)
- [x] Offset-versus-cursor numbers at page 10,000 recorded in `/docs` ([control-api-s3-4-task-history.md](control-api-s3-4-task-history.md) §12)
- [x] Rate limiter returns 429 with `Retry-After`
- [x] `mvn verify` green with Testcontainers Postgres and Redis (222 tests, 2026-10-02)
