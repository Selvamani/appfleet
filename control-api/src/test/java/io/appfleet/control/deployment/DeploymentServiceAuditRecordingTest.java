package io.appfleet.control.deployment;


import io.appfleet.control.application.Application;
import io.appfleet.control.application.ApplicationRepository;
import io.appfleet.control.application.Release;
import io.appfleet.control.application.ReleaseRepository;
import io.appfleet.control.audit.AuditEventRepository;
import io.appfleet.control.environment.Environment;
import io.appfleet.control.environment.EnvironmentRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.test.context.ActiveProfiles;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

@SpringBootTest
@ActiveProfiles("test")
@Testcontainers
public class DeploymentServiceAuditRecordingTest {

    @Container
    @ServiceConnection
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:16");

    @Autowired
    DeploymentService deploymentService;
    @Autowired
    ApplicationRepository applicationRepository;
    @Autowired
    ReleaseRepository releaseRepository;
    @Autowired
    EnvironmentRepository environmentRepository;
    @Autowired DeploymentRepository deploymentRepository;
    @Autowired
    AuditEventRepository auditEventRepository;

    private Application application;
    private Release release;
    private Environment environment;

    @BeforeEach
    void setup() {
        application = applicationRepository.save(new Application("app-"+ UUID.randomUUID(), "desc", UUID.randomUUID()));
        release = releaseRepository.save(new Release(application, "v1.0.0", "s3://artifact.jar", "checksum"));
        environment = environmentRepository.save(new Environment("env-"+UUID.randomUUID()));
    }

    @Disabled("deliberate bug — self-invocation bypasses the @Transactional proxy, REQUIRES_NEW never takes effect")
    @Test
    void createBroken_auditRowDoesNotSurviveRollback() {
        long deploymentsBefore = deploymentRepository.count();
        long auditBefore = auditEventRepository.count();
        assertThatThrownBy(() -> deploymentService.createBroken(application, release, environment, "tester")).isInstanceOf(IllegalStateException.class);
        assertThat(deploymentRepository.count()).isEqualTo(deploymentsBefore);
        assertThat(auditEventRepository.count()).isEqualTo(auditBefore);
    }

    @Test
    void create_auditRowSurvivesRollback() {
        long deploymentsBefore = deploymentRepository.count();
        long auditBefore = auditEventRepository.count();
        assertThatThrownBy(() -> deploymentService.create(application, release, environment, "tester")).isInstanceOf(IllegalStateException.class);
        assertThat(deploymentRepository.count()).isEqualTo(deploymentsBefore);
        assertThat(auditEventRepository.count()).isEqualTo(auditBefore+1);
    }

}
