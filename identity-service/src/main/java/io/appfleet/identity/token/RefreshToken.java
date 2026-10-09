package io.appfleet.identity.token;

import io.appfleet.identity.common.Uuidv7;
import io.appfleet.identity.user.AppUser;
import jakarta.persistence.*;

import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.UUID;

/**
 * One link of a refresh-token family. Only the SHA-256 of the token is stored, never the token. A link is used once:
 * rotating it marks it USED and creates its ACTIVE child in the same family.
 */
@Entity
@Table(name = "refresh_token")
public class RefreshToken {

    @Id
    private UUID id;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "user_id")
    private AppUser user;

    @Column(name = "family_id", nullable = false)
    private UUID familyId;

    @Column(name = "family_started_at")
    private Instant familyStartedAt;

    @Column(name = "parent_id")
    private UUID parentId;

    @Column(name = "token_hash", nullable = false, unique = true)
    private String tokenHash;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private RefreshStatus status;

    @Column(name = "issued_at", nullable = false)
    private Instant issuedAt;

    @Column(name = "expires_at", nullable = false)
    private Instant expiresAt;

    @Column(name = "used_at")
    private Instant usedAt;

    @Column(name = "revoked_at")
    private Instant revokedAt;

    /**
     * The access token issued together with this link; logging out denylists it.
     */
    @Column(name = "access_jti")
    private UUID accessJti;

    @Column(name = "access_expires_at")
    private Instant accessExpiresAt;

    protected RefreshToken() {}

    private RefreshToken(AppUser user, UUID familyId, Instant familyStartedAt, UUID parentId, String tokenHash,
                         Instant now, Duration ttl, Duration familyMaxLifetime) {
        this.id = Uuidv7.generate();
        this.user = user;
        this.familyId = familyId;
        this.familyStartedAt = familyStartedAt;
        this.parentId = parentId;
        this.tokenHash = tokenHash;
        this.status = RefreshStatus.ACTIVE;
        this.issuedAt = now.truncatedTo(ChronoUnit.MICROS);
        Instant slidingEnd = now.plus(ttl);
        Instant absoluteEnd = familyStartedAt.plus(familyMaxLifetime);
        this.expiresAt = (slidingEnd.isBefore(absoluteEnd) ? slidingEnd : absoluteEnd).truncatedTo(ChronoUnit.MICROS);
    }

    /**
     * The first link of a new family, issued at login.
     */
    public static RefreshToken startFamily(AppUser user, String tokenHash, Instant now, Duration ttl, Duration familyMaxLifetime) {
        Instant started = now.truncatedTo(ChronoUnit.MICROS);
        return new RefreshToken(user, Uuidv7.generate(), started, null, tokenHash, started, ttl, familyMaxLifetime);
    }

    /**
     * Uses this link up and returns its successor in the same family.
     */
    public RefreshToken rotate(String childHash, Instant now, Duration ttl, Duration familyMaxLifetime) {
        this.status = RefreshStatus.USED;
        this.usedAt = now.truncatedTo(ChronoUnit.MICROS);
        return new RefreshToken(user, familyId, familyStartedAt, id, childHash, now, ttl, familyMaxLifetime);
    }

    public boolean isExpiredAt(Instant now) {
        return !expiresAt.isAfter(now);
    }

    public void recordAccessToken(UUID jti, Instant expiresAt) {
        this.accessJti = jti;
        this.accessExpiresAt = expiresAt.truncatedTo(ChronoUnit.MICROS);
    }

    public UUID getId() {
        return id;
    }

    public AppUser getUser() {
        return user;
    }

    public UUID getFamilyId() {
        return familyId;
    }

    public UUID getParentId() {
        return parentId;
    }

    public RefreshStatus getStatus() {
        return status;
    }

    public Instant getExpiresAt() {
        return expiresAt;
    }

    public UUID getAccessJti() {
        return accessJti;
    }

    public Instant getAccessExpiresAt() {
        return accessExpiresAt;
    }
}