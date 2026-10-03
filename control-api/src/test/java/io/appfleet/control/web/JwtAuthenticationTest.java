package io.appfleet.control.web;

import io.appfleet.security.testing.TestJwt;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.lifecycle.Startables;
import tools.jackson.databind.json.JsonMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.time.Duration;
import java.util.*;

import static org.assertj.core.api.Assertions.assertThat;

@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT)
@ActiveProfiles("test")
class JwtAuthenticationTest {

    @ServiceConnection
    static final PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:16").withUrlParam("currentSchema", "control");
    @ServiceConnection(name = "redis")
    static final GenericContainer<?> redis = new GenericContainer<>("redis:7").withExposedPorts(6379);
    static { Startables.deepStart(postgres, redis).join(); }

    /** Test 19: a throwaway endpoint nobody can reach. Method security is S4.3; here it only proves the 403 handler. */
    @TestConfiguration
    @EnableMethodSecurity
    static class ForbiddenEndpoint {
        @RestController
        static class C {
            @GetMapping("/api/v1/test-only/forbidden")
            @PreAuthorize("hasAuthority('nobody:has:this')")
            String forbidden() { return "unreachable"; }
        }
    }

    @Value("${local.server.port}") int port;

    private static final String APPS = "/api/v1/applications";
    private final HttpClient client = HttpClient.newHttpClient();
    private final JsonMapper json = new JsonMapper();

    private static TestJwt user() { return TestJwt.forUser(UUID.randomUUID()); }

    private HttpResponse<String> get(String path, String... headers) throws Exception {
        HttpRequest.Builder b = HttpRequest.newBuilder(URI.create("http://localhost:" + port + path)).GET();
        for (int i = 0; i < headers.length; i += 2) b.header(headers[i], headers[i + 1]);
        return client.send(b.build(), HttpResponse.BodyHandlers.ofString());
    }

    private HttpResponse<String> getWithToken(String path, String token) throws Exception {
        return get(path, "Authorization", "Bearer " + token);
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> body(HttpResponse<String> r) { return json.readValue(r.body(), Map.class); }

    private void assertUnauthorizedProblem(HttpResponse<String> r) {
        assertThat(r.statusCode()).isEqualTo(401);
        assertThat(r.headers().firstValue("Content-Type").orElse("")).startsWith("application/problem+json");
        assertThat(body(r)).containsEntry("type", "urn:appfleet:problem:unauthorized");
    }

    private String challenge(HttpResponse<String> r) { return r.headers().firstValue("WWW-Authenticate").orElse(""); }

    @Test void noToken_is401_withProblemShape() throws Exception {
        var r = get(APPS);
        assertUnauthorizedProblem(r);
        assertThat(body(r).get("correlationId")).isNotNull()
                .isEqualTo(r.headers().firstValue(CorrelationIdFilter.HEADER).orElse(null));
        assertThat(challenge(r)).isEqualTo("Bearer");            // a missing token carries no error=
    }

    @Test void validToken_passes() throws Exception {
        assertThat(getWithToken(APPS, user().team(UUID.randomUUID(), "application:read").sign()).statusCode()).isEqualTo(200);
    }

    @Test void wrongKey_is401_invalidToken() throws Exception {
        var r = getWithToken(APPS, user().wrongKey().sign());
        assertUnauthorizedProblem(r);
        assertThat(challenge(r)).contains("invalid_token");
    }

    @Test void expired_is401() throws Exception { assertUnauthorizedProblem(getWithToken(APPS, user().expired().sign())); }

    @Test void withinClockSkew_passes_beyondItFails() throws Exception {
        assertThat(getWithToken(APPS, user().expiresIn(Duration.ofSeconds(-30)).sign()).statusCode()).isEqualTo(200);
        assertThat(getWithToken(APPS, user().expiresIn(Duration.ofSeconds(-90)).sign()).statusCode()).isEqualTo(401);
    }

    @Test void notYetValid_is401() throws Exception { assertUnauthorizedProblem(getWithToken(APPS, user().notYetValid().sign())); }

    @Test void wrongIssuer_is401() throws Exception { assertUnauthorizedProblem(getWithToken(APPS, user().issuer("other").sign())); }

    @Test void wrongAudience_is401() throws Exception { assertUnauthorizedProblem(getWithToken(APPS, user().audience("other").sign())); }

    @Test void algNone_is401() throws Exception { assertUnauthorizedProblem(getWithToken(APPS, user().algNone().sign())); }

    @Test void hs256SignedWithThePublicKey_is401() throws Exception {
        assertUnauthorizedProblem(getWithToken(APPS, user().hs256WithPublicKeyAsSecret().sign()));
    }

    @Test void tamperedPayload_is401() throws Exception {
        String[] p = user().sign().split("\\.");
        char[] payload = p[1].toCharArray();
        payload[5] = payload[5] == 'A' ? 'B' : 'A';
        assertUnauthorizedProblem(getWithToken(APPS, p[0] + "." + new String(payload) + "." + p[2]));
    }

    @Test void basicScheme_is401_withoutError() throws Exception {
        var r = get(APPS, "Authorization", "Basic dXNlcjpwYXNz");
        assertUnauthorizedProblem(r);
        assertThat(challenge(r)).isEqualTo("Bearer");
    }

    @Test void malformedToken_is401() throws Exception {
        var r = getWithToken(APPS, "not-a-jwt");
        assertUnauthorizedProblem(r);
        assertThat(challenge(r)).contains("invalid_token");
    }

    @Test void detailNeverNamesTheFailure() throws Exception {
        Set<Object> details = new HashSet<>();
        Set<String> challenges = new HashSet<>();
        for (String t : List.of(user().wrongKey().sign(), user().expired().sign(),
                user().issuer("other").sign(), "not-a-jwt")) {
            var r = getWithToken(APPS, t);
            details.add(body(r).get("detail"));
            challenges.add(challenge(r));
            assertThat(r.body()).doesNotContain("expired", "signature", "iss claim", "aud claim");
        }
        assertThat(details).hasSize(1);
        assertThat(challenges).hasSize(1).first().asString().contains("invalid_token").doesNotContain("error_description");
    }

    @Test void twoAuthorizationHeaders_recorded() throws Exception {
        var r = get(APPS, "Authorization", "Bearer " + user().sign(), "Authorization", "Bearer " + user().wrongKey().sign());
        System.out.println("S4.1 two Authorization headers -> " + r.statusCode());
        assertThat(r.statusCode()).isLessThan(500);
    }

    @Test void healthAndInfoAreOpen_otherActuatorDenied() throws Exception {
        assertThat(get("/actuator/health").statusCode()).isEqualTo(200);
        assertThat(get("/actuator/info").statusCode()).isEqualTo(200);
        assertThat(get("/actuator/env").statusCode()).isIn(401, 403);
    }

    @Test void docsPathsAreOpen() throws Exception {
        assertThat(get("/v3/api-docs").statusCode()).isEqualTo(200);
        assertThat(get("/v3/api-docs/api-v1").statusCode()).isEqualTo(200);
        assertThat(get("/swagger-ui/index.html").statusCode()).isEqualTo(200);
    }

    @Test void unknownPath_is401WithoutToken_403WithOne() throws Exception {
        assertThat(get("/some/other/path").statusCode()).isEqualTo(401);
        assertThat(getWithToken("/some/other/path", user().sign()).statusCode()).isEqualTo(403);
    }

    @Test void tokenWithNoPermissions_authenticates() throws Exception {
        assertThat(getWithToken(APPS, user().sign()).statusCode()).isEqualTo(200);   // no authority check until S4.3
    }

    @Test void forbidden_hasProblemShape() throws Exception {
        var r = getWithToken("/api/v1/test-only/forbidden", user().team(UUID.randomUUID(), "application:read").sign());
        assertThat(r.statusCode()).isEqualTo(403);
        assertThat(r.headers().firstValue("Content-Type").orElse("")).startsWith("application/problem+json");
        assertThat(body(r)).containsEntry("type", "urn:appfleet:problem:forbidden");
        assertThat(body(r).get("correlationId")).isNotNull();
        assertThat(r.headers().firstValue("WWW-Authenticate")).isEmpty();
    }

    @Test void apiPath_withToken_reachesMvc_andReturnsOurProblemShape() throws Exception {
        var r = getWithToken("/api/v1/nope", user().sign());
        assertThat(r.statusCode()).isEqualTo(404);
        assertThat(r.body()).contains("urn:appfleet:problem:not-found").contains("correlationId");
    }
}
