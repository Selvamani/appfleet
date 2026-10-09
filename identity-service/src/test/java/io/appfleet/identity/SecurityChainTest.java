package io.appfleet.identity;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Value;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;

import static org.assertj.core.api.Assertions.assertThat;

/** Real HTTP: MockMvc would skip the filter chain. */
class SecurityChainTest extends IdentityIntegrationTest {

    @Value("${local.server.port}") int port;

    private final HttpClient client = HttpClient.newHttpClient();

    private int status(String path) throws Exception {
        HttpRequest request = HttpRequest.newBuilder(URI.create("http://localhost:" + port + path)).GET().build();
        return client.send(request, HttpResponse.BodyHandlers.ofString()).statusCode();
    }

    @Test
    void health_isOpen() throws Exception {
        assertThat(status("/actuator/health")).isEqualTo(200);
    }

    @Test
    void everythingElse_isRefused() throws Exception {
        assertThat(status("/actuator/env")).isEqualTo(401);
        assertThat(status("/api/v1/users/me")).isEqualTo(401);
        assertThat(status("/anything")).isEqualTo(401);
    }
}