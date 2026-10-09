package io.appfleet.identity.audit;

import io.appfleet.identity.common.Uuidv7;
import jakarta.persistence.*;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.UUID;

/** One row of the append-only login audit. Never updated: the database refuses it. */
@Entity
@Table(name = "login_audit")
public class LoginAudit {

    @Id
    private UUID id;

    @Column(name = "occurred_at", nullable = false)
    private Instant occurredAt;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private AuditEvent event;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private LoginOutcome outcome;

    private String email;

    @Column(name = "user_id")
    private UUID userId;

    private String ip;

    @Column(name = "user_agent")
    private String userAgent;

    @Column(name = "correlation_id")
    private String correlationId;

    @Column(name = "service_account_id")
    private UUID serviceAccountId;

    protected LoginAudit() {}

    public LoginAudit(AuditEvent event, LoginOutcome outcome, String email, UUID userId, String ip, String userAgent, String correlationId) {
        this.id = Uuidv7.generate();
        this.occurredAt = Instant.now().truncatedTo(ChronoUnit.MICROS);
        this.event = event;
        this.outcome = outcome;
        this.email = email;
        this.userId = userId;
        this.ip = ip;
        this.userAgent = userAgent;
        this.correlationId = correlationId;
    }

   /** The exchange of an API key for a token (event SERVICE_TOKEN): no email, no user, but the account the key belongs to (null for an unknown key). */
   public static LoginAudit serviceToken(LoginOutcome outcome, UUID serviceAccountId, String ip, String userAgent, String correlationId) {
       LoginAudit a = new LoginAudit(AuditEvent.SERVICE_TOKEN, outcome, null, null, ip, userAgent, correlationId);
       a.serviceAccountId = serviceAccountId;
       return a;
   }


    public UUID getId() {
        return id;
    }

    public AuditEvent getEvent() {
        return event;
    }

    public LoginOutcome getOutcome() {
        return outcome;
    }

    public String getEmail() {
        return email;
    }

    public Instant getOccurredAt() {
        return occurredAt;
    }

    public UUID getUserId() {
        return userId;
    }

    public String getIp() {
        return ip;
    }

    public String getUserAgent() {
        return userAgent;
    }

    public String getCorrelationId() {
        return correlationId;
    }

    public UUID getServiceAccountId() {
        return serviceAccountId;
    }
}
