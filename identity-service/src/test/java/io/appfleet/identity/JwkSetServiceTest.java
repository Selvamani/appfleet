package io.appfleet.identity;

import com.nimbusds.jose.JOSEException;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.jwk.JWK;
import com.nimbusds.jose.jwk.KeyUse;
import com.nimbusds.jose.jwk.RSAKey;
import com.nimbusds.jose.jwk.gen.RSAKeyGenerator;
import io.appfleet.identity.auth.JwkSetService;
import io.appfleet.identity.config.JwksProperties;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.ByteArrayResource;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;
import java.util.List;
import java.util.Map;
import java.util.stream.Collectors;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** The rotation window, with a fixed clock and no Spring: which keys are published at which moment. */
class JwkSetServiceTest {

    private static final Instant T0 = Instant.parse("2026-10-07T12:00:00Z");
    private static final Duration GRACE = Duration.ofMinutes(20);

    private static Clock at(Instant instant) {
        return Clock.fixed(instant, ZoneOffset.UTC);
    }

    private static RSAKey key() throws JOSEException {
        return new RSAKeyGenerator(2048).keyUse(KeyUse.SIGNATURE).algorithm(JWSAlgorithm.RS256).keyIDFromThumbprint(true).generate();
    }

    private static List<String> kids(JwkSetService service) {
        return service.publicSet().getKeys().stream().map(JWK::getKeyID).collect(Collectors.toList());
    }

    @Test
    void withNoRetiredKey_onlyTheCurrentKeyIsPublished_andItsKidIsItsThumbprint() throws JOSEException {
        RSAKey current = key();
        JwkSetService service = new JwkSetService(current.toPublicJWK(), List.of(), GRACE, at(T0));
        assertThat(kids(service)).containsExactly(current.getKeyID());
        assertThat(current.getKeyID()).isEqualTo(current.computeThumbprint().toString());
    }

    @Test
    void aRetiredKey_isPublishedUntilItsGraceEnds_andNotAMomentLonger() throws JOSEException {
        RSAKey current = key();
        RSAKey old = key();
        Instant retiredAt = T0;
        var retired = List.of(new JwkSetService.Retired(old.toPublicJWK(), retiredAt));

        assertThat(kids(new JwkSetService(current.toPublicJWK(), retired, GRACE, at(T0)))).containsExactly(current.getKeyID(), old.getKeyID());
        assertThat(kids(new JwkSetService(current.toPublicJWK(), retired, GRACE, at(T0.plus(GRACE).minusSeconds(1))))).as("one second before the end").hasSize(2);
        assertThat(kids(new JwkSetService(current.toPublicJWK(), retired, GRACE, at(T0.plus(GRACE))))).as("at the end").containsExactly(current.getKeyID());
        assertThat(kids(new JwkSetService(current.toPublicJWK(), retired, GRACE, at(T0.plus(GRACE).plusSeconds(1))))).as("after the end").containsExactly(current.getKeyID());
    }

    @Test
    void ofSeveralRetiredKeys_onlyTheOnesStillWithinTheirGraceAreListed() throws JOSEException {
        RSAKey current = key();
        RSAKey recent = key();
        RSAKey ancient = key();
        var retired = List.of(new JwkSetService.Retired(ancient.toPublicJWK(), T0.minus(Duration.ofDays(30))),
                new JwkSetService.Retired(recent.toPublicJWK(), T0.minus(Duration.ofMinutes(5))));
        assertThat(kids(new JwkSetService(current.toPublicJWK(), retired, GRACE, at(T0)))).containsExactly(current.getKeyID(), recent.getKeyID());
    }

    @Test
    void thePublishedSet_neverCarriesPrivateMaterial() throws JOSEException {
        RSAKey current = key();
        RSAKey old = key();
        JwkSetService service = new JwkSetService(current, List.of(new JwkSetService.Retired(old, T0)), GRACE, at(T0));   // even if handed PRIVATE keys
        service.publicSet().getKeys().forEach(k -> assertThat(k.isPrivate()).as("the set itself holds no private key (kid " + k.getKeyID() + ")").isFalse());
        for (Object entry : (List<?>) service.publicSet().toJSONObject(true).get("keys")) {
            @SuppressWarnings("unchecked")
            Map<String, Object> jwk = (Map<String, Object>) entry;
            assertThat(jwk.keySet()).doesNotContain("d", "p", "q", "dp", "dq", "qi");
            assertThat(jwk).containsKeys("kty", "n", "e", "kid", "alg", "use");
        }
    }

    @Test
    void theKeyThatSignsNow_cannotAlsoBeListedAsRetired() throws JOSEException {
        RSAKey current = key();
        assertThatThrownBy(() -> new JwkSetService(current.toPublicJWK(), List.of(new JwkSetService.Retired(current.toPublicJWK(), T0)), GRACE, at(T0)))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("must not be listed as retired");
    }

    @Test
    void theSettings_refuseAGraceShorterThanTheLongestTokenPlusTheSkew() {
        assertThatThrownBy(() -> new JwksProperties(List.of(), Duration.ofMinutes(15), Duration.ofMinutes(5))).hasMessageContaining("at least 16 minutes");
        assertThatThrownBy(() -> new JwksProperties(List.of(), Duration.ofMinutes(20), Duration.ofSeconds(-1))).hasMessageContaining("must not be negative");
        assertThatThrownBy(() -> new JwksProperties.RetiredKey(null, T0)).hasMessageContaining("needs both");
        assertThat(new JwksProperties(List.of(new JwksProperties.RetiredKey(new ByteArrayResource(new byte[0]), T0)), JwksProperties.MIN_GRACE, Duration.ZERO).retireGrace())
                .isEqualTo(Duration.ofMinutes(16));
    }
}