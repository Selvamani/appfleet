package io.appfleet.control.idempotency;

import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.script.RedisScript;
import org.springframework.stereotype.Component;

import java.time.Duration;
import java.util.List;

@Component
public class IdempotencyStore {
    private static final String PREFIX = "idempotency:v1:";

    private static final RedisScript<String> CLAIM = RedisScript.of("""
            if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then
                return nil
            end
            return redis.call('GET', KEYS[1])            
            """, String.class);

    private static final RedisScript<Long> COMPLETE = RedisScript.of("""
            if redis.call('GET', KEYS[1]) == ARGV[1] then
                redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
                return 1
            end 
            return 0
            """, Long.class);

    private static final RedisScript<Long> RELEASE = RedisScript.of("""
            if redis.call('GET', KEYS[1]) == ARGV[1] then
                return redis.call('DEL', KEYS[1])
            end
            return 0
            """, Long.class);

    private final StringRedisTemplate redis;

    public IdempotencyStore(StringRedisTemplate redis) {
        this.redis = redis;
    }

    public String claim(String key, String inProgressJson, Duration ttl) {
        return redis.execute(CLAIM, List.of(PREFIX+key), inProgressJson, String.valueOf(ttl.toMillis()));
    }

    public boolean complete(String key, String inProgressJson, String completedJson, Duration ttl) {
        return Long.valueOf(1).equals(redis.execute(COMPLETE, List.of(PREFIX+key), inProgressJson, completedJson, String.valueOf(ttl.toMillis())));
    }

    public void release(String key, String inProgressJson) {
        redis.execute(RELEASE, List.of(PREFIX+key), inProgressJson);
    }

}
