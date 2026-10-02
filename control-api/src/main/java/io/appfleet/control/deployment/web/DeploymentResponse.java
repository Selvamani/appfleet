package io.appfleet.control.deployment.web;

import io.appfleet.control.deployment.Deployment;
import io.appfleet.control.deployment.DeploymentState;

import java.time.Instant;
import java.util.UUID;

public record DeploymentResponse(UUID id, UUID applicationId, UUID releaseId, String environment,
                                 DeploymentState status, Instant createdAt, Instant updatedAt) {
    public static DeploymentResponse from(Deployment deployment) {
       return new DeploymentResponse(deployment.getId(), deployment.getApplication().getId(),
               deployment.getRelease().getId(), deployment.getEnvironment().getName(), deployment.getStatus(), deployment.getCreatedAt(), deployment.getUpdatedAt());
    }
}
