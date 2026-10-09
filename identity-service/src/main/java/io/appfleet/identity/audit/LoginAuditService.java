package io.appfleet.identity.audit;


import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.util.UUID;

@Service
public class LoginAuditService {


    private static final int EMAIL_MAX = 254;
    private static final int USER_AGENT_MAX = 256;
    private static final int SHORT_MAX = 64;

    private final LoginAuditRepository audits;

    public LoginAuditService(LoginAuditRepository audits) {
        this.audits = audits;
    }

    /**
     * REQUIRES_NEW: the row is committed on its own, whatever happens to the transaction around it. A refused sign-in
     * rolls its own transaction back; the audit of that very refusal must survive it. A password is never passed in.
     */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void record(AuditEvent event, LoginOutcome outcome, String email, UUID userId, ClientInfo client) {
        audits.save(new LoginAudit(event, outcome, cut(email, EMAIL_MAX), userId,
                cut(client.ip(), SHORT_MAX), cut(client.userAgent(), USER_AGENT_MAX), cut(client.correlationId(), SHORT_MAX)));
    }

    /** Same rule as record: its own transaction, so a refused exchange still leaves its row. The key is never passed in, only the account it belonged to. */
    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void recordServiceToken(LoginOutcome outcome, UUID serviceAccountId, ClientInfo client) {
        audits.save(LoginAudit.serviceToken(outcome, serviceAccountId,
                cut(client.ip(), SHORT_MAX), cut(client.userAgent(), USER_AGENT_MAX), cut(client.correlationId(), SHORT_MAX)));
    }

    private static String cut(String value, int max) {
        return value == null || value.length() <= max ? value : value.substring(0, max);
    }
}
