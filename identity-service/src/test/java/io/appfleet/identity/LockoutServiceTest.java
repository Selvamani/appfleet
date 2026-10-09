package io.appfleet.identity;

import io.appfleet.identity.auth.LockoutService;
import io.appfleet.identity.auth.LockoutService.LockoutUnavailableException;
import io.appfleet.identity.config.LockoutProperties;
import org.junit.jupiter.api.Test;
import org.mockito.InOrder;
import org.springframework.data.redis.RedisConnectionFailureException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.ValueOperations;

import java.time.Duration;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.inOrder;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** The counter's rules against a mocked template (no Redis, no Spring). */
class LockoutServiceTest {

    private static final Duration WINDOW = Duration.ofMinutes(15);

    private final StringRedisTemplate redis = mock(StringRedisTemplate.class);
    @SuppressWarnings("unchecked")
    private final ValueOperations<String, String> ops = mock(ValueOperations.class);
    private final LockoutService service = new LockoutService(redis, new LockoutProperties(5, WINDOW));

    LockoutServiceTest() {
        when(redis.opsForValue()).thenReturn(ops);
    }

    @Test
    void theKey_isThePrefixAndTheSha256OfTheEmail_never_theEmail() {
        String key = LockoutService.key("ada@example.io");
        assertThat(key).matches("appfleet:identity:login-failures:[0-9a-f]{64}");
        assertThat(key).doesNotContain("ada").doesNotContain("@");
        assertThat(LockoutService.key("ada@example.io")).isEqualTo(key);
        assertThat(LockoutService.key("bob@example.io")).isNotEqualTo(key);
    }

    @Test
    void recordFailure_createsTheKeyWithItsLifetimeFirst_andThenCounts() {
        service.recordFailure("ada@example.io");
        String key = LockoutService.key("ada@example.io");
        InOrder order = inOrder(ops);
        order.verify(ops).setIfAbsent(key, "0", WINDOW);   // the lifetime exists before the first increment
        order.verify(ops).increment(key);
    }

    @Test
    void belowTheLimit_nobodyIsLocked() {
        when(ops.get(anyString())).thenReturn("4");
        assertThat(service.lockedFor("ada@example.io")).isEmpty();
        when(ops.get(anyString())).thenReturn(null);
        assertThat(service.lockedFor("ada@example.io")).isEmpty();
    }

    @Test
    void atTheLimit_theEmailIsLockedForTheRestOfTheWindow() {
        when(ops.get(anyString())).thenReturn("5");
        when(redis.getExpire(anyString(), any(TimeUnit.class))).thenReturn(321L);
        assertThat(service.lockedFor("ada@example.io")).contains(Duration.ofSeconds(321));
    }

    @Test
    void aKeyWithoutALifetime_isGivenOne_insteadOfLockingForEver() {
        when(ops.get(anyString())).thenReturn("9");
        when(redis.getExpire(anyString(), any(TimeUnit.class))).thenReturn(-1L);
        assertThat(service.lockedFor("ada@example.io")).contains(WINDOW);
        verify(redis).expire(LockoutService.key("ada@example.io"), WINDOW);
    }

    @Test
    void clear_deletesTheKey() {
        service.clear("ada@example.io");
        verify(redis).delete(LockoutService.key("ada@example.io"));
    }

    @Test
    void aRedisFailure_isALockoutUnavailable_onEveryOperation() {
        when(ops.get(anyString())).thenThrow(new RedisConnectionFailureException("down"));
        when(ops.setIfAbsent(anyString(), anyString(), any(Duration.class))).thenThrow(new RedisConnectionFailureException("down"));
        when(redis.delete(anyString())).thenThrow(new RedisConnectionFailureException("down"));
        assertThatThrownBy(() -> service.lockedFor("a@b.io")).isInstanceOf(LockoutUnavailableException.class);
        assertThatThrownBy(() -> service.recordFailure("a@b.io")).isInstanceOf(LockoutUnavailableException.class);
        assertThatThrownBy(() -> service.clear("a@b.io")).isInstanceOf(LockoutUnavailableException.class);
    }

    @Test
    void theWindowMustBePositive() {
        assertThatThrownBy(() -> new LockoutProperties(5, Duration.ZERO)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new LockoutProperties(5, Duration.ofSeconds(-1))).isInstanceOf(IllegalArgumentException.class);
    }
}