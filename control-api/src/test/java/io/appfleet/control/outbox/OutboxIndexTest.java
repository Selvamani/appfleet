package io.appfleet.control.outbox;

import io.appfleet.control.web.WebIntegrationTest;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

/** Tthe poller reads unsent rows in id order; that must not be a primary-key walk with a filter. */
class OutboxIndexTest extends WebIntegrationTest {

    @Test
    void v6_createsThePartialPendingIndex() {
        String definition = jdbc.queryForObject(
                "select indexdef from pg_indexes where schemaname = 'control' and tablename = 'outbox_message' "
                        + "and indexname = 'idx_outbox_pending'",
                String.class);

        assertThat(definition).contains("(id)").contains("sent_at IS NULL");
    }
}
