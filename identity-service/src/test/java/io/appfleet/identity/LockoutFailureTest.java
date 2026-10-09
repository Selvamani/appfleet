package io.appfleet.identity;

import io.appfleet.identity.auth.LockoutService;
import io.appfleet.identity.auth.LockoutService.LockoutUnavailableException;
import org.junit.jupiter.api.Test;
import org.springframework.test.context.bean.override.mockito.MockitoBean;

import java.net.http.HttpResponse;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.when;

/** When the failure counter cannot be read, signing in is refused (503): the check is the protection. */
class LockoutFailureTest extends AuthHttpTest {

    @MockitoBean LockoutService lockout;

    @Test
    void ifTheCounterIsUnavailable_signInAnswers503_notAnUnprotectedLogin() throws Exception {
        String email = uniqueEmail();
        register(email, PASSWORD);
        when(lockout.lockedFor(anyString())).thenThrow(new LockoutUnavailableException(new RuntimeException("redis down")));

        HttpResponse<String> r = login(email, PASSWORD);
        assertThat(r.statusCode()).as("even with the right password").isEqualTo(503);
        assertThat(body(r).get("type").asString()).isEqualTo("urn:appfleet:problem:service-unavailable");
        assertThat(r.headers().firstValue("Retry-After")).contains("5");
        assertThat(r.body()).doesNotContain("accessToken");
    }

    @Test
    void registrationDoesNotDependOnTheCounter() throws Exception {
        when(lockout.lockedFor(anyString())).thenThrow(new LockoutUnavailableException(new RuntimeException("redis down")));
        assertThat(register(uniqueEmail(), PASSWORD).statusCode()).isEqualTo(201);
    }
}