package io.appfleet.security.testing;

import com.nimbusds.jwt.SignedJWT;
import org.junit.jupiter.api.Test;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

class TestFixturesTest {

    @Test
    void publicAndPrivateKeyMatch() {
        assertThat(TestKeys.PUBLIC.getModulus()).isEqualTo(TestKeys.PRIVATE.getModulus());
    }

    @Test void otherKeyDiffers() {
        assertThat(TestKeys.OTHER_PRIVATE.getModulus()).isNotEqualTo(TestKeys.PRIVATE.getModulus());
    }
    @Test void signedToken_hasContractClaims() throws Exception {
        UUID team = UUID.randomUUID();
        var claims = SignedJWT.parse(TestJwt.forUser(UUID.randomUUID()).team(team, "a:b").perm("c:d").sign()).getJWTClaimsSet();
        assertThat(claims.getIssuer()).isEqualTo("appfleet-identity");
        assertThat(claims.getAudience()).containsExactly("appfleet");
        assertThat(claims.getJWTID()).isNotBlank();
        assertThat(claims.getClaim("teams")).isNotNull();
        assertThat(claims.getStringListClaim("perms")).containsExactly("c:d");
    }
    @Test void noTeams_meansNoTeamsClaim() throws Exception {
        assertThat(SignedJWT.parse(TestJwt.forUser(UUID.randomUUID()).sign()).getJWTClaimsSet().getClaim("teams")).isNull();
    }
}

