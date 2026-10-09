package io.appfleet.identity;

import io.appfleet.identity.auth.LockoutService;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.redis.core.StringRedisTemplate;

import java.net.http.HttpResponse;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/** The default limit: 5 wrong sign-ins for one email within 15 minutes, then 423. */
class LockoutTest extends AuthHttpTest {

    @Autowired StringRedisTemplate redis;

    private int wrong(String email) throws Exception {
        return login(email, "another correct horse").statusCode();
    }

    private List<Integer> sixAttempts(String email) throws Exception {
        List<Integer> statuses = new ArrayList<>();
        for (int i = 0; i < 6; i++) statuses.add(wrong(email));
        return statuses;
    }

    private Map<String, Object> shape(HttpResponse<String> r) {
        Map<String, Object> m = new LinkedHashMap<>(json.convertValue(body(r), Map.class));
        m.remove("correlationId");
        return m;
    }

    @Test
    void fiveWrongPasswords_thenTheSixthAttemptIs423_evenWithTheCorrectPassword() throws Exception {
        String email = uniqueEmail();
        register(email, PASSWORD);
        assertThat(sixAttempts(email)).containsExactly(401, 401, 401, 401, 401, 423);

        HttpResponse<String> correct = login(email, PASSWORD);
        assertThat(correct.statusCode()).as("the right password does not get through while locked").isEqualTo(423);
        assertThat(correct.headers().firstValue("Content-Type").orElse("")).startsWith("application/problem+json");
        assertThat(body(correct).get("type").asString()).isEqualTo("urn:appfleet:problem:locked");
        long retryAfter = Long.parseLong(correct.headers().firstValue("Retry-After").orElseThrow());
        assertThat(retryAfter).isBetween(1L, 900L);
    }

    /** The point of counting per email, not per account: an unknown address is locked exactly like a real one. */
    @Test
    void anUnknownEmail_isLockedExactlyLikeARealOne() throws Exception {
        String real = uniqueEmail();
        register(real, PASSWORD);
        String unknown = uniqueEmail();

        assertThat(sixAttempts(unknown)).containsExactly(401, 401, 401, 401, 401, 423);
        assertThat(sixAttempts(real)).containsExactly(401, 401, 401, 401, 401, 423);

        Map<String, Object> lockedUnknown = shape(login(unknown, PASSWORD));
        Map<String, Object> lockedReal = shape(login(real, PASSWORD));
        assertThat(lockedUnknown).isEqualTo(lockedReal);
        assertThat(login(unknown, PASSWORD).headers().firstValue("Retry-After")).isPresent();
    }

    @Test
    void aSuccessfulSignIn_clearsTheCounter() throws Exception {
        String email = uniqueEmail();
        register(email, PASSWORD);
        for (int i = 0; i < 4; i++) assertThat(wrong(email)).isEqualTo(401);
        assertThat(login(email, PASSWORD).statusCode()).isEqualTo(200);
        for (int i = 0; i < 4; i++) assertThat(wrong(email)).as("the four earlier failures no longer count").isEqualTo(401);
    }

    @Test
    void anotherEmail_isUnaffected() throws Exception {
        String locked = uniqueEmail();
        String other = uniqueEmail();
        register(locked, PASSWORD);
        register(other, PASSWORD);
        sixAttempts(locked);
        assertThat(login(other, PASSWORD).statusCode()).isEqualTo(200);
    }

    @Test
    void oneCounterPerEmail_whateverTheCaseOrSpaces() throws Exception {
        String email = uniqueEmail();
        register(email, PASSWORD);
        for (int i = 0; i < 5; i++) {
            String spelling = i % 2 == 0 ? email.toUpperCase() : "  " + email + " ";
            assertThat(login(spelling, "another correct horse").statusCode()).isEqualTo(401);
        }
        assertThat(wrong(email)).isEqualTo(423);
    }

    @Test
    void theCounterKey_hasALifetime_andHoldsNoEmailAddress() throws Exception {
        String email = uniqueEmail();
        register(email, PASSWORD);
        wrong(email);
        String key = LockoutService.key(email);
        assertThat(key).startsWith("appfleet:identity:login-failures:").doesNotContain("@").doesNotContain(email);
        assertThat(redis.hasKey(key)).isTrue();
        long ttl = redis.getExpire(key, TimeUnit.SECONDS);
        assertThat(ttl).as("never a key without a lifetime").isBetween(1L, 900L);
        Set<String> all = redis.keys(LockoutService.KEY_PREFIX + "*");
        assertThat(all).allSatisfy(k -> assertThat(k).doesNotContain("@"));
    }

    @Test
    void aLockedAttempt_doesNotRaiseTheCounterFurther() throws Exception {
        String email = uniqueEmail();
        register(email, PASSWORD);
        sixAttempts(email);
        for (int i = 0; i < 3; i++) wrong(email);
        assertThat(redis.opsForValue().get(LockoutService.key(email))).isEqualTo("5");
    }
}