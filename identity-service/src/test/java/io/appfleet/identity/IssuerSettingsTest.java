package io.appfleet.identity;

import io.appfleet.identity.auth.AccessTokenIssuer;
import io.appfleet.identity.config.IdentityJwtProperties;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.ClassPathResource;
import org.springframework.core.io.FileSystemResource;

import java.io.IOException;
import java.time.Clock;
import java.time.Duration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** No Spring context, no database: the rules that must hold before the application can start at all. */
class IssuerSettingsTest {

    private static IdentityJwtProperties props(Duration ttl) {
        return new IdentityJwtProperties(new ClassPathResource("keys/dev-private.pem"), "appfleet-identity", "appfleet", ttl);
    }

    @Test
    void accessTokenTtl_ofFifteenMinutes_isAccepted() {
        assertThat(props(Duration.ofMinutes(15)).accessTokenTtl()).isEqualTo(Duration.ofMinutes(15));
    }

    @Test
    void accessTokenTtl_overFifteenMinutes_isRefused() {
        assertThatThrownBy(() -> props(Duration.ofMinutes(16)))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("at most 15 minutes");
    }

    @Test
    void accessTokenTtl_ofZeroOrLess_isRefused() {
        assertThatThrownBy(() -> props(Duration.ZERO)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> props(Duration.ofSeconds(-1))).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void aMissingPrivateKey_stopsTheIssuerFromBeingBuilt() {
        IdentityJwtProperties missing = new IdentityJwtProperties(
                new FileSystemResource("no-such-key.pem"), "appfleet-identity", "appfleet", Duration.ofMinutes(15));
        assertThatThrownBy(() -> new AccessTokenIssuer(missing, null, null, Clock.systemUTC()))
                .isInstanceOf(IOException.class);
    }
}