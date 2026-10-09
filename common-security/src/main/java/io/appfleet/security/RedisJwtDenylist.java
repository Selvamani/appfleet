package io.appfleet.security;

import org.springframework.data.redis.core.StringRedisTemplate;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;

/**
 * The denylist in Redis: one key per revoked token, living exactly as long as the token could still be accepted.
 * The writer (identity-service) and the reader (the validators) share this class, so the key format exists once.
 */
public class RedisJwtDenylist implements JwtDenylist {

    public static final String KEY_PREFIX = "appfleet:jwt:denylist:";

    private final StringRedisTemplate redis;
    private final Duration clockSkew;
    private final Clock clock;

    public RedisJwtDenylist(StringRedisTemplate redis, Duration clockSkew) {
        this(redis, clockSkew, Clock.systemUTC());
    }

    RedisJwtDenylist(StringRedisTemplate redis, Duration clockSkew, Clock clock) {
        this.redis = redis;
        this.clockSkew = clockSkew;
        this.clock = clock;
    }

    /** The writer needs the skew too: it decides which issued tokens still count as live. Keep it equal to the validators' clock skew. */
    public Duration clockSkew() {
        return clockSkew;
    }

    /**
     * Refuses the token until it could no longer be accepted anyway. The decoder accepts a token up to clockSkew
     * after its exp, so the key lives until exp + clockSkew; one that is past that needs no key at all.
     */
    public void revoke(String jti, Instant expiresAt) {
        Duration ttl = Duration.between(clock.instant(), expiresAt.plus(clockSkew));
        if (ttl.isZero() || ttl.isNegative()) return;
        redis.opsForValue().set(KEY_PREFIX + jti, "1", ttl);
    }

    @Override
    public boolean isRevoked(String jti) {
        return Boolean.TRUE.equals(redis.hasKey(KEY_PREFIX + jti));
    }
}