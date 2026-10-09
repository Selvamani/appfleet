package io.appfleet.identity.auth;

import io.appfleet.identity.config.LockoutProperties;
import org.springframework.dao.DataAccessException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.time.Duration;
import java.util.HexFormat;
import java.util.Optional;
import java.util.concurrent.TimeUnit;

/**
 * Counts failed sign-ins per EMAIL, whether or not an account with that email exists. That is what keeps the lockout
 * from becoming a way to find out which emails have an account: an unknown address is locked exactly like a real one.
 *
 * One Redis key per email, named by the SHA-256 of the normalised address (no address in Redis), created with its
 * expiry already set (SET NX EX) and then incremented, so a key can never exist without a lifetime.
 * If Redis cannot be reached the sign-in is refused, not allowed: the check is the protection.
 */
@Service
public class LockoutService {

    public static final String KEY_PREFIX = "appfleet:identity:login-failures:";

    private final StringRedisTemplate redis;
    private final LockoutProperties properties;

    public LockoutService(StringRedisTemplate redis, LockoutProperties properties) {
        this.redis = redis;
        this.properties = properties;
    }

    /** How long this email stays refused, or empty when it may try. */
    public Optional<Duration> lockedFor(String normalizedEmail) {
        String key = key(normalizedEmail);
        try {
            String count = redis.opsForValue().get(key);
            if (count == null || Long.parseLong(count) < properties.maxFailures()) return Optional.empty();
            Long ttl = redis.getExpire(key, TimeUnit.SECONDS);
            if (ttl != null && ttl == -1) {                        // a key without a lifetime must not lock for ever
                redis.expire(key, properties.window());
                ttl = properties.window().toSeconds();
            }
            return Optional.of(Duration.ofSeconds(ttl != null && ttl > 0 ? ttl : 1));
        } catch (DataAccessException e) {
            throw new LockoutUnavailableException(e);
        }
    }

    public void recordFailure(String normalizedEmail) {
        String key = key(normalizedEmail);
        try {
            redis.opsForValue().setIfAbsent(key, "0", properties.window());
            redis.opsForValue().increment(key);
        } catch (DataAccessException e) {
            throw new LockoutUnavailableException(e);
        }
    }

    public void clear(String normalizedEmail) {
        try {
            redis.delete(key(normalizedEmail));
        } catch (DataAccessException e) {
            throw new LockoutUnavailableException(e);
        }
    }

    public static String key(String normalizedEmail) {
        try {
            byte[] digest = MessageDigest.getInstance("SHA-256").digest(normalizedEmail.getBytes(StandardCharsets.UTF_8));
            return KEY_PREFIX + HexFormat.of().formatHex(digest);
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }

    /** Redis could not be read or written; the sign-in is refused with a 503. */
    public static class LockoutUnavailableException extends RuntimeException {
        public LockoutUnavailableException(Throwable cause) { super("the lockout counter is not available", cause); }
    }
}
