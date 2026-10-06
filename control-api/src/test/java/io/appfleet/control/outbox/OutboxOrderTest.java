package io.appfleet.control.outbox;

import io.appfleet.control.config.AppfleetProperties;
import io.appfleet.control.ratelimit.RateLimitProperties;
import io.appfleet.events.CommandType;
import io.appfleet.events.DeploymentCommand;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.json.JsonMapper;

import java.time.Duration;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The advisory lock, not the row locks, is what stops a later row of a deployment from being
 * published before an earlier one. Batch size 1, so poller A locks only the first row and a poller without the
 * leader lock could take the second.
 */
class OutboxOrderTest extends OutboxIntegrationTest {

    @Autowired
    OutboxMessageRepository repository;
    @Autowired
    KafkaTemplate<String, String> kafka;
    @Autowired
    TransactionTemplate transaction;
    @Autowired
    JsonMapper json;

    private static AppfleetProperties batchOfOne() {
        return new AppfleetProperties("test", new RateLimitProperties(false, 60, 1.0),
                new OutboxProperties(true, TOPIC, 1, Duration.ofSeconds(1), Duration.ofSeconds(5), Duration.ofHours(24)));
    }

    private OutboxMessage pending(UUID aggregateId, CommandType type) {
        DeploymentCommand command = DeploymentCommand.of(type, UUID.randomUUID(), aggregateId,
                UUID.randomUUID(), UUID.randomUUID(), "staging", "test");
        return repository.saveAndFlush(new OutboxMessage(aggregateId, json.writeValueAsString(command)));
    }

    @Test
    void leaderLock_stopsALaterRowOvertaking() throws Exception {
        jdbc.update("delete from outbox_message where sent_at is null");      // only our two rows are pending
        UUID aggregate = UUID.randomUUID();
        OutboxMessage first = pending(aggregate, CommandType.DEPLOY);
        Thread.sleep(5);                                                       // distinct milliseconds: id order = creation order
        OutboxMessage second = pending(aggregate, CommandType.ROLLBACK);

        CountDownLatch aHoldsFirstRow = new CountDownLatch(1);
        CountDownLatch releaseA = new CountDownLatch(1);
        OutboxPoller a = new OutboxPoller(repository, kafka, transaction, json, batchOfOne()) {
            @Override
            protected void beforePublish(OutboxMessage message) {
                aHoldsFirstRow.countDown();                                    // A holds the leader lock and the first row
                try {
                    releaseA.await(10, TimeUnit.SECONDS);
                } catch (InterruptedException e) {
                    Thread.currentThread().interrupt();
                }
            }
        };
        OutboxPoller b = new OutboxPoller(repository, kafka, transaction, json, batchOfOne());

        ExecutorService pool = Executors.newSingleThreadExecutor();
        try {
            Future<?> aRun = pool.submit(a::pollOnce);
            assertThat(aHoldsFirstRow.await(10, TimeUnit.SECONDS)).isTrue();

            b.pollOnce();                                                      // with the leader lock B must publish nothing

            assertThat(consume(r -> aggregate.toString().equals(r.key()), 1, Duration.ofSeconds(3)))
                    .as("nothing for this deployment while A holds the first row").isEmpty();

            releaseA.countDown();
            aRun.get(10, TimeUnit.SECONDS);
            b.pollOnce();                                                      // now the second row
        } finally {
            releaseA.countDown();
            pool.shutdownNow();
        }

        List<ConsumerRecord<String, String>> records = consume(r -> aggregate.toString().equals(r.key()), 2, Duration.ofSeconds(10));
        assertThat(records).extracting(r -> header(r, "message-id"))
                .containsExactly(first.getId().toString(), second.getId().toString());
    }
}
