package io.appfleet.security;

import org.junit.jupiter.api.Test;
import org.springframework.security.oauth2.core.OAuth2TokenValidatorResult;
import org.springframework.security.oauth2.jwt.Jwt;

import java.time.Instant;
import java.util.HashSet;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

class JwtDenylistValidatorTest {

    private static Jwt jwtWith(String jti) {
        Jwt.Builder b = Jwt.withTokenValue("t").header("alg", "RS256").subject("u")
                .issuedAt(Instant.now()).expiresAt(Instant.now().plusSeconds(900));
        if (jti != null) b.claim("jti", jti);
        return b.build();
    }

    private static JwtDenylist listing(String... revoked) {
        Set<String> set = new HashSet<>(Set.of(revoked));
        return set::contains;
    }

    private static JwtDenylist broken() {
        return jti -> { throw new IllegalStateException("redis down"); };
    }

    @Test
    void aToken_notOnTheList_isAccepted() {
        assertThat(new JwtDenylistValidator(listing("other"), false).validate(jwtWith("a")).hasErrors()).isFalse();
    }

    @Test
    void aToken_onTheList_isRefused_asRevoked() {
        OAuth2TokenValidatorResult r = new JwtDenylistValidator(listing("a"), false).validate(jwtWith("a"));
        assertThat(r.hasErrors()).isTrue();
        assertThat(r.getErrors().iterator().next().getDescription()).contains("revoked");
    }

    @Test
    void aToken_withoutAJti_isRefused_becauseItCouldNeverBeRevoked() {
        assertThat(new JwtDenylistValidator(listing(), false).validate(jwtWith(null)).hasErrors()).isTrue();
        assertThat(new JwtDenylistValidator(listing(), false).validate(jwtWith(" ")).hasErrors()).isTrue();
    }

    @Test
    void whenTheDenylistCannotBeRead_failClosed_refusesTheToken() {
        OAuth2TokenValidatorResult r = new JwtDenylistValidator(broken(), false).validate(jwtWith("a"));
        assertThat(r.hasErrors()).isTrue();
        assertThat(r.getErrors().iterator().next().getDescription()).contains("could not be read");
    }

    @Test
    void whenTheDenylistCannotBeRead_failOpen_acceptsTheToken() {
        assertThat(new JwtDenylistValidator(broken(), true).validate(jwtWith("a")).hasErrors()).isFalse();
    }
}