# control-api — the last two S2 repository items: `findLineage` and the interface projection

**Spec:** [01-CONTROL-API.md §S2](../../specs/project/01-CONTROL-API.md), last bullet: *"Repositories: derived queries where trivial, `@Query` where not, interface projections for list views (and check the SQL selects only those columns)."* · Slice **S2** · Schema **`control`**

Companion: [control-api-s2-repositories.md](control-api-s2-repositories.md) (where both were designed and the two definition-of-done boxes were left open), [control-api-s1-exercises.md](control-api-s1-exercises.md) (the recursive CTE this method came from), [control-api-s2-n-plus-one.md](control-api-s2-n-plus-one.md) (SQL-log technique). **Status: implemented and green.**

Both items are already partly in the tree. `findLineage` exists on `BaseImageRepository`. It has never run. The projection was designed but never typed in. This doc designs the tests that make each one real, and records defects that reading the code already predicts, so the tests are written to *find them broken first*, as with the N+1 drill.

## 1. Naming clash to resolve first

[control-api-s2-repositories.md](control-api-s2-repositories.md) designed an **interface projection** called `DeploymentSummary` (`getId`, `getStatus`, `getCurrentStatus`, `getCreatedAt`). The tree now has a **record** `DeploymentSummary(UUID id, DeploymentState status, int taskCount)` in the same package, used by `DeploymentService.listSummaries()`. One package cannot hold both.

Decision: the record keeps `DeploymentSummary`. The two things play different roles:

| | Layer | Purpose | Loads |
|---|---|---|---|
| record `DeploymentSummary` | service | DTO handed to callers, built inside a transaction | full entities plus `tasks` (entity graph) |
| interface projection | repository | read model for a plain list | only the selected columns |

Rename the planned projection to **`DeploymentListView`**. `control-api-s2-repositories.md` is updated to match (section 5 here).

## 2. `findLineage`: test first, expect two failures

Current code (`BaseImageRepository`):

```java
@Query(value = """
    WITH RECURSIVE lineage as(
        SELECT id, name, parent_base_image_id, 0 as depth
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
```

Reading it against the entity and the config predicts these problems. **Do not fix any of them before the test has failed.**

1. **Missing `registry` column.** The method returns `List<BaseImage>`, so Hibernate maps each result row to the entity. `BaseImage` has a non-null `registry` column, but the CTE selects only `id, name, parent_base_image_id, depth`. Predicted failure when mapping: a "column not found" error for `registry`. The extra `depth` column is harmless, because unmapped result columns are ignored. A missing mapped column is not.
2. **Table is not schema-qualified.** `spring.jpa.properties.hibernate.default_schema: control` makes Hibernate qualify tables in **generated** SQL. It does not rewrite a **native** query. `FROM base_image` resolves against the connection's `search_path`. The Testcontainers connection has no `currentSchema=control` (only the manual compose URL has one), and Flyway created the tables in `control`, so the predicted failure is `relation "base_image" does not exist`. This is the same class of gap that [control-api-s2-service-layer-tests.md](control-api-s2-service-layer-tests.md) hit for entities. It applies to native SQL and the earlier fix does not cover it.
3. **No cycle guard** (not a test failure, a latent risk). Nothing in the schema prevents `A.parent = B` and `B.parent = A`. `UNION ALL` on a cyclic chain recurses forever until the connection is killed. Not tested now. Record it as a known limit and see section 2.3.

Which of 1 and 2 fires first depends on how Postgres parses the statement. It reports the missing relation first, at planning. So the first run should show (2), and after that is fixed, (1). Record the order actually observed.

### 2.1 The test

Class: `BaseImageLineageTest`, same Testcontainers annotations as the other integration tests. No `@Transactional` on the class.

```java
@Test
void findLineage_returnsChainLeafFirst() {
    BaseImage root = baseImageRepository.save(new BaseImage("root-" + UUID.randomUUID(), "reg", null));
    BaseImage mid  = baseImageRepository.save(new BaseImage("mid-"  + UUID.randomUUID(), "reg", root));
    BaseImage leaf = baseImageRepository.save(new BaseImage("leaf-" + UUID.randomUUID(), "reg", mid));

    List<BaseImage> lineage = baseImageRepository.findLineage(leaf.getId());

    assertThat(lineage).extracting(BaseImage::getId)
            .containsExactly(leaf.getId(), mid.getId(), root.getId());   // depth order, leaf first
}

@Test
void findLineage_ofRoot_isJustItself() {
    BaseImage root = baseImageRepository.save(new BaseImage("root-" + UUID.randomUUID(), "reg", null));

    assertThat(baseImageRepository.findLineage(root.getId()))
            .extracting(BaseImage::getId).containsExactly(root.getId());
}

@Test
void findLineage_ofUnknownId_isEmpty() {
    assertThat(baseImageRepository.findLineage(UUID.randomUUID())).isEmpty();
}
```

- **Assert on ids, never on `getParent()`.** `parent` is a lazy proxy and the returned entities are detached after the repository call. Touching it would be a `LazyInitializationException`, the previous drill, and is not what this test is about.
- **`UUID` suffix on every name.** `base_image.name` is `UNIQUE` (`uq_base_image_name`), and the tests share one container.
- The chain is built with three `save` calls, leaf last, because each child needs its parent already persisted.
- `containsExactly` (not `containsExactlyInAnyOrder`) is the point: the `ORDER BY depth` is part of the contract.

### 2.2 The fix, once observed broken

Both changes go in the query:

```java
@Query(value = """
    WITH RECURSIVE lineage AS (
        SELECT id, name, registry, parent_base_image_id, 0 AS depth
        FROM {h-schema}base_image
        WHERE id = :baseImageId

        UNION ALL

        SELECT parent.id, parent.name, parent.registry, parent.parent_base_image_id, lineage.depth + 1
        FROM {h-schema}base_image parent
        JOIN lineage ON lineage.parent_base_image_id = parent.id
    )
    SELECT id, name, registry, parent_base_image_id FROM lineage ORDER BY depth
    """, nativeQuery = true)
List<BaseImage> findLineage(@Param("baseImageId") UUID baseImageId);
```

- `registry` added to both halves of the CTE and to the final `SELECT`, so the entity mapping is complete.
- `{h-schema}` is Hibernate's placeholder for the configured `default_schema`. It expands to `control.` in native SQL, so the query works on any connection regardless of `search_path`. This is the answer to defect 2 that does not hard-code the schema name. **Confirm live** that the placeholder expands as expected and that the schema name in the generated SQL is `control.`. `Param` is `org.springframework.data.repository.query.Param`. It is optional if the compiler keeps parameter names (Boot's parent enables `-parameters`), but it removes the dependency on that flag.
- The final `SELECT` lists columns instead of `SELECT *`, so the entity mapping does not silently depend on the CTE's column order or on the extra `depth` column.
- The CTE name `lineage` stays unqualified. It is a query-local name, not a table.

### 2.3 Cycle guard: recorded, not built

A cyclic `parent` chain makes the query loop. Two ways to close it later:

- Use `UNION` instead of `UNION ALL`, which stops recursion when a row repeats. **This does not work here.** A row includes `depth`, which differs on every pass, so no row ever repeats. Do not use it.
- Add `WHERE lineage.depth < 50` to the recursive step. Simple and effective, and it caps runaway recursion. A legitimate base-image chain is nowhere near that deep.

Neither is added now. The schema has no way to create a cycle except direct SQL, because `BaseImage` only ever sets `parent` in its constructor. Note the limit and add the depth cap if `parent` ever becomes settable.

## 3. The interface projection

### 3.1 Design

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

Traps:

- **The projection must stay closed.** A *closed* projection contains only getters that match entity properties, so Spring Data can select just those columns. Adding a getter that navigates into an association (for example `getApplicationName()` via a nested `Application getApplication()`), or annotating one with `@Value("#{...}")`, turns it into an **open** projection. Spring Data then loads the whole entity and projects in memory, and the "selects only the projected columns" property silently disappears. That is exactly what the SQL check exists to catch.
- **`findByApplication_Id`**: the underscore traverses into the association. Hibernate should use the `application_id` foreign key directly with no join. **Confirm live** rather than assume.
- **Not a replacement for `listSummaries()`.** `taskCount` is an aggregate. An interface projection over a derived query cannot express it. A count would need a `@Query` with `size(d.tasks)` or a subquery. That is S3 material, not decided here.

### 3.2 The test: turning "check the SQL" into an assertion

Reading the log by eye is what the spec literally says, and it is easy to skip. Capture it in the test instead, using Spring Boot's `OutputCaptureExtension`.

Class: `DeploymentProjectionTest`, with `@ExtendWith(OutputCaptureExtension.class)` and SQL logging switched on for the test context:

```java
@SpringBootTest(properties = "logging.level.org.hibernate.SQL=DEBUG")
```

```java
@Test
void listView_selectsOnlyProjectedColumns(CapturedOutput output) {
    // seed: one application, release, environment, one deployment (as in the earlier tests)
    UUID applicationId = application.getId();

    List<DeploymentListView> views = deploymentRepository.findByApplication_Id(applicationId);

    assertThat(views).hasSize(1);
    assertThat(views.get(0).getStatus()).isEqualTo(DeploymentState.PENDING);

    String sql = lastSelectFromDeployment(output.getAll());
    assertThat(sql).contains("id", "status", "current_status", "created_at");
    assertThat(sql).doesNotContain("release_id", "environment_id", "version", "updated_at");
}
```

`lastSelectFromDeployment` is a small private helper that returns the last `org.hibernate.SQL` line containing `from control.deployment`. Take the *last* one, because seeding runs its own inserts and selects earlier in the same captured output.

Design notes:

- **Do not assert on the exact alias text** (`d1_0.id`). Hibernate's alias scheme can change between versions. Assert on column names present and absent.
- **`application_id` may legitimately appear** in the `WHERE` clause, so it is deliberately not in the `doesNotContain` list. The forbidden columns are the ones that would only appear in a full entity load: `release_id`, `environment_id`, `version` and `updated_at`.
- **Also assert one statement.** Use the `Statistics` helper from the N+1 test around the call and assert `getPrepareStatementCount() == 1`. It proves the projection did not load `tasks` or `application` lazily behind the scenes.
- **Fail-first check for the assertion itself.** Run once with a deliberately *open* projection (add `@Value("#{target.id}") UUID getIdAgain();` to the interface). The test should fail, because `version` and `release_id` show up in the SQL. Then remove it. A guard that cannot fail proves nothing (same rule as the `open-in-view` test).


## Observed results

**`findLineage`.** First run, 3 of 3 tests errored with `ERROR: relation "base_image" does not exist`. The `save` calls in the same tests worked, because Hibernate's own SQL is schema-qualified, so only the native query failed. This confirmed defect 2 (native SQL is not rewritten by `default_schema`). Both fixes (`{h-schema}` and `registry`) were then applied together, so the second predicted failure (missing `registry`) was **not observed separately**. It remains a prediction. After the fixes, `BaseImageLineageTest` is 3 of 3 green.

**Projection SQL, closed.** For `findByApplication_Id`, the generated SQL is exactly:

```sql
select d1_0.id,d1_0.status,d1_0.current_status,d1_0.created_at
from control.deployment d1_0
where d1_0.application_id=?
```

Four columns, no join, filtering on the foreign key `application_id` directly.

**Projection SQL, open (fail-first).** With `@Value("#{target.id}")` on `getId()`, the SQL became:

```sql
select d1_0.id,d1_0.application_id,d1_0.created_at,d1_0.current_status,d1_0.environment_id,
       d1_0.release_id,d1_0.status,d1_0.updated_at,d1_0.version
from control.deployment d1_0
where d1_0.application_id=?
```

Every entity column is loaded. `DeploymentProjectionTest` failed with `not to contain: ["release_id", "environment_id", "version", "updated_at"] but found: [...]`. Removing the `@Value` returned the test to green. An open projection is silent in the Java and visible only in the SQL, which is what the test guards.

**Derived-query name.** `findByApplication_Id` and `findByApplicationId` both resolve here, because `Deployment` has no property called `applicationId`, so Spring Data splits the name into `application` + `Id`. The underscore is only required to disambiguate.
## 4. Order of work

1. Write the three `findLineage` tests. Run. Record the first failure (predicted: missing relation) in a Results section here.
2. Add `{h-schema}`. Run. Record the second failure (predicted: `registry` column). Add `registry` and the explicit final column list. Run. Green.
3. Rename the projection in `control-api-s2-repositories.md`. Add `DeploymentListView` and `findByApplication_Id`.
4. Write the projection test. Prove it can fail with an open projection, then remove the open getter. Green.
5. Record results here and tick the two open boxes in `control-api-s2-repositories.md`.

## 5. Changes to other docs

`control-api-s2-repositories.md`: rename the planned interface projection `DeploymentSummary` to `DeploymentListView` (three places: the code block, the paragraph that follows it, and the definition-of-done line) and note the clash and the record.

## Definition of done

- [x] `BaseImageLineageTest` written; first failure recorded (second predicted failure not observed separately)
- [x] `findLineage` fixed with `{h-schema}`, `registry` in the CTE and an explicit final column list; 3 tests green
- [x] Cycle-guard limit noted (section 2.3); no cycle handling added
- [x] `DeploymentListView` and `findByApplication_Id` added; `control-api-s2-repositories.md` renamed to match
- [x] `DeploymentProjectionTest` green: 4 columns present, `release_id`, `environment_id`, `version`, `updated_at` absent, 1 statement
- [x] Projection test seen failing with a deliberately open projection, then green after removing it
- [x] Both open boxes ticked in `control-api-s2-repositories.md`
