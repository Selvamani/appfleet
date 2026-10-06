# control-api — S4.5: the transactional outbox

**Spec:** [01-CONTROL-API.md §S4](../../specs/project/01-CONTROL-API.md) — *"Gains the outbox: `OutboxMessage` written in the same transaction as the state change; a poller publishes to Kafka, marks sent, deletes. Kill-test: stop the app between commit and publish, restart, prove the message still goes out"* · Step **S4.5** of [control-api-s4-plan.md](control-api-s4-plan.md) · Consumer side: [03-TASK-SERVICE.md](../../specs/project/03-TASK-SERVICE.md) (idempotent consumer, keyed by `idempotencyToken`) · Related: [control-api-s3-3-deployments.md](control-api-s3-3-deployments.md) (the transactions this step extends). **Status: designed 2026-10-05, all open questions decided (section 8), built and closed 2026-10-06.** The code is explained file by file in [control-api-s4-5-outbox-code.md](control-api-s4-5-outbox-code.md).

A deployment request today changes the database and publishes nothing. Nothing tells task-service that work exists. This step makes control-api tell it, **reliably**: if the request commits, the command reaches Kafka at least once, even if the application dies a millisecond after the commit; if the request rolls back, no command is ever sent.

The two obvious ways to do this are both wrong, and the step is built by getting each wrong first:

- **Publish inside the transaction.** The message can leave before the commit and the commit can then fail: a command for a change that never happened.
- **Publish after the commit.** The commit can succeed and the process die before the publish: a change nobody was told about.

A database commit and a Kafka send cannot be one atomic action (a dual write). The outbox turns the second write into a database write: the command is a **row in the same transaction** as the state change, and a separate poller moves committed rows to Kafka.

## 1. What already exists

- **`outbox_message` (V1)** and **`OutboxMessage` / `OutboxMessageRepository`**: `id` (UUIDv7), `aggregate_id`, `payload jsonb`, `created_at`, `sent_at`. Nothing writes to it, nothing reads it, the repository has only `findBySentAtIsNull()` (which loads every unsent row). The entity maps `payload` as a `String` with `columnDefinition = "jsonb"`; **it has never been persisted**, so whether a `String` binds to a `jsonb` column is unverified (section 5, 1).
- **The state changes to announce:** `DeploymentService.requestDeployment` (saves a `Deployment`, a `Task` of type `DEPLOY`, and an `audit_event`) and `requestRollback` (a `Task` of type `ROLLBACK` and an audit event). Both are `@Transactional`; the rollback loads the deployment with `OPTIMISTIC_FORCE_INCREMENT`, so concurrent rollbacks of one deployment are serialized and the loser fails at commit (S3.3).
- **The audit recorder is deliberately the opposite.** `AuditEventRecorder` is `REQUIRES_NEW`: an audit row survives the rollback of the business change (S2 and S3.3 decision; the orphan audit row of a lost race is documented, not fixed). **The outbox must not copy that.** Its whole point is to commit or roll back *with* the change.
- **Kafka is in compose** (apache/kafka 3.8.0, KRaft, topics created by `kafka-init`: `deployment.commands` 3 partitions, **`task.work` 6**, `task.work.DLT` 3, `task.events` 3, `deployment.events` 3, auto-create off). `spring-kafka` and `spring-kafka-test` are on the control-api classpath; `application.yml` sets `spring.kafka.bootstrap-servers`. Nothing uses `KafkaTemplate` yet. There is **no Kafka Testcontainer** and no `org.testcontainers:kafka` dependency.
- **No scheduling.** There is no `@EnableScheduling` and no `@Scheduled` in control-api.
- **`common-events`** is an empty module (a `pom.xml`); control-api depends on it.
- **The idempotency token.** The task-service spec says each command carries an `idempotencyToken` "set by control-api, carried end-to-end". Nothing sets one. The `Task` id (UUIDv7, stable, unique per command) is the natural token.
- **The Idempotency-Key of S3.5** (Redis, per `sub`) protects the HTTP request from being executed twice. It is a different mechanism with a different job: it never reaches Kafka.

## 2. Behaviour

| Event | Result |
|---|---|
| `POST /deployments` commits | exactly **one** `outbox_message` row, written in the same transaction: `aggregate_id` = the deployment id, `payload` = a `DEPLOY` command |
| `POST /deployments/{id}/rollback` commits | exactly one row, a `ROLLBACK` command |
| the request is rejected or rolls back (404, 409, 422, a lost optimistic-lock race, any exception) | **no row**, and nothing on Kafka |
| the poller runs | each committed unsent row is sent to Kafka, then `sent_at` is set; an acknowledged message is never sent again unless a crash hit between the acknowledgement and the commit of `sent_at` |
| Kafka is unreachable | the request still answers 202 (the request path never touches Kafka); rows stay unsent; the poller retries every cycle; when Kafka returns, the backlog is published in order |
| the application dies between the commit and the publish | after restart the row is still unsent and is published |

The command, as JSON (`schemaVersion` 1):

```json
{ "schemaVersion": 1, "commandType": "DEPLOY", "idempotencyToken": "<task id>",
  "taskId": "<task id>", "deploymentId": "<id>", "applicationId": "<id>", "releaseId": "<id>",
  "environment": "staging", "requestedBy": "<sub>", "requestedAt": "2026-10-05T12:00:00Z" }
```

Kafka record: topic `task.work`, **key = the deployment id** (the aggregate id), value = the JSON, headers `message-id` (the outbox row id) and `command-type`. The key is what puts every command of one deployment in one partition, in order: the task-service spec's "partition keyed by aggregate id = a mailbox".

**Delivery is at least once.** A crash after Kafka acknowledged a message and before `sent_at` committed sends it again. That is not a bug to remove but a contract: consumers deduplicate on `idempotencyToken`, and the `message-id` header lets a duplicate be recognised.

## 3. Decisions

1. **One transaction for state and message.** `DeploymentService` saves the `OutboxMessage` in the same `@Transactional` method as the deployment, the task and the audit call. It is a plain `save`, never `REQUIRES_NEW` and never a `@TransactionalEventListener(AFTER_COMMIT)` (an after-commit hook is exactly the "publish after the commit" bug, with an in-memory window to lose the message in).
2. **The Kafka send never happens in the request path.** The service writes a row; a poller sends. A broker outage therefore cannot fail or slow a request.
3. **The command contract lives in `common-events`:** a record `DeploymentCommand` and an enum `CommandType` (`DEPLOY`, `ROLLBACK`), no Spring dependency. task-service will consume the same type. The service builds the payload with the application's `JsonMapper`; the payload is stored as `jsonb`.
4. **The idempotency token is the `Task` id.** It is a UUIDv7 generated for the command, stable across redelivery and unique per command, and it needs no new column.
5. **The poller is a `@Scheduled` job inside control-api,** `fixedDelay` (default 1 s), batch size 100 (defaults, configurable). Each cycle is **one transaction**: take the leader lock, select pending rows in id order, send each and wait for its acknowledgement, set `sent_at` on the acknowledged ones, commit. No Debezium, no Kafka Connect.
6. **One active poller at a time, by a Postgres advisory lock,** `pg_try_advisory_xact_lock(<constant>)`, taken at the start of the cycle; an instance that does not get it skips the cycle. **This differs from the plan's decision 10** (`SELECT … FOR UPDATE SKIP LOCKED` on every instance) on purpose: with `SKIP LOCKED`, instance A can hold rows 1 to 100 while instance B takes 101 to 200, and B can publish a later command of a deployment before A publishes the earlier one. Per-aggregate order is the property the key exists to give, so ordering is chosen over throughput, which is not a constraint at this scale. The price is that publishing is single-threaded; section 8, 1 records the alternative and when it would be right. The selection query still uses `FOR UPDATE SKIP LOCKED` as a second guard, so a stuck lock holder never blocks the cycle.
7. **A failed send stops the batch.** The rows acknowledged before the failure are marked sent and committed; the failed row and everything after stay pending and are retried next cycle, in order. The error is logged at WARN with the message id. A permanently failing row therefore blocks the rows behind it (head-of-line blocking): accepted for now, recorded as a risk (section 5, 5), with the escape (an attempts column, a parking state) deferred.
8. **Producer settings are reliability settings:** `acks=all`, `enable.idempotence=true`, a bounded `delivery.timeout.ms` and `max.block.ms` (so a dead broker fails a cycle in seconds, not minutes). Because the poller waits for each acknowledgement, a message is marked sent only after the broker has it.
9. **A sent row is kept, then purged.** `sent_at` is set at publish; a second scheduled job deletes rows sent more than 24 hours ago (configurable). The spec says "marks sent, deletes"; keeping a day makes a duplicate or a "was it sent?" question answerable, and pending rows are never deleted.
10. **A partial index for the poller:** V6 adds `CREATE INDEX idx_outbox_pending ON outbox_message (id) WHERE sent_at IS NULL`. The poller's query reads only unsent rows in id order; without the index it walks the primary key and filters (the S3.4 shape, and a table that grows with every request).
11. **The topic is `task.work`,** key = aggregate id, per the plan's question 6. `deployment.commands` stays unused until a use for it is decided.
12. **The poller is off in the test profile** (`appfleet.outbox.poller.enabled=false`, as rate limiting is), so the existing suite does not need Kafka. The outbox tests turn it on, or call `OutboxPoller.pollOnce()` themselves, against a Kafka Testcontainer.
13. **No domain events yet.** `deployment.events` and the `@TransactionalEventListener` patterns are S6; this step only sends the two commands task-service needs.

## 4. Tests

New: a Kafka Testcontainer (`org.testcontainers.kafka.KafkaContainer("apache/kafka:3.8.0")`, the compose image, topic `task.work` created in the test) in an `OutboxIntegrationTest` base that extends `WebIntegrationTest`; a test consumer built with `KafkaTestUtils` from `spring-kafka-test`.

### 4.1 Written first (red against the current code)

| # | Test | Red today because |
|---|---|---|
| 1 | `outboxMessage_roundTripsThroughJpa` | the entity has never been saved: a `String` bound to a `jsonb` column is a type error (risk 1) |
| 2 | `requestDeployment_writesOneOutboxMessage` | no row: after a 202, one pending row with `aggregate_id` = the deployment id, `commandType` `DEPLOY`, `taskId` = `idempotencyToken` = the id returned in the response |
| 3 | `requestRollback_writesOneOutboxMessage` | no row; `ROLLBACK` |
| 4 | `rejectedRequests_writeNoMessage` | 404, 409 (illegal transition, open rollback) and 422 each leave zero rows. Green today for the wrong reason (nothing writes), and the guard once the write exists |
| 5 | `racingRollbacks_leaveExactlyOneMessage` | two concurrent rollbacks of one deployment: one 202, one 409, and **one** outbox row, never two. The decisive test for decision 1; section 6, step 3 shows it red against a dual write |
| 6 | `poller_publishesAPendingMessage` | no poller: the topic stays empty. With it: one record, key = the deployment id, value = the payload, headers `message-id` and `command-type`, and `sent_at` set |
| 7 | `poller_keepsPerDeploymentOrder` | a `DEPLOY` then a `ROLLBACK` for the same deployment arrive in that order on one partition |
| 8 | `twoPollers_publishEachMessageOnce` | two `OutboxPoller` instances run concurrently over 50 pending rows: the topic holds exactly 50 records, no duplicates. **Correction (2026-10-06, measured):** duplicates are prevented by **two independent guards**, the advisory lock and the row locks of `FOR UPDATE SKIP LOCKED`. Removing either one alone leaves this test green; it goes red only when **both** are removed (100 records instead of 50). Ordering is protected only by the advisory lock, which is what 8b shows |
| 8b | `leaderLock_stopsALaterRowOvertaking` | the test that does depend on the leader lock: poller A is held inside a `beforePublish` seam after locking row 1 of a deployment and before sending it; poller B runs a full cycle meanwhile. With the leader lock B publishes **nothing**; without it B skips the locked row 1 and publishes row 2 first (an inversion: row 2 on the topic, row 1 not yet). After A is released the topic holds row 1 then row 2 |
| 9 | `kafkaDown_requestStillSucceeds_andIsSentLater` | a poller whose producer points at a dead broker: `POST /deployments` is a 202, the row stays pending, `pollOnce()` does not throw; a poller with a working producer then publishes it |
| 10 | `crashAfterSend_resendsTheMessage` | the first `markSent` commit is forced to fail after a successful send: the row is still pending, the next cycle publishes it again, and both records carry the same `message-id` (at-least-once, shown, not hidden) |
| 11 | `failedSend_stopsTheBatch_inOrder` | row 1 sends, row 2's send fails, row 3 is untouched: row 1 is `sent_at`, rows 2 and 3 pending, and the next good cycle sends 2 then 3 |
| 12 | `purge_deletesOnlyOldSentRows` | a sent row older than the retention is deleted; a recent sent row and a pending row of any age stay |
| 13 | `producerIsConfiguredForReliability` | the producer factory has `acks=all` and `enable.idempotence=true` |
| 14 | `v6_createsThePendingIndex` | `pg_indexes` holds `idx_outbox_pending`, partial on `sent_at IS NULL` (red without V6, as `ApplicationOwnerIndexTest` was) |

### 4.2 The kill-test (manual, recorded)

The spec's own sentence, done for real with the jar and compose: Kafka **up**, poller **disabled** by property, `POST /deployments`, confirm the pending row and an empty topic; **kill -9** the java process; start it again with the poller enabled; the message appears on `task.work` exactly as committed, with the same `message-id`. The same with Kafka stopped during the request and started afterwards. The automated tests 9 and 10 prove the pieces; this one proves the whole path, including a real process death.

### 4.3 Existing tests

The poller is off in the test profile and no existing test starts Kafka. `DeploymentService` gains the outbox write inside its transactions: the SQL-statement-count tests on `POST /deployments` (S3.3 recorded 8 statements) change by the one `insert` (plus the Hibernate merge-select if the id is assigned, S3.3's observation); the new count is recorded, and a test that pins a count is updated with the reason. `DeploymentServiceRollbackTest` and the audit tests are checked for a changed transaction boundary.

## 5. Risks to check, not assume

1. **`String` into `jsonb`.** Hibernate may bind a `String` as `varchar`, and Postgres refuses it for a `jsonb` column (`column "payload" is of type jsonb but expression is of type character varying`). The usual fix is `@JdbcTypeCode(SqlTypes.JSON)` on the field, which also makes the column definition redundant. Test 1 is first for this reason.
2. **Ids and commit order.** The row id (UUIDv7) is generated when the entity is created, inside the request transaction; two transactions can commit in the opposite order of their ids. The poller orders by id over *committed* rows only, so a late-committing smaller id is published later. For one deployment this cannot invert (state changes on one deployment are serialized by the unique active-deployment rule and the forced version increment); across deployments order is not promised. Recorded so it is not mistaken for a bug.
3. **The advisory lock and the pool.** The lock is transaction-scoped, so it releases at commit or rollback and cannot leak a connection. A cycle that waits on a dead broker holds one connection for up to `max.block.ms` plus the delivery timeout; the settings of decision 8 bound it. Test 9 includes the time the failed cycle takes.
4. **Duplicates are real.** At-least-once means test 10's duplicate will happen in production on a badly timed crash. Nothing in control-api deduplicates; task-service must (its spec requires it). Until task-service exists this is a stated dependency, not a verified one.
5. **Head-of-line blocking** (decision 7): one message that can never be sent blocks every later message. Today a payload is built by control-api and is small, so a send that fails forever is a topic or broker misconfiguration, not a data problem; it would show as a growing pending count and a WARN every second. No gauge or alert exists in this step (section 7).
6. **The request path and the outbox insert.** A failing outbox insert must fail the request (it is part of the same transaction): that is correct, and a test (`outboxInsertFails_rollsBackTheChange`, a constraint violation forced by a duplicate id) shows the deployment row is not left behind.
7. **Existing orphan audit rows** (the S3.3 known gap) are the *opposite* property: the audit row survives a rollback; the outbox row must not. Test 5 shows both in one scenario: the loser leaves an audit row and no outbox row.
8. **Clock and `created_at`.** Pending rows are ordered by id, not `created_at`, so the Postgres and JVM clocks cannot reorder them.

## 6. Order of work: find it broken first

1. **Test 1:** save an `OutboxMessage` through the repository and read it back. Record the error. Fix the mapping (`@JdbcTypeCode(SqlTypes.JSON)`), green.
2. **Tests 2 to 4, 14 against the current code:** red (no rows, no index). Write `DeploymentCommand` in `common-events`, the payload builder, the outbox write in `requestDeployment` and `requestRollback` (same transaction), and V6. Green. Re-run the SQL-count tests and record the new counts.
3. **The decisive red run, on a scratch copy:** replace the outbox write with a **dual write**, a `KafkaTemplate.send` inside the transaction, and run test 5. The losing rollback has already sent its command when it fails at commit: **two** messages for one change, test 5 red. Then **publish after commit** (an `AFTER_COMMIT` listener) with a forced exit between commit and send: the message is lost. Both recorded; then the outbox version: test 5 green.
4. **The Kafka plumbing:** the `org.testcontainers:kafka` test dependency, `OutboxIntegrationTest`, a topic, a test consumer. Tests 6 to 13 red against an empty `OutboxPoller`.
5. **`OutboxPoller`:** the native selection query with `{h-schema}` (the S2 lesson for native SQL) and `FOR UPDATE SKIP LOCKED`, the advisory lock, `pollOnce()`, the scheduled wrapper, the purge. Tests green one at a time.
6. **The kill-test** (4.2) on the dev stack, recorded.
7. **Mutation checks on a scratch copy,** touching every restored file (the stale-class trap of S4.4): (a) the outbox write moved to `REQUIRES_NEW` like the audit, test 5 red (the loser's row survives); (b) the advisory lock removed, test 8b red (row 2 overtakes row 1; test 8 stays green, see its correction); (b2) `FOR UPDATE SKIP LOCKED` removed with the lock kept, test 8 stays green (measured; a second guard), and (b3) both removed, test 8 red (each row twice); (c) `markSent` before the send, test 10 or 11 red (a lost message); (d) `acks=1`, test 13 red; (e) the batch carries on after a failed send, test 11 red.
8. `mvn verify`, a re-measure of `POST /deployments` statements, docs, plan row, concepts guide (`kf-outbox`), Outline. Results.

## 7. Not in S4.5

- **task-service and its consumer,** the idempotent consumer table, the DLT and the retry engine (its own plan). Here the topic is read only by tests.
- **Domain events** (`DeploymentRequested`, `DeploymentSucceeded`, …) on `deployment.events`, and the `AFTER_COMMIT` listener patterns (S6). Only the two commands.
- **Metrics and alerts:** a gauge of pending rows, an age-of-oldest alert. The pending count is a SQL query today.
- **A schema registry, Avro or Protobuf;** the contract is JSON with a `schemaVersion`.
- **CDC (Debezium) or Kafka Connect** as the outbox relay. A polling relay is chosen for being inspectable; the trade-off is latency of one poll interval and a query per cycle.
- **An attempts column and a parking state** for poison rows (risk 5).
- **Outbox for the audit events** and for anything but the two commands.
- **Exactly-once.** Kafka transactions between the outbox and the topic are not used; at-least-once with an idempotent consumer is the design.

## 8. Decided 2026-10-05

All eight open questions were answered with the recommendation:

1. **One poller at a time, by the Postgres advisory lock** (decision 6), not `SKIP LOCKED` on every instance. Per-deployment order is what the key is for. Revisit only if publishing throughput becomes the limit, and then partition the work by aggregate so one deployment never spans two pollers.
2. **The topic is `task.work`.** `deployment.commands` has no consumer in any spec and stays unused.
3. **Sent rows are kept 24 hours, then purged** (decision 9); pending rows are never deleted.
4. **The command contract lives in `common-events`,** because task-service must read the same type.
5. **The `Task` id is the idempotency token;** no new column.
6. **Poison rows block the line** (decision 7), with a WARN. An attempts column and a parking state are added the first time a row is actually poisoned.
7. **`requestedBy` (the caller's `sub`) is part of the command.**
8. **Poll every 1 second, batch size 100,** both configurable.

## 9. Results

### 9.1 The jsonb mapping, 2026-10-05

Test 1 (`OutboxMessageTest.outboxMessage_roundTripsThroughJpa`), written before any change to the entity. Run on a scratch copy with the `@JdbcTypeCode(SqlTypes.JSON)` annotation removed (the file touched so Maven recompiles): **red**, `InvalidDataAccessResourceUsageException: could not execute statement [ERROR: column "payload" is of type jsonb but expression is of type character varying`, exactly the risk 1 prediction. With the annotation on the `payload` field (`@JdbcTypeCode(SqlTypes.JSON)`, `@Column(nullable = false, columnDefinition = "jsonb")`): **green**, 1 test; the row reads back with its `aggregate_id`, a null `sent_at`, a `created_at`, a payload parseable as JSON, and a jsonb operator (`payload ->> 'commandType'`) works on it in SQL, so the column really holds jsonb.

### 9.2 Tests 2 to 4 and 14 against the current code, 2026-10-05

`OutboxWriteTest` (3 tests) and `OutboxIndexTest` (1), no production change: **all 4 red**.

- `requestDeployment_writesOneOutboxMessage` and `requestRollback_writesOneOutboxMessage`: `Expected size: 1 but was: 0`, no row after a 202.
- `v6_createsThePartialPendingIndex`: `EmptyResultDataAccessException: Incorrect result size: expected 1, actual 0`.
- `rejectedRequests_writeNoMessage`: **red, not green as predicted.** I predicted it would pass for the wrong reason (nothing writes yet). Its 404, 409 and 422 steps do pass, but its last step (a successful rollback followed by a rejected second one) asserts exactly **one** row for the deployment and finds none. The test is stronger than the design table said: it also pins that a rejected rollback adds no *second* message.

### 9.3 The outbox write, 2026-10-05

`DeploymentCommand` and `CommandType` in `common-events`, `OutboxWriter` (`@Transactional(propagation = MANDATORY)`), the two writes in `DeploymentService` and `V6__add_outbox_pending_index.sql`. First full run, `mvn verify -Dmaven.test.failure.ignore=true`: **330 tests, 1 failure, 1 error**, both from paste slips, found by the tests written first:

- `OutboxIndexTest`: `EmptyResultDataAccessException`. The migration file had been named after the test (`v6_createsThePartialPendingIndex.sql`), and Flyway only picks up `V<version>__<description>.sql`, so V6 never ran. Renamed to `V6__add_outbox_pending_index.sql`.
- `OutboxWriteTest.requestDeployment_writesOneOutboxMessage`: `expected: "DEPLOY" but was: "ROLLBACK"`. The `requestDeployment` write had been given `CommandType.ROLLBACK`. Fixed to `DEPLOY`.

Second run: **330 tests, 0 failures, 2 skipped**; `OutboxWriteTest` 3, `OutboxMessageTest` 1, `OutboxIndexTest` 1 green. `Instant` serialized as an ISO string (the `requestedAt` assertion read it as a `String`), so no mapper change was needed.

**A bug in S4.4 found on the way.** Reading `requestDeployment` for the wrong command type showed that the 422 text for another team's application was built as `"Application " + id + "does not exist."`, **without the space** that the unknown-application message has. The two answers differed by one character, which weakens the "indistinguishable from missing" guarantee of S4.4 decision 2, and no test caught it because `deniedAnswer_isIndistinguishableFromMissing` did not cover `POST /deployments`. S4.4 section 2 promises "the same answer and message as an unknown applicationId"; the matrix test checked the status of that row and the comparison test did not cover this endpoint, so the message text was never compared. Added a `POST /deployments` comparison to that test, then, on a scratch copy with the space removed again: **red**, `expected: "422 urn:appfleet:problem:unprocessable Unprocessable request Application <id> does not exist." but was: "… Application <id>does not exist."`. Green with the space.

**The statement count of `POST /deployments`** (`org.hibernate.SQL` at DEBUG, one correlation id): **10 statements**, up from the 8 of S3.3. The two new ones are the outbox row: a merge-select `select … from control.outbox_message om1_0 where om1_0.id=?` (the id is assigned in the constructor, so `save` is a merge, as for `task` and `audit_event`) and `insert into control.outbox_message`. No existing test pinned the count, so none needed changing. The audit insert appears before the task insert because `AuditEventRecorder` runs in its own transaction and commits first.

### 9.4 Racing rollbacks: exactly one message, 2026-10-05

Test 5 (`OutboxWriteTest.racingRollbacks_leaveExactlyOneMessage`): two concurrent `POST …/rollback` on one HEALTHY deployment through a `CyclicBarrier`, statuses `containsExactlyInAnyOrder(202, 409)`, and exactly **one** outbox row for the deployment. Real tree: **green on the first run** (4 of 4 in the class). A test that passes first time proves nothing, so it was mutated on a scratch copy:

- **Mutation (a), `OutboxWriter` on `Propagation.REQUIRES_NEW`** (the way `AuditEventRecorder` is written): **red in 3 of 3 runs**, `Expected size: 1 but was: 2`. The two rows carry **different `taskId`s**: the loser's transaction lost the optimistic-lock race and rolled back, its task row went with it, but its outbox row had already committed in its own transaction. A command for a task that never existed would have gone to task-service.

This is the difference between the audit row and the outbox row, as a number: the audit row of the same loser **does** survive (the documented orphan of S3.3) and that is acceptable for an audit trail; the outbox row must not. `MANDATORY` makes the second property a property of the class, not of the caller's care.

Not yet shown (they need Kafka, step 4 of section 6): the dual write (a `KafkaTemplate.send` inside the transaction) and publish-after-commit, each failing in its own way.

### 9.5 The poller, written by the owner, 2026-10-05 and 2026-10-06

Tasks 1 to 6 of the implementation guide ([control-api-s4-5-outbox-code.md](control-api-s4-5-outbox-code.md) section 15) were done by hand, one failing run at a time. Each failure below was read from the test output, the log or the SQL, not guessed, and each was a one-character or one-line mistake:

| Run | Symptom | Cause | Found by |
|---|---|---|---|
| module did not compile | `cannot find symbol: class OutboxProperties` in `RateLimitInterceptorTest` | missing import in the test that builds `AppfleetProperties` by hand | compiler |
| every Spring test failed | `No qualifying bean of type KafkaTemplate` | the plain `spring-kafka` dependency: Spring Boot 4 needs `spring-boot-starter-kafka` for the auto-configuration | context failure, root `Caused by` |
| every Spring test failed | `Schema validation: missing column [created_id] in table [outbox_message]` | `@Column(name = "created_id")` instead of `created_at` (then `created_At`: the column name is case-sensitive in validation) | Hibernate schema validation at startup |
| every Spring test failed | `No qualifying bean of type OutboxProperties` | `OutboxPoller` and `OutboxScheduling` injected the nested record; only `AppfleetProperties` is a bean | context failure |
| `OutboxPollerTest` red, no warning in the test summary | `Outbox cycle failed`, Postgres: `column "sent_as" does not exist`, hint `Perhaps you meant to reference the column "outbox_message.sent_at".` | typos in two native queries (`sent_as`, `sent_As`); a native query string is not checked until it runs | `org.hibernate.SQL` at DEBUG |
| `OutboxPollerTest` red, SQL fine | Kafka client WARN `{task.word=UNKNOWN_TOPIC_OR_PARTITION}` | `@DefaultValue("task.word")` in `OutboxProperties` (twice: first not fixed) | the producer's own WARN |
| green | | | |

Two lessons that are properties of the design, not of the typos: a poller that **never throws** (decision: a dead broker must not crash the scheduler) turns every bug inside a cycle into a log line, so the first thing to read when a poller test is red with an empty topic is the WARN, and the SQL log shows whether the cycle ran at all; and a send to a topic that does not exist **blocks until the timeout**, it does not fail fast, so a wrong topic name looks like a slow, silent failure.

**Result: `OutboxPollerTest` 2 of 2, `OutboxWriteTest` 4 of 4, `OutboxMessageTest` 1 of 1, `OutboxIndexTest` 1 of 1 green** (tests 6 and 7 of the design table: one record per row with key = deployment id, the `message-id` and `command-type` headers and `sent_at` set; `DEPLOY` before `ROLLBACK` on one partition).

### 9.6 Test 8b: the leader lock stops a later row overtaking, 2026-10-06

`OutboxOrderTest.leaderLock_stopsALaterRowOvertaking`, run on a scratch copy of the tree. Setup: all pending rows deleted, then two rows for one deployment (`DEPLOY` then `ROLLBACK`, created 5 ms apart so id order is creation order); **batch size 1**, so poller A locks only the first row (with the default 100 it would lock both, and a poller without the leader lock could not overtake because `SKIP LOCKED` would skip both); poller A is a subclass whose `beforePublish` signals a latch and then blocks, holding the leader lock and row 1 inside its transaction; poller B runs a full cycle meanwhile.

- **With the leader lock: green.** B's `tryLeaderLock` returns false, B publishes nothing, the topic holds no record for the deployment while A is held; after A is released and B polls again, the topic holds the two records and their `message-id` headers are row 1 then row 2.
- **Mutation (b), the leader lock removed (`if (false)`; the restored file touched): red,** `[nothing for this deployment while A holds the first row] Expecting empty but was: [ConsumerRecord(topic = task.work, partition = 1, … offset = 0 …)]`. B skipped the locked row 1 and published row 2 first: the command for a later change reached Kafka before the earlier one.

This is the property the advisory lock exists for (decision 6), shown as a failing assertion. The same mutation leaves `twoPollers_publishEachMessageOnce` (test 8) green, as the correction in section 4 says, because duplicates are prevented by `FOR UPDATE`.

### 9.7 Tests 8 to 13 and the mutation checks, 2026-10-06

`OutboxDeliveryTest` (6 tests) was written and run on a scratch copy of the tree: **6 of 6 green on the first run**, so each was then proved able to fail:

| Mutation (one change, restored file touched) | Red tests |
|---|---|
| (c) `markSent()` called before the send | `failedSend_stopsTheBatch_inOrder` (the failed row is marked sent: `[the failed row stays pending] expected: null`) and `kafkaDown_requestStillSucceeds_andIsSentLater` (a dead-broker cycle marks the row sent and the message is never published) |
| (e) `break` replaced by `continue` after a failed send | `failedSend_stopsTheBatch_inOrder` (`[the row behind it waits, in order] expected: null`) |
| (d) `acks: 1` in `application.yml` | `producerIsConfiguredForReliability` (`expected: "all"`). The same run also failed the other five tests: with `enable.idempotence: true` the Kafka client refuses `acks=1`, so no send worked at all. The setting is protected twice over, by the test and by the client |
| (f) purge by `created_at` instead of `sent_at` | `purge_deletesOnlyOldSentRows` (an old **pending** row is deleted: deleted count 2, expected 1) |
| (b) leader lock removed, `FOR UPDATE` kept | **none** of tests 8 to 13 (test 8 green); test 8b is the one that goes red (section 9.6) |
| (b2) `FOR UPDATE SKIP LOCKED` removed, leader lock kept | **none** (test 8 green) |
| (b3) both removed | `twoPollers_publishEachMessageOnce`: `Expected size: 50 but was: 100`, every row published twice |

Three corrections of my own, each found by running the mutation:

- The design said removing the advisory lock turns test 8 red (duplicates). It does not: the row locks prevent the duplicates by themselves, and the lock prevents them by itself. Test 8 needs **both** guards removed. The advisory lock earns its place through **ordering** (test 8b), not duplicates.
- `WHERE sent_at IS NOT NULL AND sent_at < :cutoff`: removing the `IS NOT NULL` is **not** a mutation. `NULL < cutoff` is not true in SQL, so pending rows were never at risk and test 12 stayed green. The meaningful mutation is the one above, purging by `created_at`.
- Mutation (d) breaks everything, not only test 13 (above).

Test 10 (`crashAfterSend_resendsTheMessage`) is a demonstration, not a guard: it shows the at-least-once duplicate on purpose (a `beforeCommit` that throws once rolls the transaction back after the send; the next cycle sends the row again; two records, one `message-id`). Test 9 asserts a cycle against a dead broker (`localhost:1`, `max.block.ms` 1 s) returns in under 10 s without throwing, leaves the row pending, and that the real poller then publishes it.

Not yet done: the dual-write and publish-after-commit demonstrations (task 8 of the code doc), the kill-test by hand, and mutation (a) is recorded in 9.4.

### 9.8 The two wrong designs, shown failing, 2026-10-06

`OutboxAtomicityTest` (2 tests, kept in the scratch copy: it needs a mutated writer to fail, and against the outbox it only repeats what the other tests prove; the source is in section 16.10 of the code doc). It asks two questions of any design: **one change, one command on the topic** (two racing rollbacks, then `pollOnce()`, then count the records for the deployment) and **a committed change reaches the topic** (a deployment request, `pollOnce()`, one record for it).

| Design | Result |
|---|---|
| **The outbox** (the real code) | 2 of 2 green |
| **Dual write**: `OutboxWriter` replaced by a `KafkaTemplate.send(...).get()` inside the transaction, no row | `racingRollbacks_publishExactlyOneRecord` red: **`[one change, one command on the topic] Expected size: 1 but was: 2`**. The loser published its command before it lost the optimistic-lock race and rolled back: two commands, one change |
| **Publish after commit**: a `TransactionSynchronization.afterCommit` that should send, with the process dying before it does (the hook left empty), no row | both tests red: **`[a committed change must reach the topic] Expected size: 1 but was: 0`**. The change committed, nothing was ever sent, and nothing in the database says a message is owed |

A side finding while building the second simulation: an exception thrown in `afterCommit` **propagates to the caller**, so the first version of the simulation made the request answer 500 although the change had already committed (the caller is told "failed" about something that succeeded). That is a third failure mode of the same design.

### 9.9 The kill-test on the real stack, 2026-10-06

The jar built by `mvn verify` (profile `local`, Postgres on 55432, Kafka and Redis from compose), process killed with `Stop-Process -Force`:

1. Poller **off** (`APPFLEET_OUTBOX_ENABLED=false`): created an application and a release through the API, then `POST /deployments`: **202**. One outbox row for the deployment with `sent_at` null; the topic holds nothing for it. This is the state "committed, not yet published".
2. **`kill -9` of the java process.** The row is still pending (`count(*) … sent_at is null` = 1): the message lives in the database, not in the process.
3. Restart with the poller **on**. Here the stack surprised us: **no topics existed.** `docker compose up kafka-init` had exited with code 1 (`Timed out waiting for a node assignment`) because the init container reaches the broker through the address the broker advertises, `localhost:9092`, and inside the init container `localhost` is the container itself. Compose disables topic auto-creation, so the poller had nothing to send to. Result for 2.5 minutes: **29 WARN lines** `Outbox message … not sent: KafkaException: Send failed`, one every few seconds (a send blocks up to `max.block.ms`, 3 s, then fails), the row still pending, **no request failed, nothing lost**.
4. Created the five topics from inside the broker container with the names and partition counts of the compose file (`task.work` 6). Within one poll cycle the row was published: `sent_at` set, pending count 0, and on the topic **key = the deployment id, header `message-id` = the outbox row id, header `command-type` = DEPLOY**, value = the command JSON.

So the kill-test passed, and an unplanned broker-side fault confirmed the other claims on a real process: a missing destination makes the poller retry quietly instead of losing or failing anything. **Infrastructure item, fixed 2026-10-06:** `kafka-init` could not create the topics as written (advertised listener). `docker-compose.yml` now has a second listener `INTERNAL` on `kafka:19092` and `kafka-init` uses it; it exits 0 and all five topics exist. See the concepts lesson `kf-advertised-listeners`.

### 9.10 Closed, 2026-10-06

`mvn verify`: **340 tests, 0 failures, 2 skipped by design** (control-api; `common-security` 41, `fleet-audit-starter` 3), with Postgres, Redis and Kafka Testcontainers. The outbox tests: `OutboxMessageTest` 1, `OutboxIndexTest` 1, `OutboxWriteTest` 4, `OutboxPollerTest` 2, `OutboxOrderTest` 1, `OutboxDeliveryTest` 6.

What is true after S4.5:

- A deployment or rollback request commits its state and its command **in one transaction**; a rolled-back request leaves no command (racing rollbacks: one row; the same race with `REQUIRES_NEW`: two, 3 of 3 runs).
- A poller publishes committed rows to `task.work` in id order, **one poller at a time** (the advisory lock; shown necessary for order, test 8b), keyed by deployment id, with `message-id` and `command-type` headers, waiting for the broker's acknowledgement before marking a row sent.
- Delivery is **at least once** (a commit failing after the send re-sends the row, same `message-id`), a failed send stops the batch and later rows wait in order, a dead broker or a missing topic produces WARN lines and retries, never a failed request.
- The two wrong designs were shown failing (dual write: 2 commands for one change; publish-after-commit: 0 for a committed change), and a real `kill -9` between commit and publish lost nothing.

What is not, and where it goes:

- **task-service does not exist yet:** nothing consumes `task.work`; deduplication on `idempotencyToken` is a stated dependency, not a verified one.
- **No metric or alert** on the pending count or the age of the oldest row; a stuck row is a WARN every few seconds and a growing `count(*)`.
- **Head-of-line blocking** is accepted: a row that can never be sent blocks the ones behind it (no attempts column, no parking state).
- **`kafka-init` was broken in compose** (the broker advertised `localhost:9092`, unreachable from the init container); **fixed 2026-10-06** with a second listener, so the topics now come from compose.
- The 8 open questions were all decided with the recommendations; one design claim was corrected by running it (duplicates are guarded twice, order only by the lock), recorded in 9.7.

## Definition of done

- [x] Tests 1 to 14 written first and run against the current code; the red ones recorded, including the jsonb error
- [x] `POST /deployments` and `POST /deployments/{id}/rollback` each write exactly one outbox row in the same transaction; a rejected or rolled-back request writes none (tests 2 to 5)
- [x] The dual-write and publish-after-commit failures were **shown** on a scratch copy (two messages for one change; a lost message), then the outbox version green
- [x] The poller publishes pending rows to `task.work` with the deployment id as key and the `message-id` and `command-type` headers; per-deployment order holds (tests 6, 7)
- [x] Two pollers publish each message once (test 8) and a later row never overtakes an earlier one (test 8b); a crash after send re-sends it with the same `message-id` (test 10)
- [x] A dead broker never fails a request and never makes the poller throw; the backlog is sent in order after recovery (tests 9, 11)
- [x] The producer has `acks=all` and idempotence on (test 13); V6's partial index exists (test 14)
- [x] The purge removes only old sent rows (test 12)
- [x] The kill-test done by hand on the dev stack: commit, `kill -9`, restart, the message goes out (Results 9.9; the topics had to be created through the broker container because `kafka-init` fails)
- [x] Mutation checks (a) to (e) seen red on a scratch copy
- [x] The statement count of `POST /deployments` re-measured (10, up from 8; no test pinned the count)
- [x] Results written; the plan's S4.5 row, the concepts guide and the Outline pages updated
- [x] `mvn verify` green with Testcontainers Postgres, Redis and Kafka
