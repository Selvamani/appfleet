package io.appfleet.control.deployment;

import java.util.UUID;

public record DeploymentSummary(UUID id, DeploymentState status, int taskCount) {
}
