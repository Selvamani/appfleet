package io.appfleet.identity;

import io.appfleet.identity.token.TokenHasher;
import io.appfleet.security.RedisJwtDenylist;
import org.junit.jupiter.api.Test;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import tools.jackson.databind.JsonNode;

import java.time.Duration;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doNothing;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.when;

/** When Redis cannot be written, the logout fails as a whole: nothing is left half done on the refresh side. */
class LogoutRedisFailureTest extends AuthHttpTest {

    @MockitoBean RedisJwtDenylist denylist;

    @Test
    void ifTheDenylistWriteFails_theRevocationRollsBack_andTheLogoutCanBeRetried() throws Exception {
        when(denylist.clockSkew()).thenReturn(Duration.ofSeconds(60));
        String email = uniqueEmail();
        register(email, PASSWORD);
        JsonNode login = body(login(email, PASSWORD));
        String refreshToken = login.get("refreshToken").asString();

        doThrow(new IllegalStateException("redis down")).when(denylist).revoke(anyString(), any());
        assertThat(post("/api/v1/auth/logout", Map.of("refreshToken", refreshToken)).statusCode()).isEqualTo(500);
        assertThat(jdbc.queryForObject("select status from refresh_token where token_hash = ?", String.class, TokenHasher.hash(refreshToken)))
                .as("the database change was rolled back with the failed Redis write").isEqualTo("ACTIVE");

        doNothing().when(denylist).revoke(anyString(), any());
        assertThat(post("/api/v1/auth/logout", Map.of("refreshToken", refreshToken)).statusCode()).isEqualTo(204);
        assertThat(jdbc.queryForObject("select status from refresh_token where token_hash = ?", String.class, TokenHasher.hash(refreshToken)))
                .isEqualTo("REVOKED");
    }
}