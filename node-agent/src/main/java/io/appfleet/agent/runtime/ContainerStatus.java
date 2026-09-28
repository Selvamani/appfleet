package io.appfleet.agent.runtime;

import java.time.Instant;

public record ContainerStatus(String containerId, ContainerState state, String detail, Instant observedAt) {
}
