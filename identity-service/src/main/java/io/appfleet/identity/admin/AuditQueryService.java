package io.appfleet.identity.admin;

import io.appfleet.identity.admin.AdminDTOs.AuditRow;
import io.appfleet.identity.admin.AdminDTOs.PageOf;
import io.appfleet.identity.audit.LoginAudit;
import io.appfleet.identity.audit.LoginAuditRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.UUID;

/** Reads the login audit, newest first. It only reads: the audit has no update or delete anywhere, not even here. */
@Service
public class AuditQueryService {

    private final LoginAuditRepository audits;

    public AuditQueryService(LoginAuditRepository audits) {
        this.audits = audits;
    }

    @Transactional(readOnly = true)
    public PageOf<AuditRow> list(UUID cursor, int limit) {
        var page = Paging.request(limit);
        var rows = cursor == null ? audits.findAllByOrderByIdDesc(page) : audits.findByIdLessThanOrderByIdDesc(cursor, page);
        return Paging.of(rows, limit, LoginAudit::getId, AuditQueryService::view);
    }

    private static AuditRow view(LoginAudit a) {
        return new AuditRow(a.getId(), a.getOccurredAt(), a.getEvent().name(), a.getOutcome().name(), a.getEmail(), a.getUserId(),
                a.getServiceAccountId(), a.getIp(), a.getUserAgent(), a.getCorrelationId());
    }
}