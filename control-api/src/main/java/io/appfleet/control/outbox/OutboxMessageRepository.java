package io.appfleet.control.outbox;

import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

public interface OutboxMessageRepository extends JpaRepository<OutboxMessage, UUID> {

    @Query(value = "select pg_try_advisory_xact_lock(:key)", nativeQuery = true)
    boolean tryLeaderLock(@Param("key") long key);

    @Query(value = """
            SELECT * FROM {h-schema}outbox_message
            WHERE sent_at IS NULL
            ORDER by id
            LIMIT :limit
              FOR UPDATE SKIP LOCKED
           """, nativeQuery = true)
    List<OutboxMessage> lockPending(@Param("limit") int limit);

    @Modifying
    @Query(value = "DELETE FROM {h-schema}outbox_message WHERE sent_at IS NOT NULL AND sent_at < :cutoff", nativeQuery = true)
    int deleteSentBefore(@Param("cutoff") Instant cutoff);
}
