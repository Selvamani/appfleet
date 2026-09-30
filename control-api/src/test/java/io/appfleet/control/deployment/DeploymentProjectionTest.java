package io.appfleet.control.deployment;

import io.appfleet.control.application.Application;
import io.appfleet.control.application.ApplicationRepository;
import io.appfleet.control.application.Release;
import io.appfleet.control.application.ReleaseRepository;
import io.appfleet.control.environment.Environment;
import io.appfleet.control.environment.EnvironmentRepository;
import org.junit.jupiter.api.BeforeAll;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.TestInstance;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
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

@SpringBootTest(properties = "logging.level.org.hibernate.SQL=DEBUG")
@ActiveProfiles("test")
@Testcontainers
@TestInstance(TestInstance.Lifecycle.PER_CLASS)
@ExtendWith(OutputCaptureExtension.class)
public class DeploymentProjectionTest {

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

    private Application application;
    private Release release;
    private Environment environment;

    @BeforeAll
    void setup() {
        application = applicationRepository.save(new Application("app-"+ UUID.randomUUID(), "desc", UUID.randomUUID()));
        release = releaseRepository.save(new Release(application, "v1.0.0", "s3://artifact.jar", "checksum"));
        environment = environmentRepository.save(new Environment("env-"+UUID.randomUUID()));
        deploymentRepository.save(new Deployment(application, release, environment));
    }

    @Test
    void listView_selectsOnlyProjectedColumns(CapturedOutput output) {
        UUID applicationId = application.getId();
        List<DeploymentListView> views = deploymentRepository.findByApplication_Id(applicationId);

        assertThat(views).hasSize(1);
        assertThat(views.get(0).getStatus()).isEqualTo(DeploymentState.PENDING);

        String sql = lastSelectFromDeployment(output.getAll());
        assertThat(sql).contains("id", "status", "current_status", "created_at");
        assertThat(sql).doesNotContain("release_id", "environment_id", "version", "updated_at");
    }

    private static String lastSelectFromDeployment(String log) {
        return log.lines()
                .filter(line -> line.contains("org.hibernate.SQL"))
                .map(line -> line.substring(line.indexOf(": ") + 2))      // drop the log prefix
                .filter(sql -> sql.startsWith("select") && sql.contains("from control.deployment"))
                .reduce((first, second) -> second)                         // keep the last one
                .orElseThrow(() -> new AssertionError("no select from control.deployment in log:\n" + log));
    }
}
