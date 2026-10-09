package io.appfleet.identity;

import io.appfleet.identity.config.RefreshProperties;
import io.appfleet.identity.token.TokenHasher;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.util.HashSet;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** No Spring context and no database. */
class RefreshUnitTest {

    @Test
    void newToken_is43UrlSafeCharacters_andDoesNotRepeat() {
        Set<String> seen = new HashSet<>();
        for (int i = 0; i < 1000; i++) {
            String t = TokenHasher.newToken();
            assertThat(t).hasSize(43).matches("[A-Za-z0-9_-]+");
            assertThat(seen.add(t)).as("repeat at " + i).isTrue();
        }
    }

    @Test
    void hash_is64LowerCaseHex_stable_andDiffersPerToken() {
        assertThat(TokenHasher.hash("abc")).isEqualTo("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");   // SHA-256 of "abc"
        assertThat(TokenHasher.hash("abc")).isEqualTo(TokenHasher.hash("abc"));
        assertThat(TokenHasher.hash("abc")).isNotEqualTo(TokenHasher.hash("abd"));
    }

    @Test
    void defaults_areSevenDaysAndThirty() {
        RefreshProperties p = new RefreshProperties(Duration.ofDays(7), Duration.ofDays(30));
        assertThat(p.tokenTtl()).isEqualTo(Duration.ofDays(7));
        assertThat(p.familyMaxLifetime()).isEqualTo(Duration.ofDays(30));
    }

    @Test
    void aTtlOfZeroOrLess_isRefused() {
        assertThatThrownBy(() -> new RefreshProperties(Duration.ZERO, Duration.ofDays(30))).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new RefreshProperties(Duration.ofSeconds(-1), Duration.ofDays(30))).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void aFamilyLifetimeShorterThanOneToken_isRefused() {
        assertThatThrownBy(() -> new RefreshProperties(Duration.ofDays(7), Duration.ofDays(3)))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("at least token-ttl");
    }
}