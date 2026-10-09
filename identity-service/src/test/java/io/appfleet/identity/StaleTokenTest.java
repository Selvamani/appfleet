package io.appfleet.identity;

import io.appfleet.identity.rbac.RoleRepository;
import io.appfleet.identity.team.Team;
import io.appfleet.identity.team.TeamMembership;
import io.appfleet.identity.team.TeamMembershipRepository;
import io.appfleet.identity.team.TeamRepository;
import io.appfleet.identity.token.SessionRevocationService;
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
import tools.jackson.databind.JsonNode;

import java.time.Duration;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The deliberate bug of the spec, "stale permissions in a live JWT": a role is taken away, and the access token
 * issued before keeps carrying it until it expires. The first test keeps that behaviour on record; the others show
 * the denylist closing the window.
 */
class StaleTokenTest extends AuthHttpTest {

    @Autowired JwtDecoder decoder;
    @Autowired AppfleetJwtAuthenticationConverter converter;
    @Autowired UserRepository users;
    @Autowired TeamRepository teams;
    @Autowired TeamMembershipRepository memberships;
    @Autowired RoleRepository roles;
    @Autowired SessionRevocationService sessions;

    private record Setup(UUID userId, UUID teamId, JsonNode login, String email) {}

    private Setup deployerOnATeam() throws Exception {
        String email = uniqueEmail();
        register(email, PASSWORD);
        Team team = teams.save(new Team("stale-" + UUID.randomUUID()));
        AppUser user = users.findByEmail(email).orElseThrow();
        memberships.save(new TeamMembership(user, team, roles.findByName("DEPLOYER").orElseThrow()));
        return new Setup(user.getId(), team.getId(), body(login(email, PASSWORD)), email);
    }

    private void takeTheRoleAway(UUID userId) {
        jdbc.update("delete from team_membership where user_id = ?", userId);
    }

    private Set<String> authoritiesOf(Jwt jwt) {
        JwtAuthenticationToken auth = (JwtAuthenticationToken) converter.convert(jwt);
        return auth.getAuthorities().stream().map(GrantedAuthority::getAuthority).collect(Collectors.toSet());
    }

    /** The bug, on record: the role is gone from the database and the token still says deployment:create. */
    @Test
    void staleToken_keepsItsPermissions_afterTheRoleIsTakenAway() throws Exception {
        Setup s = deployerOnATeam();
        String access = s.login().get("accessToken").asString();
        takeTheRoleAway(s.userId());

        assertThat(jdbc.queryForObject("select count(*) from team_membership where user_id = ?", Integer.class, s.userId())).isZero();
        assertThat(authoritiesOf(decoder.decode(access))).as("the stale token still carries the permission").contains("deployment:create");
    }

    /** How long that window is when nothing revokes the token: the whole access-token lifetime. */
    @Test
    void theWindowWithoutRevocation_isTheAccessTokenLifetime() throws Exception {
        Jwt jwt = decoder.decode(deployerOnATeam().login().get("accessToken").asString());
        assertThat(Duration.between(jwt.getIssuedAt(), jwt.getExpiresAt())).isEqualTo(Duration.ofMinutes(15));
    }

    @Test
    void revokeAllSessions_closesTheWindow_forTheStaleAccessToken() throws Exception {
        Setup s = deployerOnATeam();
        String access = s.login().get("accessToken").asString();
        takeTheRoleAway(s.userId());

        sessions.revokeAllSessions(s.userId());

        assertThatThrownBy(() -> decoder.decode(access)).isInstanceOf(JwtException.class).hasMessageContaining("revoked");
    }

    @Test
    void revokeAllSessions_alsoEndsTheRefreshTokens_soTheOldGrantsCannotComeBackThroughARefresh() throws Exception {
        Setup s = deployerOnATeam();
        takeTheRoleAway(s.userId());
        int cut = sessions.revokeAllSessions(s.userId());
        assertThat(cut).isEqualTo(1);
        assertThat(post("/api/v1/auth/refresh", Map.of("refreshToken", s.login().get("refreshToken").asString())).statusCode()).isEqualTo(401);
    }

    @Test
    void afterRevokeAllSessions_aNewLoginSeesTheCurrentGrants() throws Exception {
        Setup s = deployerOnATeam();
        takeTheRoleAway(s.userId());
        sessions.revokeAllSessions(s.userId());
        Jwt fresh = decoder.decode(body(login(s.email(), PASSWORD)).get("accessToken").asString());
        assertThat(fresh.getClaims()).doesNotContainKey("teams");
        assertThat(authoritiesOf(fresh)).isEmpty();
    }

    @Test
    void revokeAllSessions_coversEverySessionOfTheUser() throws Exception {
        Setup s = deployerOnATeam();
        String second = body(login(s.email(), PASSWORD)).get("accessToken").asString();
        String first = s.login().get("accessToken").asString();
        sessions.revokeAllSessions(s.userId());
        assertThatThrownBy(() -> decoder.decode(first)).isInstanceOf(JwtException.class);
        assertThatThrownBy(() -> decoder.decode(second)).isInstanceOf(JwtException.class);
    }

    @Test
    void revokeAllSessions_doesNotTouchAnotherUser() throws Exception {
        Setup s = deployerOnATeam();
        String other = body(login(registerOther(), PASSWORD)).get("accessToken").asString();
        sessions.revokeAllSessions(s.userId());
        assertThat(decoder.decode(other)).isNotNull();
    }

    private String registerOther() throws Exception {
        String email = uniqueEmail();
        register(email, PASSWORD);
        return email;
    }
}