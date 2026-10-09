package io.appfleet.identity;

import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

import java.net.http.HttpResponse;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/** GET and PUT /users/me and POST /users/me/password, over real HTTP with real tokens. */
class SelfServiceTest extends AuthHttpTest {

    private static final String ME = "/api/v1/users/me";
    private static final String NEW_PASSWORD = "another correct horse";

    private HttpResponse<String> changePassword(String token, String current, String next) throws Exception {
        return send("POST", ME + "/password", token, json.writeValueAsString(Map.of("currentPassword", current, "newPassword", next)));
    }

    private String errors(HttpResponse<String> r) {
        return body(r).get("errors").toString();
    }

    @Test
    void me_withoutAToken_is401_inTheProblemShape() throws Exception {
        HttpResponse<String> r = send("GET", ME, null, null);
        assertThat(r.statusCode()).isEqualTo(401);
        assertThat(body(r).get("type").asString()).isEqualTo("urn:appfleet:problem:unauthorized");
    }

    @Test
    void me_returnsTheProfileOfTheTokenSubject_withNoPasswordHash() throws Exception {
        String email = uniqueEmail();
        HttpResponse<String> r = send("GET", ME, tokenFor(email), null);
        assertThat(r.statusCode()).isEqualTo(200);
        JsonNode b = body(r);
        assertThat(b.get("email").asString()).isEqualTo(email);
        assertThat(b.get("displayName").asString()).isEqualTo("Test User");
        assertThat(b.get("status").asString()).isEqualTo("ACTIVE");
        assertThat(b.get("teams").size()).isZero();
        assertThat(r.body()).doesNotContain("password").doesNotContain("$2");
    }

    @Test
    void update_changesTheDisplayName_andTrimsIt() throws Exception {
        String token = tokenFor(uniqueEmail());
        HttpResponse<String> r = send("PUT", ME, token, json.writeValueAsString(Map.of("displayName", "  Ada Lovelace  ")));
        assertThat(r.statusCode()).isEqualTo(200);
        assertThat(body(r).get("displayName").asString()).isEqualTo("Ada Lovelace");
        assertThat(body(send("GET", ME, token, null)).get("displayName").asString()).isEqualTo("Ada Lovelace");
    }

    @Test
    void update_withABlankName_is400() throws Exception {
        HttpResponse<String> r = send("PUT", ME, tokenFor(uniqueEmail()), json.writeValueAsString(Map.of("displayName", "   ")));
        assertThat(r.statusCode()).isEqualTo(400);
        assertThat(errors(r)).contains("\"field\":\"displayName\"");
    }

    @Test
    void update_cannotTouchAnotherUser_becauseTheIdNeverComesFromTheRequest() throws Exception {
        String other = uniqueEmail();
        String otherToken = tokenFor(other);
        String token = tokenFor(uniqueEmail());
        send("PUT", ME, token, json.writeValueAsString(Map.of("displayName", "Mallory", "id", "00000000-0000-0000-0000-000000000000", "email", other)));
        assertThat(body(send("GET", ME, otherToken, null)).get("displayName").asString()).isEqualTo("Test User");
    }

    @Test
    void aTokenOfADeactivatedUser_is401_evenWhileItIsStillValid() throws Exception {
        String email = uniqueEmail();
        String token = tokenFor(email);
        jdbc.update("update app_user set status = 'DEACTIVATED', deactivated_at = now() where email = ?", email);
        assertThat(send("GET", ME, token, null).statusCode()).isEqualTo(401);
    }

    @Test
    void changePassword_endsEverySession_andOnlyTheNewPasswordWorks() throws Exception {
        String email = uniqueEmail();
        register(email, PASSWORD);
        JsonNode session = body(login(email, PASSWORD));
        String access = session.get("accessToken").asString();
        String refresh = session.get("refreshToken").asString();

        assertThat(changePassword(access, PASSWORD, NEW_PASSWORD).statusCode()).isEqualTo(204);

        assertThat(send("GET", ME, access, null).statusCode()).as("the access token in use is denylisted").isEqualTo(401);
        assertThat(post("/api/v1/auth/refresh", Map.of("refreshToken", refresh)).statusCode()).as("the refresh token is revoked").isEqualTo(401);
        assertThat(login(email, PASSWORD).statusCode()).as("the old password").isEqualTo(401);
        assertThat(login(email, NEW_PASSWORD).statusCode()).as("the new password").isEqualTo(200);
    }

    @Test
    void changePassword_withAWrongCurrentPassword_is400_andLeavesTheSessionAlone() throws Exception {
        String token = tokenFor(uniqueEmail());
        HttpResponse<String> r = changePassword(token, "not the password", NEW_PASSWORD);
        assertThat(r.statusCode()).isEqualTo(400);
        assertThat(errors(r)).contains("\"field\":\"currentPassword\"");
        assertThat(send("GET", ME, token, null).statusCode()).isEqualTo(200);
    }

    @Test
    void guessingTheCurrentPassword_withAStolenToken_runsIntoTheSameLockoutAsTheLogin() throws Exception {
        String email = uniqueEmail();
        String token = tokenFor(email);
        for (int i = 0; i < 5; i++) assertThat(changePassword(token, "guess number " + i + " here", NEW_PASSWORD).statusCode()).isEqualTo(400);
        HttpResponse<String> locked = changePassword(token, PASSWORD, NEW_PASSWORD);
        assertThat(locked.statusCode()).as("locked, also with the right current password").isEqualTo(423);
        assertThat(locked.headers().firstValue("Retry-After")).isPresent();
        assertThat(login(email, PASSWORD).statusCode()).as("the same counter locks the sign-in too").isEqualTo(423);
    }

    @Test
    void changePassword_refusesWeakPasswords_withTheRuleNotThePassword() throws Exception {
        String email = uniqueEmail();
        String token = tokenFor(email);

        HttpResponse<String> common = changePassword(token, PASSWORD, "Password123456");
        assertThat(common.statusCode()).isEqualTo(400);
        assertThat(errors(common)).contains("\"field\":\"newPassword\"").contains("common passwords").doesNotContain("Password123456");

        String localPart = email.substring(0, email.indexOf('@'));
        HttpResponse<String> fromEmail = changePassword(token, PASSWORD, "x" + localPart + "x");
        assertThat(fromEmail.statusCode()).isEqualTo(400);
        assertThat(errors(fromEmail)).contains("email address");

        HttpResponse<String> same = changePassword(token, PASSWORD, PASSWORD);
        assertThat(same.statusCode()).isEqualTo(400);
        assertThat(errors(same)).contains("must differ");

        HttpResponse<String> tooLong = changePassword(token, PASSWORD, "é".repeat(40));   // 40 characters, 80 bytes
        assertThat(tooLong.statusCode()).isEqualTo(400);
        assertThat(errors(tooLong)).contains("\"field\":\"newPassword\"").contains("72 bytes");

        assertThat(changePassword(token, PASSWORD, "short").statusCode()).as("below 12 characters").isEqualTo(400);
        assertThat(send("GET", ME, token, null).statusCode()).as("nothing above ended the session").isEqualTo(200);
    }

    @Test
    void registration_usesTheSamePolicy() throws Exception {
        HttpResponse<String> r = register(uniqueEmail(), "iloveyou1234");
        assertThat(r.statusCode()).isEqualTo(400);
        assertThat(errors(r)).contains("\"field\":\"password\"").contains("common passwords");
    }
}