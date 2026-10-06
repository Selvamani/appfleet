# control-api — S4.5: the outbox code, file by file

**Companion to** [control-api-s4-5-outbox.md](control-api-s4-5-outbox.md) (the design, the decisions and the Results). This document explains **the code**: what each file is for, how the pieces call each other, why each line is the way it is, which test proves it, and what to look at when it breaks. Written 2026-10-05 from the files on disk. **Status of each piece is in section 2; update it when the poller lands.**

## 1. The idea in one picture

A request that changes a deployment must also tell task-service. Two writes (the database and Kafka) cannot be one atomic action, so the second write becomes a database row and a separate poller moves it.

```
POST /deployments ──► DeploymentController
                          │
                          ▼
              DeploymentService.requestDeployment            @Transactional
                ├─ save Deployment                            ┐
                ├─ save Task (DEPLOY)                         │  one transaction:
                ├─ AuditEventRecorder.record  (REQUIRES_NEW)  │  commits or rolls back together
                └─ OutboxWriter.write         (MANDATORY) ───►│  insert into outbox_message
                                                              ┘
                          │ commit
                          ▼
        outbox_message row, sent_at = NULL        (the command, as jsonb)
                          │
              OutboxPoller.pollOnce  (every 1 s, one instance at a time)
                          │  send, wait for the broker's acknowledgement
                          ▼
              Kafka topic task.work, key = deployment id
                          │
                          ▼
              task-service (later): deduplicates on idempotencyToken
```

Three properties, each with its own test: **atomic** (the row exists if and only if the change committed), **ordered per deployment** (key = deployment id, one poller at a time), **at least once** (a crash may send a row twice; consumers deduplicate).

## 2. Status of every piece (2026-10-05)

| Piece | File | State |
|---|---|---|
| Command contract | `common-events/.../CommandType.java`, `DeploymentCommand.java` | built, used by the writer |
| Entity and `jsonb` mapping | `outbox/OutboxMessage.java` | built, `OutboxMessageTest` green |
| Table (V1) and pending index (V6) | `db/migration/V1__init.sql`, `V6__add_outbox_pending_index.sql` | built, `OutboxIndexTest` green |
| The write in the same transaction | `outbox/OutboxWriter.java` | built, `OutboxWriteTest` green |
| The two call sites | `deployment/DeploymentService.java` | built, `OutboxWriteTest` green |
| Repository queries | `outbox/OutboxMessageRepository.java` | queries written; used only by the poller |
| Settings | `outbox/OutboxProperties.java`, `config/AppfleetProperties.java` | written |
| **The poller** | `outbox/OutboxPoller.java` | **a skeleton on disk (`pollOnce()` does nothing).** The implementation is written in the S4.5 conversation but not yet applied or run: `OutboxPollerTest` is red against the skeleton, as intended |
| **Scheduling** | `outbox/OutboxScheduling.java` | **not yet created** |
| **Producer settings** | `application.yml` (`spring.kafka.producer.*`), `application-test.yml` (`outbox.enabled: false`) | **not yet applied** |

> **Update, later on 2026-10-05.** `OutboxMessage`, `OutboxWriter`, `OutboxProperties`, the poller queries of `OutboxMessageRepository` and the imports that referenced them were removed from the working tree by the owner, to be rewritten one by one from the guide in section 15. Until they exist again the module does not compile. The code of the pieces is in section 16 as a **verified reference** (run on a scratch copy, 16.0). Sections 3 to 14 describe the design and the code as it was.

Sections 3 to 9 describe the **built** pieces from the code on disk, and sections 10 to 12 describe the **poller, scheduling and settings** as designed and written, flagged as not yet run.

## 3. The command: `common-events`

`CommandType` is the two verbs task-service understands:

```java
public enum CommandType { DEPLOY, ROLLBACK }
```

`DeploymentCommand` is the message itself, a Java `record` (an immutable data holder: the compiler writes the constructor, the accessors `command.deploymentId()` and `equals`/`hashCode`/`toString`):

```java
public record DeploymentCommand(int schemaVersion, CommandType commandType, UUID idempotencyToken, UUID taskId,
                                UUID deploymentId, UUID applicationId, UUID releaseId, String environment,
                                String requestedBy, Instant requestedAt) {
    public static final int SCHEMA_VERSION = 1;

    public static DeploymentCommand of(CommandType commandType, UUID taskId, UUID deploymentId,
                                       UUID applicationId, UUID releaseId, String environment, String requestedBy) {
        return new DeploymentCommand(SCHEMA_VERSION, commandType, taskId, taskId, deploymentId,
                applicationId, releaseId, environment, requestedBy, Instant.now().truncatedTo(ChronoUnit.MILLIS));
    }
}
```

| Field | Meaning |
|---|---|
| `schemaVersion` | version of this layout (1); a consumer can refuse one it does not know |
| `commandType` | `DEPLOY` or `ROLLBACK` |
| `idempotencyToken` | what task-service deduplicates on; **equal to `taskId`** (design decision 4: stable across redelivery, unique per command, no new column) |
| `taskId` | the `Task` row this command belongs to |
| `deploymentId` | the aggregate; also the Kafka message key |
| `applicationId`, `releaseId`, `environment` | what to deploy and where, so the consumer needs no call back |
| `requestedBy` | the caller's `sub` (an opaque id) |
| `requestedAt` | when, truncated to milliseconds |

`of(...)` is the only place a command is built. It sets the four values the caller must not choose: the schema version, the token (a copy of `taskId`, hence `taskId` appears twice in the constructor call) and the timestamp. The module has **no Spring and no Jackson annotations on purpose**: it is what every service compiles against.

Serialized (Jackson 3 writes `Instant` as an ISO-8601 string, which `OutboxWriteTest` asserts):

```json
{ "schemaVersion": 1, "commandType": "DEPLOY", "idempotencyToken": "<task id>", "taskId": "<task id>",
  "deploymentId": "<id>", "applicationId": "<id>", "releaseId": "<id>", "environment": "staging",
  "requestedBy": "<sub>", "requestedAt": "2026-10-05T12:00:00.123Z" }
```

## 4. The table, the entity and the `jsonb` trap

V1 created the table long before anything wrote to it:

```sql
CREATE TABLE outbox_message (
    id           uuid PRIMARY KEY,
    aggregate_id uuid NOT NULL,
    payload      jsonb NOT NULL,
    created_at   timestamptz NOT NULL,
    sent_at      timestamptz            -- NULL = not published yet
);
```

`OutboxMessage` maps it:

```java
@Entity @Table(name = "outbox_message")
public class OutboxMessage {
    @Id private UUID id;                                     // UUIDv7, set in the constructor
    @Column(name = "aggregate_id", nullable = false) private UUID aggregateId;

    @JdbcTypeCode(SqlTypes.JSON)                             // see below
    @Column(nullable = false, columnDefinition = "jsonb") private String payload;

    @Column(name = "created_at", nullable = false) private Instant createdAt;
    @Column(name = "sent_at") private Instant sentAt;

    protected OutboxMessage() {}                             // for JPA only
    public OutboxMessage(UUID aggregateId, String payload) { // id = Uuidv7.generate(), createdAt = now
        ...
    }
    public void markSent() { this.sentAt = Instant.now(); } // the only state change
    // getters
}
```

- **`id` is assigned in the constructor** (UUIDv7, time-ordered, like `Task` and `AuditEvent`). Consequence: `repository.save(...)` of a new row does a *merge*, which first runs `select … where id = ?`. That is the extra select in the statement log (section 8).
- **The `jsonb` trap.** The entity had `columnDefinition = "jsonb"` from the start, which only tells Hibernate how to *create* the column. Binding a Java `String` still sends `varchar`, and Postgres refuses: `ERROR: column "payload" is of type jsonb but expression is of type character varying`. The fix is `@JdbcTypeCode(SqlTypes.JSON)`. Found by writing `OutboxMessageTest` first (S4.5 Results 9.1): red on a scratch copy without the annotation, green with it.
- **Immutable except `sentAt`.** Nothing changes a row after it is written except `markSent()`. A published row is kept 24 hours, then purged.
- **Nothing in the entity knows about Kafka.** It is a row with a state; the poller decides what to do with it.

**V6** adds the index the poller needs:

```sql
CREATE INDEX idx_outbox_pending ON outbox_message (id) WHERE sent_at IS NULL;
```

A **partial index**: it holds only unsent rows, in id order, so the poller's query ("the oldest unsent rows") is a short index range scan that stays small however many sent rows the table keeps. Without it Postgres would walk the primary key and filter, the same shape as S3.4 and S4.4. The file name must be `V<n>__<description>.sql`; the first attempt was named after the test and Flyway ignored it (Results 9.3).

## 5. `OutboxWriter`: the same transaction, enforced

```java
@Component
public class OutboxWriter {
    private final OutboxMessageRepository repository;
    private final JsonMapper json;                      // Jackson 3 (tools.jackson), the application's mapper

    public OutboxWriter(OutboxMessageRepository repository, JsonMapper json) { ... }

    @Transactional(propagation = Propagation.MANDATORY)
    public void write(DeploymentCommand command) {
        repository.save(new OutboxMessage(command.deploymentId(), json.writeValueAsString(command)));
    }
}
```

- `@Component`: Spring builds one instance and injects the two collaborators through the constructor.
- **`Propagation.MANDATORY`** is the guard. Plain `@Transactional` would *open* a transaction if there were none; `MANDATORY` *throws* instead. So the row can only ever be written inside the caller's transaction and commits or rolls back with the state change. If someone calls it from a non-transactional method, it fails loudly in the first test that does so.
- **It is deliberately the opposite of `AuditEventRecorder`**, which is `REQUIRES_NEW` (the audit row must survive a rollback). The mutation check of Results 9.4 shows the difference as a number: with `REQUIRES_NEW`, two racing rollbacks leave **two** outbox rows (the loser's row, for a task that was rolled back, survives); with `MANDATORY`, one.
- `aggregate_id` is the deployment id; `payload` is the JSON text of the command (section 3).

## 6. The two call sites in `DeploymentService`

Both methods are `@Transactional` (REQUIRED, the default). The outbox write is the **last** write before the `return`, after the audit call:

```java
// requestDeployment
Deployment deployment = new Deployment(application, release, environment);
deploymentRepository.saveAndFlush(deployment);
Task task = taskRepository.save(new Task(deployment, Task.DEPLOY));
auditEventRecorder.record(new AuditEvent(actor, "DEPLOYMENT_REQUESTED", "deployment", deployment.getId(), null));
outboxWriter.write(DeploymentCommand.of(CommandType.DEPLOY, task.getId(), deployment.getId(),
        application.getId(), release.getId(), environment.getName(), actor));
return new DeploymentAccepted(deployment.getId(), task.getId(), deployment.getStatus());

// requestRollback (after the owner check, the state check and the open-rollback check)
Task task = taskRepository.save(new Task(deployment, Task.ROLLBACK));
auditEventRecorder.record(new AuditEvent(actor, "ROLLBACK_REQUESTED", "deployment", deployment.getId(), null));
outboxWriter.write(DeploymentCommand.of(CommandType.ROLLBACK, task.getId(), deployment.getId(),
        deployment.getApplication().getId(), deployment.getRelease().getId(),
        deployment.getEnvironment().getName(), actor));
return new RollbackAccepted(deployment.getId(), task.getId());
```

What is in the transaction and what is not:

| Write | Transaction | If the request fails later |
|---|---|---|
| `Deployment`, `Task` | the request's | rolled back |
| `audit_event` | **its own** (`REQUIRES_NEW`) | **kept** (the documented orphan audit row of S3.3) |
| `outbox_message` | the request's (`MANDATORY`) | **rolled back** |

A request that is rejected before the write (404, 409, 422, a lost optimistic-lock race) never reaches `outboxWriter.write`, or reaches it and rolls back with everything else. `OutboxWriteTest.rejectedRequests_writeNoMessage` and `racingRollbacks_leaveExactlyOneMessage` prove both.

**The statement count.** `POST /deployments` is now **10 statements**, up from 8: the outbox adds a merge-select and an insert (measured with `org.hibernate.SQL` at DEBUG, one correlation id; Results 9.3). The audit insert appears before the task insert because the audit row commits first, in its own transaction.

**A slip worth remembering:** the first version of the `requestDeployment` call passed `CommandType.ROLLBACK` (copied from the rollback method). `OutboxWriteTest.requestDeployment_writesOneOutboxMessage` caught it: `expected: "DEPLOY" but was: "ROLLBACK"`.

## 7. `OutboxMessageRepository`: three queries for the poller

```java
public interface OutboxMessageRepository extends JpaRepository<OutboxMessage, UUID> {

    List<OutboxMessage> findBySentAtIsNull();       // leftover from the skeleton; nothing uses it, remove it

    @Query(value = "select pg_try_advisory_xact_lock(:key)", nativeQuery = true)
    boolean tryLeaderLock(@Param("key") long key);

    @Query(value = """
            SELECT * FROM {h-schema}outbox_message
             WHERE sent_at IS NULL
             ORDER BY id
             LIMIT :limit
               FOR UPDATE SKIP LOCKED
            """, nativeQuery = true)
    List<OutboxMessage> lockPending(@Param("limit") int limit);

    @Modifying
    @Query(value = "DELETE FROM {h-schema}outbox_message WHERE sent_at IS NOT NULL AND sent_at < :cutoff", nativeQuery = true)
    int deleteSentBefore(@Param("cutoff") Instant cutoff);
}
```

- **`tryLeaderLock`**: `pg_try_advisory_xact_lock` takes an application-level lock named by a number and returns `true` if it got it, `false` at once if another session holds it. "xact" means it is released automatically at commit or rollback, so it can never leak a connection. This is how only **one poller at a time** publishes (design decision 6): with several pollers racing on `SKIP LOCKED` alone, instance B could publish a later command of a deployment before instance A published the earlier one, which defeats the key.
- **`lockPending`**: the oldest unsent rows in id order. `FOR UPDATE` locks them for the transaction, `SKIP LOCKED` skips rows another transaction holds (a second guard if the leader lock is ever absent). It is native SQL because `SKIP LOCKED` has no JPQL form, and `{h-schema}` is Hibernate's placeholder for the schema (`control.`): without it the unqualified table name is not found (the S2 `findLineage` lesson). The result is a list of **managed entities**, so `message.markSent()` is saved at commit by dirty checking, with no explicit `save`.
- **`deleteSentBefore`**: purges rows sent before a cutoff; `@Modifying` marks it as a write. Pending rows (`sent_at IS NULL`) never match.

## 8. Settings

`OutboxProperties` is bound from `appfleet.outbox.*`, nested in `AppfleetProperties` next to the rate limit:

```java
public record OutboxProperties(@DefaultValue("true") boolean enabled,
                               @DefaultValue("task.work") @NotBlank String topic,
                               @DefaultValue("100") @Positive int batchSize,
                               @DefaultValue("1s") Duration pollInterval,
                               @DefaultValue("5s") Duration sendTimeout,
                               @DefaultValue("24h") Duration retention) {}

public record AppfleetProperties(@NotBlank String environment,
                                 @DefaultValue @Valid RateLimitProperties rateLimit,
                                 @DefaultValue @Valid OutboxProperties outbox) {}
```

| Key | Default | Meaning |
|---|---|---|
| `appfleet.outbox.enabled` | `true` | switches the **scheduled** poll only; `pollOnce()` always works (tests call it directly) |
| `appfleet.outbox.topic` | `task.work` | the Kafka topic (6 partitions in compose) |
| `appfleet.outbox.batch-size` | `100` | rows per cycle |
| `appfleet.outbox.poll-interval` | `1s` | delay between cycles |
| `appfleet.outbox.send-timeout` | `5s` | how long to wait for one acknowledgement |
| `appfleet.outbox.retention` | `24h` | how long a sent row is kept before the purge |

Environment variable form: `APPFLEET_OUTBOX_ENABLED=false` (relaxed binding, as in the rate-limit manual check). Adding the component broke one existing unit test that builds `AppfleetProperties` by hand: `RateLimitInterceptorTest` got a third constructor argument.

## 9. Tests that cover the built pieces

| Test | Proves |
|---|---|
| `OutboxMessageTest.outboxMessage_roundTripsThroughJpa` | the entity persists, `payload` is real `jsonb` (a `->>` query works), nothing is lost on read |
| `OutboxWriteTest.requestDeployment_writesOneOutboxMessage` | one `DEPLOY` row with all payload fields, `idempotencyToken` = `taskId`, `requestedBy` = the caller |
| `OutboxWriteTest.requestRollback_writesOneOutboxMessage` | one `ROLLBACK` row |
| `OutboxWriteTest.rejectedRequests_writeNoMessage` | 404, 409, 422 and a rejected second rollback write nothing; the successful rollback writes exactly one |
| `OutboxWriteTest.racingRollbacks_leaveExactlyOneMessage` | the loser's row rolls back with its change (mutation: `REQUIRES_NEW` leaves two) |
| `OutboxIndexTest.v6_createsThePartialPendingIndex` | the partial index exists in `pg_indexes` |

## 10. The poller (written, not yet run)

This is the design of `OutboxPoller` as written in the S4.5 conversation. **The file on disk is still the empty skeleton**; read this section as the specification the code is being brought to.

```java
@Component
public class OutboxPoller {
    // fields: repository, KafkaTemplate<String,String> kafka, TransactionTemplate transaction, JsonMapper json, OutboxProperties

    public void pollOnce() {                       // never throws
        try { transaction.executeWithoutResult(status -> cycle()); }
        catch (RuntimeException e) { log.warn("Outbox cycle failed, will retry: {}", e.toString()); }
    }

    private void cycle() {                          // inside one transaction
        if (!repository.tryLeaderLock(LEADER_LOCK_KEY)) return;          // another instance polls this cycle
        for (OutboxMessage message : repository.lockPending(properties.batchSize())) {
            if (!publish(message)) break;                                // failure stops the batch
            message.markSent();                                          // dirty-checked, saved at commit
        }
        beforeCommit();                                                  // test seam, empty in production
    }

    private boolean publish(OutboxMessage message) {
        // parse the payload back into DeploymentCommand (validates it), build the ProducerRecord:
        //   topic = properties.topic(), key = aggregate id, value = the JSON, headers message-id and command-type
        // kafka.send(record).get(sendTimeout)  -> waits for the broker's acknowledgement
        // any exception: log WARN, return false
    }
}
```

How to read it:

1. **One cycle is one transaction** (`TransactionTemplate`). It takes the leader lock, reads up to `batchSize` unsent rows in id order, and for each one sends and **waits for the acknowledgement** before calling `markSent()`. A row is marked sent only after the broker has it.
2. **A failed send stops the batch** (`break`): the rows acknowledged before it are marked and committed, the failed row and everything after stay pending and are retried next cycle in order. The price is **head-of-line blocking**: a message that can never be sent blocks the ones behind it. Accepted for now (design decision 7).
3. **At least once.** If the process dies after an acknowledgement and before the commit, the row is still `sent_at IS NULL` and is sent again. The `message-id` header (the outbox row id) lets a consumer recognise the duplicate; `idempotencyToken` lets it ignore it.
4. **`pollOnce()` never throws**, so a dead broker cannot crash the scheduler. With a dead broker the send times out (the producer settings below bound it to seconds), the cycle logs a WARN, nothing is marked, and the next cycle retries.
5. **`beforeCommit()`** is empty and `protected`: a test subclass overrides it to throw, simulating "sent, then crashed before the commit".
6. **`purgeSentBefore(Instant)`** deletes old sent rows in its own transaction; `purgeOldSent()` calls it with `now - retention`.

## 11. Scheduling and producer settings (written, not yet applied)

`OutboxScheduling` (to be created) registers the two periodic jobs with the configured interval:

```java
@Configuration @EnableScheduling
public class OutboxScheduling implements SchedulingConfigurer {
    public void configureTasks(ScheduledTaskRegistrar registrar) {
        registrar.addFixedDelayTask(() -> { if (properties.enabled()) poller.pollOnce(); }, properties.pollInterval());
        registrar.addFixedDelayTask(poller::purgeOldSent, Duration.ofHours(1));
    }
}
```

`fixedDelay` means "wait this long *after the previous run finished*", so a slow cycle cannot overlap itself. Typed `Duration` from `OutboxProperties` is used instead of `@Scheduled(fixedDelayString=…)` so the configured value and the schedule cannot disagree.

Producer reliability settings (design decision 8), under `spring.kafka` in `application.yml`:

```yaml
spring:
  kafka:
    bootstrap-servers: ${KAFKA_HOST:localhost}:${KAFKA_PORT:9092}
    producer:
      acks: all
      properties:
        enable.idempotence: true
        delivery.timeout.ms: 6000
        request.timeout.ms: 3000
        max.block.ms: 3000
```

- `acks: all` — the send is acknowledged only when the in-sync replicas have it (the compose broker has replication factor 1, so here it is the single broker).
- `enable.idempotence: true` — the producer's retries cannot duplicate a record within a session.
- The three timeouts bound how long a send can hang on a dead broker: a cycle ends in seconds, not minutes (`delivery.timeout.ms` must be at least `request.timeout.ms` plus linger).

`application-test.yml` sets `appfleet.outbox.enabled: false` so the existing suite never runs the scheduled poll or needs Kafka, as rate limiting is switched off there. The outbox tests call `pollOnce()` themselves against a Kafka Testcontainer.

## 12. The tests still to come, and what each will prove

| Test (design table 4.1) | Proves | Mutation that must turn it red |
|---|---|---|
| 6 `poller_publishesAPendingMessage` (written, red against the skeleton) | one record, key = deployment id, value = payload, headers, `sent_at` set | — |
| 7 `poller_keepsPerDeploymentOrder` (written, red) | `DEPLOY` then `ROLLBACK` on one partition, in order | — |
| 8 `twoPollers_publishEachMessageOnce` | 50 rows, two pollers, 50 records, no duplicates (guarded by **two independent guards**, the advisory lock and `FOR UPDATE SKIP LOCKED`; only removing **both** turns it red, 100 records) | remove both |
| 8b `leaderLock_stopsALaterRowOvertaking` | a poller held before sending row 1 cannot be overtaken: a second poller publishes nothing while the first holds the lock | remove the leader lock |
| 9 `kafkaDown_requestStillSucceeds_andIsSentLater` | a dead broker never fails a request or throws; the backlog goes out later | — |
| 10 `crashAfterSend_resendsTheMessage` | a failed commit after a send re-sends it with the same `message-id` | mark sent before the send |
| 11 `failedSend_stopsTheBatch_inOrder` | rows after a failure stay pending and go out in order | carry on after a failure |
| 12 `purge_deletesOnlyOldSentRows` | old sent rows deleted; recent sent and any pending kept | purge pending rows too |
| 13 `producerIsConfiguredForReliability` | `acks=all`, idempotence on | `acks=1` |

Also still to show on a scratch copy: the **dual write** (a `KafkaTemplate.send` inside the transaction) and **publish-after-commit**, each failing in its own way (design section 6, step 3).

## 13. Operating it

Inspect the backlog (psql in the compose Postgres, schema `control`):

```sql
select count(*) from outbox_message where sent_at is null;                       -- pending
select id, aggregate_id, payload->>'commandType', created_at
  from outbox_message where sent_at is null order by id limit 20;                -- the oldest waiting
select count(*) from outbox_message where sent_at is not null;                   -- kept for the retention
```

A **growing pending count with a WARN every second** means a send keeps failing (broker down, topic missing, or a poisoned row blocking the line). There is no metric or alert in this step.

Turn the scheduled poll off for one instance with `APPFLEET_OUTBOX_ENABLED=false`. The kill-test by hand (design 4.2): poller off, `POST /deployments`, confirm the pending row and an empty topic, `kill -9` the process, restart with the poller on, the message appears on `task.work` with the same `message-id`.

## 14. Mistakes made while building it, each caught by a test

| Mistake | Caught by | Lesson |
|---|---|---|
| `String` bound to a `jsonb` column | `OutboxMessageTest` | `columnDefinition` creates the column; `@JdbcTypeCode(SqlTypes.JSON)` binds it |
| Migration named after the test | `OutboxIndexTest` | Flyway needs `V<n>__<description>.sql` |
| `CommandType.ROLLBACK` in `requestDeployment` | `OutboxWriteTest` | the assertion on `commandType` |
| Outbox write on `REQUIRES_NEW` (mutation) | `racingRollbacks_leaveExactlyOneMessage` | `MANDATORY` makes the property a property of the class |
| Missing space in the foreign-application 422 text (S4.4, found on the way) | the new `POST /deployments` comparison in `ObjectAuthorizationTest` | the guarantee "indistinguishable from missing" needs the text compared, not only the status |

## 15. Implementation guide: build the rest yourself

Each task below says what to build, the contract, the steps, what "done" means (a test, not a feeling) and the traps. The **reference code** in section 16 is for comparing after you have tried; it was run on a scratch copy (section 16.0). Work in this order; every task ends with a green test before the next starts.

### Task 0: where the tree stands, and the two things that will bite first

On 2026-10-05 `OutboxMessage`, `OutboxWriter`, `OutboxProperties`, the poller queries in `OutboxMessageRepository`, and the imports that referenced them were removed from the working tree so they could be rewritten. Until they exist again the project does not compile. Two traps found while verifying the reference solution:

1. **`KafkaTemplate` is not a bean with the plain `spring-kafka` dependency.** `control-api/pom.xml` lists `org.springframework.kafka:spring-kafka`, which is the library only. In Spring Boot 4 the Kafka auto-configuration lives in its own module, so the application context fails to start with `No qualifying bean of type 'org.springframework.kafka.core.KafkaTemplate<java.lang.String, java.lang.String>'`. Replace the dependency with `org.springframework.boot:spring-boot-starter-kafka` (the version comes from the Boot parent, 4.1.0). The first full run after adding the poller shows this as every Spring test failing to load its context, not as one failing test.
2. **Imports.** `DeploymentService` and `AppfleetProperties` need `import io.appfleet.control.outbox.OutboxWriter;` and `import io.appfleet.control.outbox.OutboxProperties;`, and `RateLimitInterceptorTest` needs `OutboxProperties` for the hand-built `AppfleetProperties`.

### Task 1: `OutboxMessage` (the entity)

- **Goal:** map the `outbox_message` table.
- **Contract:** fields `id` (UUID, assigned in the constructor with `Uuidv7.generate()`), `aggregateId`, `payload` (a `String`), `createdAt`, `sentAt`; a `protected` no-argument constructor for JPA; `public OutboxMessage(UUID aggregateId, String payload)`; `markSent()`; getters.
- **Steps:** `@Entity @Table(name = "outbox_message")`; `@Column(name = "aggregate_id", nullable = false)` and `@Column(name = "created_at", nullable = false)` and `@Column(name = "sent_at")` for the snake_case columns; `@JdbcTypeCode(SqlTypes.JSON)` plus `@Column(nullable = false, columnDefinition = "jsonb")` on `payload`.
- **Done when:** `OutboxMessageTest` is green. **Prove it can fail first:** leave `@JdbcTypeCode` off and run it; you should see `column "payload" is of type jsonb but expression is of type character varying`.
- **Trap:** `columnDefinition` only affects table creation; it does not change how the value is bound.

### Task 2: `OutboxProperties` and the wiring

- **Goal:** typed settings for the poller.
- **Contract:** a record `OutboxProperties(boolean enabled, String topic, int batchSize, Duration pollInterval, Duration sendTimeout, Duration retention)` with `@DefaultValue` of `true`, `task.work`, `100`, `1s`, `5s`, `24h`; `@NotBlank` on the topic and `@Positive` on the batch size. Nest it in `AppfleetProperties` as a third component `@DefaultValue @Valid OutboxProperties outbox`.
- **Steps:** the record; the extra component and import; the third constructor argument in `RateLimitInterceptorTest`; `outbox.enabled: false` in `application-test.yml`.
- **Done when:** the context starts and `RateLimitInterceptorTest` (5) passes.
- **Trap:** a record binds through its canonical constructor; a missing import in `AppfleetProperties` is the whole reason the module stops compiling.

### Task 3: `OutboxWriter` and the two call sites

- **Goal:** write the command row in the caller's transaction.
- **Contract:** `@Component`; constructor `(OutboxMessageRepository, JsonMapper)`; one method `write(DeploymentCommand)` annotated `@Transactional(propagation = Propagation.MANDATORY)`. `JsonMapper` is `tools.jackson.databind.json.JsonMapper` (Jackson 3).
- **Steps:** the class; in `DeploymentService` a field, a last constructor parameter, and the two calls after the audit call and before the `return`: `CommandType.DEPLOY` in `requestDeployment` with `application.getId()`, `release.getId()`, `environment.getName()`; `CommandType.ROLLBACK` in `requestRollback` with `deployment.getApplication().getId()`, `deployment.getRelease().getId()`, `deployment.getEnvironment().getName()`.
- **Done when:** `OutboxWriteTest` (4) is green, including `racingRollbacks_leaveExactlyOneMessage`. **Prove it can fail:** on a copy, change `MANDATORY` to `REQUIRES_NEW` and run the racing test; you should see two rows with different `taskId`s.
- **Traps:** pass `DEPLOY` in `requestDeployment` (the first attempt copied `ROLLBACK`); the write must come **after** the task is saved so `task.getId()` exists.

### Task 4: the repository queries

- **Goal:** the three queries the poller needs.
- **Contract:** `boolean tryLeaderLock(long key)` as `select pg_try_advisory_xact_lock(:key)`; `List<OutboxMessage> lockPending(int limit)` selecting unsent rows ordered by `id` with `LIMIT :limit FOR UPDATE SKIP LOCKED`; `int deleteSentBefore(Instant cutoff)` as a `@Modifying` delete of rows with `sent_at` before the cutoff. All three `nativeQuery = true`.
- **Steps:** use `{h-schema}` before the table name in the two queries that name it (see `BaseImageRepository`); bind with `@Param`.
- **Done when:** the poller (task 5) runs. An optional repository test: insert three pending rows, call `lockPending(2)` inside a transaction, expect the two oldest by id.
- **Traps:** native SQL needs `{h-schema}` or the unqualified table is not found in the `control` schema; `pg_try_advisory_xact_lock` only works inside a transaction, which the poller's `TransactionTemplate` provides; delete the unused `findBySentAtIsNull()`.

### Task 5: `OutboxPoller`

- **Goal:** publish committed rows to Kafka, at least once, in order.
- **Contract:** `@Component`; constructor `(OutboxMessageRepository, KafkaTemplate<String,String>, TransactionTemplate, JsonMapper, AppfleetProperties)`; public `void pollOnce()` that never throws; public `int purgeSentBefore(Instant)`; public `void purgeOldSent()`; two `protected` empty seams, `beforePublish(OutboxMessage)` and `beforeCommit()`.
- **Algorithm of one cycle (inside one `transaction.executeWithoutResult`):**
  1. `tryLeaderLock(KEY)` with a constant `long`; if `false`, return (another instance is polling).
  2. `lockPending(batchSize)`.
  3. For each row: call `beforePublish(row)`; build a `ProducerRecord(topic, key = aggregateId.toString(), value = payload)`; add the headers `message-id` (the row id) and `command-type` (read from the payload by `json.readValue(payload, DeploymentCommand.class)`); `kafka.send(record).get(sendTimeout, MILLISECONDS)`; on success `row.markSent()`; on **any** exception log a WARN and `break`.
  4. Call `beforeCommit()`. The commit saves the `sent_at` of the marked rows by dirty checking; no explicit `save`.
- **`pollOnce()`** wraps the transaction in a `try/catch (RuntimeException)` that logs and returns, so a dead broker never throws into the scheduler.
- **Done when:** `OutboxPollerTest` (tests 6 and 7) is green: one record per row, key = deployment id, the two headers, `sent_at` set, `DEPLOY` before `ROLLBACK` on one partition.
- **Traps:** `.get(...)` with a timeout is what waits for the acknowledgement; without it you would mark rows sent that the broker never received. Restore the thread's interrupt flag when you catch `InterruptedException`. Do not call `repository.save` on the marked rows: they are managed entities.

### Task 6: `OutboxScheduling` and the producer settings

- **Goal:** run the poll and the purge on a schedule, and make a send fail fast.
- **Contract:** a `@Configuration @EnableScheduling` class implementing `SchedulingConfigurer`; in `configureTasks` register `addFixedDelayTask` for the poll (skipped while `properties.enabled()` is false) with `properties.pollInterval()`, and for `poller::purgeOldSent` every hour. In `application.yml` under `spring.kafka`: `producer.acks: all` and `producer.properties` `enable.idempotence: true`, `delivery.timeout.ms: 6000`, `request.timeout.ms: 3000`, `max.block.ms: 3000`.
- **Done when:** the application starts with the poller on and the scheduled poll publishes a pending row without a test calling `pollOnce()` (check by hand in task 9), and the existing suite is unchanged (the test profile has the poll off).
- **Trap:** `delivery.timeout.ms` must be at least `request.timeout.ms` plus linger or the producer refuses to start.

### Task 7: the remaining tests (specifications, write them yourself)

Write each test before the behaviour it checks if the behaviour is not already there.

| Test | Arrange | Act | Assert |
|---|---|---|---|
| 8 `twoPollers_publishEachMessageOnce` | insert 50 pending rows for distinct unique aggregates (`repository.save` of `OutboxMessage` with a payload built from `DeploymentCommand.of(...)` and `json.writeValueAsString`); build **two** `OutboxPoller` objects with `new`, from the autowired dependencies | release both from a `CyclicBarrier` and call `pollOnce()` on both | consuming the topic filtered to your 50 keys gives exactly 50 records and no duplicates; all 50 rows have `sent_at`. Duplicates are prevented by the advisory lock and by `FOR UPDATE SKIP LOCKED`, each on its own; this test goes red only if **both** are removed |
| 8b `leaderLock_stopsALaterRowOvertaking` | one deployment with two pending rows r1 and r2; a subclass of `OutboxPoller` for A whose `beforePublish` blocks on a latch the first time (after r1 is locked, before it is sent) | start A's `pollOnce()` on a thread; wait until A is blocked; run `pollOnce()` of a second poller B on the test thread; release A | after B's cycle and **before** releasing A the topic holds **no** record for the key (with the leader lock, B publishes nothing); after releasing A it holds r1 then r2. Without the leader lock B would skip the locked r1 and publish r2 first |
| 9 `kafkaDown_requestStillSucceeds_andIsSentLater` | a second `KafkaTemplate` whose producer factory points at `localhost:1` with `max.block.ms` and `delivery.timeout.ms` small; a poller built with it | `POST /deployments` (202), then the dead poller's `pollOnce()`, then the normal poller's | the POST was 202; the dead `pollOnce()` returned without throwing and the row is still pending; the normal poller then publishes it; measure how long the failed cycle took and assert it is a few seconds, not minutes |
| 10 `crashAfterSend_resendsTheMessage` | a poller subclass whose `beforeCommit` throws once | one pending row; `pollOnce()` (the transaction rolls back after the send), then a normal `pollOnce()` | the row was pending after the first call, and the topic holds **two** records for the key with the **same** `message-id` header |
| 11 `failedSend_stopsTheBatch_inOrder` | three pending rows r1, r2, r3 of three aggregates; a poller whose `KafkaTemplate` fails the second send (a `ProducerFactory` wrapper, or a subclass overriding the send step) | `pollOnce()`, then a normal `pollOnce()` | after the first call r1 has `sent_at`, r2 and r3 do not; after the second all three are sent, r2 before r3 |
| 12 `purge_deletesOnlyOldSentRows` | an old sent row, a recent sent row, an old **pending** row | `purgeSentBefore(cutoff)` | only the old sent row is gone; the return value is 1 |
| 13 `producerIsConfiguredForReliability` | autowire the `ProducerFactory` | read `getConfigurationProperties()` | `acks` is `all` and `enable.idempotence` is `true` |

### Task 8: show the two wrong designs failing (scratch copy)

On a copy of the repository: (1) **dual write**: add a `KafkaTemplate.send` call inside `DeploymentService.requestRollback`, before the commit, and run `racingRollbacks_leaveExactlyOneMessage` extended to count the records on the topic; the loser has already sent its command when it fails at commit, so the topic holds two. (2) **publish after commit**: send from a `TransactionSynchronization.afterCommit` and make the process exit between the commit and the send; the row is committed and nothing was sent. Record both in the Results.

### Task 9: the kill-test and the mutation checks

- **Kill-test by hand:** compose up (Postgres, Redis, Kafka and `kafka-init`); run the jar with `APPFLEET_OUTBOX_ENABLED=false`; `POST /deployments`; confirm `select count(*) from outbox_message where sent_at is null` is 1 and the topic is empty; `kill -9` the java process; restart with the poller on; confirm the message appears on `task.work` with the same `message-id` and `sent_at` is set.
- **Mutations on a scratch copy**, one at a time, **touching every restored file** (the stale-class trap): (a) `REQUIRES_NEW` on the writer: the racing test goes red; (b) the leader lock removed: test 8b goes red (test 8 stays green); (b2) `FOR UPDATE SKIP LOCKED` removed with the lock kept: test 8 **stays green**; (b3) both removed: test 8 goes red (100 records); (c) `markSent` before the send: tests 10 and 11 go red; (d) `acks: 1`: test 13 goes red; (e) carry on after a failed send: test 11 goes red.
- **Close:** `mvn verify`, the statement count of `POST /deployments` (10), the Results section of the design doc, the plan row, the concepts guide (`kf-outbox`), the Outline pages.

## 16. Reference code (verified)

### 16.0 What was verified

The files below were assembled on a **scratch copy** of the repository (the real tree was being rewritten) and run through the reactor: `OutboxPollerTest` 2 of 2, `OutboxWriteTest` 4 of 4, `OutboxMessageTest` 1 of 1, `OutboxIndexTest` 1 of 1 and `RateLimitInterceptorTest` 5 of 5 green, with the pom change of 16.7. **Not** run on the reference: the full `mvn verify`, tests 8 to 13 (they are specifications in task 7), and the `beforePublish` seam (added for test 8b; it compiles and is not called by tests 6 and 7). The tests in 16.8 are the ones on disk in the real tree.

### 16.1 `OutboxMessage`

```java
package io.appfleet.control.outbox;

import io.appfleet.control.common.Uuidv7;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "outbox_message")
public class OutboxMessage {

    @Id
    private UUID id;

    @Column(name = "aggregate_id", nullable = false)
    private UUID aggregateId;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(nullable = false, columnDefinition = "jsonb")
    private String payload;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "sent_at")
    private Instant sentAt;

    protected OutboxMessage() {
    }

    public OutboxMessage(UUID aggregateId, String payload) {
        this.id = Uuidv7.generate();
        this.aggregateId = aggregateId;
        this.payload = payload;
        this.createdAt = Instant.now();
    }

    public void markSent() {
        this.sentAt = Instant.now();
    }

    public UUID getId() {
        return id;
    }

    public UUID getAggregateId() {
        return aggregateId;
    }

    public String getPayload() {
        return payload;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public Instant getSentAt() {
        return sentAt;
    }
}
```

### 16.2 `OutboxProperties` and `AppfleetProperties`

```java
package io.appfleet.control.outbox;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Positive;
import org.springframework.boot.context.properties.bind.DefaultValue;

import java.time.Duration;

/** appfleet.outbox.*: the poller of S4.5. {@code enabled} switches only the scheduled run, never pollOnce(). */
public record OutboxProperties(@DefaultValue("true") boolean enabled,
                               @DefaultValue("task.work") @NotBlank String topic,
                               @DefaultValue("100") @Positive int batchSize,
                               @DefaultValue("1s") Duration pollInterval,
                               @DefaultValue("5s") Duration sendTimeout,
                               @DefaultValue("24h") Duration retention) {
}
```

`AppfleetProperties` gains the third component and the import `io.appfleet.control.outbox.OutboxProperties`:

```java
public record AppfleetProperties(@NotBlank String environment,
                                 @DefaultValue @Valid RateLimitProperties rateLimit,
                                 @DefaultValue @Valid OutboxProperties outbox) {
}
```

`RateLimitInterceptorTest` builds the properties by hand and needs the new argument (and the import):

```java
new RateLimitInterceptor(
        new AppfleetProperties("test", new RateLimitProperties(enabled, 3, 1.0),
                new OutboxProperties(false, "task.work", 100, Duration.ofSeconds(1), Duration.ofSeconds(5), Duration.ofHours(24))), limiter);
```

### 16.3 `OutboxWriter`

```java
package io.appfleet.control.outbox;

import io.appfleet.events.DeploymentCommand;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;
import tools.jackson.databind.json.JsonMapper;

/**
 * Writes a command as an outbox row. MANDATORY: it must join the caller's transaction, never start its own,
 * because the row has to commit or roll back together with the state change it announces.
 */
@Component
public class OutboxWriter {

    private final OutboxMessageRepository repository;
    private final JsonMapper json;

    public OutboxWriter(OutboxMessageRepository repository, JsonMapper json) {
        this.repository = repository;
        this.json = json;
    }

    @Transactional(propagation = Propagation.MANDATORY)
    public void write(DeploymentCommand command) {
        repository.save(new OutboxMessage(command.deploymentId(), json.writeValueAsString(command)));
    }
}
```

`DeploymentService`: the import `io.appfleet.control.outbox.OutboxWriter`, `io.appfleet.events.CommandType` and `io.appfleet.events.DeploymentCommand`; a field and a last constructor parameter `OutboxWriter outboxWriter`; and the two calls, each right after the `auditEventRecorder.record(...)` line and before the `return`:

```java
// requestDeployment
outboxWriter.write(DeploymentCommand.of(CommandType.DEPLOY, task.getId(), deployment.getId(),
        application.getId(), release.getId(), environment.getName(), actor));

// requestRollback
outboxWriter.write(DeploymentCommand.of(CommandType.ROLLBACK, task.getId(), deployment.getId(),
        deployment.getApplication().getId(), deployment.getRelease().getId(),
        deployment.getEnvironment().getName(), actor));
```

### 16.4 `OutboxMessageRepository`

```java
package io.appfleet.control.outbox;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

public interface OutboxMessageRepository extends JpaRepository<OutboxMessage, UUID> {

    /** Transaction-scoped leader lock: one poller at a time, so per-deployment order cannot invert (decision 6). */
    @Query(value = "select pg_try_advisory_xact_lock(:key)", nativeQuery = true)
    boolean tryLeaderLock(@Param("key") long key);

    /** The oldest unsent rows, in id order. SKIP LOCKED is the second guard behind the leader lock. */
    @Query(value = """
            SELECT * FROM {h-schema}outbox_message
             WHERE sent_at IS NULL
             ORDER BY id
             LIMIT :limit
               FOR UPDATE SKIP LOCKED
            """, nativeQuery = true)
    List<OutboxMessage> lockPending(@Param("limit") int limit);

    @Modifying
    @Query(value = "DELETE FROM {h-schema}outbox_message WHERE sent_at IS NOT NULL AND sent_at < :cutoff", nativeQuery = true)
    int deleteSentBefore(@Param("cutoff") Instant cutoff);
}
```

### 16.5 `OutboxPoller`

```java
package io.appfleet.control.outbox;

import io.appfleet.control.config.AppfleetProperties;
import io.appfleet.events.DeploymentCommand;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.json.JsonMapper;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
import java.util.concurrent.TimeUnit;

/**
 * Moves committed outbox rows to Kafka. One cycle is one transaction: take the leader lock, read the oldest
 * unsent rows, send each and wait for its acknowledgement, mark the acknowledged ones sent, commit.
 * Delivery is at least once: a crash between an acknowledgement and the commit sends that row again.
 */
@Component
public class OutboxPoller {

    private static final Logger log = LoggerFactory.getLogger(OutboxPoller.class);
    private static final long LEADER_LOCK_KEY = 7_450_001L;

    private final OutboxMessageRepository repository;
    private final KafkaTemplate<String, String> kafka;
    private final TransactionTemplate transaction;
    private final JsonMapper json;
    private final OutboxProperties properties;

    public OutboxPoller(OutboxMessageRepository repository, KafkaTemplate<String, String> kafka,
                        TransactionTemplate transaction, JsonMapper json, AppfleetProperties properties) {
        this.repository = repository;
        this.kafka = kafka;
        this.transaction = transaction;
        this.json = json;
        this.properties = properties.outbox();
    }

    /** One cycle. Never throws: a failed cycle is logged and retried by the next one. */
    public void pollOnce() {
        try {
            transaction.executeWithoutResult(status -> cycle());
        } catch (RuntimeException e) {
            log.warn("Outbox cycle failed, will retry: {}", e.toString());
        }
    }

    /** Deletes rows sent before the cutoff. Pending rows are never deleted. */
    public int purgeSentBefore(Instant cutoff) {
        Integer deleted = transaction.execute(status -> repository.deleteSentBefore(cutoff));
        return deleted == null ? 0 : deleted;
    }

    /** The scheduled purge: the retention is configured, 24 hours by default. */
    public void purgeOldSent() {
        try {
            purgeSentBefore(Instant.now().minus(properties.retention()));
        } catch (RuntimeException e) {
            log.warn("Outbox purge failed, will retry: {}", e.toString());
        }
    }

    /** Test seam: called for each row after it is locked and before it is sent. */
    protected void beforePublish(OutboxMessage message) {
    }

    /** Test seam: called inside the transaction after the batch, before the commit. */
    protected void beforeCommit() {
    }

    private void cycle() {
        if (!repository.tryLeaderLock(LEADER_LOCK_KEY)) {
            return;                                    // another instance is polling this cycle
        }
        List<OutboxMessage> pending = repository.lockPending(properties.batchSize());
        for (OutboxMessage message : pending) {
            beforePublish(message);
            if (!publish(message)) {
                break;                                 // head-of-line: the rest wait, in order, for the next cycle
            }
            message.markSent();
        }
        beforeCommit();
    }

    private boolean publish(OutboxMessage message) {
        try {
            DeploymentCommand command = json.readValue(message.getPayload(), DeploymentCommand.class);
            ProducerRecord<String, String> record = new ProducerRecord<>(
                    properties.topic(), message.getAggregateId().toString(), message.getPayload());
            record.headers().add("message-id", message.getId().toString().getBytes(StandardCharsets.UTF_8));
            record.headers().add("command-type", command.commandType().name().getBytes(StandardCharsets.UTF_8));
            kafka.send(record).get(properties.sendTimeout().toMillis(), TimeUnit.MILLISECONDS);   // wait for the broker's acknowledgement
            return true;
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            log.warn("Outbox message {} not sent: interrupted", message.getId());
            return false;
        } catch (Exception e) {
            log.warn("Outbox message {} not sent: {}", message.getId(), e.toString());
            return false;
        }
    }
}
```

### 16.6 `OutboxScheduling`

```java
package io.appfleet.control.outbox;

import io.appfleet.control.config.AppfleetProperties;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.scheduling.annotation.SchedulingConfigurer;
import org.springframework.scheduling.config.ScheduledTaskRegistrar;

import java.time.Duration;

/** Registers the poll and the purge with the configured interval; the poll is a no-op while appfleet.outbox.enabled is false. */
@Configuration
@EnableScheduling
public class OutboxScheduling implements SchedulingConfigurer {

    private final OutboxPoller poller;
    private final OutboxProperties properties;

    public OutboxScheduling(OutboxPoller poller, AppfleetProperties appfleet) {
        this.poller = poller;
        this.properties = appfleet.outbox();
    }

    @Override
    public void configureTasks(ScheduledTaskRegistrar registrar) {
        registrar.addFixedDelayTask(() -> {
            if (properties.enabled()) {
                poller.pollOnce();
            }
        }, properties.pollInterval());
        registrar.addFixedDelayTask(poller::purgeOldSent, Duration.ofHours(1));
    }
}
```

### 16.7 Configuration, migration and the pom

`application.yml`, under `spring.kafka`:

```yaml
spring:
  kafka:
    bootstrap-servers: ${KAFKA_HOST:localhost}:${KAFKA_PORT:9092}
    producer:
      acks: all
      properties:
        enable.idempotence: true
        delivery.timeout.ms: 6000
        request.timeout.ms: 3000
        max.block.ms: 3000
```

`application-test.yml`:

```yaml
appfleet:
  environment: test
  rate-limit:
    enabled: false
  outbox:
    enabled: false
```

`V6__add_outbox_pending_index.sql`:

```sql
CREATE INDEX idx_outbox_pending ON outbox_message (id) WHERE sent_at IS NULL;
```

`control-api/pom.xml`: replace the plain library with the Boot starter, which brings the `KafkaTemplate` auto-configuration (task 0, trap 1); add the Testcontainers Kafka module for the tests:

```xml
<!-- replaces org.springframework.kafka:spring-kafka -->
<dependency>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter-kafka</artifactId>
</dependency>

<!-- test scope, next to the other testcontainers dependencies -->
<dependency>
  <groupId>org.testcontainers</groupId>
  <artifactId>kafka</artifactId>
  <scope>test</scope>
</dependency>
```

### 16.8 The tests on disk

These are the files in `control-api/src/test/java/io/appfleet/control/outbox/` as they are now.

#### `OutboxMessageTest`

```java
package io.appfleet.control.outbox;

import com.jayway.jsonpath.JsonPath;
import io.appfleet.control.web.WebIntegrationTest;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

/** Entity has never been saved. Does a String payload reach the jsonb column? */
class OutboxMessageTest extends WebIntegrationTest {

    @Autowired
    OutboxMessageRepository repository;

    @Test
    void outboxMessage_roundTripsThroughJpa() {
        UUID aggregateId = UUID.randomUUID();

        OutboxMessage saved = repository.saveAndFlush(
                new OutboxMessage(aggregateId, "{\"commandType\":\"DEPLOY\",\"schemaVersion\":1}"));

        OutboxMessage loaded = repository.findById(saved.getId()).orElseThrow();
        assertThat(loaded.getAggregateId()).isEqualTo(aggregateId);
        assertThat(loaded.getSentAt()).isNull();
        assertThat(loaded.getCreatedAt()).isNotNull();
        assertThat((String) JsonPath.read(loaded.getPayload(), "$.commandType")).isEqualTo("DEPLOY");

        // it really is jsonb in the database, not text: a jsonb operator works on it
        assertThat(jdbc.queryForObject("select payload ->> 'commandType' from outbox_message where id = ?",
                String.class, saved.getId())).isEqualTo("DEPLOY");
    }
}
```

#### `OutboxIndexTest`

```java
package io.appfleet.control.outbox;

import io.appfleet.control.web.WebIntegrationTest;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** Tthe poller reads unsent rows in id order; that must not be a primary-key walk with a filter. */
class OutboxIndexTest extends WebIntegrationTest {

    @Test
    void v6_createsThePartialPendingIndex() {
        String definition = jdbc.queryForObject(
                "select indexdef from pg_indexes where schemaname = 'control' and tablename = 'outbox_message' "
                        + "and indexname = 'idx_outbox_pending'",
                String.class);

        assertThat(definition).contains("(id)").contains("sent_at IS NULL");
    }
}
```

#### `OutboxWriteTest`

```java
package io.appfleet.control.outbox;

import com.jayway.jsonpath.JsonPath;
import io.appfleet.control.web.TestAuth;
import io.appfleet.control.web.TestFixtures;
import io.appfleet.control.web.WebIntegrationTest;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockHttpServletResponse;

import java.util.*;
import java.util.concurrent.*;

import static io.appfleet.control.deployment.DeploymentState.HEALTHY;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

/** The command is a row in the same transaction as the state change. */
class OutboxWriteTest extends WebIntegrationTest {

    private static final String DEPLOYMENTS = "/api/v1/deployments";

    private MockHttpServletResponse postDeployment(TestFixtures.Fixture f) throws Exception {
        String body = """
                  {"applicationId":"%s","releaseId":"%s","environment":"%s"}
                  """.formatted(f.app().getId(), f.release().getId(), f.env().getName());
        return mockMvc.perform(post(DEPLOYMENTS).contentType(MediaType.APPLICATION_JSON).content(body))
                .andReturn().getResponse();
    }

    private List<Map<String, Object>> rowsFor(Object aggregateId) {
        return jdbc.queryForList(
                "select id, payload::text as payload, sent_at from outbox_message where aggregate_id = ? order by id", aggregateId);
    }

    private static <T> T field(Map<String, Object> row, String path) {
        return JsonPath.read((String) row.get("payload"), path);
    }

    @Test
    void requestDeployment_writesOneOutboxMessage() throws Exception {
        TestFixtures.Fixture f = fixtures.fixture();

        MockHttpServletResponse r = postDeployment(f);

        assertThat(r.getStatus()).isEqualTo(202);
        UUID deploymentId = UUID.fromString(JsonPath.read(r.getContentAsString(), "$.deploymentId"));
        String taskId = JsonPath.read(r.getContentAsString(), "$.taskId");

        List<Map<String, Object>> rows = rowsFor(deploymentId);
        assertThat(rows).hasSize(1);
        Map<String, Object> row = rows.get(0);
        assertThat(row.get("sent_at")).isNull();
        assertThat((Integer) field(row, "$.schemaVersion")).isEqualTo(1);
        assertThat((String) field(row, "$.commandType")).isEqualTo("DEPLOY");
        assertThat((String) field(row, "$.taskId")).isEqualTo(taskId);
        assertThat((String) field(row, "$.idempotencyToken")).isEqualTo(taskId);
        assertThat((String) field(row, "$.deploymentId")).isEqualTo(deploymentId.toString());
        assertThat((String) field(row, "$.applicationId")).isEqualTo(f.app().getId().toString());
        assertThat((String) field(row, "$.releaseId")).isEqualTo(f.release().getId().toString());
        assertThat((String) field(row, "$.environment")).isEqualTo(f.env().getName());
        assertThat((String) field(row, "$.requestedBy")).isEqualTo(TestAuth.USER.toString());
        assertThat((String) field(row, "$.requestedAt")).isNotBlank();
    }

    @Test
    void requestRollback_writesOneOutboxMessage() throws Exception {
        UUID deploymentId = fixtures.deploymentFor(TestAuth.TEAM, HEALTHY).getId();

        MockHttpServletResponse r = mockMvc.perform(post(DEPLOYMENTS + "/" + deploymentId + "/rollback"))
                .andReturn().getResponse();

        assertThat(r.getStatus()).isEqualTo(202);
        String taskId = JsonPath.read(r.getContentAsString(), "$.taskId");
        List<Map<String, Object>> rows = rowsFor(deploymentId);
        assertThat(rows).hasSize(1);
        Map<String, Object> row = rows.get(0);
        assertThat((String) field(row, "$.commandType")).isEqualTo("ROLLBACK");
        assertThat((String) field(row, "$.taskId")).isEqualTo(taskId);
        assertThat((String) field(row, "$.idempotencyToken")).isEqualTo(taskId);
        assertThat((String) field(row, "$.deploymentId")).isEqualTo(deploymentId.toString());
        assertThat((String) field(row, "$.requestedBy")).isEqualTo(TestAuth.USER.toString());
        assertThat((String) field(row, "$.applicationId")).isEqualTo(
                jdbc.queryForObject("select application_id::text from deployment where id = ?", String.class, deploymentId));
    }

    @Test
    void rejectedRequests_writeNoMessage() throws Exception {
        long before = count("select count(*) from outbox_message");

        // 404: no such deployment
        assertThat(mockMvc.perform(post(DEPLOYMENTS + "/" + UUID.randomUUID() + "/rollback"))
                .andReturn().getResponse().getStatus()).isEqualTo(404);

        // 409: a PENDING deployment cannot be rolled back
        UUID pending = fixtures.deploymentFor(TestAuth.TEAM).getId();
        assertThat(mockMvc.perform(post(DEPLOYMENTS + "/" + pending + "/rollback"))
                .andReturn().getResponse().getStatus()).isEqualTo(409);

        // 422: the application does not exist
        String unknownApplication = """
                  {"applicationId":"%s","releaseId":"%s","environment":"nowhere"}
                  """.formatted(UUID.randomUUID(), UUID.randomUUID());
        assertThat(mockMvc.perform(post(DEPLOYMENTS).contentType(MediaType.APPLICATION_JSON).content(unknownApplication))
                .andReturn().getResponse().getStatus()).isEqualTo(422);

        assertThat(count("select count(*) from outbox_message")).isEqualTo(before);

        // 409 again: a second rollback while one is open adds no second message
        UUID healthy = fixtures.deploymentFor(TestAuth.TEAM, HEALTHY).getId();
        assertThat(mockMvc.perform(post(DEPLOYMENTS + "/" + healthy + "/rollback"))
                .andReturn().getResponse().getStatus()).isEqualTo(202);
        assertThat(mockMvc.perform(post(DEPLOYMENTS + "/" + healthy + "/rollback"))
                .andReturn().getResponse().getStatus()).isEqualTo(409);
        assertThat(rowsFor(healthy)).hasSize(1);
    }

    @Test
    void racingRollbacks_leaveExactlyOneMessage() throws Exception {
        UUID deploymentId = fixtures.deploymentFor(TestAuth.TEAM, HEALTHY).getId();
        int n = 2;
        CyclicBarrier barrier = new CyclicBarrier(n);
        Callable<Integer> call = () -> {
            barrier.await(5, TimeUnit.SECONDS);
            return mockMvc.perform(post(DEPLOYMENTS + "/" + deploymentId + "/rollback"))
                    .andReturn().getResponse().getStatus();
        };
        ExecutorService pool = Executors.newFixedThreadPool(n);
        List<Integer> statuses = new ArrayList<>();
        try {
            for (Future<Integer> f : pool.invokeAll(Collections.nCopies(n, call), 10, TimeUnit.SECONDS)) {
                statuses.add(f.get());
            }
        } finally {
            pool.shutdownNow();
        }

        assertThat(statuses).containsExactlyInAnyOrder(202, 409);
        assertThat(rowsFor(deploymentId)).hasSize(1);          // one winner, one message: the loser's row rolled back with it
    }
}
```

#### `OutboxIntegrationTest`

```java
package io.appfleet.control.outbox;

import io.appfleet.control.web.WebIntegrationTest;
import org.apache.kafka.clients.admin.Admin;
import org.apache.kafka.clients.admin.NewTopic;
import org.apache.kafka.clients.consumer.ConsumerConfig;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.apache.kafka.clients.consumer.ConsumerRecords;
import org.apache.kafka.clients.consumer.KafkaConsumer;
import org.apache.kafka.common.serialization.StringDeserializer;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.kafka.KafkaContainer;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.UUID;
import java.util.function.Predicate;

/** Postgres and Redis from the base, plus a real Kafka (the compose image) started once per JVM. */
public abstract class OutboxIntegrationTest extends WebIntegrationTest {

    protected static final String TOPIC = "task.work";

    static final KafkaContainer kafka = new KafkaContainer("apache/kafka:3.8.0");

    static {
        kafka.start();
        try (Admin admin = Admin.create(Map.of("bootstrap.servers", kafka.getBootstrapServers()))) {
            admin.createTopics(List.of(new NewTopic(TOPIC, 6, (short) 1))).all().get();   // as in docker-compose: 6 partitions
        } catch (Exception e) {
            throw new IllegalStateException("could not create the topic " + TOPIC, e);
        }
    }

    @DynamicPropertySource
    static void kafkaProperties(DynamicPropertyRegistry registry) {
        registry.add("spring.kafka.bootstrap-servers", kafka::getBootstrapServers);
    }

    /** Reads the whole topic from the beginning with a fresh consumer group, keeps the records that match, waits up to {@code wait}. */
    protected List<ConsumerRecord<String, String>> consume(Predicate<ConsumerRecord<String, String>> keep, int expected, Duration wait) {
        Properties props = new Properties();
        props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, kafka.getBootstrapServers());
        props.put(ConsumerConfig.GROUP_ID_CONFIG, "test-" + UUID.randomUUID());
        props.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest");
        props.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class.getName());
        props.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class.getName());
        List<ConsumerRecord<String, String>> kept = new ArrayList<>();
        long deadline = System.nanoTime() + wait.toNanos();
        try (KafkaConsumer<String, String> consumer = new KafkaConsumer<>(props)) {
            consumer.subscribe(List.of(TOPIC));
            while (System.nanoTime() < deadline && kept.size() < expected) {
                ConsumerRecords<String, String> records = consumer.poll(Duration.ofMillis(300));
                records.forEach(r -> { if (keep.test(r)) kept.add(r); });
            }
        }
        return kept;
    }

    protected static String header(ConsumerRecord<String, String> record, String name) {
        var h = record.headers().lastHeader(name);
        return h == null ? null : new String(h.value(), java.nio.charset.StandardCharsets.UTF_8);
    }
}
```

#### `OutboxPollerTest`

```java
package io.appfleet.control.outbox;

import com.jayway.jsonpath.JsonPath;
import io.appfleet.control.web.TestAuth;
import io.appfleet.control.web.TestFixtures;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.MediaType;

import java.time.Duration;
import java.util.List;
import java.util.UUID;

import static io.appfleet.control.deployment.DeploymentState.HEALTHY;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

class OutboxPollerTest extends OutboxIntegrationTest {

    private static final String DEPLOYMENTS = "/api/v1/deployments";

    @Autowired
    OutboxPoller poller;

    private UUID requestDeployment() throws Exception {
        TestFixtures.Fixture f = fixtures.fixture();
        String body = """
                  {"applicationId":"%s","releaseId":"%s","environment":"%s"}
                  """.formatted(f.app().getId(), f.release().getId(), f.env().getName());
        String response = mockMvc.perform(post(DEPLOYMENTS).contentType(MediaType.APPLICATION_JSON).content(body))
                .andReturn().getResponse().getContentAsString();
        return UUID.fromString(JsonPath.read(response, "$.deploymentId"));
    }

    @Test
    void poller_publishesAPendingMessage() throws Exception {
        UUID deploymentId = requestDeployment();

        poller.pollOnce();

        List<ConsumerRecord<String, String>> records =
                consume(r -> deploymentId.toString().equals(r.key()), 1, Duration.ofSeconds(10));
        assertThat(records).hasSize(1);
        ConsumerRecord<String, String> record = records.get(0);
        assertThat(record.key()).isEqualTo(deploymentId.toString());
        assertThat((String) JsonPath.read(record.value(), "$.commandType")).isEqualTo("DEPLOY");
        assertThat(header(record, "command-type")).isEqualTo("DEPLOY");

        UUID outboxId = jdbc.queryForObject("select id from outbox_message where aggregate_id = ?", UUID.class, deploymentId);
        assertThat(header(record, "message-id")).isEqualTo(outboxId.toString());
        assertThat(jdbc.queryForObject("select sent_at is not null from outbox_message where id = ?", Boolean.class, outboxId)).isTrue();
    }

    @Test
    void poller_keepsPerDeploymentOrder() throws Exception {
        UUID deploymentId = requestDeployment();
        fixtures.driveTo(deploymentId, HEALTHY);
        mockMvc.perform(post(DEPLOYMENTS + "/" + deploymentId + "/rollback")).andReturn();

        poller.pollOnce();

        List<ConsumerRecord<String, String>> records =
                consume(r -> deploymentId.toString().equals(r.key()), 2, Duration.ofSeconds(10));
        assertThat(records).hasSize(2);
        assertThat(records).extracting(r -> (String) JsonPath.read(r.value(), "$.commandType"))
                .containsExactly("DEPLOY", "ROLLBACK");
        assertThat(records.get(0).partition()).isEqualTo(records.get(1).partition());
    }
}
```

### 16.9 Order and delivery tests (verified, 2026-10-06)

Both files were written and run on a scratch copy of the tree (`OutboxOrderTest` 1 of 1, `OutboxDeliveryTest` 6 of 6 green) and every test was proved able to fail with a mutation: see Results 9.6 and 9.7 of the design doc. Put them next to the other outbox tests.

#### `OutboxOrderTest` (test 8b)

```java
package io.appfleet.control.outbox;

import io.appfleet.control.config.AppfleetProperties;
import io.appfleet.control.ratelimit.RateLimitProperties;
import io.appfleet.events.CommandType;
import io.appfleet.events.DeploymentCommand;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.json.JsonMapper;

import java.time.Duration;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * S4.5 test 8b: the advisory lock, not the row locks, is what stops a later row of a deployment from being
 * published before an earlier one. Batch size 1, so poller A locks only the first row and a poller without the
 * leader lock could take the second.
 */
class OutboxOrderTest extends OutboxIntegrationTest {

    @Autowired
    OutboxMessageRepository repository;
    @Autowired
    KafkaTemplate<String, String> kafka;
    @Autowired
    TransactionTemplate transaction;
    @Autowired
    JsonMapper json;

    private static AppfleetProperties batchOfOne() {
        return new AppfleetProperties("test", new RateLimitProperties(false, 60, 1.0),
                new OutboxProperties(true, TOPIC, 1, Duration.ofSeconds(1), Duration.ofSeconds(5), Duration.ofHours(24)));
    }

    private OutboxMessage pending(UUID aggregateId, CommandType type) {
        DeploymentCommand command = DeploymentCommand.of(type, UUID.randomUUID(), aggregateId,
                UUID.randomUUID(), UUID.randomUUID(), "staging", "test");
        return repository.saveAndFlush(new OutboxMessage(aggregateId, json.writeValueAsString(command)));
    }

    // 8b
    @Test
    void leaderLock_stopsALaterRowOvertaking() throws Exception {
        jdbc.update("delete from outbox_message where sent_at is null");      // only our two rows are pending
        UUID aggregate = UUID.randomUUID();
        OutboxMessage first = pending(aggregate, CommandType.DEPLOY);
        Thread.sleep(5);                                                       // distinct milliseconds: id order = creation order
        OutboxMessage second = pending(aggregate, CommandType.ROLLBACK);

        CountDownLatch aHoldsFirstRow = new CountDownLatch(1);
        CountDownLatch releaseA = new CountDownLatch(1);
        OutboxPoller a = new OutboxPoller(repository, kafka, transaction, json, batchOfOne()) {
            @Override
            protected void beforePublish(OutboxMessage message) {
                aHoldsFirstRow.countDown();                                    // A holds the leader lock and the first row
                try {
                    releaseA.await(10, TimeUnit.SECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }
        };
        OutboxPoller b = new OutboxPoller(repository, kafka, transaction, json, batchOfOne());

        ExecutorService pool = Executors.newSingleThreadExecutor();
        try {
            Future<?> aRun = pool.submit(a::pollOnce);
            assertThat(aHoldsFirstRow.await(10, TimeUnit.SECONDS)).isTrue();

            b.pollOnce();                                                      // with the leader lock B must publish nothing

            assertThat(consume(r -> aggregate.toString().equals(r.key()), 1, Duration.ofSeconds(3)))
                    .as("nothing for this deployment while A holds the first row").isEmpty();

            releaseA.countDown();
            aRun.get(10, TimeUnit.SECONDS);
            b.pollOnce();                                                      // now the second row
        } finally {
            releaseA.countDown();
            pool.shutdownNow();
        }

        List<ConsumerRecord<String, String>> records = consume(r -> aggregate.toString().equals(r.key()), 2, Duration.ofSeconds(10));
        assertThat(records).extracting(r -> header(r, "message-id"))
                .containsExactly(first.getId().toString(), second.getId().toString());
    }
}
```

#### `OutboxDeliveryTest` (tests 8 to 13)

```java
package io.appfleet.control.outbox;

import com.jayway.jsonpath.JsonPath;
import io.appfleet.control.config.AppfleetProperties;
import io.appfleet.control.ratelimit.RateLimitProperties;
import io.appfleet.control.web.TestFixtures;
import io.appfleet.events.CommandType;
import io.appfleet.events.DeploymentCommand;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.apache.kafka.clients.producer.ProducerConfig;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.apache.kafka.common.serialization.StringSerializer;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.MediaType;
import org.springframework.kafka.core.DefaultKafkaProducerFactory;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.kafka.core.ProducerFactory;
import org.springframework.kafka.support.SendResult;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.json.JsonMapper;

import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

/** S4.5 tests 8 to 13: what the poller does when pollers race, the broker is down, a send fails or the process dies. */
class OutboxDeliveryTest extends OutboxIntegrationTest {

    @Autowired
    OutboxPoller poller;                       // the real bean: default batch size, the real Kafka
    @Autowired
    OutboxMessageRepository repository;
    @Autowired
    KafkaTemplate<String, String> kafka;
    @Autowired
    ProducerFactory<String, String> producerFactory;
    @Autowired
    TransactionTemplate transaction;
    @Autowired
    JsonMapper json;

    private static AppfleetProperties props(int batchSize) {
        return new AppfleetProperties("test", new RateLimitProperties(false, 60, 1.0),
                new OutboxProperties(true, TOPIC, batchSize, Duration.ofSeconds(1), Duration.ofSeconds(3), Duration.ofHours(24)));
    }

    private OutboxPoller newPoller(KafkaTemplate<String, String> template) {
        return new OutboxPoller(repository, template, transaction, json, props(100));
    }

    private void clearPending() {
        jdbc.update("delete from outbox_message where sent_at is null");
    }

    private OutboxMessage pending(UUID aggregateId, CommandType type) {
        DeploymentCommand command = DeploymentCommand.of(type, UUID.randomUUID(), aggregateId,
                UUID.randomUUID(), UUID.randomUUID(), "staging", "test");
        return repository.saveAndFlush(new OutboxMessage(aggregateId, json.writeValueAsString(command)));
    }

    private Instant sentAt(OutboxMessage message) {
        Timestamp sent = jdbc.queryForObject("select sent_at from outbox_message where id = ?", Timestamp.class, message.getId());
        return sent == null ? null : sent.toInstant();
    }

    private UUID requestDeployment() throws Exception {
        TestFixtures.Fixture f = fixtures.fixture();
        String body = """
                {"applicationId":"%s","releaseId":"%s","environment":"%s"}
                """.formatted(f.app().getId(), f.release().getId(), f.env().getName());
        var response = mockMvc.perform(post("/api/v1/deployments").contentType(MediaType.APPLICATION_JSON).content(body))
                .andReturn().getResponse();
        assertThat(response.getStatus()).isEqualTo(202);
        return UUID.fromString(JsonPath.read(response.getContentAsString(), "$.deploymentId"));
    }

    // 8
    @Test
    void twoPollers_publishEachMessageOnce() throws Exception {
        clearPending();
        Set<String> keys = new HashSet<>();
        for (int i = 0; i < 50; i++) {
            UUID aggregate = UUID.randomUUID();
            keys.add(aggregate.toString());
            pending(aggregate, CommandType.DEPLOY);
        }
        OutboxPoller a = newPoller(kafka);
        OutboxPoller b = newPoller(kafka);
        CyclicBarrier barrier = new CyclicBarrier(2);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            Callable<Void> runA = () -> { barrier.await(5, TimeUnit.SECONDS); a.pollOnce(); return null; };
            Callable<Void> runB = () -> { barrier.await(5, TimeUnit.SECONDS); b.pollOnce(); return null; };
            for (Future<Void> f : pool.invokeAll(List.of(runA, runB), 30, TimeUnit.SECONDS)) {
                f.get();
            }
        } finally {
            pool.shutdownNow();
        }

        List<ConsumerRecord<String, String>> records = consume(r -> keys.contains(r.key()), 51, Duration.ofSeconds(6));
        assertThat(records).hasSize(50);                                                   // 51 asked for: a duplicate would show
        assertThat(records.stream().map(r -> header(r, "message-id")).distinct()).hasSize(50);
        assertThat(count("select count(*) from outbox_message where sent_at is null")).isZero();
    }

    // 9
    @Test
    void kafkaDown_requestStillSucceeds_andIsSentLater() throws Exception {
        clearPending();
        UUID deploymentId = requestDeployment();                                           // 202: the request path never touches Kafka

        Map<String, Object> dead = Map.of(
                ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:1",
                ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class,
                ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, StringSerializer.class,
                ProducerConfig.MAX_BLOCK_MS_CONFIG, 1000,
                ProducerConfig.REQUEST_TIMEOUT_MS_CONFIG, 1000,
                ProducerConfig.DELIVERY_TIMEOUT_MS_CONFIG, 2000);
        OutboxPoller deadPoller = newPoller(new KafkaTemplate<>(new DefaultKafkaProducerFactory<String, String>(dead)));

        long started = System.nanoTime();
        deadPoller.pollOnce();                                                             // must not throw
        Duration took = Duration.ofNanos(System.nanoTime() - started);

        assertThat(took).as("a dead broker fails a cycle in seconds").isLessThan(Duration.ofSeconds(10));
        assertThat(count("select count(*) from outbox_message where aggregate_id = ? and sent_at is null", deploymentId)).isEqualTo(1);

        poller.pollOnce();                                                                 // the broker is back
        assertThat(consume(r -> deploymentId.toString().equals(r.key()), 1, Duration.ofSeconds(10))).hasSize(1);
        assertThat(count("select count(*) from outbox_message where aggregate_id = ? and sent_at is null", deploymentId)).isZero();
    }

    // 10
    @Test
    void crashAfterSend_resendsTheMessage() throws Exception {
        clearPending();
        UUID aggregate = UUID.randomUUID();
        OutboxMessage row = pending(aggregate, CommandType.DEPLOY);
        AtomicBoolean crashed = new AtomicBoolean(false);
        OutboxPoller crashing = new OutboxPoller(repository, kafka, transaction, json, props(100)) {
            @Override
            protected void beforeCommit() {
                if (crashed.compareAndSet(false, true)) {
                    throw new IllegalStateException("the process dies after the send and before the commit");
                }
            }
        };

        crashing.pollOnce();                                                               // sent, then the transaction rolls back
        assertThat(sentAt(row)).as("still pending: the commit never happened").isNull();

        poller.pollOnce();                                                                 // the next cycle sends it again
        List<ConsumerRecord<String, String>> records = consume(r -> aggregate.toString().equals(r.key()), 3, Duration.ofSeconds(6));
        assertThat(records).hasSize(2);                                                    // at least once: a duplicate, by design
        assertThat(records).extracting(r -> header(r, "message-id")).containsOnly(row.getId().toString());
        assertThat(sentAt(row)).isNotNull();
    }

    // 11
    @Test
    void failedSend_stopsTheBatch_inOrder() throws Exception {
        clearPending();
        UUID a1 = UUID.randomUUID();
        UUID a2 = UUID.randomUUID();
        UUID a3 = UUID.randomUUID();
        OutboxMessage r1 = pending(a1, CommandType.DEPLOY);
        Thread.sleep(5);
        OutboxMessage r2 = pending(a2, CommandType.DEPLOY);
        Thread.sleep(5);
        OutboxMessage r3 = pending(a3, CommandType.DEPLOY);
        KafkaTemplate<String, String> failingOnSecond = new KafkaTemplate<>(producerFactory) {
            @Override
            public CompletableFuture<SendResult<String, String>> send(ProducerRecord<String, String> record) {
                if (a2.toString().equals(record.key())) {
                    return CompletableFuture.failedFuture(new IllegalStateException("the broker refused the second message"));
                }
                return super.send(record);
            }
        };

        newPoller(failingOnSecond).pollOnce();

        assertThat(sentAt(r1)).as("sent before the failure").isNotNull();
        assertThat(sentAt(r2)).as("the failed row stays pending").isNull();
        assertThat(sentAt(r3)).as("the row behind it waits, in order").isNull();

        poller.pollOnce();                                                                 // a good cycle: row 2, then row 3
        assertThat(sentAt(r2)).isNotNull();
        assertThat(sentAt(r3)).isNotNull();
        assertThat(sentAt(r2)).isBeforeOrEqualTo(sentAt(r3));
    }

    // 12
    @Test
    void purge_deletesOnlyOldSentRows() {
        clearPending();
        Instant now = Instant.now();
        UUID oldSent = insert(now.minus(Duration.ofDays(3)), now.minus(Duration.ofDays(2)));
        UUID recentSent = insert(now.minus(Duration.ofHours(3)), now.minus(Duration.ofHours(1)));
        UUID oldPending = insert(now.minus(Duration.ofDays(3)), null);

        int deleted = poller.purgeSentBefore(now.minus(Duration.ofHours(24)));

        assertThat(deleted).isEqualTo(1);
        assertThat(count("select count(*) from outbox_message where id = ?", oldSent)).isZero();
        assertThat(count("select count(*) from outbox_message where id = ?", recentSent)).isEqualTo(1);
        assertThat(count("select count(*) from outbox_message where id = ?", oldPending)).isEqualTo(1);
    }

    private UUID insert(Instant createdAt, Instant sentAt) {
        UUID id = UUID.randomUUID();
        jdbc.update("insert into outbox_message (id, aggregate_id, payload, created_at, sent_at) values (?, ?, '{}'::jsonb, ?, ?)",
                id, UUID.randomUUID(), Timestamp.from(createdAt), sentAt == null ? null : Timestamp.from(sentAt));
        return id;
    }

    // 13
    @Test
    void producerIsConfiguredForReliability() {
        Map<String, Object> config = producerFactory.getConfigurationProperties();

        assertThat(String.valueOf(config.get("acks"))).isEqualTo("all");
        assertThat(String.valueOf(config.get("enable.idempotence"))).isEqualTo("true");
    }
}
```

### 16.10 The two wrong designs as a test (scratch only)

Used to show the dual write and publish-after-commit failing (Results 9.8). It passes against the outbox; to see it fail, replace `OutboxWriter` with a version that sends inside the transaction, or with one that registers an empty `afterCommit`.

```java
package io.appfleet.control.outbox;

import com.jayway.jsonpath.JsonPath;
import io.appfleet.control.web.TestAuth;
import io.appfleet.control.web.TestFixtures;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.MediaType;

import java.time.Duration;
import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static io.appfleet.control.deployment.DeploymentState.HEALTHY;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

/**
 * S4.5, the two wrong designs, as tests. Both pass against the outbox. The first fails against a dual write (a Kafka
 * send inside the transaction), the second against publish-after-commit. Kept in a scratch copy: they need a mutated
 * OutboxWriter to fail, and with the outbox they only repeat what OutboxWriteTest and OutboxPollerTest prove.
 */
class OutboxAtomicityTest extends OutboxIntegrationTest {

    @Autowired
    OutboxPoller poller;

    @Test
    void racingRollbacks_publishExactlyOneRecord() throws Exception {
        UUID deploymentId = fixtures.deploymentFor(TestAuth.TEAM, HEALTHY).getId();
        int n = 2;
        CyclicBarrier barrier = new CyclicBarrier(n);
        Callable<Integer> call = () -> {
            barrier.await(5, TimeUnit.SECONDS);
            return mockMvc.perform(post("/api/v1/deployments/" + deploymentId + "/rollback"))
                    .andReturn().getResponse().getStatus();
        };
        ExecutorService pool = Executors.newFixedThreadPool(n);
        List<Integer> statuses = new ArrayList<>();
        try {
            for (Future<Integer> f : pool.invokeAll(Collections.nCopies(n, call), 10, TimeUnit.SECONDS)) {
                statuses.add(f.get());
            }
        } finally {
            pool.shutdownNow();
        }
        assertThat(statuses).containsExactlyInAnyOrder(202, 409);

        poller.pollOnce();                                                  // a no-op for a design that already sent
        List<ConsumerRecord<String, String>> records =
                consume(r -> deploymentId.toString().equals(r.key()), 3, Duration.ofSeconds(6));
        assertThat(records).as("one change, one command on the topic").hasSize(1);
    }

    @Test
    void committedChange_isEventuallyPublished() throws Exception {
        TestFixtures.Fixture f = fixtures.fixture();
        String body = """
                {"applicationId":"%s","releaseId":"%s","environment":"%s"}
                """.formatted(f.app().getId(), f.release().getId(), f.env().getName());
        var response = mockMvc.perform(post("/api/v1/deployments").contentType(MediaType.APPLICATION_JSON).content(body))
                .andReturn().getResponse();
        assertThat(response.getStatus()).isEqualTo(202);
        UUID deploymentId = UUID.fromString(JsonPath.read(response.getContentAsString(), "$.deploymentId"));

        poller.pollOnce();

        assertThat(consume(r -> deploymentId.toString().equals(r.key()), 1, Duration.ofSeconds(10)))
                .as("a committed change must reach the topic").hasSize(1);
    }
}
```
