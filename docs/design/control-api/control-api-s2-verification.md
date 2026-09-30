# control-api — S2 entities: implementation checkout and verification

**Spec:** [01-CONTROL-API.md §S2](../../specs/project/01-CONTROL-API.md) · Slice **S2**

Companion to [control-api-s2-entities.md](control-api-s2-entities.md) (the pre-implementation design — class shapes, owning-side decisions, why entities aren't records). That doc says what was planned; this one says what was actually typed in, what was wrong the first two passes, and the live proof that the final state matches the schema. Same relationship [control-api-spring-flow.md](control-api-spring-flow.md) has to [control-api.md](control-api.md) for S0 — a plan doc and a "here's what actually happened" doc, kept separate on purpose.

## Why a separate doc instead of editing the design doc in place

The design doc is a decision record — owning sides, why `@Version` goes where it goes, why entities can't be records. None of those decisions changed. What happened instead was ordinary implementation drift: typos, a couple of type mismatches against the live schema, and one real gap between the design and the frozen `V1` migration. Recording that drift in the design doc would blur "decision" with "bug found while typing it in" — this doc keeps them apart.

## Checkout — two passes, findings by severity

All 12 entities were re-read against `control-api-schema-3nf.md`'s frozen schema after being typed in, twice (a first full pass, then a recheck after fixes). Findings, in the order they were actually found and fixed:

### Pass 1 — breaking

| Finding | File | Fix |
|---|---|---|
| `@Table(name = "ImageVersion")` — Postgres folds unquoted identifiers to lowercase, resolving to `imageversion` (no underscore), not the real table `image_version` | `ImageVersion.java` | `@Table(name = "image_version")` |
| `Node.host` field, no `@Column(name=...)`, mapped to column `host` — real column is `hostname` | `Node.java` | Renamed field to `hostname`, added matching `@Column` |
| `Application.ownerTeamId` typed `String`, schema column is `uuid NOT NULL` | `Application.java` | Changed to `UUID ownerTeamId` |
| `Deployment.transitionTo(...)` set `this.currentStatus = target` instead of `this.status = target` — the FSM field never advanced past `PENDING`, `canTransitionTo` (which reads `status`) then rejected almost every subsequent transition | `Deployment.java` | Corrected to `this.status = target` |
| `OutboxMessage.sentAt` was `nullable = false` and required in the constructor — every row was constructed already "sent," defeating the outbox pattern (nothing would ever be left for the S6 poller to find) | `OutboxMessage.java` | Dropped from constructor, `nullable = false` removed (schema column is nullable), added `markSent()` |

### Pass 1 — naming/typo (non-breaking, `@Column(name=...)` overrides kept the DB mapping correct regardless)

- `Release.getApplicationId()` returned an `Application`, not an id — renamed `getApplication()`
- `ImageVersion.piplelineState`/`getPiplelineState()` — renamed `pipelineState`/`getPipelineState()`
- `AuditEvent.target_id`/`getTarget_id()` — renamed `targetId`/`getTargetId()`
- `Environment.name` was missing `unique = true` (schema has it) — added

### Pass 2 — found on recheck

| Finding | File | Fix |
|---|---|---|
| `Attempt.finished_at` was `nullable = false`, but the constructor (reduced to `(Task, int)`) never set it, and there was no method to ever transition an attempt to a finished state | `Attempt.java` | `nullable = false` removed, added `complete()` and `fail(String errorDetail)` — mirrors `Deployment.transitionTo`'s "the only way this field changes is through a named method" discipline |
| `Node.hostname()` getter — didn't match JavaBean convention (`getHostname()`). Compiled and worked (Hibernate uses field access here), but would break the first thing that does reflection-based property access — Jackson serialization, a mapper, once S3 exists | `Node.java` | Renamed to `getHostname()` |

Everything above is confirmed fixed as of the current tree — no open findings remain in the entity classes themselves.

## The one gap that wasn't a bug: `Deployment.version`

`Deployment` carries `@Version private Long version;` per the S2 spec item ("`@Version` on Deployment... two threads load the same deployment, both transition it, one gets `OptimisticLockException`"). `V1__init.sql` — frozen before S2 started — never included a `version` column, because optimistic locking wasn't yet a decided feature when the schema was designed in S1.

This surfaced as a real, expected failure the first time the app booted against the live schema after all 12 entities were in place:

```
org.hibernate.tool.schema.spi.SchemaManagementException:
Schema validation: missing column [version] in table [deployment]
```

Not an entity mistake — `ddl-auto: validate` doing exactly its job, catching a genuine schema/entity drift. Fixed with a new migration, additive, `V1`/`V2` untouched (never edited after commit):

```sql
-- V3__add_deployment_version.sql
ALTER TABLE deployment ADD COLUMN version bigint NOT NULL DEFAULT 0;
```

`bigint` because Hibernate maps `Long` → `bigint`. `DEFAULT 0` because a `NOT NULL` column added to a table that could already hold rows needs a backfill value — the table happened to be empty at the time (no `POST /applications` endpoint exists yet, S3 hasn't started), but the default is the correct habit regardless of whether it was needed this time.

## Live verification

Confirmed against the running Docker Postgres (`appfleet-postgres-1`, port `55432`), not just a clean compile:

```
$ docker exec appfleet-postgres-1 psql -U appfleet -d appfleet -c \
    "select version, description, success from control.flyway_schema_history order by version;"

 version |            description             | success
---------+------------------------------------+---------
 1       | init                               | t
 2       | add task attempt and image lineage | t
 3       | add deployment version             | t
```

`control-api` booted clean (`Started ControlApiApplication in 2.644 seconds`) with all 12 entities present and `ddl-auto: validate` passing — no `SchemaManagementException`, no missing/mismatched columns, no type errors. `\d control.deployment` confirmed the `version bigint NOT NULL DEFAULT 0` column landed exactly as the migration specified, alongside every constraint from `V1`/`V2` (the `CHECK` on `status`, the partial unique index, all three FKs) untouched.

App stopped cleanly after verification (`taskkill`, port `8081` freed) — this doc records a point-in-time proof, not a service left running.

## Definition of done (S2 entities)

- [x] All 12 entities + `DeploymentState` + `TaskStatus` + `Uuidv7` created, matching `control-api-s2-entities.md`'s packages
- [x] Two-pass checkout complete, zero open findings in entity classes
- [x] `V3__add_deployment_version.sql` written to close the `@Version` gap, additive, `V1`/`V2` unedited
- [x] `mvn verify` green
- [x] `ddl-auto: validate` confirmed passing against the live `V1`+`V2`+`V3` schema, boot-tested, not just compiled
- [x] `Deployment.transitionTo(...)` unit-tested — `DeploymentTest` (4 tests) and `DeploymentStateTest` (49 parameterized pairs) green; design in [control-api-s2-deployment-tests.md](control-api-s2-deployment-tests.md)
- [x] `@Version` exercised by two concurrent transactions — `DeploymentOptimisticLockTest` (3 tests) green, 20 of 20 runs of the concurrent test; see below and [control-api-s2-optimistic-lock.md](control-api-s2-optimistic-lock.md)

## Optimistic lock: what was actually observed

The design doc left the exception type as "confirm live, then pin". Result: two transactions load the same `VALIDATING` deployment (`version = 1`) and write different transitions (`DEPLOYING` and `FAILED`). Exactly one commits. The other fails with `org.springframework.orm.ObjectOptimisticLockingFailureException`, and it is the direct `getCause()` of the `ExecutionException` from the `Future`. No further unwrapping is needed. Final row: `version = 2`, `status` equal to the winner's target.

Two mistakes were made while typing the test in. Both were caught by running it, and neither was an entity bug:

| Mistake | Symptom | Fix |
|---|---|---|
| Task B targeted `VALIDATING`, which is already the current state | `IllegalStateException: Illegal transition from VALIDATING to VALIDATING` from the state machine, before the lock was reached | Target `FAILED` |
| Assertion `failures.hasSize(2)` | Fails even when behaviour is correct, since one task wins | `hasSize(1)` |

Environment findings from the same run: plain `mvn test` failed at startup with `invalid value for parameter "TimeZone": "Asia/Calcutta"`. Fixed by setting `<argLine>-Duser.timezone=UTC</argLine>` in the root `pom.xml` properties.

## `currentStatus` does not follow `status` in `transitionTo`, on purpose

`Deployment.transitionTo` updates `status` only. `current_status` is the deliberate denormalization from [control-api-schema-3nf.md](control-api-schema-3nf.md): a cache of the latest task-derived state, updated by an `AFTER_COMMIT` listener in S6, never inside the transaction that changed the state. Making `transitionTo` write it as well would defeat that design. Until S6 exists the column simply stays at `PENDING`. This is expected, not a bug.

## What's next

Remaining S2 exercises: N+1 (deliberately broken first, then the three fixes) and the `LazyInitializationException` drill. Self-invocation, rollback rules and `REQUIRES_NEW` are done, see [control-api-s2-service-layer-tests.md](control-api-s2-service-layer-tests.md).
