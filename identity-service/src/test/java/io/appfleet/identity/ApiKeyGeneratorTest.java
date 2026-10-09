package io.appfleet.identity;

import io.appfleet.identity.serviceaccount.ApiKeyGenerator;
import io.appfleet.identity.serviceaccount.ServiceAccountProperties;
import io.appfleet.identity.token.TokenHasher;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.util.HashSet;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** No Spring, no database: the key format and the two settings. */
class ApiKeyGeneratorTest {

    @Test
    void aKey_hasTheAgreedShape_andItsHashIsOfTheWholeKey() {
        ApiKeyGenerator.Generated g = ApiKeyGenerator.generate();
        assertThat(g.key()).startsWith("afk_").hasSize(59).matches("^afk_[A-Za-z0-9_-]{11}\\.[A-Za-z0-9_-]{43}$");
        assertThat(g.prefix()).hasSize(11);
        assertThat(g.hash()).matches("^[0-9a-f]{64}$").isEqualTo(TokenHasher.hash(g.key()));
        assertThat(ApiKeyGenerator.prefixOf(g.key())).contains(g.prefix());
    }

    @Test
    void keys_doNotRepeat() {
        Set<String> keys = new HashSet<>();
        Set<String> prefixes = new HashSet<>();
        for (int i = 0; i < 2000; i++) {
            ApiKeyGenerator.Generated g = ApiKeyGenerator.generate();
            keys.add(g.key());
            prefixes.add(g.prefix());
        }
        assertThat(keys).hasSize(2000);
        assertThat(prefixes).hasSize(2000);
    }

    @Test
    void textThatCannotBeAKey_hasNoPrefix() {
        String good = ApiKeyGenerator.generate().key();
        assertThat(ApiKeyGenerator.prefixOf(null)).isEmpty();
        assertThat(ApiKeyGenerator.prefixOf("")).isEmpty();
        assertThat(ApiKeyGenerator.prefixOf("hello")).isEmpty();
        assertThat(ApiKeyGenerator.prefixOf("xyz_" + good.substring(4))).as("wrong tag").isEmpty();
        assertThat(ApiKeyGenerator.prefixOf(good + "x")).as("too long").isEmpty();
        assertThat(ApiKeyGenerator.prefixOf(good.substring(1))).as("too short").isEmpty();
        assertThat(ApiKeyGenerator.prefixOf(good.substring(0, 15) + "_" + good.substring(16))).as("no dot where it belongs").isEmpty();
    }

    @Test
    void theSettings_haveSafeLimits() {
        assertThat(new ServiceAccountProperties(Duration.ofMinutes(5), 2).tokenTtl()).isEqualTo(Duration.ofMinutes(5));
        assertThat(new ServiceAccountProperties(Duration.ofMinutes(15), 1).maxActiveKeys()).isEqualTo(1);
        assertThatThrownBy(() -> new ServiceAccountProperties(Duration.ofMinutes(16), 2)).hasMessageContaining("at most 15 minutes");
        assertThatThrownBy(() -> new ServiceAccountProperties(Duration.ZERO, 2)).hasMessageContaining("above 0");
        assertThatThrownBy(() -> new ServiceAccountProperties(Duration.ofMinutes(5), 0)).hasMessageContaining("at least 1");
    }
}