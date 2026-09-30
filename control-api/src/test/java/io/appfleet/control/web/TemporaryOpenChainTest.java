package io.appfleet.control.web;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.test.context.ActiveProfiles;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT,
        properties = "management.health.redis.enabled=false")
@ActiveProfiles("test")
@Testcontainers
class TemporaryOpenChainTest {

    @Container
    @ServiceConnection
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:16");

    @Value("${local.server.port}")
    int port;

    private final HttpClient client = HttpClient.newHttpClient();

    private HttpResponse<String> send(String method, String path, String body) throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create("http://localhost:" + port + path));
        if (body == null) {
            b.method(method, HttpRequest.BodyPublishers.noBody());
        } else {
            b.header("Content-Type", "application/json").method(method, HttpRequest.BodyPublishers.ofString(body));
        }
        return client.send(b.build(), HttpResponse.BodyHandlers.ofString());
    }

    @Test
    void apiPath_reachesMvc_andReturnsOurProblemShape() throws Exception {
        HttpResponse<String> r = send("GET", "/api/v1/nope", null);
        assertThat(r.statusCode()).isEqualTo(404);
        assertThat(r.headers().firstValue("Content-Type").orElse("")).contains("application/problem+json");
        assertThat(r.body()).contains("urn:appfleet:problem:not-found").contains("correlationId");
    }

    @Test
    void post_toApiPath_isNotBlockedByCsrf() throws Exception {
        assertThat(send("POST", "/api/v1/nope", "{}").statusCode()).isEqualTo(404);
    }

    @Test
    void health_isOpen() throws Exception {
        assertThat(send("GET", "/actuator/health", null).statusCode()).isEqualTo(200);
    }

    @Test
    void otherActuatorEndpoints_areNotOpen() throws Exception {
        assertThat(send("GET", "/actuator/env", null).statusCode()).isGreaterThanOrEqualTo(400);
    }
}
