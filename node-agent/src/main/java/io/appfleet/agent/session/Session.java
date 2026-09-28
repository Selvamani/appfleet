package io.appfleet.agent.session;

import java.time.Instant;

public record Session(String id, String appImageId, String userId, String containerId, String nodeId, SessionState state, Instant startedAt, Instant lastAcitvityAt) {
}
