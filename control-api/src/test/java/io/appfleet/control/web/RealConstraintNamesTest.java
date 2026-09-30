package io.appfleet.control.web;

import io.appfleet.control.application.Application;
import io.appfleet.control.application.ApplicationRepository;
import io.appfleet.control.application.Release;
import io.appfleet.control.application.ReleaseRepository;
import io.appfleet.control.deployment.Deployment;
import io.appfleet.control.deployment.DeploymentRepository;
import io.appfleet.control.environment.Environment;
import io.appfleet.control.environment.EnvironmentRepository;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.test.context.ActiveProfiles;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.util.UUID;

import static org.assertj.core.api.AssertionsForClassTypes.catchThrowable;
import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest
@ActiveProfiles("test")
@Testcontainers
public class RealConstraintNamesTest {

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

    @Test
    void duplicateApplicationName_reportsUqApplicationName() {
        String name = "dup-" + UUID.randomUUID();
        applicationRepository.save(new Application(name, "d", UUID.randomUUID()));

        Throwable thrown = catchThrowable(() ->
                applicationRepository.save(new Application(name, "d", UUID.randomUUID())));

        assertThat(thrown).isInstanceOf(DataIntegrityViolationException.class);
        assertThat(constraintName(thrown)).isEqualTo("uq_application_name");
    }

    @Test
    void secondActiveDeploymentForSameAppAndEnv_reportsPartialIndexName() {
        Application app = applicationRepository.save(new Application("app-" + UUID.randomUUID(), "d", UUID.randomUUID()));
        Release release = releaseRepository.save(new Release(app, "v1", "s3://x", "c"));
        Environment env = environmentRepository.save(new Environment("env-" + UUID.randomUUID()));
        deploymentRepository.save(new Deployment(app, release, env));

        Throwable thrown = catchThrowable(() ->
                deploymentRepository.save(new Deployment(app, release, env)));

        assertThat(thrown).isInstanceOf(DataIntegrityViolationException.class);
        assertThat(constraintName(thrown)).isEqualTo("uq_deployment_active_per_app_env");
    }

    private static String constraintName(Throwable t) {
        for (Throwable c = t; c != null; c = c.getCause()) {
            if (c instanceof org.hibernate.exception.ConstraintViolationException cve) {
                return cve.getConstraintName();
            }
        }
        return null;
    }

}
