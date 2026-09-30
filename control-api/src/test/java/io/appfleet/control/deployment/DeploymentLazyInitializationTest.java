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
import org.hibernate.LazyInitializationException;
import org.hibernate.SessionFactory;
import org.hibernate.stat.Statistics;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.context.ApplicationContext;
import org.springframework.orm.jpa.support.OpenEntityManagerInViewInterceptor;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.transaction.PlatformTransactionManager;
import org.springframework.transaction.support.TransactionTemplate;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

@SpringBootTest
@ActiveProfiles("test")
@Testcontainers
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
public class DeploymentLazyInitializationTest {

    @Container
    @ServiceConnection
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:16");

    static final int DEPLOYMENTS = 3;
    static final int TASKS_PER_DEPLOYMENT = 2;

    @Autowired
    DeploymentService deploymentService;
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
    @Autowired
    ApplicationContext context;

    @BeforeAll
    void seed() {
        Environment environment = environmentRepository.save(new Environment("env-" + UUID.randomUUID()));
        for (int i = 0; i < DEPLOYMENTS; i++) {
            Application application = applicationRepository.save(
                    new Application("app-" + i + "-" + UUID.randomUUID(), "desc", UUID.randomUUID()));
            Release release = releaseRepository.save(
                    new Release(application, "v1.0.0", "s3://artifact.jar", "checksum"));
            Deployment deployment = deploymentRepository.save(
                    new Deployment(application, release, environment));
            for (int t = 0; t < TASKS_PER_DEPLOYMENT; t++) {
                taskRepository.save(new Task(deployment, "task-" + t));
            }
        }
    }

    @Test
    void listAllNaive_touchingTasksOutsideTransaction_throws() {
        List<Deployment> deployments = deploymentService.listAllNaive();

        assertThatThrownBy(() -> deployments.get(0).getTasks().size())
                .isInstanceOf(LazyInitializationException.class);
    }

    @Test
    void entityGraph_tasksReadableAfterTransaction_butOtherAssociationsStillThrow() {
        List<Deployment> deployments = new TransactionTemplate(transactionManager).execute(status -> deploymentRepository.findAllBy());

        assertThat(deployments.get(0).getTasks()).hasSize(2);
        assertThatThrownBy(() -> deployments.get(0).getApplication().getName())
                .isInstanceOf(LazyInitializationException.class);
    }

    private Statistics stats() {
        Statistics statistics = emf.unwrap(SessionFactory.class).getStatistics();
        statistics.setStatisticsEnabled(true);
        return statistics;
    }

    @Test
    void listSummaries_worksOutsideTransaction_inOneStatement() {
        Statistics statistics = stats();
        statistics.clear();
        List<DeploymentSummary> summaries = deploymentService.listSummaries();

        assertThat(summaries).hasSize(3);
        assertThat(summaries).allSatisfy(summary -> assertThat(summary.taskCount()).isEqualTo(2));
        assertThat(stats().getPrepareStatementCount()).isEqualTo(1);
    }

    @Test
    void openInView_isDisabled() {
        assertThat(context.getBeansOfType(OpenEntityManagerInViewInterceptor.class)).isEmpty();
    }
}
