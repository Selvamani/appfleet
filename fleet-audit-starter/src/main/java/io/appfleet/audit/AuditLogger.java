package io.appfleet.audit;

public interface AuditLogger {
    void record(AuditEvent event);
}
