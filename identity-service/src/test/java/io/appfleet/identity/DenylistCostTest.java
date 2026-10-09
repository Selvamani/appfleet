package io.appfleet.identity;

import io.appfleet.security.RedisJwtDenylist;
import io.appfleet.security.testing.TestJwt;
import io.appfleet.security.testing.TestKeys;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

/** The cost of asking Redis on every request, as numbers for the denylist-versus-short-expiry argument. */
class DenylistCostTest extends IdentityIntegrationTest {

    private static final int N = 2000;

    @Autowired RedisJwtDenylist denylist;
    @Autowired JwtDecoder decoderWithDenylist;

    private static double microsPerCall(Runnable call) {
        for (int i = 0; i < 200; i++) call.run();   // warm up
        long start = System.nanoTime();
        for (int i = 0; i < N; i++) call.run();
        return (System.nanoTime() - start) / 1000.0 / N;
    }

    @Test
    void measured_theDenylistLookupAndTheDecodeWithAndWithout() {
        String token = TestJwt.forUser(UUID.randomUUID()).sign();
        JwtDecoder withoutDenylist = NimbusJwtDecoder.withPublicKey(TestKeys.PUBLIC).build();   // signature only: a floor, not the real decoder

        double lookup = microsPerCall(() -> denylist.isRevoked(UUID.randomUUID().toString()));
        double decodeWith = microsPerCall(() -> decoderWithDenylist.decode(token));
        double decodeSignatureOnly = microsPerCall(() -> withoutDenylist.decode(token));

        System.out.printf("DENYLIST-COST lookup=%.0f us  decode_with_denylist=%.0f us  decode_signature_only=%.0f us  (n=%d, Redis in a local container)%n",
                lookup, decodeWith, decodeSignatureOnly, N);
        assertThat(lookup).as("one Redis lookup stays far below a millisecond-scale budget").isLessThan(5000.0);
        assertThat(decodeWith).isGreaterThan(0.0);
    }
}