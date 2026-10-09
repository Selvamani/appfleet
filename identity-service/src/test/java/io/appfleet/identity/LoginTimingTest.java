package io.appfleet.identity;

import org.junit.jupiter.api.Test;
import org.springframework.test.context.TestPropertySource;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The login must take the same time whether the user is unknown, known with the wrong password, or deactivated:
 * otherwise the time tells an attacker which emails have an account. Measured at the production BCrypt cost (12),
 * where one hash takes a few hundred milliseconds and any skipped hash is impossible to miss.
 *
 * The lockout limit is raised so that the repeated attempts of the measurement are never refused early.
 */
@TestPropertySource(properties = {
        "appfleet.identity.password.bcrypt-cost=12",
        "appfleet.identity.lockout.max-failures=1000"
})
class LoginTimingTest extends AuthHttpTest {

    private static final int WARM_UP = 2;
    private static final int SAMPLES = 7;

    private interface Attempt { void run() throws Exception; }

    /** Median wall-clock time of one attempt, in milliseconds. */
    private static double medianMillis(Attempt attempt) throws Exception {
        for (int i = 0; i < WARM_UP; i++) attempt.run();
        List<Double> times = new ArrayList<>();
        for (int i = 0; i < SAMPLES; i++) {
            long start = System.nanoTime();
            attempt.run();
            times.add((System.nanoTime() - start) / 1_000_000.0);
        }
        Collections.sort(times);
        return times.get(SAMPLES / 2);
    }

    @Test
    void measured_unknownUser_wrongPassword_andDeactivatedUser_takeTheSameTime() throws Exception {
        String known = uniqueEmail();
        register(known, PASSWORD);
        String deactivated = uniqueEmail();
        register(deactivated, PASSWORD);
        jdbc.update("update app_user set status = 'DEACTIVATED', deactivated_at = now() where email = ?", deactivated);

        double wrong = medianMillis(() -> login(known, "another correct horse"));
        double unknown = medianMillis(() -> login(uniqueEmail(), "another correct horse"));
        double off = medianMillis(() -> login(deactivated, PASSWORD));

        System.out.printf("TIMING-GAP cost=12  wrong_password=%.0f ms  unknown_user=%.0f ms  deactivated=%.0f ms  unknown/wrong=%.2f  deactivated/wrong=%.2f%n",
                wrong, unknown, off, unknown / wrong, off / wrong);

        assertThat(wrong).as("a wrong password at cost 12 does a real BCrypt check").isGreaterThan(50.0);
        assertThat(unknown / wrong).as("unknown user must cost about the same as a wrong password").isBetween(0.6, 1.6);
        assertThat(off / wrong).as("a deactivated user must cost about the same as a wrong password").isBetween(0.6, 1.6);
    }
}