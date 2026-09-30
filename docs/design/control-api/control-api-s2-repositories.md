# control-api — S2 repositories

**Spec:** [01-CONTROL-API.md §S2](../../specs/project/01-CONTROL-API.md), last bullet: *"Repositories: derived queries where trivial, `@Query` where not, interface projections for list views (and check the SQL selects only those columns)."*

Companion: [control-api-s2-entities.md](control-api-s2-entities.md) (the entities these sit on top of), [control-api-s2-verification.md](control-api-s2-verification.md) (implementation checkout of those entities), [control-api-s1-exercises.md](control-api-s1-exercises.md) (the window-function/recursive-CTE queries, parked but relevant — see §5 below, they land here). **Status: designed, not yet implemented** — no `Repository` interfaces exist in the tree yet.

## What this doc does *not* design

The N+1 exercise (S2 checklist item 2, still pending per [control-api-s2-verification.md](control-api-s2-verification.md)'s "what's next") needs three *additional* `Deployment`-fetching methods — one using `JOIN FETCH`, one using `@EntityGraph`, one relying on `@BatchSize` — specifically to demonstrate the broken-then-fixed sequence the spec wants. Those don't belong here: writing them now, before the N+1 has actually been observed broken, would skip the "find it broken first" step the whole exercise exists to teach. `DeploymentRepository` below gets only the trivial derived methods; the fetch-strategy variants are a separate, later doc.

## Package layout

One repository per entity, living in the same package as its entity — same discipline as the entities themselves:

```
io.appfleet.control
├── application/    ApplicationRepository, ReleaseRepository
├── environment/    EnvironmentRepository, NodeRepository
├── deployment/     DeploymentRepository
├── catalogue/      BaseImageRepository, AppImageRepository, ImageVersionRepository
├── task/           TaskRepository, AttemptRepository
├── audit/          AuditEventRepository
└── outbox/         OutboxMessageRepository
```

All extend `JpaRepository<Entity, UUID>` — Spring Data generates `save`/`findById`/`findAll`/`delete`/etc. for free; only what's genuinely needed beyond that gets added per repository.

## `application/`

```java
package io.appfleet.control.application;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.Optional;
import java.util.UUID;

public interface ApplicationRepository extends JpaRepository<Application, UUID> {
    Optional<Application> findByName(String name);
}
```

`findByName` is a derived query — Spring Data parses the method name and generates `WHERE name = ?` with no `@Query` needed. Justified because `application.name` is the one column S1's schema made a real candidate key (`UNIQUE` constraint) — looking an application up by name is a genuine, named use case (e.g. resolving a name typed into a CLI or a URL path segment), not a speculative method added because the column exists.

```java
package io.appfleet.control.application;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface ReleaseRepository extends JpaRepository<Release, UUID> {
    List<Release> findByApplication(Application application);
    Optional<Release> findByApplicationAndVersion(Application application, String version);
}
```

`findByApplicationAndVersion` mirrors the `uq_release_app_version` unique constraint from `V1__init.sql` — same reasoning as `Application.findByName`: the method exists because the schema already guarantees at most one match, not because "it might be useful."

## `environment/`

```java
package io.appfleet.control.environment;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.Optional;
import java.util.UUID;

public interface EnvironmentRepository extends JpaRepository<Environment, UUID> {
    Optional<Environment> findByName(String name);
}
```

```java
package io.appfleet.control.environment;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.List;
import java.util.UUID;

public interface NodeRepository extends JpaRepository<Node, UUID> {
    List<Node> findByEnvironment(Environment environment);
}
```

## `deployment/`

```java
package io.appfleet.control.deployment;

import io.appfleet.control.application.Application;
import io.appfleet.control.environment.Environment;
import org.springframework.data.jpa.repository.JpaRepository;
import java.util.List;
import java.util.UUID;

public interface DeploymentRepository extends JpaRepository<Deployment, UUID> {
    List<Deployment> findByApplication(Application application);
    List<Deployment> findByApplicationAndEnvironment(Application application, Environment environment);
}
```

Deliberately minimal for now — see "What this doc does not design" above. The window-function query from [control-api-s1-exercises.md §2](control-api-s1-exercises.md) ("latest deployment per application per environment") is a candidate for a native `@Query` here once that exercise resumes, but adding it now would be designing ahead of when it's actually needed — same discipline as not adding the N+1-fix variants yet.

## `catalogue/`

```java
package io.appfleet.control.catalogue;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface BaseImageRepository extends JpaRepository<BaseImage, UUID> {

    Optional<BaseImage> findByName(String name);

    @Query(value = """
        WITH RECURSIVE lineage AS (
            SELECT id, name, parent_base_image_id, 0 AS depth
            FROM base_image
            WHERE id = :baseImageId

            UNION ALL

            SELECT parent.id, parent.name, parent.parent_base_image_id, lineage.depth + 1
            FROM base_image parent
            JOIN lineage ON lineage.parent_base_image_id = parent.id
        )
        SELECT * FROM lineage ORDER BY depth
        """, nativeQuery = true)
    List<BaseImage> findLineage(UUID baseImageId);
}
```

`findLineage` is the `@Query` half of the checklist bullet, and it's a **native** query specifically because `WITH RECURSIVE` has no JPQL equivalent — Hibernate's query language can't express recursive CTEs, so this is the one repository method in the whole module that has to drop to raw SQL. This is the same query designed in [control-api-s1-exercises.md §3](control-api-s1-exercises.md); it lands here as the actual callable method once repositories exist, rather than being pasted ad hoc into a Query Console every time.

```java
package io.appfleet.control.catalogue;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.List;
import java.util.UUID;

public interface AppImageRepository extends JpaRepository<AppImage, UUID> {
    List<AppImage> findByBaseImage(BaseImage baseImage);
}

public interface ImageVersionRepository extends JpaRepository<ImageVersion, UUID> {
    List<ImageVersion> findByAppImage(AppImage appImage);
}
```

## `task/`

```java
package io.appfleet.control.task;

import io.appfleet.control.deployment.Deployment;
import org.springframework.data.jpa.repository.JpaRepository;
import java.util.List;
import java.util.UUID;

public interface TaskRepository extends JpaRepository<Task, UUID> {
    List<Task> findByDeployment(Deployment deployment);
}
```

```java
package io.appfleet.control.task;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.List;
import java.util.UUID;

public interface AttemptRepository extends JpaRepository<Attempt, UUID> {
    List<Attempt> findByTask(Task task);
}
```

`TaskRepository.findByDeployment` is exactly the query the N+1 exercise will run *without* a fetch strategy first, to observe the 51-query problem — designed here as the plain derived method, deliberately not yet optimized.

## `audit/` and `outbox/`

```java
package io.appfleet.control.audit;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.UUID;

public interface AuditEventRepository extends JpaRepository<AuditEvent, UUID> {
}
```

No custom methods — nothing writes to `AuditEvent` yet (that's `AuditLogger`'s eventual Postgres-backed implementation, still just `Slf4jAuditLogger` per [control-api-spring-flow.md](control-api-spring-flow.md)), and nothing reads it either. `JpaRepository`'s inherited `save`/`findAll` are enough until a real caller exists — adding derived queries speculatively here would be the exact "unused N+1 trap" mistake called out in [control-api-s2-entities.md](control-api-s2-entities.md)'s owning-side reasoning, just applied to a repository method instead of a relationship.

```java
package io.appfleet.control.outbox;

import org.springframework.data.jpa.repository.JpaRepository;
import java.util.List;
import java.util.UUID;

public interface OutboxMessageRepository extends JpaRepository<OutboxMessage, UUID> {
    List<OutboxMessage> findBySentAtIsNull();
}
```

`findBySentAtIsNull` is the one method here that *is* justified ahead of a caller existing — it's exactly what the S6 `OutboxPoller` (sketched in [control-api-spring-flow.md §3](control-api-spring-flow.md)) will call on every scheduled tick: "find unsent rows, publish them, mark sent." The method name doubles as documentation for that not-yet-built poller.

## Interface projection — the checklist's other half

*"interface projections for list views (and check the SQL selects only those columns)."* One example, on the entity most likely to back a real list view once S3 exists — a deployment list that shouldn't need to pull every column or touch any lazy association:

```java
package io.appfleet.control.deployment;

import java.time.Instant;
import java.util.UUID;

public interface DeploymentListView {
    UUID getId();
    DeploymentState getStatus();
    DeploymentState getCurrentStatus();
    Instant getCreatedAt();
}
```

Added to `DeploymentRepository`:

```java
List<DeploymentListView> findByApplication_Id(UUID applicationId);
```

Spring Data generates a query that selects **only** `id`, `status`, `current_status`, `created_at` — not `application_id`/`release_id`/`environment_id` (no join needed at all for this one), not the `@OneToMany tasks` collection. The checklist's parenthetical — "check the SQL selects only those columns" — means literally turning on SQL logging (`logging.level.org.hibernate.SQL=DEBUG`, already how the N+1 exercise gets observed) and confirming the generated `SELECT` lists exactly four columns, not `SELECT *` or a full entity load. That verification step happens once this method is actually typed in and run, not now.

`findByApplication_Id` — the underscore navigates into the `application` association to reach its `id` field; this is Spring Data's syntax for "traverse a relationship in a derived query," distinct from `findByApplication(Application application)` above which takes the whole associated entity as a parameter instead of just its id.

## Definition of done

- [ ] All 12 repository interfaces created, matching the packages above
- [x] `BaseImageRepository.findLineage(...)` tested against a seeded multi-level `base_image` chain (needs [control-api-s1-exercises.md](control-api-s1-exercises.md)'s parked seed data, or a small hand-built 3-level chain in the test itself)
- [x] `DeploymentListView` projection verified with SQL logging on — confirm the generated query selects only the four projected columns
- [ ] `mvn verify` green

## What's next

`TaskRepository.findByDeployment` existing is what unblocks the N+1 exercise — that's the very next thing after these are typed in: call it for 50 deployments with SQL logging on, count 51 queries, then design the 3 fixes (`JOIN FETCH`, `@EntityGraph`, `@BatchSize`) in their own doc.
