package io.appfleet.control.web;

import io.appfleet.security.testing.TestJwt;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.test.context.ActiveProfiles;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.lifecycle.Startables;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

/** With appfleet.docs.public=false the OpenAPI document needs a valid token. Real HTTP, because MockMvc skips the chain. */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = "appfleet.docs.public=false")
@ActiveProfiles("test")
class DocsExposureTest {

    @ServiceConnection
    static final PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:16").withUrlParam("currentSchema", "control");
    @ServiceConnection(name = "redis")
    static final GenericContainer<?> redis = new GenericContainer<>("redis:7").withExposedPorts(6379);
    static { Startables.deepStart(postgres, redis).join(); }

    @Value("${local.server.port}") int port;

    private final HttpClient client = HttpClient.newHttpClient();

    private HttpResponse<String> get(String path, String... headers) throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create("http://localhost:" + port + path)).GET();
        for (int i = 0; i < headers.length; i += 2) b.header(headers[i], headers[i + 1]);
        return client.send(b.build(), HttpResponse.BodyHandlers.ofString());
    }

    @Test
    void apiDocs_withoutToken_are401InTheProblemShape() throws Exception {
        for (String path : new String[]{"/v3/api-docs", "/v3/api-docs/api-v1"}) {
            var r = get(path);
            assertThat(r.statusCode()).as(path).isEqualTo(401);
            assertThat(r.headers().firstValue("Content-Type").orElse("")).startsWith("application/problem+json");
            assertThat(r.headers().firstValue("WWW-Authenticate").orElse("")).isEqualTo("Bearer");
        }
    }

    @Test
    void apiDocs_withAnyValidToken_areServed() throws Exception {
        String token = TestJwt.forUser(UUID.randomUUID()).sign();   // no team, no permission: any valid token is enough
        assertThat(get("/v3/api-docs/api-v1", "Authorization", "Bearer " + token).statusCode()).isEqualTo(200);
    }
}
