# control-api — the N+1 drill: break it, count it, fix it three ways

**Spec:** [01-CONTROL-API.md §S2](../../specs/project/01-CONTROL-API.md) — *"Build the N+1 first: list 50 deployments with their tasks, SQL logging on, count the 51 queries. Fix it three ways — `JOIN FETCH`, `@EntityGraph`, `@BatchSize` — and diff the generated SQL in `/docs`."* · Slice **S2** · Schema **`control`**

Companion: [control-api-s2-entities.md](control-api-s2-entities.md) (why `Deployment.tasks` is the one deliberate bidirectional pair, which exists for this exercise), [control-api-s2-repositories.md](control-api-s2-repositories.md) (`TaskRepository.findByDeployment` and the "fix variants come later, in their own doc" promise), [control-api-s2-service-layer.md](control-api-s2-service-layer.md) (`listAllNaive`), [control-api-s2-optimistic-lock.md](control-api-s2-optimistic-lock.md) (same test-owned `TransactionTemplate` approach). **Status: implemented and green (baseline `@Disabled` since `@BatchSize` was added, per 5.3).**

## 1. What the drill is

`Deployment.tasks` is `@OneToMany(mappedBy = "deployment", fetch = LAZY)`. Load 50 deployments, then touch `getTasks()` on each one inside a transaction:

- 1 query: `select ... from deployment`
- 50 queries: `select ... from task where deployment_id = ?`, once per deployment, fired lazily when `getTasks().size()` is called

Total 51. Nothing in the Java looks wrong. The cost is invisible until someone counts.

The discipline from the earlier docs applies: **find it broken first.** The naive version is written, run and its number recorded before any fix exists. No fetch-strategy repository method and no `@BatchSize` goes into `main` before then.

## 2. How to count: Hibernate statistics, not log lines

Log lines are for humans reading SQL. A test should assert on a number.

```java
@Autowired EntityManagerFactory emf;

private Statistics stats() {
    Statistics s = emf.unwrap(SessionFactory.class).getStatistics();
    s.setStatisticsEnabled(true);   // runtime switch, no property needed
    return s;
}
```

Usage inside a measured block:

```java
Statistics stats = stats();
stats.clear();                                   // drop everything counted so far, including seeding
// ... run the code under test in a transaction ...
long statements = stats.getPrepareStatementCount();
```

`getPrepareStatementCount()` counts JDBC statements Hibernate prepared since the last `clear()`. That is the "51".

Two rules that keep the number honest:

- Call `clear()` immediately before the measured transaction, not in `@BeforeEach`. Seeding runs hundreds of inserts and would drown the count.
- Measure only the code under test. Do not `assertThat(deploymentRepository.count())` inside the measured block. That is one more statement.

For the SQL diff (section 6), turn on `logging.level.org.hibernate.SQL=DEBUG` in the test's properties and copy the statements out of the surefire output. Statistics give the count and the log gives the text.

## 3. Seed data

**50 deployments, 3 tasks each = 150 tasks.** Small enough to run in a second, big enough that 51 versus 1 is obvious.

Constraint to design around: V1 has the partial unique index `uq_deployment_active_per_app_env` on `(application_id, environment_id) WHERE status NOT IN ('FAILED','ROLLED_BACK')`. Only one non-terminal deployment may exist per application and environment. 50 deployments in one environment therefore need **50 different applications**. Seed: 50 applications, 50 releases (one each), one shared environment, one deployment per application, three tasks per deployment.

Seed once for the whole class, not per test: `@TestInstance(Lifecycle.PER_CLASS)` and a `@BeforeAll` on a non-static method (needed to use `@Autowired` repositories). Every test in the class is read-only, so the shared data stays stable and each test sees exactly 50 deployments and 150 tasks. That also means `findAll()` returns exactly the seeded 50 with no filtering.

Use unique names (`"app-" + i + "-" + UUID.randomUUID()`) as the earlier tests do.

## 4. Step 1: the naive baseline

Class: `DeploymentNPlusOneTest`, package `io.appfleet.control.deployment`. Same Testcontainers annotations as `DeploymentOptimisticLockTest`, plus `@TestInstance(PER_CLASS)`. The class is not `@Transactional` and the test owns its transaction.

```java
@Test
void naive_issuesOnePlusNStatements() {
    Statistics stats = stats();
    TransactionTemplate readOnly = new TransactionTemplate(txManager);
    readOnly.setReadOnly(true);

    stats.clear();
    int totalTasks = readOnly.execute(status -> {
        List<Deployment> deployments = deploymentRepository.findAll();      // 1
        int n = 0;
        for (Deployment d : deployments) {
            n += d.getTasks().size();                                        // +1 each, lazy
        }
        return n;
    });

    assertThat(totalTasks).isEqualTo(150);                    // proves the loop really loaded everything
    assertThat(stats.getPrepareStatementCount()).isEqualTo(51);
}
```

Why assert `150`: a fix that returns fewer tasks would also lower the statement count. Pinning the returned data means only genuine fixes pass.

Why `findAll()` and not `listAllNaive()`: the service method returns entities out of its transaction, which is the *other* drill (`LazyInitializationException`). Here the loop must run inside one transaction so the lazy loads succeed. Keeping the test-owned transaction also leaves `main` untouched.

**Record the result.** Run it, confirm 51, and paste the observed SQL (1 `deployment` select, first few `task where deployment_id = ?` selects) into the results section below.

### 4.1 Observed result (step 1)

`naive_issuesOnePlusNStatements` is green: 150 tasks returned, **51** statements. Captured with `-Dlogging.level.org.hibernate.SQL=DEBUG`, this is exactly the measured block (seeding excluded):

```sql
-- 1 statement
select d1_0.id,d1_0.application_id,d1_0.created_at,d1_0.current_status,d1_0.environment_id,
       d1_0.release_id,d1_0.status,d1_0.updated_at,d1_0.version
from control.deployment d1_0

-- 50 statements, identical text, one per deployment, only the bound id differs
select t1_0.deployment_id,t1_0.id,t1_0.created_at,t1_0.status,t1_0.task_type,t1_0.updated_at
from control.task t1_0
where t1_0.deployment_id=?
```

Only two distinct statement texts appear: one deployment select (1 time) and one task select (50 times). No `application`, `release` or `environment` selects fire, which confirms the `@ManyToOne` associations stayed lazy and untouched.

## 5. Step 2: three fixes

Each fix gets one test asserting the same `150` tasks and a statement count. Each fix is written only after step 1 has been observed.

### 5.1 `JOIN FETCH` (explicit JPQL)

```java
// DeploymentRepository
@Query("select d from Deployment d join fetch d.tasks")
List<Deployment> findAllWithTasksJoinFetch();
```

Expected: **1 statement.** One `select ... from deployment d join task t on t.deployment_id = d.id`.

Traps to write down while doing it:

- **Row multiplication.** The join returns one row per task, so 150 rows for 50 deployments. Hibernate 6 and later de-duplicates the root entities in memory, so `distinct` is no longer required. Assert `findAllWithTasksJoinFetch()` returns **50** deployments, not 150. That guards the trap.
- **Inner join drops empty parents.** A deployment with zero tasks disappears from the result. The seed has none, so the test cannot see this. Note it. `left join fetch` is the fix when parents without children must be kept.
- **Pagination.** `join fetch` on a collection combined with `Pageable` makes Hibernate page in memory (warning `HHH90003004`, "firstResult/maxResults specified with collection fetch"). It is a real limitation for the S3 list endpoints. Do not paginate this query.
- **Only one bag per query.** Do not also fetch `Task.attempts` in the same query. Two `List` collections in one fetch fail with `MultipleBagFetchException`. Not needed here.

### 5.2 `@EntityGraph`

```java
// DeploymentRepository
@EntityGraph(attributePaths = "tasks")
List<Deployment> findAllBy();
```

Expected: **1 statement**, same shape as 5.1 (`left outer join`, since entity graphs default to left fetch).

Difference from 5.1 worth recording: an entity graph is declarative and is attached to a repository method's *derived* query, so the query text stays derived. It defaults to `left join`, so empty parents are kept, which is the opposite of the bare `join fetch` above. Assert that the generated SQL says `left join`, not `inner join`. This is the point of doing all three and diffing them.

### 5.3 `@BatchSize`

```java
// Deployment
@OneToMany(mappedBy = "deployment", fetch = FetchType.LAZY)
@BatchSize(size = 25)
private List<Task> tasks = new ArrayList<>();
```

No query change. The loop from step 1 still runs unchanged, but Hibernate loads tasks for up to 25 deployments per statement: `select ... from task where deployment_id in (?, ?, ..., ?)`.

Expected: **3 statements**: 1 for deployments, then `ceil(50 / 25) = 2` batched task loads. **Confirm live.** Hibernate 7 may render the `IN` list differently on Postgres (for example a single array parameter), and the count depends on exactly how it batches. Whatever number appears is the number to record. The formula is a prediction, not a spec.

This is the one that changes existing behaviour. It sits on the field, so it affects *every* lazy load of `tasks`, including the naive loop. Consequence for the tests:

- The step 1 baseline can no longer show 51 once `@BatchSize` exists. Per the spec's own convention for kept-broken versions ("keep the broken version as a `@Disabled` test"), mark `naive_issuesOnePlusNStatements` `@Disabled("fixed by @BatchSize on Deployment.tasks; remove the annotation to reproduce the 51")`. It stays as reproducible documentation.
- Do this last, after 5.1 and 5.2 are green, so the baseline stays live for as long as possible.
- The 5.1 and 5.2 tests are unaffected. An explicit fetch join loads tasks in the first query, so there is nothing left for batching to do.

## 6. The SQL diff

Observed results, all four variants returning the same 150 tasks. SQL captured with `-Dlogging.level.org.hibernate.SQL=DEBUG`:

| Variant | Statements | Shape of the task SQL |
|---|---|---|
| naive | 51 | 50 × `where deployment_id = ?` |
| `JOIN FETCH` | 1 | `from deployment d1_0 join task t1_0 on d1_0.id=t1_0.deployment_id` (inner join) |
| `@EntityGraph` | 1 | `from deployment d1_0 left join task t1_0 on d1_0.id=t1_0.deployment_id` |
| `@BatchSize(25)` | 3 (observed) | `where deployment_id = any (?)`, one array parameter per batch, 2 batches of up to 25 |

Same 150 tasks returned by all four.

## 7. Which one to use, as a recommendation

- **Default for a known list-with-children endpoint:** an explicit fetch on the repository method, `@EntityGraph` first. It is visible at the call site, attached to one use case, and keeps `left` semantics.
- **`JOIN FETCH`:** when the query needs conditions on the joined rows, or when an inner join is what is wanted.
- **`@BatchSize`:** as a safety net on the association. It makes accidental lazy loads cost `1 + N/25` instead of `1 + N`, without fixing any specific query. It does not remove the N+1 and does not replace an explicit fetch on a hot path.
- **Never:** flipping the association to `EAGER`. It applies to every load, including ones that never wanted tasks, and it still issues N+1 for `findAll()`.

### 7.1 Confirmed against the observed results

The runs support the recommendation above. Two points are worth stating explicitly, because they were easy to misread while doing the drill.

- **`findAll()` does not use any of the fixes.** `JOIN FETCH` and `@EntityGraph` exist only on their own repository methods (`findAllWithTasksJoinFetch`, `findAllBy`). Only `@BatchSize` is on the entity, so it changes every lazy load of `Deployment.tasks`. In the batch test, plain `findAll()` gave 3 statements for that reason alone. Calling `findAll()` in new code and touching `tasks` is still an N+1, softened by batching.
- **Observed join difference.** `JOIN FETCH` produced `join control.task` (inner) and `@EntityGraph` produced `left join control.task`. A deployment with no tasks would vanish from the `JOIN FETCH` result but not from the `@EntityGraph` result. This is why `@EntityGraph` is the default.

Preference order for a "deployments with their tasks" list:

1. `@EntityGraph` on a derived method. No JPQL string to mistype, left-join semantics, declared on the one method that needs it.
2. `JOIN FETCH` when the query needs a condition on the joined rows (for example tasks with status `FAILED`) or an inner join on purpose.
3. `@BatchSize` stays on the field as a safety net for lazy loads nobody planned for.

Pagination caveat for S3: a collection fetch (either fix) combined with `Pageable` makes Hibernate page in memory. For paged list endpoints, page the deployment ids first and fetch children for that page, or rely on `@BatchSize` on the paged query.

## 8. What this doc does not design

- `LazyInitializationException` (touching `tasks` after the transaction closes). Separate drill, next.
- DTO or projection responses. That is S3, where controllers must never return entities.
- Seeding volume for performance work. That is the parked S1 exercise ([control-api-s1-exercises.md](control-api-s1-exercises.md)).

## Definition of done

- [x] `DeploymentNPlusOneTest` seeds 50 applications, 50 deployments and 150 tasks once per class
- [x] Step 1 baseline test green asserting 51 statements and 150 tasks; SQL recorded here **before any fix is written**
- [x] 5.1 `findAllWithTasksJoinFetch` green: 1 statement, 50 entities, 150 tasks
- [x] 5.2 `findAllBy` with `@EntityGraph` green: 1 statement, `left join` confirmed
- [x] 5.3 `@BatchSize(size = 25)` added last; actual statement count recorded; step 1 baseline marked `@Disabled`
- [x] SQL for all four variants diffed in a Results section here
- [x] Recommendation in section 7 confirmed against what was observed (see 7.1)
