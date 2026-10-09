package io.appfleet.identity;

import io.appfleet.identity.token.TokenHasher;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataAccessException;
import tools.jackson.databind.JsonNode;

import java.net.http.HttpResponse;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class LoginAuditTest extends AuthHttpTest {

    private List<Map<String, Object>> rows(String email) {
        return jdbc.queryForList("select * from login_audit where email = ? order by occurred_at, id", email);
    }

    private UUID userId(String email) {
        return jdbc.queryForObject("select id from app_user where email = ?", UUID.class, email);
    }

    @Test
    void aSuccessfulSignIn_leavesOneRow_withTheUserTheAddressTheAgentAndTheCorrelationId() throws Exception {
        String email = uniqueEmail();
        register(email, PASSWORD);
        HttpResponse<String> r = loginWithHeaders(email, PASSWORD, "User-Agent", "TestAgent/1.0");

        List<Map<String, Object>> rows = rows(email);
        assertThat(rows).hasSize(1);
        Map<String, Object> row = rows.get(0);
        assertThat(row.get("event")).isEqualTo("LOGIN");
        assertThat(row.get("outcome")).isEqualTo("SUCCESS");
        assertThat(row.get("user_id")).isEqualTo(userId(email));
        assertThat(row.get("user_agent")).isEqualTo("TestAgent/1.0");
        assertThat((String) row.get("ip")).isIn("127.0.0.1", "0:0:0:0:0:0:0:1");
        assertThat(row.get("correlation_id")).isEqualTo(r.headers().firstValue("X-Correlation-Id").orElseThrow());
    }

    /** The reason this needs REQUIRES_NEW: a refused sign-in rolls its own transaction back, and its audit row must not go with it. */
    @Test
    void aWrongPassword_stillLeavesItsRow_eventhoughTheLoginRolledBack() throws Exception {
        String email = uniqueEmail();
        register(email, PASSWORD);
        assertThat(login(email, "another correct horse").statusCode()).isEqualTo(401);
        List<Map<String, Object>> rows = rows(email);
        assertThat(rows).hasSize(1);
        assertThat(rows.get(0).get("outcome")).isEqualTo("BAD_CREDENTIALS");
        assertThat(rows.get(0).get("user_id")).isEqualTo(userId(email));
    }

    @Test
    void anUnknownEmail_leavesAnUnknownUserRow_withNoUserId() throws Exception {
        String email = uniqueEmail();
        login(email, PASSWORD);
        List<Map<String, Object>> rows = rows(email);
        assertThat(rows).hasSize(1);
        assertThat(rows.get(0).get("outcome")).isEqualTo("UNKNOWN_USER");
        assertThat(rows.get(0).get("user_id")).isNull();
    }

    @Test
    void aDeactivatedUser_leavesADeactivatedRow_whichTheCallerNeverSees() throws Exception {
        String email = uniqueEmail();
        register(email, PASSWORD);
        jdbc.update("update app_user set status = 'DEACTIVATED', deactivated_at = now() where email = ?", email);
        HttpResponse<String> r = login(email, PASSWORD);
        assertThat(r.statusCode()).isEqualTo(401);
        assertThat(r.body()).doesNotContainIgnoringCase("deactivated");
        assertThat(rows(email).get(0).get("outcome")).isEqualTo("DEACTIVATED");
    }

    @Test
    void aLockedAttempt_leavesALockedRow_afterTheFiveFailures() throws Exception {
        String email = uniqueEmail();
        register(email, PASSWORD);
        for (int i = 0; i < 5; i++) login(email, "another correct horse");
        assertThat(login(email, PASSWORD).statusCode()).isEqualTo(423);
        List<Map<String, Object>> rows = rows(email);
        assertThat(rows).hasSize(6);
        assertThat(rows.subList(0, 5)).allSatisfy(r -> assertThat(r.get("outcome")).isEqualTo("BAD_CREDENTIALS"));
        assertThat(rows.get(5).get("outcome")).isEqualTo("LOCKED");
        assertThat(rows.get(5).get("user_id")).isEqualTo(userId(email));
    }

    @Test
    void aRefreshTokenReuse_isAudited_withTheUser() throws Exception {
        String email = uniqueEmail();
        register(email, PASSWORD);
        String first = body(login(email, PASSWORD)).get("refreshToken").asString();
        post("/api/v1/auth/refresh", Map.of("refreshToken", first));
        assertThat(post("/api/v1/auth/refresh", Map.of("refreshToken", first)).statusCode()).isEqualTo(401);

        List<Map<String, Object>> reuse = jdbc.queryForList(
                "select * from login_audit where event = 'REFRESH_REUSE' and user_id = ?", userId(email));
        assertThat(reuse).hasSize(1);
        assertThat(reuse.get(0).get("outcome")).isEqualTo("REUSED");
        assertThat(reuse.get(0).get("email")).isNull();
        assertThat(jdbc.queryForObject("select count(*) from login_audit where event = 'REFRESH_REUSE' and user_id = ?", Integer.class, userId(email)))
                .as("an unknown or expired token is not a reuse").isEqualTo(1);
        assertThat(post("/api/v1/auth/refresh", Map.of("refreshToken", TokenHasher.newToken())).statusCode()).isEqualTo(401);
        assertThat(jdbc.queryForObject("select count(*) from login_audit where event = 'REFRESH_REUSE' and user_id = ?", Integer.class, userId(email))).isEqualTo(1);
    }

    @Test
    void oneRowPerAttempt() throws Exception {
        String email = uniqueEmail();
        register(email, PASSWORD);
        login(email, "another correct horse");
        login(email, PASSWORD);
        login(email, "yet another correct horse");
        assertThat(rows(email)).extracting(r -> r.get("outcome")).containsExactly("BAD_CREDENTIALS", "SUCCESS", "BAD_CREDENTIALS");
    }

    @Test
    void noPasswordIsEverStored() throws Exception {
        String email = uniqueEmail();
        register(email, PASSWORD);
        String wrong = "a-wrong-password-" + UUID.randomUUID();
        login(email, wrong);
        login(email, PASSWORD);
        String everything = rows(email).toString();
        assertThat(everything).doesNotContain(wrong).doesNotContain(PASSWORD);
    }

    @Test
    void theUserAgent_isCutAt256Characters() throws Exception {
        String email = uniqueEmail();
        register(email, PASSWORD);
        loginWithHeaders(email, PASSWORD, "User-Agent", "a".repeat(400));
        assertThat((String) rows(email).get(0).get("user_agent")).hasSize(256);
    }

    @Test
    void theEmail_isStoredAsTheNormalisedAddress() throws Exception {
        String email = uniqueEmail();
        register(email, PASSWORD);
        login("  " + email.toUpperCase() + " ", PASSWORD);
        assertThat(rows(email)).hasSize(1);
    }

    @Test
    void theAddressIsThePeer_notWhatTheClientClaimsInXForwardedFor() throws Exception {
        String email = uniqueEmail();
        register(email, PASSWORD);
        loginWithHeaders(email, PASSWORD, "X-Forwarded-For", "203.0.113.9");
        assertThat((String) rows(email).get(0).get("ip")).isNotEqualTo("203.0.113.9").isIn("127.0.0.1", "0:0:0:0:0:0:0:1");
    }

    @Test
    void theAudit_isAppendOnly_theDatabaseRefusesUpdateDeleteAndTruncate() throws Exception {
        String email = uniqueEmail();
        register(email, PASSWORD);
        login(email, PASSWORD);
        assertThatThrownBy(() -> jdbc.update("update login_audit set outcome = 'SUCCESS' where email = ?", email))
                .isInstanceOf(DataAccessException.class).hasMessageContaining("append-only");
        assertThatThrownBy(() -> jdbc.update("delete from login_audit where email = ?", email))
                .isInstanceOf(DataAccessException.class).hasMessageContaining("append-only");
        assertThatThrownBy(() -> jdbc.execute("truncate login_audit"))
                .isInstanceOf(DataAccessException.class).hasMessageContaining("append-only");
        assertThat(rows(email)).hasSize(1);
    }

    @Test
    void auditingDoesNotChangeWhatTheCallerSees() throws Exception {
        String known = uniqueEmail();
        register(known, PASSWORD);
        JsonNode wrong = body(login(known, "another correct horse"));
        JsonNode unknown = body(login(uniqueEmail(), "another correct horse"));
        assertThat(wrong.get("type")).isEqualTo(unknown.get("type"));
        assertThat(wrong.get("detail")).isEqualTo(unknown.get("detail"));
    }
}