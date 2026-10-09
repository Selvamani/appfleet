package io.appfleet.identity.audit;

import org.springframework.data.domain.Pageable;
import org.springframework.data.repository.Repository;

import java.util.List;
import java.util.UUID;

public interface LoginAuditRepository extends Repository<LoginAudit, UUID> {
    LoginAudit save(LoginAudit audit);
    /** Newest first, keyset by id (UUIDv7). There is still no update or delete method: the audit is append-only. */
    List<LoginAudit> findAllByOrderByIdDesc(Pageable page);
    List<LoginAudit> findByIdLessThanOrderByIdDesc(UUID cursor, Pageable page);
}
