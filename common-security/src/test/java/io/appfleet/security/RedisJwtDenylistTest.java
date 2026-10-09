package io.appfleet.security;

import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.ValueOperations;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** The key format and the lifetime of a key, against a mocked template (no Redis needed). */
class RedisJwtDenylistTest {

    private static final Instant NOW = Instant.parse("2026-10-07T10:00:00Z");
    private static final Duration SKEW = Duration.ofSeconds(60);

    private final StringRedisTemplate redis = mock(StringRedisTemplate.class);
    @SuppressWarnings("unchecked")
    private final ValueOperations<String, String> ops = mock(ValueOperations.class);
    private final RedisJwtDenylist denylist = new RedisJwtDenylist(redis, SKEW, Clock.fixed(NOW, ZoneOffset.UTC));

    RedisJwtDenylistTest() {
        when(redis.opsForValue()).thenReturn(ops);
    }

    @Test
    void revoke_storesOneKeyPerJti_livingUntilExpPlusTheClockSkew() {
        denylist.revoke("abc", NOW.plusSeconds(600));
        ArgumentCaptor<Duration> ttl = ArgumentCaptor.forClass(Duration.class);
        verify(ops).set(eq("appfleet:jwt:denylist:abc"), eq("1"), ttl.capture());
        assertThat(ttl.getValue()).isEqualTo(Duration.ofSeconds(660));   // 600 s left + 60 s the decoder still accepts
    }

    @Test
    void revoke_ofATokenPastItsExpiryAndSkew_writesNothing() {
        denylist.revoke("old", NOW.minusSeconds(61));
        verify(ops, never()).set(any(), any(), any(Duration.class));
    }

    @Test
    void revoke_ofATokenExpiredInsideTheSkew_stillWritesAKey_becauseTheDecoderWouldAcceptIt() {
        denylist.revoke("recent", NOW.minusSeconds(30));
        ArgumentCaptor<Duration> ttl = ArgumentCaptor.forClass(Duration.class);
        verify(ops).set(eq("appfleet:jwt:denylist:recent"), eq("1"), ttl.capture());
        assertThat(ttl.getValue()).isEqualTo(Duration.ofSeconds(30));
    }

    @Test
    void isRevoked_asksForTheSameKey() {
        when(redis.hasKey("appfleet:jwt:denylist:abc")).thenReturn(true);
        when(redis.hasKey("appfleet:jwt:denylist:other")).thenReturn(false);
        assertThat(denylist.isRevoked("abc")).isTrue();
        assertThat(denylist.isRevoked("other")).isFalse();
    }

    @Test
    void isRevoked_treatsANullAnswerAsNotRevoked() {
        when(redis.hasKey(any(String.class))).thenReturn(null);
        assertThat(denylist.isRevoked("x")).isFalse();
    }
}