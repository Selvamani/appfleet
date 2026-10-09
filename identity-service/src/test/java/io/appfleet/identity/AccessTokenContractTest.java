package io.appfleet.identity;

import com.nimbusds.jwt.SignedJWT;
import io.appfleet.identity.rbac.RoleRepository;
import io.appfleet.identity.team.Team;
import io.appfleet.identity.team.TeamMembership;
import io.appfleet.identity.team.TeamMembershipRepository;
import io.appfleet.identity.team.TeamRepository;
import io.appfleet.identity.user.AppUser;
import io.appfleet.identity.user.UserRepository;
import io.appfleet.security.AppfleetJwtAuthenticationConverter;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtException;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;

import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The cross-module test: a token signed by identity-service is decoded by common-security's own decoder (the one
 * control-api runs) and mapped by its own authority converter. If the two modules disagree about a claim, this fails.
 */
class AccessTokenContractTest extends AuthHttpTest {

    @Autowired JwtDecoder decoder;
    @Autowired AppfleetJwtAuthenticationConverter converter;
    @Autowired UserRepository users;
    @Autowired TeamRepository teams;
    @Autowired TeamMembershipRepository memberships;
    @Autowired RoleRepository roles;

    private void grant(String email, Team team, String roleName) {
        AppUser user = users.findByEmail(email).orElseThrow();
        memberships.save(new TeamMembership(user, team, roles.findByName(roleName).orElseThrow()));
    }

    private String loginToken(String email) throws Exception {
        return body(login(email, PASSWORD)).get("accessToken").asString();
    }

    @Test
    void theIssuedToken_isAcceptedByCommonSecuritysDecoder_withTheContractClaims() throws Exception {
        String email = uniqueEmail();
        register(email, PASSWORD);
        Team a = teams.save(new Team("a-" + UUID.randomUUID()));
        Team b = teams.save(new Team("b-" + UUID.randomUUID()));
        grant(email, a, "DEPLOYER");
        grant(email, b, "VIEWER");
        UUID userId = users.findByEmail(email).orElseThrow().getId();

        String token = loginToken(email);
        Jwt jwt = decoder.decode(token);

        // not jwt.getIssuer(): Spring converts iss to a URL, and "appfleet-identity" is not one
        assertThat(jwt.getClaimAsString("iss")).isEqualTo("appfleet-identity");
        assertThat(jwt.getAudience()).containsExactly("appfleet");
        assertThat(jwt.getSubject()).isEqualTo(userId.toString());
        assertThat(UUID.fromString(jwt.getId())).isNotNull();
        assertThat(Duration.between(jwt.getIssuedAt(), jwt.getExpiresAt())).isEqualTo(Duration.ofMinutes(15));

        Map<String, List<String>> claim = jwt.getClaim("teams");
        assertThat(claim).containsOnlyKeys(a.getId().toString(), b.getId().toString());
        assertThat(claim.get(a.getId().toString())).containsExactly(
                "application:create", "application:read", "deployment:create", "deployment:read");
        assertThat(claim.get(b.getId().toString())).containsExactly("application:read", "deployment:read");

        assertThat(jwt.getClaims()).doesNotContainKeys("roles", "perms");
    }

    @Test
    void theHeader_isRs256AndTypeJwt() throws Exception {
        String email = uniqueEmail();
        String token = tokenFor(email);
        var header = SignedJWT.parse(token).getHeader();
        assertThat(header.getAlgorithm().getName()).isEqualTo("RS256");
        assertThat(header.getType().getType()).isEqualTo("JWT");
    }

    @Test
    void commonSecuritysConverter_turnsTheTeamsClaimIntoTheUnionOfPermissions() throws Exception {
        String email = uniqueEmail();
        register(email, PASSWORD);
        grant(email, teams.save(new Team("c-" + UUID.randomUUID())), "OPERATOR");

        JwtAuthenticationToken auth = (JwtAuthenticationToken) converter.convert(decoder.decode(loginToken(email)));
        Set<String> authorities = auth.getAuthorities().stream().map(GrantedAuthority::getAuthority).collect(Collectors.toSet());
        assertThat(authorities).containsExactlyInAnyOrder(
                "application:create", "application:read", "deployment:create", "deployment:read",
                "deployment:rollback", "node:drain");
    }

    @Test
    void aUserWithNoGrants_getsAValidTokenWithoutATeamsClaim() throws Exception {
        String email = uniqueEmail();
        Jwt jwt = decoder.decode(tokenFor(email));
        assertThat(jwt.getClaims()).doesNotContainKey("teams");
        JwtAuthenticationToken auth = (JwtAuthenticationToken) converter.convert(jwt);
        assertThat(auth.getAuthorities()).isEmpty();
    }

    @Test
    void aTamperedToken_isRefusedByTheDecoder() throws Exception {
        String token = tokenFor(uniqueEmail());
        String[] parts = token.split("\\.");
        String payload = new String(java.util.Base64.getUrlDecoder().decode(parts[1]), java.nio.charset.StandardCharsets.UTF_8)
                .replace("appfleet-identity", "appfleet-idemtity");
        String forged = parts[0] + "." + java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(payload.getBytes(java.nio.charset.StandardCharsets.UTF_8)) + "." + parts[2];
        assertThatThrownBy(() -> decoder.decode(forged)).isInstanceOf(JwtException.class);
    }

    @Test
    void everyLoginGetsItsOwnJti() throws Exception {
        String email = uniqueEmail();
        register(email, PASSWORD);
        String first = decoder.decode(loginToken(email)).getId();
        String second = decoder.decode(loginToken(email)).getId();
        assertThat(first).isNotEqualTo(second);
    }
}