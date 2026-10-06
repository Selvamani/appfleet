package io.appfleet.control.outbox;

import com.jayway.jsonpath.JsonPath;
import io.appfleet.control.web.TestAuth;
import io.appfleet.control.web.TestFixtures;
import org.apache.kafka.clients.consumer.ConsumerRecord;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.MediaType;

import java.time.Duration;
import java.util.List;
import java.util.UUID;

import static io.appfleet.control.deployment.DeploymentState.HEALTHY;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

class OutboxPollerTest extends OutboxIntegrationTest {

    private static final String DEPLOYMENTS = "/api/v1/deployments";

    @Autowired
    OutboxPoller poller;

    private UUID requestDeployment() throws Exception {
        TestFixtures.Fixture f = fixtures.fixture();
        String body = """
                  {"applicationId":"%s","releaseId":"%s","environment":"%s"}
                  """.formatted(f.app().getId(), f.release().getId(), f.env().getName());
        String response = mockMvc.perform(post(DEPLOYMENTS).contentType(MediaType.APPLICATION_JSON).content(body))
                .andReturn().getResponse().getContentAsString();
        return UUID.fromString(JsonPath.read(response, "$.deploymentId"));
    }

    @Test
    void poller_publishesAPendingMessage() throws Exception {
        UUID deploymentId = requestDeployment();

        poller.pollOnce();

        List<ConsumerRecord<String, String>> records =
                consume(r -> deploymentId.toString().equals(r.key()), 1, Duration.ofSeconds(10));
        assertThat(records).hasSize(1);
        ConsumerRecord<String, String> record = records.get(0);
        assertThat(record.key()).isEqualTo(deploymentId.toString());
        assertThat((String) JsonPath.read(record.value(), "$.commandType")).isEqualTo("DEPLOY");
        assertThat(header(record, "command-type")).isEqualTo("DEPLOY");

        UUID outboxId = jdbc.queryForObject("select id from outbox_message where aggregate_id = ?", UUID.class, deploymentId);
        assertThat(header(record, "message-id")).isEqualTo(outboxId.toString());
        assertThat(jdbc.queryForObject("select sent_at is not null from outbox_message where id = ?", Boolean.class, outboxId)).isTrue();
    }

    @Test
    void poller_keepsPerDeploymentOrder() throws Exception {
        UUID deploymentId = requestDeployment();
        fixtures.driveTo(deploymentId, HEALTHY);
        mockMvc.perform(post(DEPLOYMENTS + "/" + deploymentId + "/rollback")).andReturn();

        poller.pollOnce();

        List<ConsumerRecord<String, String>> records =
                consume(r -> deploymentId.toString().equals(r.key()), 2, Duration.ofSeconds(10));
        assertThat(records).hasSize(2);
        assertThat(records).extracting(r -> (String) JsonPath.read(r.value(), "$.commandType"))
                .containsExactly("DEPLOY", "ROLLBACK");
        assertThat(records.get(0).partition()).isEqualTo(records.get(1).partition());
    }
}
