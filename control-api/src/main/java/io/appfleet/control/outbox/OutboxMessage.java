package io.appfleet.control.outbox;

import io.appfleet.control.common.Uuidv7;
import jakarta.persistence.Column;
import jakarta.persistence.Entity;
import jakarta.persistence.Id;
import jakarta.persistence.Table;
import org.hibernate.annotations.JdbcTypeCode;
import org.hibernate.type.SqlTypes;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.UUID;

@Entity @Table(name = "outbox_message")
public class OutboxMessage {
    @Id
    private UUID id;

    @Column(name = "aggregate_id", nullable = false)
    private UUID aggregateId;

    @JdbcTypeCode(SqlTypes.JSON)
    @Column(columnDefinition = "jsonb", nullable = false)
    private String payload;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "sent_at")
    private Instant sentAt;

    protected OutboxMessage() {}

    public OutboxMessage(UUID aggregateId, String payload) {
        this.id = Uuidv7.generate();
        this.aggregateId = aggregateId;
        this.payload = payload;
        this.createdAt = Instant.now().truncatedTo(ChronoUnit.MICROS);
    }

    public void markSent() {
        this.sentAt = Instant.now().truncatedTo(ChronoUnit.MICROS);
    }

    public UUID getId() {
        return id;
    }

    public UUID getAggregateId() {
        return aggregateId;
    }

    public String getPayload() {
        return payload;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public Instant getSentAt() {
        return sentAt;
    }
}
