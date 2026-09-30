package io.appfleet.control.deployment;

import java.time.Instant;
import java.util.UUID;

public interface DeploymentListView {
    UUID getId();
    DeploymentState getStatus();
    DeploymentState getCurrentStatus();
    Instant getCreatedAt();
}
