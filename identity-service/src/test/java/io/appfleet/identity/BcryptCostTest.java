package io.appfleet.identity;

import org.junit.jupiter.api.Test;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;

import java.util.Arrays;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * The BCrypt numbers the spec asks for, measured on the machine that runs the test: the median time of one hash at cost
 * 10, 12 and 14 (after one warm-up). BCrypt's cost is a power of two, so each step of 2 should cost about 4 times as much.
 * The assertions only pin that shape; the numbers are for the docs (the printed BCRYPT-COST line).
 */
class BcryptCostTest {

    private static final String PASSWORD = "correct horse battery";
    private static final int SAMPLES = 3;

    private static long medianMillis(int cost) {
        BCryptPasswordEncoder encoder = new BCryptPasswordEncoder(cost);
        encoder.encode(PASSWORD);   // warm-up
        long[] ms = new long[SAMPLES];
        for (int i = 0; i < SAMPLES; i++) {
            long t = System.nanoTime();
            encoder.encode(PASSWORD);
            ms[i] = (System.nanoTime() - t) / 1_000_000;
        }
        Arrays.sort(ms);
        return ms[SAMPLES / 2];
    }

    @Test
    void eachStepOfTwoInTheCost_costsAboutFourTimesAsMuch() {
        long c10 = medianMillis(10);
        long c12 = medianMillis(12);
        long c14 = medianMillis(14);
        System.out.println("BCRYPT-COST cost=10 median=" + c10 + " ms  cost=12 median=" + c12 + " ms  cost=14 median=" + c14 + " ms"
                + "  12/10=" + String.format("%.1f", (double) c12 / c10) + "  14/12=" + String.format("%.1f", (double) c14 / c12)
                + "  (samples=" + SAMPLES + " after 1 warm-up)");
        assertThat(c12).as("cost 12 is slower than cost 10").isGreaterThan(c10);
        assertThat(c14).as("cost 14 is slower than cost 12").isGreaterThan(c12);
        assertThat((double) c14 / c12).as("about 4 times per step of 2, not 1 and not 16").isBetween(2.0, 8.0);
    }
}