package io.appfleet.security;

import io.appfleet.security.testing.TestJwt;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.core.io.ClassPathResource;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtException;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.UUID;
import java.util.function.Consumer;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class JwtSecurityAutoConfigurationTest {

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(JwtSecurityAutoConfiguration.class))
            .withPropertyValues(
                    "appfleet.security.jwt.public-key-location=classpath:keys/dev-public.pem",
                    "appfleet.security.jwt.issuer=appfleet-identity");

    private static TestJwt user() {
        return TestJwt.forUser(UUID.randomUUID());
    }

    private void decoder(Consumer<JwtDecoder> test) {
        runner.run(ctx -> test.accept(ctx.getBean(JwtDecoder.class)));
    }

    @Test
    void validToken_decodes() {
        decoder(d -> assertThat(d.decode(user().team(UUID.randomUUID(), "deployment:create").sign()).getClaimAsMap("teams"))
                .hasSize(1));
    }

    @Test
    void wrongKey_rejected() {
        decoder(d -> assertThatThrownBy(() -> d.decode(user().wrongKey().sign())).isInstanceOf(JwtException.class));
    }

    @Test
    void expired_rejected() {
        decoder(d -> assertThatThrownBy(() -> d.decode(user().expired().sign())).isInstanceOf(JwtException.class));
    }

    @Test
    void notYetValid_rejected() {
        decoder(d -> assertThatThrownBy(() -> d.decode(user().notYetValid().sign())).isInstanceOf(JwtException.class));
    }

    @Test
    void wrongIssuer_rejected() {
        decoder(d -> assertThatThrownBy(() -> d.decode(user().issuer("other").sign())).isInstanceOf(JwtException.class));
    }

    @Test
    void wrongAudience_rejected() {
        decoder(d -> assertThatThrownBy(() -> d.decode(user().audience("other").sign())).isInstanceOf(JwtException.class));
    }

    @Test
    void algNone_rejected() {
        decoder(d -> assertThatThrownBy(() -> d.decode(user().algNone().sign())).isInstanceOf(JwtException.class));
    }

    @Test
    void hs256WithPublicKey_rejected() {
        decoder(d -> assertThatThrownBy(() -> d.decode(user().hs256WithPublicKeyAsSecret().sign())).isInstanceOf(JwtException.class));
    }

    @Test
    void malformed_rejected() {
        decoder(d -> assertThatThrownBy(() -> d.decode("not-a-jwt")).isInstanceOf(JwtException.class));
    }

    @Test
    void clockSkew_30sPasses_90sFails() {
        decoder(d -> {
            assertThat(d.decode(user().expiresIn(Duration.ofSeconds(-30)).sign())).isNotNull();
            assertThatThrownBy(() -> d.decode(user().expiresIn(Duration.ofSeconds(-90)).sign()))
                    .isInstanceOf(JwtException.class);
        });
    }

    @Test
    void tamperedPayload_rejected() {
        decoder(d -> {
            String[] p = user().sign().split("\\.");
            char[] payload = p[1].toCharArray();
            payload[5] = payload[5] == 'A' ? 'B' : 'A';
            String tampered = p[0] + "." + new String(payload) + "." + p[2];
            assertThatThrownBy(() -> d.decode(tampered)).isInstanceOf(JwtException.class);
        });
    }

    @Test
    void missingIssuer_failsContext() {
        new ApplicationContextRunner()
                .withConfiguration(AutoConfigurations.of(JwtSecurityAutoConfiguration.class))
                .withPropertyValues("appfleet.security.jwt.public-key-location=classpath:keys/dev-public.pem")
                .run(ctx -> assertThat(ctx).hasFailed());
    }

    @Test
    void noKeyProperty_registersNothing() {
        new ApplicationContextRunner()
                .withConfiguration(AutoConfigurations.of(JwtSecurityAutoConfiguration.class))
                .run(ctx -> assertThat(ctx).doesNotHaveBean(JwtDecoder.class));
    }

    @Test
    void unreadableKey_failsContext() {
        new ApplicationContextRunner()
                .withConfiguration(AutoConfigurations.of(JwtSecurityAutoConfiguration.class))
                .withPropertyValues("appfleet.security.jwt.public-key-location=classpath:keys/missing.pem",
                        "appfleet.security.jwt.issuer=appfleet-identity")
                .run(ctx -> assertThat(ctx).hasFailed());
    }

    @Test
    void registersAllBeans() {
        runner.run(ctx -> assertThat(ctx).hasSingleBean(JwtDecoder.class)
                .hasSingleBean(AppfleetJwtAuthenticationConverter.class)
                .hasSingleBean(ProblemAuthenticationEntryPoint.class)
                .hasSingleBean(ProblemAccessDeniedHandler.class));
    }

    @Test
    void autoConfigurationIsRegistered() throws Exception {
        var res = new ClassPathResource("META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports");
        assertThat(res.exists()).isTrue();
        assertThat(res.getContentAsString(StandardCharsets.UTF_8)).contains(JwtSecurityAutoConfiguration.class.getName());
    }

}

