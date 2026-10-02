package io.appfleet.control.deployment.web;

import io.appfleet.control.deployment.DeploymentState;

import java.util.UUID;

public record DeploymentAccepted(UUID deploymentId, UUID taskId, DeploymentState status) {
}
