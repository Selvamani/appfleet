package io.appfleet.control.web;

import io.appfleet.security.testing.TestJwt;
import org.springframework.boot.test.context.TestConfiguration;
import org.springframework.boot.webmvc.test.autoconfigure.MockMvcBuilderCustomizer;
import org.springframework.context.annotation.Bean;
import org.springframework.http.HttpHeaders;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

@TestConfiguration(proxyBeanMethods = false)
public class TestAuth {

    public static final UUID USER = UUID.fromString("00000000-0000-0000-0000-0000000000a1");
    public static final UUID TEAM = UUID.fromString("00000000-0000-0000-0000-0000000000b1");

    public static final UUID TEAM_A = UUID.fromString("00000000-0000-0000-0000-00000000a0a0");
    public static final UUID TEAM_B = UUID.fromString("00000000-0000-0000-0000-00000000b0b0");

    public static final List<String> ALL_PERMISSIONS = List.of(
            "application:read", "application:create",
            "deployment:create", "deployment:rollback", "deployment:read");

    @Bean
    MockMvcBuilderCustomizer defaultAuthorization() {
        String header = "Bearer " + defaultToken();
        return builder -> builder.defaultRequest(get("/").header(HttpHeaders.AUTHORIZATION, header));
    }

    /** A token for a user who holds every permission on one team. Existing tests are about behaviour, not authorization. */
    public static String defaultToken() {
        return TestJwt.forUser(USER)
                .team(TEAM, "application:read", "application:create",
                        "deployment:create", "deployment:rollback", "deployment:read")
                .expiresIn(Duration.ofHours(12))      // outlives any test run; the context is cached per JVM
                .sign();
    }

    public static String tokenFor(UUID sub) {
        return TestJwt.forUser(sub)
                .team(TEAM, "application:read", "application:create",
                        "deployment:create", "deployment:rollback", "deployment:read")
                .expiresIn(Duration.ofHours(12))
                .sign();
    }

    /** A token for a fresh caller on one team, holding exactly these permissions and nothing else. */
    public static String tokenWith(String... permissions) {
        return TestJwt.forUser(UUID.randomUUID())
                .team(TEAM, permissions)
                .expiresIn(Duration.ofHours(12))
                .sign();
    }

    /** A token holding every permission except the one given. */
    public static String tokenWithout(String permission) {
        return tokenWith(ALL_PERMISSIONS.stream()
                .filter(p -> !p.equals(permission))
                .toArray(String[]::new));
    }


    /** A token for a given caller with exactly these permissions per team. */
    public static String tokenFor(UUID sub, Map<UUID, List<String>> teams) {
        TestJwt jwt = TestJwt.forUser(sub);
        teams.forEach((team, permissions) -> jwt.team(team, permissions.toArray(String[]::new)));
        return jwt.expiresIn(Duration.ofHours(12)).sign();
    }

    public static String tokenForTeams(Map<UUID, List<String>> teams) {
        return tokenFor(UUID.randomUUID(), teams);
    }

    /** Global permissions in `perms`, no team grants. */
    public static String tokenWithGlobalPerms(String... permissions) {
        return TestJwt.forUser(UUID.randomUUID()).perm(permissions).expiresIn(Duration.ofHours(12)).sign();
    }
}
