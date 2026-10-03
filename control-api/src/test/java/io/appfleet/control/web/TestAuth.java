package io.appfleet.control.web;

import io.appfleet.security.testing.TestJwt;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.webmvc.test.autoconfigure.MockMvcBuilderCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.http.HttpHeaders;

import java.time.Duration;
import java.util.UUID;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

@TestConfiguration(proxyBeanMethods = false)
public class TestAuth {

    public static final UUID USER = UUID.fromString("00000000-0000-0000-0000-0000000000a1");
    public static final UUID TEAM = UUID.fromString("00000000-0000-0000-0000-0000000000b1");

    /** A token for a user who holds every permission on one team. Existing tests are about behaviour, not authorization. */
    public static String defaultToken() {
        return TestJwt.forUser(USER)
                .team(TEAM, "application:read", "application:create",
                        "deployment:create", "deployment:rollback", "deployment:read")
                .expiresIn(Duration.ofHours(12))      // outlives any test run; the context is cached per JVM
                .sign();
    }

    @Bean
    MockMvcBuilderCustomizer defaultAuthorization() {
        String header = "Bearer " + defaultToken();
        return builder -> builder.defaultRequest(get("/").header(HttpHeaders.AUTHORIZATION, header));
    }
}
