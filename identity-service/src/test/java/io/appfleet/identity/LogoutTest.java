package io.appfleet.identity;

import io.appfleet.identity.token.TokenHasher;
import io.appfleet.security.RedisJwtDenylist;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtException;
import tools.jackson.databind.JsonNode;

import java.net.http.HttpResponse;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class LogoutTest extends AuthHttpTest {

    @Autowired JwtDecoder decoder;
    @Autowired StringRedisTemplate redis;

    private JsonNode registerAndLogin(String email) throws Exception {
        register(email, PASSWORD);
        return body(login(email, PASSWORD));
    }

    private HttpResponse<String> logout(String refreshToken) throws Exception {
        return post("/api/v1/auth/logout", Map.of("refreshToken", refreshToken));
    }

    private HttpResponse<String> refresh(String refreshToken) throws Exception {
        return post("/api/v1/auth/refresh", Map.of("refreshToken", refreshToken));
    }

    private Map<String, Object> row(String token) {
        return jdbc.queryForMap("select * from refresh_token where token_hash = ?", TokenHasher.hash(token));
    }

    private int activeInFamily(String token) {
        return jdbc.queryForObject("select count(*) from refresh_token where family_id = ? and status = 'ACTIVE'",
                Integer.class, row(token).get("family_id"));
    }

    private void assertRevoked(String accessToken) {
        assertThatThrownBy(() -> decoder.decode(accessToken)).isInstanceOf(JwtException.class).hasMessageContaining("revoked");
    }

    // ---- the link remembers its access token --------------------------------------------------------------------

    @Test
    void login_recordsTheAccessTokenOnTheFirstLink() throws Exception {
        JsonNode login = registerAndLogin(uniqueEmail());
        Jwt jwt = decoder.decode(login.get("accessToken").asString());
        Map<String, Object> row = row(login.get("refreshToken").asString());
        assertThat(row.get("access_jti").toString()).isEqualTo(jwt.getId());
        Double secondsApart = jdbc.queryForObject("select abs(extract(epoch from (access_expires_at - to_timestamp(?)))) from refresh_token where token_hash = ?",
                Double.class, jwt.getExpiresAt().getEpochSecond(), TokenHasher.hash(login.get("refreshToken").asString()));
        assertThat(secondsApart).isLessThan(1.0);
    }

    @Test
    void refresh_recordsTheNewAccessTokenOnTheNewLink() throws Exception {
        JsonNode login = registerAndLogin(uniqueEmail());
        JsonNode refreshed = body(refresh(login.get("refreshToken").asString()));
        Jwt jwt = decoder.decode(refreshed.get("accessToken").asString());
        assertThat(row(refreshed.get("refreshToken").asString()).get("access_jti").toString()).isEqualTo(jwt.getId());
    }

    // ---- logout -------------------------------------------------------------------------------------------------

    @Test
    void logout_is204_andTheRefreshTokenStopsWorking() throws Exception {
        String refreshToken = registerAndLogin(uniqueEmail()).get("refreshToken").asString();
        HttpResponse<String> r = logout(refreshToken);
        assertThat(r.statusCode()).isEqualTo(204);
        assertThat(r.body()).isEmpty();
        assertThat(activeInFamily(refreshToken)).isZero();
        assertThat(refresh(refreshToken).statusCode()).isEqualTo(401);
    }

    @Test
    void logout_withAnUnknownToken_is204_andChangesNothing() throws Exception {
        String live = registerAndLogin(uniqueEmail()).get("refreshToken").asString();
        long before = jdbc.queryForObject("select count(*) from refresh_token where status = 'ACTIVE'", Long.class);
        assertThat(logout(TokenHasher.newToken()).statusCode()).isEqualTo(204);
        assertThat(jdbc.queryForObject("select count(*) from refresh_token where status = 'ACTIVE'", Long.class)).isEqualTo(before);
        assertThat(refresh(live).statusCode()).isEqualTo(200);
    }

    @Test
    void logout_withAnAlreadyUsedToken_stillEndsTheWholeFamily() throws Exception {
        String first = registerAndLogin(uniqueEmail()).get("refreshToken").asString();
        String second = body(refresh(first)).get("refreshToken").asString();
        assertThat(logout(first).statusCode()).isEqualTo(204);
        assertThat(refresh(second).statusCode()).as("the newest link died with the family").isEqualTo(401);
    }

    @Test
    void logout_leavesAnotherSessionOfTheSameUserAlone() throws Exception {
        String email = uniqueEmail();
        register(email, PASSWORD);
        JsonNode a = body(login(email, PASSWORD));
        JsonNode b = body(login(email, PASSWORD));
        logout(a.get("refreshToken").asString());
        assertThat(decoder.decode(b.get("accessToken").asString())).isNotNull();
        assertThat(refresh(b.get("refreshToken").asString()).statusCode()).isEqualTo(200);
    }

    // ---- the denylist -------------------------------------------------------------------------------------------

    @Test
    void logout_denylistsTheSessionsAccessToken() throws Exception {
        JsonNode login = registerAndLogin(uniqueEmail());
        String access = login.get("accessToken").asString();
        Jwt jwt = decoder.decode(access);                       // valid until the logout
        logout(login.get("refreshToken").asString());
        assertRevoked(access);

        long ttl = redis.getExpire(RedisJwtDenylist.KEY_PREFIX + jwt.getId(), TimeUnit.SECONDS);
        long remaining = jwt.getExpiresAt().getEpochSecond() - java.time.Instant.now().getEpochSecond();
        assertThat(ttl).as("lives as long as the token could still be accepted: exp + 60 s clock skew")
                .isBetween(remaining, remaining + 61);
    }

    @Test
    void logout_denylistsEveryUnexpiredAccessTokenOfTheFamily() throws Exception {
        JsonNode first = registerAndLogin(uniqueEmail());
        JsonNode second = body(refresh(first.get("refreshToken").asString()));
        JsonNode third = body(refresh(second.get("refreshToken").asString()));
        logout(third.get("refreshToken").asString());
        assertRevoked(first.get("accessToken").asString());
        assertRevoked(second.get("accessToken").asString());
        assertRevoked(third.get("accessToken").asString());
    }

    @Test
    void aNewLoginAfterLogout_isAFreshWorkingSession() throws Exception {
        String email = uniqueEmail();
        JsonNode old = registerAndLogin(email);
        logout(old.get("refreshToken").asString());
        JsonNode fresh = body(login(email, PASSWORD));
        assertThat(decoder.decode(fresh.get("accessToken").asString())).isNotNull();
        assertThat(refresh(fresh.get("refreshToken").asString()).statusCode()).isEqualTo(200);
    }

    @Test
    void aTokenOfAnotherUser_isNotAffected() throws Exception {
        JsonNode a = registerAndLogin(uniqueEmail());
        JsonNode b = registerAndLogin(uniqueEmail());
        logout(a.get("refreshToken").asString());
        assertThat(decoder.decode(b.get("accessToken").asString())).isNotNull();
    }

    // ---- validation ---------------------------------------------------------------------------------------------

    @Test
    void aBlankMissingOrHugeToken_is400() throws Exception {
        assertThat(logout("").statusCode()).isEqualTo(400);
        assertThat(post("/api/v1/auth/logout", Map.of()).statusCode()).isEqualTo(400);
        assertThat(logout("x".repeat(201)).statusCode()).isEqualTo(400);
    }

    @Test
    void get_onLogout_isRefused() throws Exception {
        assertThat(get("/api/v1/auth/logout").statusCode()).isEqualTo(401);
    }

    @Test
    void theTokensJtiIsAUuid() throws Exception {
        Jwt jwt = decoder.decode(registerAndLogin(uniqueEmail()).get("accessToken").asString());
        assertThat(UUID.fromString(jwt.getId())).isNotNull();
    }
}