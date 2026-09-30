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
public class DeploymentServiceRollbackTest {

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

    private Application application;
    private Release release;
    private Environment environment;

    @BeforeEach
    void setUp() {
        application = applicationRepository.save(
                new Application("app-" + UUID.randomUUID(), "desc", UUID.randomUUID()));
        release = releaseRepository.save(
                new Release(application, "v1.0.0", "s3://artifact.jar", "checksum"));
        environment = environmentRepository.save(
                new Environment("env-" + UUID.randomUUID()));
    }

    @Test
    void createRiskyDefault_commitsDespiteCheckedException() {
        long before = deploymentRepository.count();
        assertThatThrownBy(() -> deploymentService.createRiskyDefault(application, release, environment)).isInstanceOf(DeploymentValidationException.class);
        assertThat(deploymentRepository.count()).isEqualTo(before+1);
    }

    @Test
    void createRiskySafe_rollsBackOnCheckedException() {
        long before = deploymentRepository.count();
        assertThatThrownBy(() -> deploymentService.createRiskySafe(application, release, environment)).isInstanceOf(DeploymentValidationException.class);
        assertThat(deploymentRepository.count()).isEqualTo(before);
    }
}
