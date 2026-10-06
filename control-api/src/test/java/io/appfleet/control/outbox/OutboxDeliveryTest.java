package io.appfleet.control.outbox;

import com.jayway.jsonpath.JsonPath;
import io.appfleet.control.config.AppfleetProperties;
import io.appfleet.control.ratelimit.RateLimitProperties;
import io.appfleet.control.web.TestFixtures;
import io.appfleet.events.CommandType;
import io.appfleet.events.DeploymentCommand;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.apache.kafka.clients.producer.ProducerConfig;
import org.apache.kafka.clients.producer.ProducerRecord;
import org.apache.kafka.common.serialization.StringSerializer;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.MediaType;
import org.springframework.kafka.core.DefaultKafkaProducerFactory;
import org.springframework.kafka.core.KafkaTemplate;
import org.springframework.kafka.core.ProducerFactory;
import org.springframework.kafka.support.SendResult;
import org.springframework.transaction.support.TransactionTemplate;
import tools.jackson.databind.json.JsonMapper;

import java.sql.Timestamp;
import java.time.Duration;
import java.time.Instant;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.Callable;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CyclicBarrier;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicBoolean;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

/** What the poller does when pollers race, the broker is down, a send fails or the process dies. */
class OutboxDeliveryTest extends OutboxIntegrationTest {

    @Autowired
    OutboxPoller poller;                       // the real bean: default batch size, the real Kafka
    @Autowired
    OutboxMessageRepository repository;
    @Autowired
    KafkaTemplate<String, String> kafka;
    @Autowired
    ProducerFactory<String, String> producerFactory;
    @Autowired
    TransactionTemplate transaction;
    @Autowired
    JsonMapper json;

    private static AppfleetProperties props(int batchSize) {
        return new AppfleetProperties("test", new RateLimitProperties(false, 60, 1.0),
                new OutboxProperties(true, TOPIC, batchSize, Duration.ofSeconds(1), Duration.ofSeconds(3), Duration.ofHours(24)));
    }

    private OutboxPoller newPoller(KafkaTemplate<String, String> template) {
        return new OutboxPoller(repository, template, transaction, json, props(100));
    }

    private void clearPending() {
        jdbc.update("delete from outbox_message where sent_at is null");
    }

    private OutboxMessage pending(UUID aggregateId, CommandType type) {
        DeploymentCommand command = DeploymentCommand.of(type, UUID.randomUUID(), aggregateId,
                UUID.randomUUID(), UUID.randomUUID(), "staging", "test");
        return repository.saveAndFlush(new OutboxMessage(aggregateId, json.writeValueAsString(command)));
    }

    private Instant sentAt(OutboxMessage message) {
        Timestamp sent = jdbc.queryForObject("select sent_at from outbox_message where id = ?", Timestamp.class, message.getId());
        return sent == null ? null : sent.toInstant();
    }

    private UUID requestDeployment() throws Exception {
        TestFixtures.Fixture f = fixtures.fixture();
        String body = """
                  {"applicationId":"%s","releaseId":"%s","environment":"%s"}
                  """.formatted(f.app().getId(), f.release().getId(), f.env().getName());
        var response = mockMvc.perform(post("/api/v1/deployments").contentType(MediaType.APPLICATION_JSON).content(body))
                .andReturn().getResponse();
        assertThat(response.getStatus()).isEqualTo(202);
        return UUID.fromString(JsonPath.read(response.getContentAsString(), "$.deploymentId"));
    }

    @Test
    void twoPollers_publishEachMessageOnce() throws Exception {
        clearPending();
        Set<String> keys = new HashSet<>();
        for (int i = 0; i < 50; i++) {
            UUID aggregate = UUID.randomUUID();
            keys.add(aggregate.toString());
            pending(aggregate, CommandType.DEPLOY);
        }
        OutboxPoller a = newPoller(kafka);
        OutboxPoller b = newPoller(kafka);
        CyclicBarrier barrier = new CyclicBarrier(2);
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            Callable<Void> runA = () -> { barrier.await(5, TimeUnit.SECONDS); a.pollOnce(); return null; };
            Callable<Void> runB = () -> { barrier.await(5, TimeUnit.SECONDS); b.pollOnce(); return null; };
            for (Future<Void> f : pool.invokeAll(List.of(runA, runB), 30, TimeUnit.SECONDS)) {
                f.get();
            }
        } finally {
            pool.shutdownNow();
        }

        List<ConsumerRecord<String, String>> records = consume(r -> keys.contains(r.key()), 51, Duration.ofSeconds(6));
        assertThat(records).hasSize(50);                                                   // 51 asked for: a duplicate would show
        assertThat(records.stream().map(r -> header(r, "message-id")).distinct()).hasSize(50);
        assertThat(count("select count(*) from outbox_message where sent_at is null")).isZero();
    }

    @Test
    void kafkaDown_requestStillSucceeds_andIsSentLater() throws Exception {
        clearPending();
        UUID deploymentId = requestDeployment();                                           // 202: the request path never touches Kafka

        Map<String, Object> dead = Map.of(
                ProducerConfig.BOOTSTRAP_SERVERS_CONFIG, "localhost:1",
                ProducerConfig.KEY_SERIALIZER_CLASS_CONFIG, StringSerializer.class,
                ProducerConfig.VALUE_SERIALIZER_CLASS_CONFIG, StringSerializer.class,
                ProducerConfig.MAX_BLOCK_MS_CONFIG, 1000,
                ProducerConfig.REQUEST_TIMEOUT_MS_CONFIG, 1000,
                ProducerConfig.DELIVERY_TIMEOUT_MS_CONFIG, 2000);
        OutboxPoller deadPoller = newPoller(new KafkaTemplate<>(new DefaultKafkaProducerFactory<String, String>(dead)));

        long started = System.nanoTime();
        deadPoller.pollOnce();                                                             // must not throw
        Duration took = Duration.ofNanos(System.nanoTime() - started);

        assertThat(took).as("a dead broker fails a cycle in seconds").isLessThan(Duration.ofSeconds(10));
        assertThat(count("select count(*) from outbox_message where aggregate_id = ? and sent_at is null", deploymentId)).isEqualTo(1);

        poller.pollOnce();                                                                 // the broker is back
        assertThat(consume(r -> deploymentId.toString().equals(r.key()), 1, Duration.ofSeconds(10))).hasSize(1);
        assertThat(count("select count(*) from outbox_message where aggregate_id = ? and sent_at is null", deploymentId)).isZero();
    }

    @Test
    void crashAfterSend_resendsTheMessage() throws Exception {
        clearPending();
        UUID aggregate = UUID.randomUUID();
        OutboxMessage row = pending(aggregate, CommandType.DEPLOY);
        AtomicBoolean crashed = new AtomicBoolean(false);
        OutboxPoller crashing = new OutboxPoller(repository, kafka, transaction, json, props(100)) {
            @Override
            protected void beforeCommit() {
                if (crashed.compareAndSet(false, true)) {
                    throw new IllegalStateException("the process dies after the send and before the commit");
                }
            }
        };

        crashing.pollOnce();                                                               // sent, then the transaction rolls back
        assertThat(sentAt(row)).as("still pending: the commit never happened").isNull();

        poller.pollOnce();                                                                 // the next cycle sends it again
        List<ConsumerRecord<String, String>> records = consume(r -> aggregate.toString().equals(r.key()), 3, Duration.ofSeconds(6));
        assertThat(records).hasSize(2);                                                    // at least once: a duplicate, by design
        assertThat(records).extracting(r -> header(r, "message-id")).containsOnly(row.getId().toString());
        assertThat(sentAt(row)).isNotNull();
    }

    @Test
    void failedSend_stopsTheBatch_inOrder() throws Exception {
        clearPending();
        UUID a1 = UUID.randomUUID();
        UUID a2 = UUID.randomUUID();
        UUID a3 = UUID.randomUUID();
        OutboxMessage r1 = pending(a1, CommandType.DEPLOY);
        Thread.sleep(5);
        OutboxMessage r2 = pending(a2, CommandType.DEPLOY);
        Thread.sleep(5);
        OutboxMessage r3 = pending(a3, CommandType.DEPLOY);
        KafkaTemplate<String, String> failingOnSecond = new KafkaTemplate<>(producerFactory) {
            @Override
            public CompletableFuture<SendResult<String, String>> send(ProducerRecord<String, String> record) {
                if (a2.toString().equals(record.key())) {
                    return CompletableFuture.failedFuture(new IllegalStateException("the broker refused the second message"));
                }
                return super.send(record);
            }
        };

        newPoller(failingOnSecond).pollOnce();

        assertThat(sentAt(r1)).as("sent before the failure").isNotNull();
        assertThat(sentAt(r2)).as("the failed row stays pending").isNull();
        assertThat(sentAt(r3)).as("the row behind it waits, in order").isNull();

        poller.pollOnce();                                                                 // a good cycle: row 2, then row 3
        assertThat(sentAt(r2)).isNotNull();
        assertThat(sentAt(r3)).isNotNull();
        assertThat(sentAt(r2)).isBeforeOrEqualTo(sentAt(r3));
    }

    @Test
    void purge_deletesOnlyOldSentRows() {
        clearPending();
        Instant now = Instant.now();
        UUID oldSent = insert(now.minus(Duration.ofDays(3)), now.minus(Duration.ofDays(2)));
        UUID recentSent = insert(now.minus(Duration.ofHours(3)), now.minus(Duration.ofHours(1)));
        UUID oldPending = insert(now.minus(Duration.ofDays(3)), null);

        int deleted = poller.purgeSentBefore(now.minus(Duration.ofHours(24)));

        assertThat(deleted).isEqualTo(1);
        assertThat(count("select count(*) from outbox_message where id = ?", oldSent)).isZero();
        assertThat(count("select count(*) from outbox_message where id = ?", recentSent)).isEqualTo(1);
        assertThat(count("select count(*) from outbox_message where id = ?", oldPending)).isEqualTo(1);
    }

    private UUID insert(Instant createdAt, Instant sentAt) {
        UUID id = UUID.randomUUID();
        jdbc.update("insert into outbox_message (id, aggregate_id, payload, created_at, sent_at) values (?, ?, '{}'::jsonb, ?, ?)",
                id, UUID.randomUUID(), Timestamp.from(createdAt), sentAt == null ? null : Timestamp.from(sentAt));
        return id;
    }

    @Test
    void producerIsConfiguredForReliability() {
        Map<String, Object> config = producerFactory.getConfigurationProperties();

        assertThat(String.valueOf(config.get("acks"))).isEqualTo("all");
        assertThat(String.valueOf(config.get("enable.idempotence"))).isEqualTo("true");
    }
}
