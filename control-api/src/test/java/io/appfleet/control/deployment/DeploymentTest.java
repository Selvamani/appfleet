package io.appfleet.control.deployment;

import io.appfleet.control.application.Application;
import io.appfleet.control.application.Release;
import io.appfleet.control.environment.Environment;
import org.junit.jupiter.api.Test;

import java.util.UUID;
import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

public class DeploymentTest {

    private Deployment newDeployment() {
        Application application = new Application("checkout-service", "desc", UUID.randomUUID());
        Release release = new Release(application, "v1.0.0", "s3://artifact.jar", "checksum");
        Environment environment = new Environment("prod");
        return new Deployment(application, release, environment);
    }

    @Test
    void startsInPending() {
        Deployment deployment = newDeployment();
        assertThat(deployment.getStatus()).isEqualTo(DeploymentState.PENDING);
    }

    @Test
    void legalTransitionUpdatesStatusAndUpdatedAt() {
        Deployment deployment = newDeployment();
        var before = deployment.getUpdatedAt();

        deployment.transitionTo(DeploymentState.VALIDATING);

        assertThat(deployment.getStatus()).isEqualTo(DeploymentState.VALIDATING);
        assertThat(deployment.getUpdatedAt()).isAfterOrEqualTo(before);
    }

    @Test
    void illegalTransitionThrowsAndLeavesStatusUnchanged() {
        Deployment deployment = newDeployment();

        assertThatThrownBy(() -> deployment.transitionTo(DeploymentState.HEALTHY))
                .isInstanceOf(IllegalTransitionException.class)
                .hasMessageContaining(DeploymentState.PENDING.name())
                .hasMessageContaining(DeploymentState.HEALTHY.name());

        assertThat(deployment.getStatus()).isEqualTo(DeploymentState.PENDING);
    }

    @Test
    void terminalStatesRejectEveryTransition() {
        Deployment deploymentTest1 = newDeployment();
        deploymentTest1.transitionTo(DeploymentState.VALIDATING);
        deploymentTest1.transitionTo(DeploymentState.FAILED);

        for (DeploymentState target : DeploymentState.values()) {
            assertThatThrownBy(() -> deploymentTest1.transitionTo(target))
                    .isInstanceOf(IllegalTransitionException.class);
        }

        Deployment deploymentTest2 = newDeployment();
        deploymentTest2.transitionTo(DeploymentState.VALIDATING);
        deploymentTest2.transitionTo(DeploymentState.DEPLOYING);
        deploymentTest2.transitionTo(DeploymentState.HEALTHY);
        deploymentTest2.transitionTo(DeploymentState.ROLLED_BACK);

        for (DeploymentState target : DeploymentState.values()) {
            assertThatThrownBy(() -> deploymentTest2.transitionTo(target))
                    .isInstanceOf(IllegalTransitionException.class);
        }
    }


}
