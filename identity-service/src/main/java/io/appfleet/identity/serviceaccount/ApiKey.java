package io.appfleet.identity.serviceaccount;


import io.appfleet.identity.common.Uuidv7;
import io.appfleet.identity.user.AppUser;
import jakarta.persistence.*;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.UUID;

/** One key of a service account. The key itself exists nowhere in the system after it was shown once; only its SHA-256 is stored. */
@Entity
@Table(name = "api_key")
public class ApiKey {

    @Id
    private UUID id;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "service_account_id")
    private ServiceAccount serviceAccount;

    @Column(nullable = false)
    private String prefix;

    @Column(name = "key_hash", nullable = false)
    private String keyHash;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private ApiKeyStatus status;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "created_by")
    private AppUser createdBy;

    @Column(name = "revoked_at")
    private Instant revokedAt;

    @Column(name = "last_used_at")
    private Instant lastUsedAt;

    protected ApiKey() {}

    public ApiKey(ServiceAccount serviceAccount, String prefix, String keyHash, AppUser createdBy) {
        this.id = Uuidv7.generate();
        this.serviceAccount = serviceAccount;
        this.prefix = prefix;
        this.keyHash = keyHash;
        this.status = ApiKeyStatus.ACTIVE;
        this.createdAt = Instant.now().truncatedTo(ChronoUnit.MICROS);
        this.createdBy = createdBy;
    }

    /** Calling it twice changes nothing. */
    public void revoke() {
        if (status == ApiKeyStatus.REVOKED) return;
        status = ApiKeyStatus.REVOKED;
        revokedAt = Instant.now().truncatedTo(ChronoUnit.MICROS);
    }

    public boolean isActive() {
        return status == ApiKeyStatus.ACTIVE;
    }

    public UUID getId() {
        return id;
    }

    public ServiceAccount getServiceAccount() {
        return serviceAccount;
    }

    public String getPrefix() {
        return prefix;
    }

    public String getKeyHash() {
        return keyHash;
    }

    public ApiKeyStatus getStatus() {
        return status;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public AppUser getCreatedBy() {
        return createdBy;
    }

    public Instant getRevokedAt() {
        return revokedAt;
    }

    public Instant getLastUsedAt() {
        return lastUsedAt;
    }


}
