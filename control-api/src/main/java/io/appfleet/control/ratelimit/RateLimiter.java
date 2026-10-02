package io.appfleet.control.ratelimit;

import io.appfleet.control.config.AppfleetProperties;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.core.io.ClassPathResource;
import org.springframework.dao.DataAccessException;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.RedisScript;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.util.List;

@Component
public class RateLimiter {

    private static final Logger log = LoggerFactory.getLogger(RateLimiter.class);
    private static final String PREFIX = "ratelimit:v1:team:";
    private static final RedisScript<List> TAKE_TOKEN = RedisScript.of(new ClassPathResource("ratelimit/take-token.lua"), List.class);

    private final StringRedisTemplate redis;
    private final RateLimitProperties limits;

    public RateLimiter(StringRedisTemplate redis, AppfleetProperties properties) {
        this.redis = redis;
        this.limits = properties.rateLimit();
    }

    public RateLimitDecision tryConsume(String team) {
        try {
            List<?> r = redis.execute(TAKE_TOKEN, List.of(PREFIX + team),
                    String.valueOf(limits.capacity()), String.valueOf(limits.refillPerSecond()));
            return new RateLimitDecision(((Long) r.get(0)) == 1, (Long) r.get(1), Duration.ofMillis((Long) r.get(2)));
        } catch (DataAccessException e) {
            log.warn("Rate limiter unavailable, request allowed: {}", e.getMessage());
            return new RateLimitDecision(true, -1, Duration.ZERO);
        }
    }

}
