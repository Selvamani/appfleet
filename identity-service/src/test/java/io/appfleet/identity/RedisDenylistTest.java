package io.appfleet.identity;

import io.appfleet.security.RedisJwtDenylist;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.redis.core.StringRedisTemplate;

import java.time.Instant;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/** The shared denylist class against a real Redis. */
class RedisDenylistTest extends IdentityIntegrationTest {

    @Autowired RedisJwtDenylist denylist;
    @Autowired StringRedisTemplate redis;

    @Test
    void aRevokedJti_isRevoked_andAnotherIsNot() {
        String jti = UUID.randomUUID().toString();
        denylist.revoke(jti, Instant.now().plusSeconds(600));
        assertThat(denylist.isRevoked(jti)).isTrue();
        assertThat(denylist.isRevoked(UUID.randomUUID().toString())).isFalse();
    }

    @Test
    void theKey_livesUntilExpPlusTheClockSkew_andThenGoesAway() {
        String jti = UUID.randomUUID().toString();
        denylist.revoke(jti, Instant.now().plusSeconds(600));
        long ttl = redis.getExpire(RedisJwtDenylist.KEY_PREFIX + jti, TimeUnit.SECONDS);
        assertThat(ttl).isBetween(655L, 660L);   // 600 s left + 60 s skew
    }

    @Test
    void aTokenPastItsExpiryAndTheSkew_getsNoKey() {
        String jti = UUID.randomUUID().toString();
        denylist.revoke(jti, Instant.now().minusSeconds(61));
        assertThat(redis.hasKey(RedisJwtDenylist.KEY_PREFIX + jti)).isFalse();
    }

    @Test
    void theKeyFormat_isThePrefixAndTheJti() {
        String jti = UUID.randomUUID().toString();
        denylist.revoke(jti, Instant.now().plusSeconds(60));
        assertThat(redis.hasKey("appfleet:jwt:denylist:" + jti)).isTrue();
    }
}