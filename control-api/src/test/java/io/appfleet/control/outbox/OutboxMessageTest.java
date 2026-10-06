package io.appfleet.control.outbox;

import com.jayway.jsonpath.JsonPath;
import io.appfleet.control.web.WebIntegrationTest;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

/** Entity has never been saved. Does a String payload reach the jsonb column? */
class OutboxMessageTest extends WebIntegrationTest {

    @Autowired
    OutboxMessageRepository repository;

    @Test
    void outboxMessage_roundTripsThroughJpa() {
        UUID aggregateId = UUID.randomUUID();

        OutboxMessage saved = repository.saveAndFlush(
                new OutboxMessage(aggregateId, "{\"commandType\":\"DEPLOY\",\"schemaVersion\":1}"));

        OutboxMessage loaded = repository.findById(saved.getId()).orElseThrow();
        assertThat(loaded.getAggregateId()).isEqualTo(aggregateId);
        assertThat(loaded.getSentAt()).isNull();
        assertThat(loaded.getCreatedAt()).isNotNull();
        assertThat((String) JsonPath.read(loaded.getPayload(), "$.commandType")).isEqualTo("DEPLOY");

        // it really is jsonb in the database, not text: a jsonb operator works on it
        assertThat(jdbc.queryForObject("select payload ->> 'commandType' from outbox_message where id = ?",
                String.class, saved.getId())).isEqualTo("DEPLOY");
    }
}