package io.appfleet.control.outbox;

import com.jayway.jsonpath.JsonPath;
import io.appfleet.control.web.TestAuth;
import io.appfleet.control.web.TestFixtures;
import io.appfleet.control.web.WebIntegrationTest;
import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockHttpServletResponse;

import java.util.*;
import java.util.concurrent.*;

import static io.appfleet.control.deployment.DeploymentState.HEALTHY;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

/** The command is a row in the same transaction as the state change. */
class OutboxWriteTest extends WebIntegrationTest {

    private static final String DEPLOYMENTS = "/api/v1/deployments";

    private MockHttpServletResponse postDeployment(TestFixtures.Fixture f) throws Exception {
        String body = """
                  {"applicationId":"%s","releaseId":"%s","environment":"%s"}
                  """.formatted(f.app().getId(), f.release().getId(), f.env().getName());
        return mockMvc.perform(post(DEPLOYMENTS).contentType(MediaType.APPLICATION_JSON).content(body))
                .andReturn().getResponse();
    }

    private List<Map<String, Object>> rowsFor(Object aggregateId) {
        return jdbc.queryForList(
                "select id, payload::text as payload, sent_at from outbox_message where aggregate_id = ? order by id", aggregateId);
    }

    private static <T> T field(Map<String, Object> row, String path) {
        return JsonPath.read((String) row.get("payload"), path);
    }

    @Test
    void requestDeployment_writesOneOutboxMessage() throws Exception {
        TestFixtures.Fixture f = fixtures.fixture();

        MockHttpServletResponse r = postDeployment(f);

        assertThat(r.getStatus()).isEqualTo(202);
        UUID deploymentId = UUID.fromString(JsonPath.read(r.getContentAsString(), "$.deploymentId"));
        String taskId = JsonPath.read(r.getContentAsString(), "$.taskId");

        List<Map<String, Object>> rows = rowsFor(deploymentId);
        assertThat(rows).hasSize(1);
        Map<String, Object> row = rows.get(0);
        assertThat(row.get("sent_at")).isNull();
        assertThat((Integer) field(row, "$.schemaVersion")).isEqualTo(1);
        assertThat((String) field(row, "$.commandType")).isEqualTo("DEPLOY");
        assertThat((String) field(row, "$.taskId")).isEqualTo(taskId);
        assertThat((String) field(row, "$.idempotencyToken")).isEqualTo(taskId);
        assertThat((String) field(row, "$.deploymentId")).isEqualTo(deploymentId.toString());
        assertThat((String) field(row, "$.applicationId")).isEqualTo(f.app().getId().toString());
        assertThat((String) field(row, "$.releaseId")).isEqualTo(f.release().getId().toString());
        assertThat((String) field(row, "$.environment")).isEqualTo(f.env().getName());
        assertThat((String) field(row, "$.requestedBy")).isEqualTo(TestAuth.USER.toString());
        assertThat((String) field(row, "$.requestedAt")).isNotBlank();
    }

    @Test
    void requestRollback_writesOneOutboxMessage() throws Exception {
        UUID deploymentId = fixtures.deploymentFor(TestAuth.TEAM, HEALTHY).getId();

        MockHttpServletResponse r = mockMvc.perform(post(DEPLOYMENTS + "/" + deploymentId + "/rollback"))
                .andReturn().getResponse();

        assertThat(r.getStatus()).isEqualTo(202);
        String taskId = JsonPath.read(r.getContentAsString(), "$.taskId");
        List<Map<String, Object>> rows = rowsFor(deploymentId);
        assertThat(rows).hasSize(1);
        Map<String, Object> row = rows.get(0);
        assertThat((String) field(row, "$.commandType")).isEqualTo("ROLLBACK");
        assertThat((String) field(row, "$.taskId")).isEqualTo(taskId);
        assertThat((String) field(row, "$.idempotencyToken")).isEqualTo(taskId);
        assertThat((String) field(row, "$.deploymentId")).isEqualTo(deploymentId.toString());
        assertThat((String) field(row, "$.requestedBy")).isEqualTo(TestAuth.USER.toString());
        assertThat((String) field(row, "$.applicationId")).isEqualTo(
                jdbc.queryForObject("select application_id::text from deployment where id = ?", String.class, deploymentId));
    }

    @Test
    void rejectedRequests_writeNoMessage() throws Exception {
        long before = count("select count(*) from outbox_message");

        // 404: no such deployment
        assertThat(mockMvc.perform(post(DEPLOYMENTS + "/" + UUID.randomUUID() + "/rollback"))
                .andReturn().getResponse().getStatus()).isEqualTo(404);

        // 409: a PENDING deployment cannot be rolled back
        UUID pending = fixtures.deploymentFor(TestAuth.TEAM).getId();
        assertThat(mockMvc.perform(post(DEPLOYMENTS + "/" + pending + "/rollback"))
                .andReturn().getResponse().getStatus()).isEqualTo(409);

        // 422: the application does not exist
        String unknownApplication = """
                  {"applicationId":"%s","releaseId":"%s","environment":"nowhere"}
                  """.formatted(UUID.randomUUID(), UUID.randomUUID());
        assertThat(mockMvc.perform(post(DEPLOYMENTS).contentType(MediaType.APPLICATION_JSON).content(unknownApplication))
                .andReturn().getResponse().getStatus()).isEqualTo(422);

        assertThat(count("select count(*) from outbox_message")).isEqualTo(before);

        // 409 again: a second rollback while one is open adds no second message
        UUID healthy = fixtures.deploymentFor(TestAuth.TEAM, HEALTHY).getId();
        assertThat(mockMvc.perform(post(DEPLOYMENTS + "/" + healthy + "/rollback"))
                .andReturn().getResponse().getStatus()).isEqualTo(202);
        assertThat(mockMvc.perform(post(DEPLOYMENTS + "/" + healthy + "/rollback"))
                .andReturn().getResponse().getStatus()).isEqualTo(409);
        assertThat(rowsFor(healthy)).hasSize(1);
    }

    @Test
    void racingRollbacks_leaveExactlyOneMessage() throws Exception {
        UUID deploymentId = fixtures.deploymentFor(TestAuth.TEAM, HEALTHY).getId();
        int n = 2;
        CyclicBarrier barrier = new CyclicBarrier(n);
        Callable<Integer> call = () -> {
            barrier.await(5, TimeUnit.SECONDS);
            return mockMvc.perform(post(DEPLOYMENTS + "/" + deploymentId + "/rollback"))
                    .andReturn().getResponse().getStatus();
        };
        ExecutorService pool = Executors.newFixedThreadPool(n);
        List<Integer> statuses = new ArrayList<>();
        try {
            for (Future<Integer> f : pool.invokeAll(Collections.nCopies(n, call), 10, TimeUnit.SECONDS)) {
                statuses.add(f.get());
            }
        } finally {
            pool.shutdownNow();
        }

        assertThat(statuses).containsExactlyInAnyOrder(202, 409);
        assertThat(rowsFor(deploymentId)).hasSize(1);          // one winner, one message: the loser's row rolled back with it
    }
}
