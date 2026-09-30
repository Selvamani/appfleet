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

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import java.util.List;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.*;
import java.util.stream.Stream;

@SpringBootTest
@ActiveProfiles("test")
@Testcontainers
public class DeploymentOptimisticLockTest {

    @Container
    @ServiceConnection
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:16");

    @Autowired
    ApplicationRepository applicationRepository;
    @Autowired
    ReleaseRepository releaseRepository;
    @Autowired
    EnvironmentRepository environmentRepository;
    @Autowired
    DeploymentRepository deploymentRepository;
    @Autowired
    PlatformTransactionManager transactionManager;

    private TransactionTemplate tx;
    private Application application;
    private Release release;
    private Environment environment;

    @BeforeEach
    void setup() {
        tx = new TransactionTemplate(transactionManager);
        application = applicationRepository.save(new Application("app-"+ UUID.randomUUID(), "desc", UUID.randomUUID()));
        release = releaseRepository.save(new Release(application, "v1.0.0", "s3://artifact.jar", "checksum"));
        environment = environmentRepository.save(new Environment("env-"+UUID.randomUUID()));
    }

    private UUID seedPending() {
        return deploymentRepository.save(new Deployment(application, release, environment)).getId();
    }

    private UUID seedValidating() {
        UUID id = seedPending();
        tx.executeWithoutResult(status -> deploymentRepository.findById(id).orElseThrow().transitionTo(DeploymentState.VALIDATING));
        return id;
    }

    @Test
    void twoConcurrentTransitions_exactlyOneWins() throws Exception {
        UUID id =  seedValidating();
        CyclicBarrier cyclicBarrier = new CyclicBarrier(2);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            Future<Void> pollA = pool.submit(transitionTask(id, DeploymentState.DEPLOYING, cyclicBarrier));
            Future<Void> pollB = pool.submit(transitionTask(id, DeploymentState.FAILED, cyclicBarrier));

            Throwable outA = outcome(pollA);
            Throwable outB = outcome(pollB);

            List<Throwable> failures = Stream.of(outA, outB).filter(Objects::nonNull).toList();
            assertThat(failures).hasSize(1);
            assertThat(failures.get(0)).isInstanceOf(ObjectOptimisticLockingFailureException.class);

            DeploymentState winnerTarget = outA == null ? DeploymentState.DEPLOYING : DeploymentState.FAILED;
            Deployment reloaded = deploymentRepository.findById(id).orElseThrow();
            assertThat(reloaded.getVersion()).isEqualTo(2L);
            assertThat(reloaded.getStatus()).isEqualTo(winnerTarget);
        } finally {
            pool.shutdownNow();
        }
    }

    private Callable<Void> transitionTask(UUID id, DeploymentState target, CyclicBarrier barrier) {
        return () -> {
            tx.executeWithoutResult(status -> {
                Deployment deployment = deploymentRepository.findById(id).orElseThrow();
                try {
                    barrier.await(5, TimeUnit.SECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                    throw new IllegalStateException(e);
                } catch (BrokenBarrierException | TimeoutException e) {
                    throw new IllegalStateException(e);
                }
                deployment.transitionTo(target);
            });
            return null;
        };
    }

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

    @Test
    void successfulTransition_incrementsVersion() {
        UUID id = seedPending();
        tx.executeWithoutResult(status -> deploymentRepository.findById(id).orElseThrow().transitionTo(DeploymentState.VALIDATING));
        assertThat(deploymentRepository.findById(id).orElseThrow().getVersion()).isEqualTo(1L);
    }

    @Test
    void noOpTransaction_doesNotIncrementVersion() {
        UUID id = seedPending();
        tx.executeWithoutResult(status -> deploymentRepository.findById(id).orElseThrow());
        assertThat(deploymentRepository.findById(id).orElseThrow().getVersion()).isEqualTo(0L);
    }

}
