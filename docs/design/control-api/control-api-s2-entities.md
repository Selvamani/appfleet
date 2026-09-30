# control-api — S2 entities (JPA)

**Spec:** [01-CONTROL-API.md §S2](../../specs/project/01-CONTROL-API.md) · Slice **S2** · Schema **`control`**

Companion: [control-api-schema-3nf.md](control-api-schema-3nf.md) (the frozen schema this maps), [control-api-s1-exercises.md](control-api-s1-exercises.md) (parked — data/query exercises resume after S2/S3 land), [control-api-spring-flow.md](control-api-spring-flow.md) (runtime wiring). This doc is the class-by-class entity design for S2 — written before the code, same discipline as [node-agent.md](../node-agent/node-agent.md).

Every table in `V1__init.sql`/`V2__add_task_attempt_and_image_lineage.sql` maps to exactly one entity below. No entity invents a column or relationship the schema doesn't already have — **the schema owns the truth, JPA maps it** (spec's own S2 first bullet).

## Entities are not records

The S3 convention says DTOs are records. Entities are **not** DTOs and are deliberately plain mutable classes instead, for a mechanical reason: Hibernate proxies `LAZY` associations by subclassing the entity at runtime. A `record` is implicitly `final` — it cannot be subclassed, so a `LAZY` association on a record silently can't be proxied. Two different rules for two different kinds of class: entities are plain classes with a no-arg constructor (protected, Hibernate-only) and a domain constructor; DTOs, once S3 controllers exist, stay records.

## UUIDv7 generation

Repo convention: IDs are UUIDv7 (sortable, index-friendly) over UUIDv4. Postgres and Hibernate don't generate v7 UUIDs natively, so a small shared utility generates them application-side, and every entity's `@Id` has **no** `@GeneratedValue` — the ID is set in the constructor, before `persist()` ever sees it.

```java
package io.appfleet.control.common;

import java.security.SecureRandom;
import java.util.UUID;

public final class UuidV7 {
    private static final SecureRandom RANDOM = new SecureRandom();

    private UuidV7() {}

    public static UUID generate() {
        byte[] value = new byte[16];
        RANDOM.nextBytes(value);
        long timestamp = System.currentTimeMillis();

        value[0] = (byte) (timestamp >>> 40);
        value[1] = (byte) (timestamp >>> 32);
        value[2] = (byte) (timestamp >>> 24);
        value[3] = (byte) (timestamp >>> 16);
        value[4] = (byte) (timestamp >>> 8);
        value[5] = (byte) timestamp;
        value[6] = (byte) (0x70 | (value[6] & 0x0F));   // version 7
        value[8] = (byte) (0x80 | (value[8] & 0x3F));   // variant 10

        long msb = 0, lsb = 0;
        for (int i = 0; i < 8; i++) msb = (msb << 8) | (value[i] & 0xff);
        for (int i = 8; i < 16; i++) lsb = (lsb << 8) | (value[i] & 0xff);
        return new UUID(msb, lsb);
    }
}
```

`io.appfleet.control.common` is a cross-package utility location, same discipline as node-agent's cross-package public types (`ContainerSpec`, `Session`, `FencingToken`) — only things genuinely used by 2+ packages live somewhere shared; everything else stays local to its feature package.

## Package layout

Package-by-feature, same convention as node-agent:

```
io.appfleet.control
├── common/         UuidV7
├── application/    Application, Release, ApplicationRepository, ReleaseRepository
├── environment/    Environment, Node, EnvironmentRepository, NodeRepository
├── deployment/     Deployment, DeploymentState (enum, owns legal transitions), DeploymentRepository
├── catalogue/      BaseImage, AppImage, ImageVersion, + their repositories
├── task/           Task, Attempt, TaskStatus (enum), TaskRepository, AttemptRepository
├── audit/          AuditEvent, AuditEventRepository
└── outbox/         OutboxMessage, OutboxMessageRepository
```

## Owning-side decisions

Per spec: "relationships with the owning side chosen consciously; every association `LAZY`."

| Relationship | Owning side | Why |
|---|---|---|
| `Application` 1:N `Release` | `Release` (has `application_id`) | The "many" side always owns in a 1:N. No back-collection on `Application` — nothing calls `application.getReleases()` yet, and adding one now is an unused N+1 trap sitting idle. |
| `Environment` 1:N `Node` | `Node` (has `environment_id`) | Same reasoning, no back-collection. |
| `Deployment` N:1 `Application`/`Release`/`Environment` | `Deployment` (has all three FKs) | `Deployment` is the "many" side of all three. |
| `Deployment` 1:N `TaskStatus` | `TaskStatus` (has `deployment_id`), **but `Deployment` also gets a `mappedBy` back-collection** | The one deliberate bidirectional pair — exists specifically so the N+1 exercise (S2 item 2) has something real to trigger against. Every other relationship in this schema stays unidirectional on purpose; this is the exception, not the default. |
| `BaseImage` self-referential (`parent_base_image_id`) | the child row | `BaseImage.parent` only — no `children` collection. Lineage is walked via a native recursive-CTE query (JPQL can't express `WITH RECURSIVE`), not by chasing this object graph in Java. |
| `AppImage` N:1 `BaseImage` | `AppImage` (has `base_image_id`) | |
| `ImageVersion` N:1 `AppImage` | `ImageVersion` (has `app_image_id`) | |
| `TaskStatus` 1:N `Attempt` | `Attempt` (has `task_id`) | No back-collection needed beyond what `Task.attempts` already gives via the same reasoning as `Deployment.tasks`. |
| `AuditEvent.targetId`, `OutboxMessage.aggregateId` | plain `UUID` fields, **not** `@ManyToOne` | Deliberate — an audit/outbox row shouldn't hold a hard FK to whatever it references; once services split at S4, that target may live in a different service's schema entirely, and this repo's own rule is "no service reads another service's schema." |

## `Deployment`'s state machine

Spec's top-level FSM bullets: "model states as an enum owning its legal transitions — an illegal transition throws, always, no flag to bypass" and "transitions emit events; status is never set directly by a controller." Both land on `DeploymentState` and `Deployment.transitionTo(...)`:

```java
package io.appfleet.control.deployment;

public enum DeploymentState {
    PENDING, VALIDATING, DEPLOYING, HEALTHY, DEGRADED, FAILED, ROLLED_BACK;

    public boolean canTransitionTo(DeploymentState target) {
        return switch (this) {
            case PENDING -> target == VALIDATING;
            case VALIDATING -> target == DEPLOYING || target == FAILED;
            case DEPLOYING -> target == HEALTHY || target == FAILED;
            case HEALTHY -> target == DEGRADED || target == ROLLED_BACK;
            case DEGRADED -> target == HEALTHY || target == ROLLED_BACK;
            case FAILED, ROLLED_BACK -> false;
        };
    }
}
```

Mirrors the spec's mermaid diagram exactly. `Deployment.status` has no public setter — `transitionTo(target)` is the only mutation path, and it throws `IllegalStateException` on an illegal transition rather than silently accepting one.

## Full entity code

### `application/`

```java
package io.appfleet.control.application;

import jakarta.persistence.*;
import java.time.Instant;
import java.util.UUID;
import io.appfleet.control.common.UuidV7;

@Entity
@Table(name = "application")
public class Application {

    @Id
    private UUID id;

    @Column(nullable = false, unique = true)
    private String name;

    private String description;

    @Column(name = "owner_team_id", nullable = false)
    private UUID ownerTeamId;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    protected Application() {}

    public Application(String name, String description, UUID ownerTeamId) {
        this.id = UuidV7.generate();
        this.name = name;
        this.description = description;
        this.ownerTeamId = ownerTeamId;
        this.createdAt = Instant.now();
    }

    public UUID getId() { return id; }
    public String getName() { return name; }
    public String getDescription() { return description; }
    public UUID getOwnerTeamId() { return ownerTeamId; }
    public Instant getCreatedAt() { return createdAt; }
}
```

```java
package io.appfleet.control.application;

import jakarta.persistence.*;
import java.time.Instant;
import java.util.UUID;
import io.appfleet.control.common.UuidV7;

@Entity
@Table(name = "release")
public class Release {

    @Id
    private UUID id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "application_id", nullable = false)
    private Application application;

    @Column(nullable = false)
    private String version;

    @Column(name = "artifact_ref", nullable = false)
    private String artifactRef;

    @Column(nullable = false)
    private String checksum;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    protected Release() {}

    public Release(Application application, String version, String artifactRef, String checksum) {
        this.id = UuidV7.generate();
        this.application = application;
        this.version = version;
        this.artifactRef = artifactRef;
        this.checksum = checksum;
        this.createdAt = Instant.now();
    }

    public UUID getId() { return id; }
    public Application getApplication() { return application; }
    public String getVersion() { return version; }
    public String getArtifactRef() { return artifactRef; }
    public String getChecksum() { return checksum; }
    public Instant getCreatedAt() { return createdAt; }
}
```

### `environment/`

```java
package io.appfleet.control.environment;

import jakarta.persistence.*;
import java.util.UUID;
import io.appfleet.control.common.UuidV7;

@Entity
@Table(name = "environment")
public class Environment {

    @Id
    private UUID id;

    @Column(nullable = false, unique = true)
    private String name;

    protected Environment() {}

    public Environment(String name) {
        this.id = UuidV7.generate();
        this.name = name;
    }

    public UUID getId() { return id; }
    public String getName() { return name; }
}
```

```java
package io.appfleet.control.environment;

import jakarta.persistence.*;
import java.util.UUID;
import io.appfleet.control.common.UuidV7;

@Entity
@Table(name = "node")
public class Node {

    @Id
    private UUID id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "environment_id", nullable = false)
    private Environment environment;

    @Column(nullable = false)
    private String hostname;

    protected Node() {}

    public Node(Environment environment, String hostname) {
        this.id = UuidV7.generate();
        this.environment = environment;
        this.hostname = hostname;
    }

    public UUID getId() { return id; }
    public Environment getEnvironment() { return environment; }
    public String getHostname() { return hostname; }
}
```

### `deployment/`

```java
package io.appfleet.control.deployment;

import io.appfleet.control.application.Application;
import io.appfleet.control.application.Release;
import io.appfleet.control.environment.Environment;
import io.appfleet.control.task.TaskStatus;
import jakarta.persistence.*;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import io.appfleet.control.common.UuidV7;

@Entity
@Table(name = "deployment")
public class Deployment {

    @Id
    private UUID id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "application_id", nullable = false)
    private Application application;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "release_id", nullable = false)
    private Release release;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "environment_id", nullable = false)
    private Environment environment;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private DeploymentState status;

    @Enumerated(EnumType.STRING)
    @Column(name = "current_status", nullable = false)
    private DeploymentState currentStatus; // deliberate denormalization — see control-api-schema-3nf.md

    @OneToMany(mappedBy = "deployment", fetch = FetchType.LAZY)
    private List<Task> tasks = new ArrayList<>();

    @Version
    private Long version;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    protected Deployment() {}

    public Deployment(Application application, Release release, Environment environment) {
        this.id = UuidV7.generate();
        this.application = application;
        this.release = release;
        this.environment = environment;
        this.status = DeploymentState.PENDING;
        this.currentStatus = DeploymentState.PENDING;
        this.createdAt = Instant.now();
        this.updatedAt = Instant.now();
    }

    public void transitionTo(DeploymentState target) {
        if (!status.canTransitionTo(target)) {
            throw new IllegalStateException("Illegal transition from " + status + " to " + target);
        }
        this.status = target;
        this.updatedAt = Instant.now();
    }

    public UUID getId() { return id; }
    public Application getApplication() { return application; }
    public Release getRelease() { return release; }
    public Environment getEnvironment() { return environment; }
    public DeploymentState getStatus() { return status; }
    public DeploymentState getCurrentStatus() { return currentStatus; }
    public List<Task> getTasks() { return tasks; }
    public Long getVersion() { return version; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
}
```

`@Version` is S2 checklist item 3 — Hibernate increments it on every update, throws `OptimisticLockException` on a stale write. Retry-vs-fail policy: **not decided yet** — that decision is made when the test proving `OptimisticLockException` fires is written, per the spec ("decide and document the retry-vs-fail policy"). Flagged as open below.

### `catalogue/`

```java
package io.appfleet.control.catalogue;

import jakarta.persistence.*;
import java.util.UUID;
import io.appfleet.control.common.UuidV7;

@Entity
@Table(name = "base_image")
public class BaseImage {

    @Id
    private UUID id;

    @Column(nullable = false, unique = true)
    private String name;

    @Column(nullable = false)
    private String registry;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "parent_base_image_id")
    private BaseImage parent;

    protected BaseImage() {}

    public BaseImage(String name, String registry, BaseImage parent) {
        this.id = UuidV7.generate();
        this.name = name;
        this.registry = registry;
        this.parent = parent;
    }

    public UUID getId() { return id; }
    public String getName() { return name; }
    public String getRegistry() { return registry; }
    public BaseImage getParent() { return parent; }
}
```

```java
package io.appfleet.control.catalogue;

import jakarta.persistence.*;
import java.util.UUID;
import io.appfleet.control.common.UuidV7;

@Entity
@Table(name = "app_image")
public class AppImage {

    @Id
    private UUID id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "base_image_id", nullable = false)
    private BaseImage baseImage;

    @Column(nullable = false)
    private String name;

    private String maintainer;

    protected AppImage() {}

    public AppImage(BaseImage baseImage, String name, String maintainer) {
        this.id = UuidV7.generate();
        this.baseImage = baseImage;
        this.name = name;
        this.maintainer = maintainer;
    }

    public UUID getId() { return id; }
    public BaseImage getBaseImage() { return baseImage; }
    public String getName() { return name; }
    public String getMaintainer() { return maintainer; }
}
```

```java
package io.appfleet.control.catalogue;

import jakarta.persistence.*;
import java.util.UUID;
import io.appfleet.control.common.UuidV7;

@Entity
@Table(name = "image_version")
public class ImageVersion {

    @Id
    private UUID id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "app_image_id", nullable = false)
    private AppImage appImage;

    @Column(nullable = false)
    private String version;

    @Column(name = "pipeline_state", nullable = false)
    private String pipelineState;

    protected ImageVersion() {}

    public ImageVersion(AppImage appImage, String version, String pipelineState) {
        this.id = UuidV7.generate();
        this.appImage = appImage;
        this.version = version;
        this.pipelineState = pipelineState;
    }

    public UUID getId() { return id; }
    public AppImage getAppImage() { return appImage; }
    public String getVersion() { return version; }
    public String getPipelineState() { return pipelineState; }
}
```

### `task/`

```java
package io.appfleet.control.task;

public enum TaskStatus {
    PENDING, RUNNING, SUCCEEDED, FAILED
}
```

```java
package io.appfleet.control.task;

import io.appfleet.control.deployment.Deployment;
import jakarta.persistence.*;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import io.appfleet.control.common.UuidV7;

@Entity
@Table(name = "task")
public class Task {

    @Id
    private UUID id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "deployment_id", nullable = false)
    private Deployment deployment;

    @Column(name = "task_type", nullable = false)
    private String taskType;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private TaskStatus status;

    @OneToMany(mappedBy = "task", fetch = FetchType.LAZY)
    private List<Attempt> attempts = new ArrayList<>();

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    protected Task() {}

    public Task(Deployment deployment, String taskType) {
        this.id = UuidV7.generate();
        this.deployment = deployment;
        this.taskType = taskType;
        this.status = TaskStatus.PENDING;
        this.createdAt = Instant.now();
        this.updatedAt = Instant.now();
    }

    public UUID getId() { return id; }
    public Deployment getDeployment() { return deployment; }
    public String getTaskType() { return taskType; }
    public TaskStatus getStatus() { return status; }
    public List<Attempt> getAttempts() { return attempts; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getUpdatedAt() { return updatedAt; }
}
```

```java
package io.appfleet.control.task;

import jakarta.persistence.*;
import java.time.Instant;
import java.util.UUID;
import io.appfleet.control.common.UuidV7;

@Entity
@Table(name = "attempt")
public class Attempt {

    @Id
    private UUID id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "task_id", nullable = false)
    private Task task;

    @Column(name = "attempt_number", nullable = false)
    private int attemptNumber;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private TaskStatus status;

    @Column(name = "started_at", nullable = false)
    private Instant startedAt;

    @Column(name = "finished_at")
    private Instant finishedAt;

    @Column(name = "error_detail")
    private String errorDetail;

    protected Attempt() {}

    public Attempt(Task task, int attemptNumber) {
        this.id = UuidV7.generate();
        this.task = task;
        this.attemptNumber = attemptNumber;
        this.status = TaskStatus.PENDING;
        this.startedAt = Instant.now();
    }

    public UUID getId() { return id; }
    public Task getTask() { return task; }
    public int getAttemptNumber() { return attemptNumber; }
    public TaskStatus getStatus() { return status; }
    public Instant getStartedAt() { return startedAt; }
    public Instant getFinishedAt() { return finishedAt; }
    public String getErrorDetail() { return errorDetail; }
}
```

### `audit/` and `outbox/`

Both flat, no `@ManyToOne` — `targetId`/`aggregateId` stay plain `UUID` fields (see the owning-side table above for why):

```java
package io.appfleet.control.audit;

import jakarta.persistence.*;
import java.time.Instant;
import java.util.UUID;
import io.appfleet.control.common.UuidV7;

@Entity
@Table(name = "audit_event")
public class AuditEvent {

    @Id
    private UUID id;

    @Column(nullable = false)
    private String actor;

    @Column(nullable = false)
    private String action;

    @Column(name = "target_type", nullable = false)
    private String targetType;

    @Column(name = "target_id", nullable = false)
    private UUID targetId;

    private String detail;

    @Column(name = "occurred_at", nullable = false)
    private Instant occurredAt;

    protected AuditEvent() {}

    public AuditEvent(String actor, String action, String targetType, UUID targetId, String detail) {
        this.id = UuidV7.generate();
        this.actor = actor;
        this.action = action;
        this.targetType = targetType;
        this.targetId = targetId;
        this.detail = detail;
        this.occurredAt = Instant.now();
    }

    public UUID getId() { return id; }
    public String getActor() { return actor; }
    public String getAction() { return action; }
    public String getTargetType() { return targetType; }
    public UUID getTargetId() { return targetId; }
    public String getDetail() { return detail; }
    public Instant getOccurredAt() { return occurredAt; }
}
```

```java
package io.appfleet.control.outbox;

import jakarta.persistence.*;
import java.time.Instant;
import java.util.UUID;
import io.appfleet.control.common.UuidV7;

@Entity
@Table(name = "outbox_message")
public class OutboxMessage {

    @Id
    private UUID id;

    @Column(name = "aggregate_id", nullable = false)
    private UUID aggregateId;

    @Column(nullable = false, columnDefinition = "jsonb")
    private String payload;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "sent_at")
    private Instant sentAt;

    protected OutboxMessage() {}

    public OutboxMessage(UUID aggregateId, String payload) {
        this.id = UuidV7.generate();
        this.aggregateId = aggregateId;
        this.payload = payload;
        this.createdAt = Instant.now();
    }

    public void markSent() { this.sentAt = Instant.now(); }

    public UUID getId() { return id; }
    public UUID getAggregateId() { return aggregateId; }
    public String getPayload() { return payload; }
    public Instant getCreatedAt() { return createdAt; }
    public Instant getSentAt() { return sentAt; }
}
```

`payload` as plain `String` + `columnDefinition = "jsonb"` needs no extra type converter in Hibernate 6 — text in/out, Postgres stores/validates as `jsonb`.

## What S2 does after entities exist

Not designed yet — separate doc/pass once entities are typed in and verified against the running schema:

- **N+1 drill** (item 2) — list 50 deployments with tasks, count queries, fix 3 ways, diff SQL into `/docs`.
- **Optimistic-lock test** (item 3) — two threads, same deployment, one gets `OptimisticLockException`; retry-vs-fail policy decided there, not here.
- **`LazyInitializationException` drill** (item 4) — touch `deployment.tasks` outside a transaction, fix without `open-in-view`, then disable `open-in-view` globally.
- **Self-invocation bug** (item 5) — proxy-bypass demo + fix, kept as `@Disabled`.
- **Rollback rules** (item 6) — checked exception commits anyway by default; `rollbackFor` fix; both tests kept.
- **`REQUIRES_NEW`** (item 7) — audit row survives a rolled-back deployment.
- **Repositories** (item 8) — derived queries, `@Query` where needed, interface projections for list views.

## Definition of done (entities)

- [ ] All 12 entities + `DeploymentState` + `TaskStatus` + `UuidV7` created, matching the packages above
- [ ] `mvn verify` green, `ddl-auto: validate` passes against the live `V1`+`V2` schema (proves every entity's mapping matches the actual columns — no drift)
- [ ] `Deployment.transitionTo(...)` unit-tested: legal transitions succeed, illegal ones throw `IllegalStateException`, every state pair from the mermaid diagram covered
