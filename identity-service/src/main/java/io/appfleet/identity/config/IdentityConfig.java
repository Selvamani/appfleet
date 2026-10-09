package io.appfleet.identity.config;

import io.appfleet.identity.serviceaccount.ServiceAccountProperties;
import io.appfleet.security.RedisJwtDenylist;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;

import java.time.Clock;
import java.time.Duration;

@Configuration
@EnableConfigurationProperties({IdentityJwtProperties.class, PasswordProperties.class, RefreshProperties.class, LockoutProperties.class, ServiceAccountProperties.class, JwksProperties.class})
public class IdentityConfig {

    @Bean
    PasswordEncoder passwordEncoder(PasswordProperties properties) {
        return new BCryptPasswordEncoder(properties.bcryptCost());
    }

    /**
     * The writing side of the denylist. The skew must equal the validators' clock skew (appfleet.security.jwt.clock-skew,
     * 60 seconds by default), so it is read from that very property.
     */
    @Bean
    RedisJwtDenylist redisJwtDenylist(StringRedisTemplate redis, @Value("${appfleet.security.jwt.clock-skew:60s}") Duration clockSkew) {
        return new RedisJwtDenylist(redis, clockSkew);
    }

    @Bean
    Clock clock() {
        return Clock.systemUTC();
    }
}
