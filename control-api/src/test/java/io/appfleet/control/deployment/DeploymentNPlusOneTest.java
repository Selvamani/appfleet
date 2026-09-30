package io.appfleet.control.deployment;

import io.appfleet.control.application.Application;
import io.appfleet.control.application.ApplicationRepository;
import io.appfleet.control.application.Release;
import io.appfleet.control.application.ReleaseRepository;
import io.appfleet.control.environment.Environment;
import io.appfleet.control.environment.EnvironmentRepository;
import io.appfleet.control.task.Task;
import io.appfleet.control.task.TaskRepository;
import jakarta.persistence.EntityManagerFactory;
import org.hibernate.SessionFactory;
import org.hibernate.stat.Statistics;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest
@ActiveProfiles("test")
@Testcontainers
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
public class DeploymentNPlusOneTest {

    @Container
    @ServiceConnection
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:16" );

    @Autowired
    ApplicationRepository applicationRepository;
    @Autowired
    ReleaseRepository releaseRepository;
    @Autowired
    EnvironmentRepository environmentRepository;
    @Autowired
    DeploymentRepository deploymentRepository;
    @Autowired
    TaskRepository taskRepository;
    @Autowired
    PlatformTransactionManager transactionManager;
    @Autowired
    EntityManagerFactory emf;

    static final int DEPLOYMENTS = 50;
    static final int TASKS_PER_DEPLOYMENT = 3;
    record Result(int deployments, int tasks) {}

    @BeforeAll
    void seed() {
        Environment environment = environmentRepository.save(new Environment("env-"+UUID.randomUUID()));
        for(int i=0; i<DEPLOYMENTS; i++) {
            Application application = applicationRepository.save(new Application("app-"+ i + "-" + UUID.randomUUID(), "desc", UUID.randomUUID()));
            Release release = releaseRepository.save(new Release(application, "v1.0.0", "s3://artifact.jar", "checksum"));
            Deployment deployment = deploymentRepository.save(new Deployment(application, release, environment));
            for(int t=0; t<TASKS_PER_DEPLOYMENT; t++) {
                taskRepository.save(new Task(deployment, "task-"+t));
            }
        }

    }

    private Statistics stats() {
        Statistics statistics = emf.unwrap(SessionFactory.class).getStatistics();
        statistics.setStatisticsEnabled(true);
        return statistics;
    }

    @Test
    @Disabled
    void naive_issuesOnePlusNStatements() {
        Statistics stats = stats();
        TransactionTemplate tx = new TransactionTemplate(transactionManager);
        tx.setReadOnly(true);

        stats.clear();
        Result result = tx.execute(status -> {
            List<Deployment> deployments = deploymentRepository.findAll();
            int n = 0;
            for(Deployment deployment : deployments) {
                n += deployment.getTasks().size();
            }
            return new Result(deployments.size(), n);
        });

        assertThat(result.deployments).isEqualTo(DEPLOYMENTS);
        assertThat(result.tasks).isEqualTo(DEPLOYMENTS*TASKS_PER_DEPLOYMENT);
        assertThat(stats.getPrepareStatementCount()).isEqualTo(51);
    }

    @Test
    void naive_issuesOnePlusNStatementsJoinFetch() {
        Statistics stats = stats();
        TransactionTemplate tx = new TransactionTemplate(transactionManager);
        tx.setReadOnly(true);

        stats.clear();
        Result result = tx.execute(status -> {
            List<Deployment> deployments = deploymentRepository.findAllWithTasksJoinFetch();
            int n = 0;
            for(Deployment deployment : deployments) {
                n += deployment.getTasks().size();
            }
            return new Result(deployments.size(), n);
        });

        assertThat(result.deployments).isEqualTo(DEPLOYMENTS);
        assertThat(result.tasks).isEqualTo(DEPLOYMENTS*TASKS_PER_DEPLOYMENT);
        assertThat(stats.getPrepareStatementCount()).isEqualTo(1);
    }

    @Test
    void naive_issuesOnePlusNStatementsEntityGraph() {
        Statistics stats = stats();
        TransactionTemplate tx = new TransactionTemplate(transactionManager);
        tx.setReadOnly(true);

        stats.clear();
        Result result = tx.execute(status -> {
            List<Deployment> deployments = deploymentRepository.findAllBy();
            int n = 0;
            for(Deployment deployment : deployments) {
                n += deployment.getTasks().size();
            }
            return new Result(deployments.size(), n);
        });

        assertThat(result.deployments).isEqualTo(DEPLOYMENTS);
        assertThat(result.tasks).isEqualTo(DEPLOYMENTS*TASKS_PER_DEPLOYMENT);
        assertThat(stats.getPrepareStatementCount()).isEqualTo(1);
    }

    @Test
    void naive_issuesOnePlusNStatementsBatch() {
        Statistics stats = stats();
        TransactionTemplate tx = new TransactionTemplate(transactionManager);
        tx.setReadOnly(true);

        stats.clear();
        Result result = tx.execute(status -> {
            List<Deployment> deployments = deploymentRepository.findAll();
            int n = 0;
            for(Deployment deployment : deployments) {
                n += deployment.getTasks().size();
            }
            return new Result(deployments.size(), n);
        });

        assertThat(result.deployments).isEqualTo(DEPLOYMENTS);
        assertThat(result.tasks).isEqualTo(DEPLOYMENTS*TASKS_PER_DEPLOYMENT);
        assertThat(stats.getPrepareStatementCount()).isEqualTo(3);
    }
}