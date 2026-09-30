# control-api — the `LazyInitializationException` drill, and `open-in-view` off

**Spec:** [01-CONTROL-API.md §S2](../../specs/project/01-CONTROL-API.md) — *"Trigger `LazyInitializationException` by touching tasks outside the transaction. Fix without `open-in-view` — then turn `open-in-view` off globally and write down why it's on by default and why you disagree."* · Slice **S2** · Schema **`control`**

Companion: [control-api-s2-service-layer.md](control-api-s2-service-layer.md) (`listAllNaive()`, the deliberate hook, and the two fix options stated there), [control-api-s2-n-plus-one.md](control-api-s2-n-plus-one.md) (`findAllBy()` with `@EntityGraph`, reused here; same statement-counting technique), [control-api-s2-optimistic-lock.md](control-api-s2-optimistic-lock.md) (same test-owned transaction approach). **Status: implemented and green; section 4 position accepted.**

## 1. What the drill is

`Deployment.tasks` is lazy. A lazy collection is only a placeholder until something touches it, and touching it needs an open Hibernate session. `DeploymentService.listAllNaive()` is `@Transactional(readOnly = true)`. Its session closes when the method returns, and it returns detached entities:

```java
List<Deployment> deployments = deploymentService.listAllNaive();   // transaction ends here
deployments.get(0).getTasks().size();                              // no session -> LazyInitializationException
```

Nothing is wrong inside the service. The failure happens in the *caller*, which is why it is so common: the bug is invisible in the code that caused it.

Two facts the test setup depends on:

- **The test class must not be `@Transactional`.** A test-managed transaction keeps one session open across the whole test method, so the collection would load fine and the exception would never appear. Same rule as the optimistic-lock test.
- **`@SpringBootTest` here never goes through an HTTP request,** so `open-in-view` has no effect in these tests either way. `open-in-view` only acts on web requests (section 4). The drill therefore behaves identically before and after the property is flipped. That is expected, not a sign the setting is ignored.

## 2. Find it broken first

**Test 1: `listAllNaive_touchingTasksOutsideTransaction_throws`**

```java
@Test
void listAllNaive_touchingTasksOutsideTransaction_throws() {
    List<Deployment> deployments = deploymentService.listAllNaive();

    assertThatThrownBy(() -> deployments.get(0).getTasks().size())
            .isInstanceOf(LazyInitializationException.class);
}
```

Import: `org.hibernate.LazyInitializationException`. The exception is thrown by Hibernate directly from the collection, so Spring's exception translation (which only wraps repository and template calls) does not touch it. Assert on the **type**. The message wording differs between Hibernate versions, so do not pin the text. Record the observed message in the results section once run.

**On the spec's "keep the broken version as a `@Disabled` test".** For the self-invocation bug the `@Disabled` test asserts the *desired* behaviour, which fails because of the defect. Here the defect is Hibernate's documented behaviour and it is deterministic, so a test that asserts the exception is a true statement on every run. `listAllNaive()` stays in `DeploymentService` unchanged as the reachable broken version, and Test 1 keeps proving it stays broken. If a `@Disabled` twin (asserting `getTasks().size()` returns a count) is wanted for strict convention-matching, it is one extra method, and it changes nothing else.

Seed: this class needs only a few rows. 3 deployments with 2 tasks each, one application per deployment (the same partial unique index constraint as the N+1 doc, section 3), seeded once with `@TestInstance(PER_CLASS)`.

## 3. Fixes, without `open-in-view`

The service-layer doc named two. This doc adds a third observation that explains *why* the first is not enough.

### 3.1 Entity graph on its own: fixes only what it names

`findAllBy()` (already exists, `@EntityGraph(attributePaths = "tasks")`) initialises `tasks` inside the transaction, so touching tasks afterwards works. It does **not** initialise `application`, `release` or `environment`, which stay lazy proxies.

**Test 2: `entityGraph_tasksReadableAfterTransaction_butOtherAssociationsStillThrow`**

```java
List<Deployment> deployments = new TransactionTemplate(txManager)
        .execute(s -> deploymentRepository.findAllBy());       // transaction closes on return

assertThat(deployments.get(0).getTasks()).hasSize(2);           // loaded by the graph: fine
assertThatThrownBy(() -> deployments.get(0).getApplication().getName())
        .isInstanceOf(LazyInitializationException.class);      // not in the graph: still lazy
```

Uses a test-owned `TransactionTemplate` and the repository directly, so no `main` change is needed. This test shows why option (b) alone is fragile: returning entities means every caller can still walk into the next unfetched association. The graph fixes one path, not the class of bug.

### 3.2 DTO mapped inside the transaction: the real fix

The entity never leaves the transaction. The service maps to a record while the session is open, so nothing lazy escapes.

New in `main`, package `io.appfleet.control.deployment`:

```java
public record DeploymentSummary(UUID id, DeploymentState status, int taskCount) {}
```

```java
// DeploymentService
@Transactional(readOnly = true)
public List<DeploymentSummary> listSummaries() {
    return deploymentRepository.findAllBy().stream()          // entity graph: tasks already loaded, 1 query
            .map(d -> new DeploymentSummary(d.getId(), d.getStatus(), d.getTasks().size()))
            .toList();
}
```

Two fixes cooperating, each doing a different job: `@EntityGraph` prevents the N+1 (one statement), the DTO prevents the leak (no entity crosses the boundary). Either alone leaves a problem: the graph alone leaks entities, the DTO alone over a plain `findAll()` reintroduces N+1 inside the transaction.

Repo convention applies: DTOs are records, and entities never go out of controllers ([01-CONTROL-API.md §S3](../../specs/project/01-CONTROL-API.md)). This is the shape S3 will use.

**Test 3: `listSummaries_worksOutsideTransaction_inOneStatement`**

```java
Statistics stats = stats();          // same helper as the N+1 test
stats.clear();
List<DeploymentSummary> summaries = deploymentService.listSummaries();

assertThat(summaries).hasSize(3);
assertThat(summaries).allSatisfy(s -> assertThat(s.taskCount()).isEqualTo(2));
assertThat(stats.getPrepareStatementCount()).isEqualTo(1);
```

No exception is possible: a record holds an id, an enum and an int. The statement count proves the fix did not trade one bug for the N+1.

## 4. `open-in-view`: why it exists, why it is turned off

Nothing in the tests above can show `open-in-view` at work, because it only acts on a web request, and control-api has no controllers yet (S3). So the write-up is reasoning, and Test 4 below is the only mechanical check.

**What it does.** When `spring.jpa.open-in-view` is true (Spring Boot's default), Boot registers `OpenEntityManagerInViewInterceptor`. For each web request it opens an `EntityManager` before the controller runs and keeps it open until the response has been written. Entities loaded anywhere in the request stay attached, so a lazy collection touched in the controller, in a view or during JSON serialisation loads instead of throwing.

**Why it is on by default.** Compatibility. The pattern predates Boot, it made lazy loading "just work" in MVC views, and switching it off by default would have broken many existing applications. Boot logs a startup warning when the property is left unset (`spring.jpa.open-in-view is enabled by default. Therefore, database queries may be performed during view rendering`) because the authors consider it a trap, not a recommendation.

**Why to turn it off (position taken here; revise it if you disagree, since the spec asks for your own reasons):**

1. **It hides the very bug this drill is about.** With it on, the `LazyInitializationException` never fires in a controller. The lazy load happens silently at serialisation time, one query per row, i.e. the N+1 from [control-api-s2-n-plus-one.md](control-api-s2-n-plus-one.md), out of sight of any service test and any transaction boundary.
2. **It holds a database connection for the whole request.** The `EntityManager` obtains its connection when it first needs one and keeps it until the response is complete. Slow JSON serialisation, a slow downstream call or a slow client all hold a pool connection idle. Under load that is pool exhaustion caused by code that does no database work.
3. **It blurs the transaction boundary the rest of this slice teaches.** Reads after the service returns run outside any explicit transaction, each in its own autocommit read. Two lazy loads in one request can see different database states.
4. **It makes the service layer's contract a lie.** The service says "I return a `Deployment`", but correctness depends on the web layer keeping a session open behind it. Turn it off and the compiler-level contract (return a DTO) matches the runtime one.

**Cost of turning it off.** Every controller must receive data that is already fully loaded, which is exactly what the DTO fix in 3.2 does. There is no cost for control-api because no controller exists yet, so this is the cheapest moment to choose.

**The change.** In `control-api/src/main/resources/application.yml`, under `spring.jpa`:

```yaml
spring:
  jpa:
    open-in-view: false
    hibernate:
      ddl-auto: validate
```

**Test 4: `openInView_isDisabled`**

```java
@Autowired ApplicationContext context;

@Test
void openInView_isDisabled() {
    assertThat(context.getBeansOfType(OpenEntityManagerInViewInterceptor.class)).isEmpty();
}
```

Import: `org.springframework.orm.jpa.support.OpenEntityManagerInViewInterceptor`. This checks the effect, not the property string: when the flag is true and the app is a web app, Boot registers that interceptor bean. **Confirm live** that the assertion fails with the property unset (the interceptor is present) before relying on it passing with `false`. A guard test that cannot fail proves nothing. Run it once with `open-in-view` removed, observe the failure, then restore.

## 5. Order of work

1. Write Test 1. Run it. Confirm `LazyInitializationException` and record the message here. No `main` change.
2. Write Test 2. Run it. Confirm tasks are readable and `getApplication().getName()` throws.
3. Add `DeploymentSummary` and `DeploymentService.listSummaries()`. Write Test 3. Confirm 1 statement.
4. Write Test 4 with `open-in-view` **unset**. Confirm it fails. Then add `open-in-view: false` and confirm it passes.
5. Record results and the final position on section 4 here.


## Observed results

**Test 1.** Green. The exception message from Hibernate 7 is:

```
Cannot lazily initialize collection of role 'io.appfleet.control.deployment.Deployment.tasks' with key '<uuid>' (no session)
```

**Test 2.** Green. `findAllBy()` returns detached entities whose `tasks` are loaded (2 each), while `getApplication().getName()` throws `LazyInitializationException`.

**Test 3.** Green. `listSummaries()` returns 3 summaries, each with `taskCount == 2`, in 1 statement, called outside any transaction.

**Test 4.** Guard proven to be able to fail. With the property forced on (`-Dspring.jpa.open-in-view=true`) the test fails with:

```
Expecting empty but was: {"openEntityManagerInViewInterceptor"=org.springframework.orm.jpa.support.OpenEntityManagerInViewInterceptor@...}
```

With `spring.jpa.open-in-view: false` in `application.yml` it passes. The property was set in `application.yml` before this test was first run, so the "watch it fail first" step was done afterwards with the `-D` override rather than by removing the line.
## 6. Notes

- **New test class:** `DeploymentLazyInitializationTest`, same Testcontainers annotations plus `@TestInstance(PER_CLASS)`. It needs `DeploymentService`, `DeploymentRepository`, the three parent repositories, `TaskRepository`, `PlatformTransactionManager` and `EntityManagerFactory`.
- **Boilerplate threshold reached.** The same container block and parent-entity seeding now sit in five test classes. The optimistic-lock doc said to extract a shared base only if a fourth appeared. A shared `abstract class PostgresIntegrationTest` with one `static` container would also let Spring cache a single application context across the classes and cut suite time. Recommended as a separate small step *before* adding this class, not part of this drill.
- **Not in scope:** the S3 controller-level behaviour (where `open-in-view` would actually be visible), and Jackson serialising entities. Both belong to S3.

## Definition of done

- [x] Test 1 green: `LazyInitializationException` observed on `listAllNaive()` output; message recorded
- [x] Test 2 green: entity graph fixes `tasks` only; `application` still throws
- [x] Test 3 green: `listSummaries()` works outside a transaction in 1 statement
- [x] Test 4 seen failing with `open-in-view` unset, then green with `open-in-view: false` in `application.yml`
- [x] Position in section 4 accepted by the author as the "why on by default, why disagree" note the spec asks for
