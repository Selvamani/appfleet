# control-api — S3.3: deployments, rollback and task lookup

**Spec:** [01-CONTROL-API.md §S3](../../specs/project/01-CONTROL-API.md) — `POST /api/v1/deployments` (202 + `Location`), `GET /api/v1/deployments/{id}`, `POST /api/v1/deployments/{id}/rollback` (202), conflicts as 409 · Slice **S3.3** of [control-api-s3-rest.md](control-api-s3-rest.md)

Companion: [control-api-s3-2-applications-releases.md](control-api-s3-2-applications-releases.md) (the pattern this step repeats: DTO records, service returns DTOs, advice does all error mapping), [control-api-s2-service-layer.md](control-api-s2-service-layer.md) (why the audit recorder is `REQUIRES_NEW`), [control-api-s2-optimistic-lock.md](control-api-s2-optimistic-lock.md) (fail fast, 409, no retry). **Status: implemented 2026-10-01, `mvn verify` green (145 tests, 2 skipped by design). Results in section 10.**

This is the first step with a state machine behind the endpoints. Nothing executes a deployment yet (no saga, no worker, no events), so every deployment created here stays `PENDING` and every rollback only records intent. That is expected and is stated in section 4 of the plan doc.

## 1. What already exists

- Entities `Deployment` (with `@Version`, `status`, `currentStatus`), `Task` (`taskType` is a plain string, `status` is `TaskStatus`), `Environment` (unique `name`), and their repositories.
- `DeploymentState.canTransitionTo`, the single source of truth for legal transitions. `HEALTHY` and `DEGRADED` can go to `ROLLED_BACK`; nothing else can.
- Database constraint `uq_deployment_active_per_app_env`, a partial unique index that allows one deployment per (application, environment) whose status is not `FAILED` or `ROLLED_BACK`. It is already in the advice's conflict whitelist with a human `detail`.
- `IllegalTransitionException` and `ObjectOptimisticLockingFailureException`, both already mapped to 409 (`illegal-transition`, `concurrent-modification`).
- `AuditEventRecorder.record`, which runs in `REQUIRES_NEW`.
- `ReleaseRepository.findByIdAndApplication_Id`, which checks that a release belongs to an application.
- `EnvironmentRepository.findByName`.

What does not exist: a real create method in `DeploymentService` (the current `create`, `createBroken` and the `createRisky*` methods are S2 demonstrations and **must be left alone**, because their tests document the lessons), any deployment or task DTO, any controller, `GET /tasks/{id}`, and a way to create environments through the API.

## 2. Endpoints

| Method and path | Success | Errors |
|---|---|---|
| `POST /api/v1/deployments` | 202, `Location: /api/v1/tasks/{taskId}`, body `DeploymentAccepted` | 400 validation or malformed body, 422 unknown application, release or environment, or release not of that application, 409 active deployment exists |
| `GET /api/v1/deployments/{id}` | 200 `DeploymentResponse` | 400 malformed id, 404 |
| `POST /api/v1/deployments/{id}/rollback` | 202, `Location: /api/v1/tasks/{taskId}`, body `RollbackAccepted` | 400 malformed id, 404, 409 illegal transition, 409 rollback already requested, 409 concurrent modification |
| `GET /api/v1/tasks/{id}` | 200 `TaskResponse` | 400 malformed id, 404 |

`GET /tasks/{id}` is not in the spec's list. It is added for the same reason as the two `GET`-by-id endpoints in S3.2: a 202 whose `Location` returns 404 is a broken contract (plan doc, open question 1, recommendation taken). It is read-only and reuses one small DTO.

## 3. Decisions taken

The plan doc's open questions 1 to 4 are answered with their recommendations. Restated here with the reasoning, so this document stands alone.

1. **`Location` points at `/api/v1/tasks/{taskId}`.** The client asked for work to be done, and the task is the thing that will progress.
2. **Rollback records intent and changes no status.** Legal only when the deployment is `HEALTHY` or `DEGRADED`, decided by asking `DeploymentState.canTransitionTo(ROLLED_BACK)`, **not** by repeating the list of states in a second place. It records a `ROLLBACK` task in `PENDING` and returns 202. The deployment's `status` is left alone, because moving it to `ROLLED_BACK` would make the 202 a lie: nothing was rolled back. The status change belongs to whatever executes the task (S5 and S6).
3. **Audit actor is the constant `"system"`** until S4 provides a principal. An `X-Actor` header is rejected because it is spoofable and would have to be thrown away in S4.
4. **New service methods, old ones untouched:** `requestDeployment` and `requestRollback` (section 5).

New decisions made in this document:

5. **Missing references in the body are 422, not 404.** `POST /deployments` with an unknown `applicationId`, `releaseId` or environment name is a request that is well-formed and valid but that the server refuses on domain grounds, which is the plan doc's definition of 422. A 404 on `POST /deployments` would suggest the endpoint itself does not exist. This needs a small new unchecked exception (for example `UnprocessableRequestException`) and a handler mapping it to the existing `unprocessable` slug. The existing `unprocessable` handler is for the checked demo exception `DeploymentValidationException` and stays as is.
6. **A release that belongs to a different application is 422 too.** It is the plan doc's own example for 422. The check is `findByIdAndApplication_Id`, which returns empty for a mismatch, so "release does not exist" and "release belongs to another application" become one case with one message. Fine: the caller should not learn which.
7. **The environment is given by name, not id.** Names are unique and are what clients know (`staging`). The column has `uq_environment_name`.
8. **`DeploymentResponse` exposes `status` and never `currentStatus`.** `currentStatus` is the deliberately denormalised copy that nothing updates until S6, so exposing it would publish a value that is wrong by design.
9. **A second rollback while one is pending is rejected** with 409 `conflict`. Otherwise two rollback tasks for one deployment pile up. The check is an existence query for a `ROLLBACK` task in `PENDING` or `RUNNING` (section 5.2).

## 4. DTOs

Records in the domain's `web` package, response types own a static factory, as in S3.2.

```java
// io.appfleet.control.deployment.web
public record CreateDeploymentRequest(
        @NotNull UUID applicationId,
        @NotNull UUID releaseId,
        @NotBlank @Size(max = 63) String environment) {}

public record DeploymentAccepted(UUID deploymentId, UUID taskId, DeploymentState status) {}

public record RollbackAccepted(UUID deploymentId, UUID taskId) {}

public record DeploymentResponse(UUID id, UUID applicationId, UUID releaseId, String environment,
                                 DeploymentState status, Instant createdAt, Instant updatedAt) {
    static DeploymentResponse from(Deployment d) { ... }
}

// io.appfleet.control.task.web
public record TaskResponse(UUID id, UUID deploymentId, String taskType, TaskStatus status,
                           Instant createdAt, Instant updatedAt) {
    static TaskResponse from(Task t) { ... }
}
```

The environment name rule is deliberately loose (`@NotBlank`, at most 63): the `Environment` entity defines no format, so this step does not invent one. An unknown name is a 422, not a validation error.

## 5. Service layer

### 5.1 `requestDeployment`

New method on `DeploymentService`, returning a DTO so nothing leaves the transaction:

```java
@Transactional
public DeploymentAccepted requestDeployment(CreateDeploymentRequest req, String actor)
```

Steps, in this order, and the order matters:

1. Load the application: `findById`, else 422.
2. Load the release with `releaseRepository.findByIdAndApplication_Id(releaseId, applicationId)`, else 422.
3. Load the environment with `findByName`, else 422.
4. `Deployment deployment = new Deployment(app, release, env)` and **`deploymentRepository.saveAndFlush(deployment)`**.
5. `taskRepository.save(new Task(deployment, "DEPLOY"))`.
6. **After** the flush, `auditEventRecorder.record(new AuditEvent(actor, "DEPLOYMENT_REQUESTED", "deployment", id, null))`.
7. Return `new DeploymentAccepted(deployment.getId(), task.getId(), PENDING)`.

**Why the flush comes before the audit.** The recorder runs in `REQUIRES_NEW`, so the audit row commits on its own and survives a rollback of the caller. That is the behaviour S2 set out to prove. But `Deployment` has `@Version`, so `save` issues no `insert` until flush. If the audit were recorded first, a request that then loses to `uq_deployment_active_per_app_env` would return 409 **and leave behind an audit row saying a deployment was requested** for a deployment that does not exist. Flushing first makes the partial index fire inside step 4, before the audit is written, so the 409 leaves no orphan row.

One gap remains and is stated honestly: if the transaction fails **after** the flush, for example at commit, the audit row already exists. The real fix is S6's `AFTER_COMMIT` listener, which records audit only for committed changes. Until then this is an accepted, documented limitation, and test row 4 pins the case that is fixable now.

`Task` has no cascade from `Deployment` (the collection is `mappedBy` with no `cascade`), so the task is saved through its own repository. Task type strings `"DEPLOY"` and `"ROLLBACK"` become public constants on `Task`, so the strings are not retyped in services and tests.

### 5.2 `requestRollback`

```java
@Transactional
public RollbackAccepted requestRollback(UUID deploymentId, String actor)
```

1. Load the deployment with the **optimistic force-increment lock** (`@Lock(LockModeType.OPTIMISTIC_FORCE_INCREMENT)` on a repository method, for example `findLockedById`), else `NotFoundException("Deployment", id)`.
2. If `!deployment.getStatus().canTransitionTo(ROLLED_BACK)`, throw `IllegalTransitionException` (existing 409 `illegal-transition`). Do **not** call `transitionTo`; the check is only a question.
3. If `taskRepository.existsByDeployment_IdAndTaskTypeAndStatusIn(id, "ROLLBACK", [PENDING, RUNNING])`, throw a new `RollbackAlreadyRequestedException`, mapped to 409 `conflict` by its own handler (the existing `conflict` path is for constraint names, so this is a separate handler with a fixed `detail`).
4. Save `new Task(deployment, "ROLLBACK")`, record audit `ROLLBACK_REQUESTED`, return ids.

**Why force-increment.** Two concurrent rollback requests would both pass step 3, because neither sees the other's uncommitted task, and both would insert a task. Force-incrementing the deployment's version makes the second commit fail with `ObjectOptimisticLockingFailureException`, which the advice already maps to 409 `concurrent-modification`. That applies the S2 policy (fail fast, no retry) to a new place and needs no pessimistic lock. The deployment row is otherwise unchanged, so this is a real side effect worth noting: a rollback request bumps `version`.

**The pending-task check covers only the sequential case.** Under concurrency both requests pass step 3 in every observed run (section 10), so the lock decides the race. Step 3 exists for case 13, where the first rollback has already committed and the second gets a clear 409 `conflict` instead of relying on the version check.

**Known gap: the concurrent loser leaves an orphan audit row.** Hibernate does the forced version increment as a before-completion action, at commit, not at flush. The audit row is written earlier, in its own `REQUIRES_NEW` transaction. So the loser of a concurrent rollback has already committed `ROLLBACK_REQUESTED` when its commit fails with 409 `concurrent-modification`. In 10 of 10 runs of case 16 the loser took this path, so this is the normal outcome of a concurrent rollback, not an edge case. `saveAndFlush` does not help, because the increment runs after the flush. Accepted until S6, whose `AFTER_COMMIT` listener records audit only for committed changes. Case 16 pins the behaviour: it expects two audit rows when the loser is `concurrent-modification`.

Alternative considered and not taken: a partial unique index on open `ROLLBACK` tasks (`WHERE task_type = 'ROLLBACK' AND status IN ('PENDING','RUNNING')`) plus `saveAndFlush` of the task before the audit. The loser would then fail at the flush, before the audit write, exactly as deploy does. Not taken because S6 fixes audit for every write path at once, and the force-increment lock is the lesson of this step.

### 5.3 Reads

```java
@Transactional(readOnly = true) public DeploymentResponse get(UUID id)
@Transactional(readOnly = true) public TaskResponse getTask(UUID id)   // in a TaskService
```

`DeploymentResponse.from` reads the environment's name. With `open-in-view` off, that association is lazy, so the lookup needs `@EntityGraph(attributePaths = "environment")` on a new repository method (say `findDetailById`). Application and release ids come from the lazy proxies' `getId()`, which does not initialise them. **Verify in the SQL log** that `GET /deployments/{id}` is one `select` with a join and no follow-up queries.

### 5.4 A fix this step depends on

`Task`'s constructor uses `Instant.now()` without truncating, and `Deployment.transitionTo` does the same. `createdAt` and `updatedAt` therefore have 100 ns precision in memory and microsecond precision in Postgres, which is the bug S3.2 found and fixed for applications and releases. A 202 that returns a freshly built entity and a later `GET` would disagree. Apply `.truncatedTo(ChronoUnit.MICROS)` in `Task`'s constructor and in `Deployment.transitionTo` before the first test that compares them.

## 6. Controllers

`DeploymentController` in `deployment.web`, `@RequestMapping("/api/v1/deployments")`, and `TaskController` in `task.web`. Thin, as in S3.2: annotations validate, the service does the work, the controller builds `Location`.

- `POST /deployments` returns `ResponseEntity.accepted().location(URI.create("/api/v1/tasks/" + taskId)).body(...)`. The `Location` is a relative path, for the same reason as S3.2.
- `POST /deployments/{id}/rollback` has no request body.
- Put controllers in the `..web` package from the start. The S3.2 controller ended up in the parent package and the doc had to be read around it.

## 7. Tests

**Style.** Same as S3.2: `@SpringBootTest`, `@AutoConfigureMockMvc`, Testcontainers Postgres, AssertJ for `assertThat`, Hamcrest only inside MockMvc matchers. **Extract the shared Testcontainers base class now.** This is the fourth web test class, and S3.5 adds Redis, so the duplication has reached the point the plan doc set as a deadline.

Web test classes extend `web/WebIntegrationTest`, which carries those annotations, `MockMvc`, `JdbcTemplate` and one Postgres container per JVM.

- **Singleton container, no `@Testcontainers`.** The container is started in a static block. The JUnit extension would stop a static `@Container` after each class, while Spring's context cache would keep handing the next class a context that points at the stopped container.
- **Scope: web tests only** (`ApplicationEndpointsTest`, `ApplicationPaginationTest`, `DeploymentEndpointsTest`). The S2 tests keep their own containers because they assert absolute counts (`DeploymentNPlusOneTest` expects exactly 51 statements for 50 deployments, `DeploymentLazyInitializationTest` expects fixed list sizes), which rows left by other classes would break.
- **`.withUrlParam("currentSchema", "control")` is required.** `@ServiceConnection` replaces the whole datasource URL and drops the `currentSchema=control` from `application.yml`. Hibernate (`default_schema`) and Flyway (`schemas`) name the schema themselves, so only raw SQL notices.
- **Shared database.** Tests use unique names and before/after deltas. `ApplicationPaginationTest` cleans with `TRUNCATE application CASCADE`, because deleting releases fails once deployments reference them.

Fixtures come from repositories, not the API (there is no endpoint to create environments, and moving a deployment to `HEALTHY` needs `transitionTo`, which the API never calls in S3). A helper creates an `Environment`, an `Application` and a `Release`, and a second helper drives a saved deployment through `transitionTo` to a target state.

Test class `DeploymentEndpointsTest`:

| # | Case | Expected |
|---|---|---|
| 1 | valid `POST /deployments` | 202, `Location` starts with `/api/v1/tasks/`, body ids; afterwards the database holds one `PENDING` deployment, one `PENDING` `DEPLOY` task and one `DEPLOYMENT_REQUESTED` audit row |
| 2 | follow the `Location` from case 1 | 200 `TaskResponse`, `taskType` `DEPLOY`, `status` `PENDING` |
| 3 | `GET /deployments/{id}` | 200, `status` `PENDING`, `environment` is the name, **no** `currentStatus` field |
| 4 | second `POST` for the same application and environment | 409 `conflict`, `detail` from the whitelist map, and **the number of `DEPLOYMENT_REQUESTED` audit rows is unchanged** (the flush-before-audit proof, section 5.1). Count by action, not by target id: an orphan row would carry the losing deployment's id, which the test never sees |
| 5 | `POST` again after the first deployment is moved to `FAILED` | 202 (the partial index allows it) |
| 6 | empty body and a body with a blank environment | 400 `validation-failed`, `errors` lists every offending field |
| 7 | unknown application, unknown release, unknown environment, one test each | 422 `unprocessable` |
| 8 | release that belongs to another application | 422 |
| 9 | `GET /deployments/{unknown}` and `GET /deployments/not-a-uuid` | 404 `not-found`, 400 `validation-failed` with `errors[].field == "id"` |
| 10 | rollback on a `PENDING` deployment | 409 `illegal-transition` |
| 11 | rollback on a `HEALTHY` deployment | 202; a `ROLLBACK` task exists in `PENDING`; the deployment's `status` is still `HEALTHY`; its `version` went up by one |
| 12 | rollback on `DEGRADED` (202) and on `FAILED` and `ROLLED_BACK` (409) | as stated |
| 13 | rollback twice in a row | first 202, second 409 `conflict` |
| 14 | `GET /tasks/{unknown}` | 404 |
| 15 | two concurrent `POST /deployments` for the same application and environment | exactly one 202 and one 409, never a 500 |
| 16 | two concurrent rollbacks on a `HEALTHY` deployment | exactly one 202 and one 409 (either `conflict` or `concurrent-modification`), never a 500, and exactly one `ROLLBACK` task exists afterwards |

Cases 15 and 16 use two threads and a barrier with timeouts, as in S3.2's concurrent test, and the assertion sits on the returned statuses, **not** inside the thread. Case 16 is the one that justifies the force-increment lock: remove the lock and it is expected to fail with two 202 and two tasks. Do that once on purpose and record it, so the lock is proven necessary.

## 8. Order of work: find it broken first

1. Extract the shared test base class and move the existing web tests onto it. `mvn verify` stays green (121 tests, 2 skipped by design).
2. Section 5.4: truncate timestamps in `Task` and `Deployment.transitionTo`.
3. Write case 1 with no controller. Run: 404. Record it.
4. `requestDeployment`, DTOs, `DeploymentController`, `TaskController`, `GET /tasks/{id}`. Cases 1 to 3.
5. Case 4 **with the audit recorded before the flush first** (the wrong order), confirm an orphan audit row appears, then reorder and watch it go. This is the lesson of the step.
6. Cases 5 to 9 (validation, 422 handler, `Deployment` lookups).
7. `requestRollback` without the force-increment lock and without the pending-task check. Cases 10 to 12.
8. Case 13, then the pending-task check.
9. Case 16 against the lockless version (expected red), then add the lock (green).
10. Case 15.
11. Results section here. `mvn verify`.

## 9. Not in S3.3

- Anything that moves a deployment out of `PENDING`, or executes a task. That is S5 and S6.
- `Idempotency-Key` on `POST /deployments`. S3.5 adds it on top of this endpoint, so the endpoint is written to be wrapped.
- Task history listing and pagination (`GET /deployments/{id}/tasks`). S3.4.
- Environment management endpoints. Tests create environments through the repository; a manual run against a real database needs an `environment` row inserted by hand, since no migration seeds one.
- Authorisation. S4. The IDOR exploit test in S4 is built against `POST /deployments`, so keep the endpoint simple and unguarded for now.
- OpenAPI annotations (S3.7) and rate limiting (S3.6).

## 10. Results

Everything below was observed, not assumed. Final state: `mvn verify` green, 145 tests, 2 skipped by design. `DeploymentEndpointsTest` 24 tests (cases 1 to 16; the rollback state cases are parameterised). Green in both alphabetical and reverse-alphabetical class order.

**Mistakes caught by running it**

| What | Symptom | Cause |
|---|---|---|
| Raw SQL in tests could not see the tables | `relation "task" does not exist` from `JdbcTemplate` | `@ServiceConnection` replaces the datasource URL and drops `currentSchema=control`. Repositories still worked because Hibernate qualifies names with `default_schema`. Fixed with `.withUrlParam("currentSchema", "control")` on the container. The same cause is why `BaseImageRepository.findLineage` needed `{h-schema}` in S2 |
| `ApplicationPaginationTest` 9 errors after the container became shared | `violates foreign key constraint "deployment_release_id_fkey"` | Its cleanup used `deleteAllInBatch` on releases while deployments from `DeploymentEndpointsTest` referenced them. Order-dependent: green when the pagination class happened to run first. Fixed with `TRUNCATE application CASCADE`, proven with `-Dsurefire.runOrder=reversealphabetical` |

**Found broken first**

| Step | Deliberate break | Observed | After the fix |
|---|---|---|---|
| Section 8 step 5 | Audit recorded before `saveAndFlush` | Case 4: `expected: 1L but was: 2L` audit rows. Case 15: `expected: 3L but was: 4L`. SQL log: `insert into audit_event` before `insert into deployment` in every request | Green |
| Section 8 step 9 | `@Lock(OPTIMISTIC_FORCE_INCREMENT)` removed | Case 16 failed 5 of 5 runs (fresh JVM each): `[202, 202]` instead of `[202, 409]` | 10 of 10 green; the loser was `ObjectOptimisticLockingFailureException` in every run |

Section 8 step 3 (case 1 run with no controller, expecting 404) was not recorded: the controller already existed when the tests were written.

**Confirmed live**

- `GET /deployments/{id}` is one statement: `deployment join environment` through `findDetailById` with `@EntityGraph`. Application and release ids come from the foreign-key columns, with no extra query.
- `POST /deployments` is eight statements, in this order: three lookups, `insert deployment` (`saveAndFlush`), merge `select` on `task`, merge `select` on `audit_event`, `insert audit_event` (`REQUIRES_NEW` commit), `insert task` (caller commit).
- Every SQL line of a request carries that request's correlation id, including the `REQUIRES_NEW` audit insert. Fixture statements outside a request show `[]`.
- The force-increment failure happens inside the transaction manager's commit, outside the service method, and still arrives as `ObjectOptimisticLockingFailureException`, so 409 `concurrent-modification`. No 500 in any run.
- One Postgres container serves all web test classes; `ApplicationEndpointsTest` reuses the cached context (13 tests in about 0.2 s).

**Still true, recorded not fixed**

- **The concurrent rollback loser leaves an orphan `ROLLBACK_REQUESTED` audit row**, in 10 of 10 runs (section 5.2). Fixed by S6's `AFTER_COMMIT` listener.
- **The `DEPLOY` task insert lands after the audit commit.** This is the window accepted in section 5.1. The task insert has no realistic failure mode (its only constraint is the foreign key to the deployment just flushed).
- **Two merge `select`s per `POST /deployments`.** `Task` and `AuditEvent` have assigned UUIDs and no `@Version`, so `save` does a `merge`. Same as `Application` and `Release` in S3.2. The fix would be `Persistable<UUID>` or `@Version`; not in S3.3.
- **The S2 tests still start their own containers** because of their absolute counts. The build guide's "one shared container per module" is met for web tests only.

## Definition of done

- [x] Shared Testcontainers base class extracted, existing web tests moved onto it, `mvn verify` green
- [x] `Task` and `Deployment.transitionTo` timestamps truncated to microseconds
- [x] `requestDeployment` and `requestRollback` implemented; the S2 demonstration methods untouched
- [x] `DeploymentController`, `TaskController` and the DTOs implemented in the `..web` packages
- [x] Unprocessable and rollback-already-requested handlers added, green (failing-first not recorded: the handlers existed before their tests)
- [x] Orphan audit row reproduced with the wrong order and fixed by flush-before-audit, both observed and recorded
- [x] `DeploymentEndpointsTest` cases 1 to 16 green, including both concurrent cases
- [x] Case 16 shown failing without the force-increment lock, then green with it
- [x] `GET /deployments/{id}` observed in the SQL log as a single joined `select`
- [x] Results section written, plan doc's open questions 1 to 4 marked answered
- [x] `mvn verify` green
