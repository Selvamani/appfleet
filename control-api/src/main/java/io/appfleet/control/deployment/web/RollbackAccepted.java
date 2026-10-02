package io.appfleet.control.deployment.web;

import java.util.UUID;

public record RollbackAccepted(UUID deploymentId, UUID taskId) {
}
