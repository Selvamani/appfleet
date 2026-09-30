package io.appfleet.audit;


import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class Slf4jAuditLogger implements AuditLogger {

    private static final Logger log = LoggerFactory.getLogger(Slf4jAuditLogger.class);

    @Override
    public void record(AuditEvent event) {
        log.info("audit actor={} action={} targetType={} targetId={} occurredAt={} detail={} ",
                event.actor(), event.action(), event.targetType(), event.targetId(), event.occurredAt(), event.detail()
        );
    }
}
