package io.appfleet.identity;

import org.junit.jupiter.api.Test;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.RestController;

import java.net.http.HttpResponse;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The meta-test the spec asks for: a protected endpoint really answers 403. If @EnableMethodSecurity is ever removed,
 * this is the test that fails (the handler would answer 200).
 */
class MethodSecurityHttpTest extends AuthHttpTest {

    @TestConfiguration
    static class ForbiddenEndpoint {
        @RestController
        static class C {
            @GetMapping("/api/v1/test-only/forbidden")
            @PreAuthorize("hasAuthority('nobody:has')")
            String forbidden() { return "unreachable"; }
        }
    }

    @Test
    void aProtectedEndpoint_answers403_forASignedInUserWithoutThePermission() throws Exception {
        String token = tokenFor(uniqueEmail());
        HttpResponse<String> r = send("GET", "/api/v1/test-only/forbidden", token, null);
        assertThat(r.statusCode()).as("403, not 200 (method security off) and not 500 (the handler swallowed it)").isEqualTo(403);
        assertThat(body(r).get("type").asString()).isEqualTo("urn:appfleet:problem:forbidden");
    }

    /** The chain used to refuse everything not named. A signed-in caller must not turn that into a 405 or a 500 on the auth paths. */
    @Test
    void aSignedInUser_usingTheWrongMethodOnAnAuthPath_is403() throws Exception {
        String token = tokenFor(uniqueEmail());
        assertThat(send("GET", "/api/v1/auth/login", token, null).statusCode()).isEqualTo(403);
        assertThat(send("DELETE", "/api/v1/auth/refresh", token, null).statusCode()).isEqualTo(403);
    }

    @Test
    void aProtectedEndpoint_answers401_withoutAToken() throws Exception {
        assertThat(send("GET", "/api/v1/test-only/forbidden", null, null).statusCode()).isEqualTo(401);
    }
}