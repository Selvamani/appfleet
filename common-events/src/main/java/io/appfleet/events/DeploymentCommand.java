package io.appfleet.events;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.UUID;

public record DeploymentCommand(int schemaVersion, CommandType commandType, UUID idempotencyToken, UUID taskId,
                                UUID deploymentId, UUID applicationId, UUID releaseId, String environment,
                                String requestedBy, Instant requestedAt) {

    public static final int SCHEMA_VERSION = 1;

    public static DeploymentCommand of(CommandType commandType, UUID taskId, UUID deploymentId,
                                       UUID applicationId, UUID releaseId, String environment, String requestedBy) {
        return new DeploymentCommand(SCHEMA_VERSION, commandType, taskId, taskId, deploymentId,
                applicationId, releaseId, environment, requestedBy, Instant.now().truncatedTo(ChronoUnit.MILLIS));
    }
}

