package io.appfleet.security;

import io.appfleet.security.testing.TestJwt;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtException;

import java.util.HashSet;
import java.util.Set;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** The denylist is off unless asked for, and then it sits inside the decoder next to the other validators. */
class JwtDenylistAutoConfigurationTest {

    /** A list that tests can write to; stands in for Redis. */
    static class InMemoryDenylist implements JwtDenylist {
        final Set<String> revoked = new HashSet<>();
        @Override public boolean isRevoked(String jti) { return revoked.contains(jti); }
    }

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(JwtSecurityAutoConfiguration.class))
            .withPropertyValues(
                    "appfleet.security.jwt.public-key-location=classpath:keys/dev-public.pem",
                    "appfleet.security.jwt.issuer=appfleet-identity");

    private static String token() {
        return TestJwt.forUser(UUID.randomUUID()).sign();
    }

    @Test
    void byDefault_thereIsNoDenylistValidator_andARevokedJtiIsStillAccepted() {
        InMemoryDenylist list = new InMemoryDenylist();
        runner.withBean(JwtDenylist.class, () -> list).run(ctx -> {
            assertThat(ctx).doesNotHaveBean(JwtDenylistValidator.class);
            JwtDecoder decoder = ctx.getBean(JwtDecoder.class);
            Jwt jwt = decoder.decode(token());
            list.revoked.add(jwt.getId());
            assertThat(decoder.decode(token())).isNotNull();   // nobody consults the list
        });
    }

    @Test
    void whenEnabled_aRevokedToken_isRefusedByTheDecoder() {
        InMemoryDenylist list = new InMemoryDenylist();
        runner.withPropertyValues("appfleet.security.jwt.denylist.enabled=true")
                .withBean(JwtDenylist.class, () -> list)
                .run(ctx -> {
                    JwtDecoder decoder = ctx.getBean(JwtDecoder.class);
                    String token = token();
                    Jwt jwt = decoder.decode(token);                 // fine while the list is empty
                    list.revoked.add(jwt.getId());
                    assertThatThrownBy(() -> decoder.decode(token))
                            .isInstanceOf(JwtException.class).hasMessageContaining("revoked");
                    assertThat(decoder.decode(token())).as("another token is unaffected").isNotNull();
                });
    }

    @Test
    void whenEnabled_theRedisListIsTheDefault() {
        // spring-data-redis is on the test classpath (optional dependency), so the Redis list is the default.
        runner.withPropertyValues("appfleet.security.jwt.denylist.enabled=true")
                .withBean(org.springframework.data.redis.core.StringRedisTemplate.class,
                        () -> org.mockito.Mockito.mock(org.springframework.data.redis.core.StringRedisTemplate.class))
                .run(ctx -> {
                    assertThat(ctx).hasSingleBean(RedisJwtDenylist.class);
                    assertThat(ctx).hasSingleBean(JwtDenylistValidator.class);
                });
    }

    @Test
    void failOpen_isReadFromItsProperty() {
        runner.withPropertyValues("appfleet.security.jwt.denylist.enabled=true", "appfleet.security.jwt.denylist.fail-open=true")
                .withBean(JwtDenylist.class, () -> jti -> { throw new IllegalStateException("redis down"); })
                .run(ctx -> assertThat(ctx.getBean(JwtDecoder.class).decode(token())).isNotNull());
    }

    @Test
    void failClosed_isTheDefault() {
        runner.withPropertyValues("appfleet.security.jwt.denylist.enabled=true")
                .withBean(JwtDenylist.class, () -> jti -> { throw new IllegalStateException("redis down"); })
                .run(ctx -> assertThatThrownBy(() -> ctx.getBean(JwtDecoder.class).decode(token()))
                        .isInstanceOf(JwtException.class));
    }
}