# control-api — optimistic locking on `Deployment`

**Spec:** [01-CONTROL-API.md §S2](../../specs/project/01-CONTROL-API.md) — *"`@Version` on Deployment. Test: two threads load the same deployment, both transition it, one gets `OptimisticLockException`. Decide and document the retry-vs-fail policy."* · Slice **S2** · Schema **`control`**

Companion: [control-api-s2-entities.md](control-api-s2-entities.md) (why `@Version` sits on `Deployment`), [control-api-s2-verification.md](control-api-s2-verification.md) (`V3__add_deployment_version.sql`, which proved the column exists but never exercised it), [control-api-s2-deployment-tests.md](control-api-s2-deployment-tests.md) (the pure unit tests of `transitionTo`), [control-api-s2-service-layer-tests.md](control-api-s2-service-layer-tests.md) (same Testcontainers setup this test reuses). **Status: implemented and passing.** Observed results are in [control-api-s2-verification.md](control-api-s2-verification.md).

## 1. What this test proves that the existing tests cannot

`DeploymentTest` proves `transitionTo` is correct for **one** caller with a **correct view** of the current state. It says nothing about two callers who both read `VALIDATING`, then each decide on a different next step:

- caller A: `VALIDATING -> DEPLOYING`
- caller B: `VALIDATING -> FAILED`

Both calls are legal against the state each caller saw. The state machine cannot reject either one, because each check runs against a stale in-memory copy. Without `@Version`, both `UPDATE`s succeed and the last writer silently wins (lost update). `@Version` turns this into `UPDATE deployment SET ..., version = 1 WHERE id = ? AND version = 0`; the loser matches zero rows and Hibernate throws.

Only a real database and two real transactions can show this. Same reasoning as [control-api-s2-service-layer-tests.md](control-api-s2-service-layer-tests.md): the guarantee lives in the `UPDATE ... WHERE version = ?`, not in Java.

## 2. What needs to exist first

Nothing new in `main`. The test drives `DeploymentRepository` and `Deployment.transitionTo` directly through a `TransactionTemplate`.

Reason: the point is the interleaving (load, load, write, write). A service method with a hard-wired `@Transactional` boundary would give the test no place to pause between the load and the write. A test-owned transaction does.

`DeploymentService.create(...)` cannot seed the row. It always throws, by design of the audit-survival test. Seed with `deploymentRepository.save(new Deployment(...))`, the same way `DeploymentServiceRollbackTest.setUp` seeds its parents.

## 3. Tests

Class: `DeploymentOptimisticLockTest`, package `io.appfleet.control.deployment`, under `control-api/src/test`.

Same class annotations as `DeploymentServiceRollbackTest`: `@SpringBootTest`, `@ActiveProfiles("test")`, `@Testcontainers`, `postgres:16` with `@ServiceConnection`.

**The test class must not be `@Transactional`.** A test-managed transaction would wrap both threads' work in one shared boundary, or none, and the interleaving would mean nothing.

Extra autowired beans: `PlatformTransactionManager`, used to build a `TransactionTemplate`.

### 3.1 `twoConcurrentTransitions_exactlyOneWins`

Setup: seed a `Deployment`, then move it to `VALIDATING` and commit. Record its id.

Two tasks run on a 2-thread `ExecutorService`. Each does the following inside its own `TransactionTemplate.execute`:

1. `findById(id)`, so it sees `VALIDATING` at `version = 1`.
2. `barrier.await()`, a `CyclicBarrier(2)`. This guarantees both loads finish before either write.
3. `transitionTo(target)`. Task A uses `DEPLOYING`, task B uses `FAILED`.
4. Return, so the transaction commits and flushes the `UPDATE`.

Collect both `Future`s. Assertions:

- Exactly one future completes normally.
- Exactly one future fails, with a cause chain containing `ObjectOptimisticLockingFailureException`.
- Reload the row. `version` is `2` (one write, not two).
- The final `status` equals the target of the winning task.

Do not assert *which* task wins. Postgres row locking decides that, and asserting it would make the test flaky.

**Failure mode to expect while typing it in:** if the barrier sits outside the transaction, the loads may not overlap and the test passes for the wrong reason (sequential execution throws `IllegalStateException` from the state machine instead, or nothing at all). Keep both `findById` and `await` *inside* the `execute` callback.

**Exception type to confirm live, not assume:** Hibernate throws its own `OptimisticLockException` / `StaleObjectStateException`. Spring's `JpaTransactionManager` translates it at commit to `ObjectOptimisticLockingFailureException`. The spec's wording says `OptimisticLockException`. Run the test once, print the actual exception class and cause chain, then pin the assertion to what really surfaces. Record it in [control-api-s2-verification.md](control-api-s2-verification.md) as done for the earlier drift.

### 3.2 `successfulTransition_incrementsVersion`

Single thread. Seed, load, `transitionTo(VALIDATING)`, commit. Reload. `version` went `0 -> 1`. Guards the mapping: a `@Version` field that is not actually written by Hibernate would let 3.1 fail in a confusing way.

### 3.3 `noOpTransaction_doesNotIncrementVersion`

Single thread. Load a deployment inside a transaction, change nothing, commit. `version` unchanged. Documents that Hibernate bumps `version` only when the entity is dirty. Consequence for the policy below: a "read then decide nothing" path never causes a conflict.

Skip a fourth "stale detached entity" test. 3.1 already covers the mechanism and this variant adds no new behaviour.

### 3.4 Reference code

Full class for 3.1 to 3.3. The exception type in 3.1 is the expected one and still needs the live confirmation described above.

```java
package io.appfleet.control.deployment;

import io.appfleet.control.application.Application;
import io.appfleet.control.application.ApplicationRepository;
import io.appfleet.control.application.Release;
import io.appfleet.control.application.ReleaseRepository;
import io.appfleet.control.environment.Environment;
import io.appfleet.control.environment.EnvironmentRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.orm.ObjectOptimisticLockingFailureException;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.util.List;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.*;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest
@ActiveProfiles("test")
@Testcontainers
public class DeploymentOptimisticLockTest {   // NOT @Transactional, see section 3

    @Container
    @ServiceConnection
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:16");

    @Autowired ApplicationRepository applicationRepository;
    @Autowired ReleaseRepository releaseRepository;
    @Autowired EnvironmentRepository environmentRepository;
    @Autowired DeploymentRepository deploymentRepository;
    @Autowired PlatformTransactionManager txManager;

    private TransactionTemplate tx;
    private Application application;
    private Release release;
    private Environment environment;

    @BeforeEach
    void setUp() {
        tx = new TransactionTemplate(txManager);
        application = applicationRepository.save(
                new Application("app-" + UUID.randomUUID(), "desc", UUID.randomUUID()));
        release = releaseRepository.save(
                new Release(application, "v1.0.0", "s3://artifact.jar", "checksum"));
        environment = environmentRepository.save(
                new Environment("env-" + UUID.randomUUID()));
    }

    // ---- 3.1 -----------------------------------------------------------

    @Test
    void twoConcurrentTransitions_exactlyOneWins() throws Exception {
        UUID id = seedValidating();                       // status VALIDATING, version 1, committed
        CyclicBarrier barrier = new CyclicBarrier(2);
        ExecutorService pool = Executors.newFixedThreadPool(2);   // must equal barrier parties
        try {
            Future<Void> a = pool.submit(transitionTask(id, DeploymentState.DEPLOYING, barrier));
            Future<Void> b = pool.submit(transitionTask(id, DeploymentState.FAILED, barrier));

            Throwable outA = outcome(a);
            Throwable outB = outcome(b);

            List<Throwable> failures = Stream.of(outA, outB).filter(Objects::nonNull).toList();
            assertThat(failures).hasSize(1);
            assertThat(failures.get(0)).isInstanceOf(ObjectOptimisticLockingFailureException.class);

            DeploymentState winnerTarget = (outA == null) ? DeploymentState.DEPLOYING : DeploymentState.FAILED;
            Deployment reloaded = deploymentRepository.findById(id).orElseThrow();
            assertThat(reloaded.getVersion()).isEqualTo(2L);        // one write, not two
            assertThat(reloaded.getStatus()).isEqualTo(winnerTarget);
        } finally {
            pool.shutdownNow();
        }
    }

    // ---- 3.2 -----------------------------------------------------------

    @Test
    void successfulTransition_incrementsVersion() {
        UUID id = seedPending();
        assertThat(deploymentRepository.findById(id).orElseThrow().getVersion()).isEqualTo(0L);

        tx.executeWithoutResult(s ->
                deploymentRepository.findById(id).orElseThrow().transitionTo(DeploymentState.VALIDATING));

        assertThat(deploymentRepository.findById(id).orElseThrow().getVersion()).isEqualTo(1L);
    }

    // ---- 3.3 -----------------------------------------------------------

    @Test
    void noOpTransaction_doesNotIncrementVersion() {
        UUID id = seedPending();

        tx.executeWithoutResult(s -> deploymentRepository.findById(id).orElseThrow());   // load, change nothing

        assertThat(deploymentRepository.findById(id).orElseThrow().getVersion()).isEqualTo(0L);
    }

    // ---- helpers -------------------------------------------------------

    private UUID seedPending() {
        return deploymentRepository.save(new Deployment(application, release, environment)).getId();
    }

    private UUID seedValidating() {
        UUID id = seedPending();
        tx.executeWithoutResult(s ->
                deploymentRepository.findById(id).orElseThrow().transitionTo(DeploymentState.VALIDATING));
        return id;
    }

    /** Load and barrier both stay INSIDE the transaction, or the loads may not overlap. */
    private Callable<Void> transitionTask(UUID id, DeploymentState target, CyclicBarrier barrier) {
        return () -> {
            tx.executeWithoutResult(s -> {
                Deployment d = deploymentRepository.findById(id).orElseThrow();
                await(barrier);                  // both loaded, neither written yet
                d.transitionTo(target);          // dirty, flushed at commit
            });                                  // commit: UPDATE ... WHERE version = ? runs here
            return null;
        };
    }

    private static void await(CyclicBarrier barrier) {
        try {
            barrier.await(5, TimeUnit.SECONDS);  // timeout: a dead peer fails the test instead of hanging it
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
            throw new IllegalStateException(e);
        } catch (BrokenBarrierException | TimeoutException e) {
            throw new IllegalStateException(e);
        }
    }

    /** null = task succeeded, otherwise the underlying exception. */
    private static Throwable outcome(Future<Void> f) throws InterruptedException {
        try {
            f.get(10, TimeUnit.SECONDS);
            return null;
        } catch (ExecutionException e) {
            return e.getCause();
        } catch (TimeoutException e) {
            throw new AssertionError("task hung", e);
        }
    }
}
```

Points that are easy to get wrong:

- `seedPending()` relies on `save` committing by itself. The Spring Data repository method runs in its own transaction, so no outer template is needed. Without a surrounding transaction the row is committed before the threads start.
- `tx.executeWithoutResult` needs Spring 5.2 or later. Spring Boot 3 is well past that.
- 3.2 and 3.3 assert `version == 0` after seeding. That relies on Hibernate initialising a `null` `Long` version to `0` on persist. `V3` also defaults the column to `0`, so both agree.
- Reload calls at the end of each test run outside any transaction. Only plain columns are read, so there is no `LazyInitializationException` risk.

## 4. Policy: fail, do not retry

Decision: **`Deployment` transitions fail fast on an optimistic-lock conflict. No automatic retry.** The S3 controller advice maps the exception to **409 Conflict** with a `ProblemDetail` body (the S3 checklist already lists "optimistic-lock" as a `ProblemDetail` case).

Reasoning:

- A transition is a *decision made on observed state*. Caller B chose `FAILED` because it saw `VALIDATING`. By the time B could retry, A has already moved the deployment to `DEPLOYING`. Silently re-reading and re-applying B's intent means acting on state B never saw.
- A blind retry does not even preserve B's intent: `DEPLOYING -> FAILED` is legal, so it would go through, which may or may not be what B wanted. The caller must decide with fresh data. That is what a 409 gives them.
- Retry is right for *commutative* writes: counters, heartbeats, last-seen timestamps. There, re-applying on fresh data loses nothing. Transitions are the opposite case.
- The state machine already protects the retry path. If a caller retries after a 409, the re-load sees the new state, and `transitionTo` either accepts or throws `IllegalStateException`. Both outcomes are correct and visible.

Where a bounded retry (say 3 attempts) *would* be acceptable later: internal, system-initiated transitions that always mean "the same target regardless of current state". None exist in S2. Revisit if S4/S6 introduces one.

## 5. Notes and risks

- **Boilerplate.** The Testcontainers block is now copied into three test classes. Extract an abstract base with a shared `static` container only if a fourth appears. Not part of this doc.
- **`currentStatus` is not updated by `transitionTo`, by design.** It is the S6 `AFTER_COMMIT` listener's cache, see [control-api-schema-3nf.md](control-api-schema-3nf.md). This test asserts on `status` only.
- **Thread failures.** Use `future.get(timeout)` with a short timeout, so a broken barrier fails the test rather than hanging the build.

## Definition of done

- [x] `DeploymentOptimisticLockTest` with 3.1, 3.2, 3.3 written and green against Testcontainers Postgres
- [x] Actual exception class and cause chain from 3.1 recorded in [control-api-s2-verification.md](control-api-s2-verification.md)
- [x] Policy in section 4 accepted; the observed exception (`ObjectOptimisticLockingFailureException`, direct cause) does not change the reasoning
- [x] Test passes 20 times in a row, to rule out flakiness from thread timing
