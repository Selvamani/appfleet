package io.appfleet.identity.token;

import jakarta.persistence.LockModeType;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.Repository;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface RefreshTokenRepository extends Repository<RefreshToken, UUID> {

    RefreshToken save(RefreshToken token);

    /** Needed in RefreshTokenService.rotate: Hibernate writes inserts before updates, so the used link must be flushed first. */
    void flush();

    /** Locks the row until the transaction ends, so two requests with the same token are decided one after the other. */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    Optional<RefreshToken> findByTokenHash(String tokenHash);

    /** The access tokens issued by one family that the decoder could still accept (expiry within the cutoff or later). */
    @Query("select new io.appfleet.identity.token.AccessRef(t.accessJti, t.accessExpiresAt) from RefreshToken t "
            + "where t.familyId = :familyId and t.accessJti is not null and t.accessExpiresAt > :cutoff")
    List<AccessRef> findLiveAccessTokensOfFamily(@Param("familyId") UUID familyId, @Param("cutoff") Instant cutoff);

    @Query("select new io.appfleet.identity.token.AccessRef(t.accessJti, t.accessExpiresAt) from RefreshToken t "
            + "where t.user.id = :userId and t.accessJti is not null and t.accessExpiresAt > :cutoff")
    List<AccessRef> findLiveAccessTokensOfUser(@Param("userId") UUID userId, @Param("cutoff") Instant cutoff);

    /** Cuts off every ACTIVE link of every family of one user. */
    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Query("update RefreshToken t set t.status = io.appfleet.identity.token.RefreshStatus.REVOKED, t.revokedAt = :now "
            + "where t.user.id = :userId and t.status = io.appfleet.identity.token.RefreshStatus.ACTIVE")
    int revokeActiveForUser(@Param("userId") UUID userId, @Param("now") Instant now);

    /** Cuts off every link of the family that could still be used. USED links stay USED: they keep their history. */
    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Query("update RefreshToken t set t.status = io.appfleet.identity.token.RefreshStatus.REVOKED, t.revokedAt = :now "
            + "where t.familyId = :familyId and t.status = io.appfleet.identity.token.RefreshStatus.ACTIVE")
    int revokeActiveInFamily(@Param("familyId") UUID familyId, @Param("now") Instant now);
}