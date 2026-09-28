package io.appfleet.agent.runtime;

import java.time.Instant;

public record ContainerHandle(String containerId, String nodeId, String image, Instant startedAt) {
}
