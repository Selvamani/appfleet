package io.appfleet.control.outbox;

import io.appfleet.control.web.WebIntegrationTest;
import org.apache.kafka.clients.admin.Admin;
import org.apache.kafka.clients.admin.NewTopic;
import org.apache.kafka.clients.consumer.ConsumerConfig;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.apache.kafka.clients.consumer.ConsumerRecords;
import org.apache.kafka.clients.consumer.KafkaConsumer;
import org.apache.kafka.common.serialization.StringDeserializer;
import org.springframework.test.context.DynamicPropertyRegistry;
import org.springframework.test.context.DynamicPropertySource;
import org.testcontainers.kafka.KafkaContainer;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import java.util.UUID;
import java.util.function.Predicate;

/** Postgres and Redis from the base, plus a real Kafka (the compose image) started once per JVM. */
public abstract class OutboxIntegrationTest extends WebIntegrationTest {

    protected static final String TOPIC = "task.work";

    static final KafkaContainer kafka = new KafkaContainer("apache/kafka:3.8.0");

    static {
        kafka.start();
        try (Admin admin = Admin.create(Map.of("bootstrap.servers", kafka.getBootstrapServers()))) {
            admin.createTopics(List.of(new NewTopic(TOPIC, 6, (short) 1))).all().get();   // as in docker-compose: 6 partitions
        } catch (Exception e) {
            throw new IllegalStateException("could not create the topic " + TOPIC, e);
        }
    }

    @DynamicPropertySource
    static void kafkaProperties(DynamicPropertyRegistry registry) {
        registry.add("spring.kafka.bootstrap-servers", kafka::getBootstrapServers);
    }

    /** Reads the whole topic from the beginning with a fresh consumer group, keeps the records that match, waits up to {@code wait}. */
    protected List<ConsumerRecord<String, String>> consume(Predicate<ConsumerRecord<String, String>> keep, int expected, Duration wait) {
        Properties props = new Properties();
        props.put(ConsumerConfig.BOOTSTRAP_SERVERS_CONFIG, kafka.getBootstrapServers());
        props.put(ConsumerConfig.GROUP_ID_CONFIG, "test-" + UUID.randomUUID());
        props.put(ConsumerConfig.AUTO_OFFSET_RESET_CONFIG, "earliest");
        props.put(ConsumerConfig.KEY_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class.getName());
        props.put(ConsumerConfig.VALUE_DESERIALIZER_CLASS_CONFIG, StringDeserializer.class.getName());
        List<ConsumerRecord<String, String>> kept = new ArrayList<>();
        long deadline = System.nanoTime() + wait.toNanos();
        try (KafkaConsumer<String, String> consumer = new KafkaConsumer<>(props)) {
            consumer.subscribe(List.of(TOPIC));
            while (System.nanoTime() < deadline && kept.size() < expected) {
                ConsumerRecords<String, String> records = consumer.poll(Duration.ofMillis(300));
                records.forEach(r -> { if (keep.test(r)) kept.add(r); });
            }
        }
        return kept;
    }

    protected static String header(ConsumerRecord<String, String> record, String name) {
        var h = record.headers().lastHeader(name);
        return h == null ? null : new String(h.value(), java.nio.charset.StandardCharsets.UTF_8);
    }
}
