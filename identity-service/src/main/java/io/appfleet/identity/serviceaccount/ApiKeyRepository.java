package io.appfleet.identity.serviceaccount;

import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.Repository;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface ApiKeyRepository extends Repository<ApiKey, UUID> {

    ApiKey save(ApiKey key);

    /** The prefix is the public half of a key and is unique: it names the one row to compare the hash with. */
    Optional<ApiKey> findByPrefix(String prefix);

    Optional<ApiKey> findByIdAndServiceAccount_Id(UUID id, UUID serviceAccountId);

    long countByServiceAccount_IdAndStatus(UUID serviceAccountId, ApiKeyStatus status);

    /** The keys of every account of one team in ONE select (the account id is the foreign key, no join to the account). */
    @Query("select k from ApiKey k where k.serviceAccount.team.id = :teamId order by k.createdAt")
    List<ApiKey> findByTeamId(@Param("teamId") UUID teamId);

    /**
     * Records the use of a key, but at most once per minute per key, so a busy service does not turn every token request
     * into a write. A bulk update clears the persistence context: call it last.
     */
    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Query("update ApiKey k set k.lastUsedAt = :now where k.id = :id and (k.lastUsedAt is null or k.lastUsedAt < :before)")
    int touch(@Param("id") UUID id, @Param("now") Instant now, @Param("before") Instant before);
}