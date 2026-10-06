package io.appfleet.control.outbox;

import io.appfleet.control.config.AppfleetProperties;
import io.appfleet.events.DeploymentCommand;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.stereotype.Component;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.json.JsonMapper;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
import java.util.concurrent.ExecutionException;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.TimeoutException;

/**
 * Moves committed outbox rows to Kafka. One cycle is one transaction: take the leader lock, read the oldest
 * unsent rows, send each and wait for its acknowledgement, mark the acknowledged ones sent, commit.
 * Delivery is at least once: a crash between an acknowledgement and the commit sends that row again.
 */
@Component
public class OutboxPoller {

    private static final Logger log = LoggerFactory.getLogger(OutboxPoller.class);
    private static final long LEADER_LOCK_KEY = 7_450_001L;


    private final OutboxMessageRepository repository;
    private final KafkaTemplate<String, String> kafka;
    private final TransactionTemplate transaction;
    private final JsonMapper jsonMapper;
    private final OutboxProperties properties;

    public OutboxPoller(OutboxMessageRepository repository, KafkaTemplate<String, String> kafka, TransactionTemplate transaction, JsonMapper jsonMapper, AppfleetProperties appfleetProperties) {
        this.repository = repository;
        this.kafka = kafka;
        this.transaction = transaction;
        this.jsonMapper = jsonMapper;
        this.properties = appfleetProperties.outbox();
    }

    /**
     * One cycle. Never throws: a failed cycle is logged and retried by the next one.
     */
    public void pollOnce() {
        try {
            transaction.executeWithoutResult(status -> cycle());
        } catch (RuntimeException e) {
            log.warn("Outbox cycle failed, will retry: {}", e.toString());
        }
    }

    /**
     * Deletes rows sent before the cutoff. Pending rows are never deleted.
     */
    public int purgeSentBefore(Instant cutoff) {
        Integer deleted = transaction.execute(status -> repository.deleteSentBefore(cutoff));
        return deleted == null ? 0 : deleted;
    }

    /**
     * The scheduled purge: the retention is configured, 24 hours by default.
     */
    public void purgeOldSent() {
        try {
            purgeSentBefore(Instant.now().minus(properties.retention()));
        } catch (RuntimeException e) {
            log.warn("Outbox purge failed, will retry: {}", e.toString());
        }
    }

    /**
     * Test seam: called for each row after it is locked and before it is sent.
     */
    protected void beforePublish(OutboxMessage message) {
    }

    /**
     * Test seam: called inside the transaction after the batch, before the commit.
     */
    protected void beforeCommit() {
    }

    private void cycle() {
        if (!repository.tryLeaderLock(LEADER_LOCK_KEY)) {
            return;    // another instance is polling this cycle
        }
        List<OutboxMessage> pending = repository.lockPending(properties.batchSize());
        for (OutboxMessage message : pending) {
            beforePublish(message);
            if(!publish(message)) {
                break;
            }
            message.markSent();
        }
        beforeCommit();
    }

    private boolean publish(OutboxMessage message) {
        try {
            DeploymentCommand command = jsonMapper.readValue(message.getPayload(), DeploymentCommand.class);
            ProducerRecord<String, String> record = new ProducerRecord<>(
                    properties.topic(), message.getAggregateId().toString(), message.getPayload());
            record.headers().add("message-id", message.getId().toString().getBytes(StandardCharsets.UTF_8));
            record.headers().add("command-type", command.commandType().name().getBytes(StandardCharsets.UTF_8));
            kafka.send(record).get(properties.sendTimeout().toMillis(), TimeUnit.MILLISECONDS);
            return true;
        } catch (InterruptedException e) {
            log.warn("Outbox message {} not sent: interrupted", message.getId());
            return false;
        } catch (Exception e) {
            log.warn("Outbox message {} not sent: {}", message.getId(), e.toString());
            return false;
        }
    }
}