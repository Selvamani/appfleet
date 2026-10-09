package io.appfleet.identity;

import org.junit.jupiter.api.Test;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import tools.jackson.databind.JsonNode;

import java.net.http.HttpResponse;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class RegisterTest extends AuthHttpTest {

    @Test
    void register_is201_andTheBodyHasNoPasswordField() throws Exception {
        String email = uniqueEmail();
        HttpResponse<String> r = register(email, PASSWORD);
        assertThat(r.statusCode()).isEqualTo(201);
        JsonNode b = body(r);
        assertThat(b.get("email").asString()).isEqualTo(email);
        assertThat(b.get("id").asString()).isNotBlank();
        assertThat(b.has("password")).isFalse();
        assertThat(b.has("passwordHash")).isFalse();
        assertThat(r.body()).doesNotContain(PASSWORD);
    }

    @Test
    void email_isStoredLowerCase() throws Exception {
        String lower = uniqueEmail();
        HttpResponse<String> r = register(lower.toUpperCase(), PASSWORD);
        assertThat(r.statusCode()).isEqualTo(201);
        assertThat(body(r).get("email").asString()).isEqualTo(lower);
        assertThat(jdbc.queryForObject("select count(*) from app_user where email = ?", Integer.class, lower)).isEqualTo(1);
    }

    @Test
    void password_isStoredAsABcryptHashAtTheConfiguredCost() throws Exception {
        String email = uniqueEmail();
        register(email, PASSWORD);
        String hash = jdbc.queryForObject("select password_hash from app_user where email = ?", String.class, email);
        assertThat(hash).startsWith("$2a$04$");   // cost 4 in the tests; 12 in production
        assertThat(hash).isNotEqualTo(PASSWORD);
        assertThat(new BCryptPasswordEncoder().matches(PASSWORD, hash)).isTrue();
    }

    @Test
    void sameEmail_is409_inTheProblemShape_withTheCorrelationId() throws Exception {
        String email = uniqueEmail();
        register(email, PASSWORD);
        HttpResponse<String> r = register(email, PASSWORD);
        assertThat(r.statusCode()).isEqualTo(409);
        assertThat(r.headers().firstValue("Content-Type").orElse("")).startsWith("application/problem+json");
        JsonNode b = body(r);
        assertThat(b.get("type").asString()).isEqualTo("urn:appfleet:problem:conflict");
        assertThat(b.get("status").asInt()).isEqualTo(409);
        assertThat(b.get("correlationId").asString()).isEqualTo(r.headers().firstValue("X-Correlation-Id").orElse("?"));
    }

    @Test
    void sameEmailInAnotherCase_is409() throws Exception {
        String email = uniqueEmail();
        register(email, PASSWORD);
        assertThat(register(email.toUpperCase(), PASSWORD).statusCode()).isEqualTo(409);
    }

    @Test
    void emailWithSurroundingSpaces_is400_itIsNotSilentlyTrimmed() throws Exception {
        assertThat(register("  " + uniqueEmail() + " ", PASSWORD).statusCode()).isEqualTo(400);
    }

    @Test
    void invalidEmail_is400_withTheFieldNamed() throws Exception {
        HttpResponse<String> r = register("not-an-email", PASSWORD);
        assertThat(r.statusCode()).isEqualTo(400);
        JsonNode b = body(r);
        assertThat(b.get("type").asString()).isEqualTo("urn:appfleet:problem:validation-failed");
        assertThat(b.get("errors").toString()).contains("\"field\":\"email\"");
    }

    @Test
    void shortPassword_is400() throws Exception {
        HttpResponse<String> r = register(uniqueEmail(), "short");
        assertThat(r.statusCode()).isEqualTo(400);
        assertThat(body(r).get("errors").toString()).contains("\"field\":\"password\"");
    }

    @Test
    void passwordOf72CharactersButMoreThan72Bytes_is400_notSilentlyTruncated() throws Exception {
        String longInBytes = "é".repeat(40);   // 40 characters, 80 bytes in UTF-8
        HttpResponse<String> r = register(uniqueEmail(), longInBytes);
        assertThat(r.statusCode()).isEqualTo(400);
        assertThat(body(r).get("errors").toString()).contains("\"field\":\"password\"").contains("72 bytes");
    }

    @Test
    void blankDisplayName_is400() throws Exception {
        HttpResponse<String> r = post("/api/v1/auth/register", Map.of("email", uniqueEmail(), "displayName", " ", "password", PASSWORD));
        assertThat(r.statusCode()).isEqualTo(400);
        assertThat(body(r).get("errors").toString()).contains("\"field\":\"displayName\"");
    }

    @Test
    void malformedJson_is400_asMalformedRequest() throws Exception {
        HttpResponse<String> r = postRaw("/api/v1/auth/register", "{not json");
        assertThat(r.statusCode()).isEqualTo(400);
        assertThat(body(r).get("type").asString()).isEqualTo("urn:appfleet:problem:malformed-request");
    }

    @Test
    void get_onRegister_isRefused() throws Exception {
        assertThat(get("/api/v1/auth/register").statusCode()).isEqualTo(401);
    }
}