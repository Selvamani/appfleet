package io.appfleet.identity.admin;

import io.appfleet.identity.admin.AdminDTOs.AuditRow;
import io.appfleet.identity.admin.AdminDTOs.PageOf;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.UUID;

/** The login audit holds email addresses and client addresses: platform administrators only. */
@RestController
@RequestMapping("/api/v1/audit/logins")
public class AuditController {

    private final AuditQueryService audit;

    public AuditController(AuditQueryService audit) {
        this.audit = audit;
    }

    @GetMapping
    @PreAuthorize("@guard.platformAdmin(authentication)")
    PageOf<AuditRow> list(@RequestParam(required = false) UUID cursor, @RequestParam(defaultValue = "50") int limit) {
        return audit.list(cursor, limit);
    }
}