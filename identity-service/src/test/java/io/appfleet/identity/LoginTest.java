package io.appfleet.identity;

import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

import java.net.http.HttpResponse;
import java.util.LinkedHashMap;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class LoginTest extends AuthHttpTest {

    @Test
    void login_returnsABearerTokenThatExpiresIn900Seconds_andIsNotCacheable() throws Exception {
        String email = uniqueEmail();
        register(email, PASSWORD);
        HttpResponse<String> r = login(email, PASSWORD);
        assertThat(r.statusCode()).isEqualTo(200);
        JsonNode b = body(r);
        assertThat(b.get("tokenType").asString()).isEqualTo("Bearer");
        assertThat(b.get("expiresIn").asLong()).isEqualTo(900);
        assertThat(b.get("accessToken").asString().split("\\.")).hasSize(3);
        assertThat(r.headers().firstValue("Cache-Control").orElse("")).contains("no-store");
        assertThat(r.headers().firstValue("Pragma").orElse("")).isEqualTo("no-cache");
        assertThat(b.get("refreshToken").asString()).as("a refresh token since I3").hasSize(43);
    }

    @Test
    void emailIsMatchedWithoutRegardToCaseAndSpaces() throws Exception {
        String email = uniqueEmail();
        register(email, PASSWORD);
        assertThat(login("  " + email.toUpperCase() + " ", PASSWORD).statusCode()).isEqualTo(200);
    }

    /** One message for three different reasons, so the response does not say which of them it was. */
    @Test
    void unknownUser_wrongPassword_andDeactivatedUser_areOneIndistinguishableAnswer() throws Exception {
        String known = uniqueEmail();
        register(known, PASSWORD);
        String deactivated = uniqueEmail();
        register(deactivated, PASSWORD);
        jdbc.update("update app_user set status = 'DEACTIVATED', deactivated_at = now() where email = ?", deactivated);

        Map<String, Object> unknown = withoutPerRequestFields(login(uniqueEmail(), PASSWORD));
        Map<String, Object> wrong = withoutPerRequestFields(login(known, "another correct horse"));
        Map<String, Object> off = withoutPerRequestFields(login(deactivated, PASSWORD));

        assertThat(unknown).containsEntry("status", 401).containsEntry("type", "urn:appfleet:problem:unauthorized");
        assertThat(wrong).isEqualTo(unknown);
        assertThat(off).isEqualTo(unknown);
    }

    @Test
    void aDeactivatedUserWithTheRightPassword_getsNoToken() throws Exception {
        String email = uniqueEmail();
        register(email, PASSWORD);
        jdbc.update("update app_user set status = 'DEACTIVATED', deactivated_at = now() where email = ?", email);
        HttpResponse<String> r = login(email, PASSWORD);
        assertThat(r.statusCode()).isEqualTo(401);
        assertThat(r.body()).doesNotContain("accessToken");
    }

    @Test
    void blankPassword_is400() throws Exception {
        HttpResponse<String> r = post("/api/v1/auth/login", Map.of("email", uniqueEmail(), "password", ""));
        assertThat(r.statusCode()).isEqualTo(400);
    }

    @Test
    void get_onLogin_isRefused() throws Exception {
        assertThat(get("/api/v1/auth/login").statusCode()).isEqualTo(401);
    }

    private Map<String, Object> withoutPerRequestFields(HttpResponse<String> r) {
        Map<String, Object> m = new LinkedHashMap<>(json.convertValue(body(r), Map.class));
        m.remove("correlationId");
        return m;
    }
}