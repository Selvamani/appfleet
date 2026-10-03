package io.appfleet.control.web;

import com.jayway.jsonpath.JsonPath;
import io.appfleet.control.deployment.web.CreateDeploymentRequest;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.extension.ExtendWith;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.system.CapturedOutput;
import org.springframework.boot.test.system.OutputCaptureExtension;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.boot.webmvc.test.autoconfigure.AutoConfigureMockMvc;
import org.springframework.context.annotation.Import;
import org.springframework.http.MediaType;
import org.springframework.jdbc.core.JdbcTemplate;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.util.StringUtils;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;
import tools.jackson.databind.json.JsonMapper;

import java.time.Duration;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

@SpringBootTest(properties = {
        "spring.data.redis.host=localhost",
        "spring.data.redis.port=1",                    // nothing listens here: Redis is "down"
        "management.health.redis.enabled=false",
        "appfleet.rate-limit.enabled=true"
})
@AutoConfigureMockMvc
@ActiveProfiles("test")
@Import({TestFixtures.class, TestAuth.class})
@Testcontainers
class IdempotencyRedisDownTest {

    // Own container and own context: nothing else shares this configuration, so the per-class
    // @Container lifecycle cannot leave a cached context pointing at a stopped container.
    @Container
    @ServiceConnection
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:16").withUrlParam("currentSchema", "control");

    private static final String URL = "/api/v1/deployments";
    private static final String PROBLEM = "urn:appfleet:problem:";

    @Autowired MockMvc mockMvc;
    @Autowired JdbcTemplate jdbc;
    @Autowired JsonMapper json;
    @Autowired TestFixtures fixtures;

    private MockHttpServletResponse send(CreateDeploymentRequest body, String key) throws Exception {
        var req = post(URL).contentType(MediaType.APPLICATION_JSON).content(json.writeValueAsString(body));
        if (key != null) {
            req.header("Idempotency-Key", key);
        }
        return mockMvc.perform(req).andReturn().getResponse();
    }

    private long deploymentsFor(CreateDeploymentRequest body) {
        return jdbc.queryForObject("select count(*) from deployment where application_id = ?", Long.class, body.applicationId());
    }

    @Test
    void withKey_redisDown_returns503Quickly_andCreatesNothing() throws Exception {
        CreateDeploymentRequest body = fixtures.fixture().request();

        long start = System.nanoTime();
        MockHttpServletResponse r = send(body, UUID.randomUUID().toString());
        Duration elapsed = Duration.ofNanos(System.nanoTime() - start);

        assertThat(r.getStatus()).isEqualTo(503);
        assertThat((String) JsonPath.read(r.getContentAsString(), "$.type")).isEqualTo(PROBLEM + "service-unavailable");
        assertThat(r.getHeader("Retry-After")).isEqualTo("5");
        assertThat(elapsed).isLessThan(Duration.ofSeconds(3));
        assertThat(deploymentsFor(body)).isZero();          // claim is the first Redis call: nothing executed
    }

    @Test
    void withoutKey_redisDown_stillWorks() throws Exception {
        CreateDeploymentRequest body = fixtures.fixture().request();
        assertThat(send(body, null).getStatus()).isEqualTo(202);
        assertThat(deploymentsFor(body)).isEqualTo(1);
    }

    @Test
    @ExtendWith(OutputCaptureExtension.class)
    void rateLimiter_redisDown_failsOpen(CapturedOutput output) throws Exception {
        MockHttpServletResponse r = mockMvc.perform(get("/api/v1/applications").param("limit", "1")
                .header("X-Team-Id", UUID.randomUUID().toString())).andReturn().getResponse();

        assertThat(r.getStatus()).isEqualTo(200);
        assertThat(StringUtils.countOccurrencesOf(output.getOut(), "Rate limiter unavailable")).isEqualTo(1);
    }
}
