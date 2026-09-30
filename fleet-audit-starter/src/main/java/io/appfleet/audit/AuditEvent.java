package io.appfleet.audit;

import java.time.Instant;

public record AuditEvent(String actor, String action, String targetType, String targetId, String detail, Instant occurredAt) {
}
