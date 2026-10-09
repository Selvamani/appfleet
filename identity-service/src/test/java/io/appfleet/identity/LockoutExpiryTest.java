package io.appfleet.identity;

import org.junit.jupiter.api.Test;
import org.springframework.test.context.TestPropertySource;

import java.net.http.HttpResponse;

import static org.assertj.core.api.Assertions.assertThat;

/** A short window, so that the end of a lockout can be watched. */
@TestPropertySource(properties = {
        "appfleet.identity.lockout.max-failures=2",
        "appfleet.identity.lockout.window=3s"
})
class LockoutExpiryTest extends AuthHttpTest {

    @Test
    void theLockoutEndsWithTheWindow() throws Exception {
        String email = uniqueEmail();
        register(email, PASSWORD);
        assertThat(login(email, "another correct horse").statusCode()).isEqualTo(401);
        assertThat(login(email, "another correct horse").statusCode()).isEqualTo(401);

        HttpResponse<String> locked = login(email, PASSWORD);
        assertThat(locked.statusCode()).isEqualTo(423);
        assertThat(Long.parseLong(locked.headers().firstValue("Retry-After").orElseThrow())).isBetween(1L, 3L);

        Thread.sleep(3400);
        assertThat(login(email, PASSWORD).statusCode()).as("the window is over").isEqualTo(200);
    }

    @Test
    void theWindowIsFixed_itStartsAtTheFirstFailureAndDoesNotSlide() throws Exception {
        String email = uniqueEmail();
        register(email, PASSWORD);
        login(email, "another correct horse");
        Thread.sleep(2000);
        login(email, "another correct horse");              // the second failure does not extend the window
        assertThat(login(email, PASSWORD).statusCode()).isEqualTo(423);
        Thread.sleep(1400);                                 // 3.4 s after the FIRST failure
        assertThat(login(email, PASSWORD).statusCode()).isEqualTo(200);
    }
}