package io.appfleet.identity;

import io.appfleet.identity.auth.AccessTokenIssuer;
import io.appfleet.identity.rbac.RoleRepository;
import io.appfleet.identity.team.Team;
import io.appfleet.identity.team.TeamMembership;
import io.appfleet.identity.team.TeamMembershipRepository;
import io.appfleet.identity.team.TeamRepository;
import io.appfleet.identity.user.AppUser;
import io.appfleet.identity.user.UserRepository;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** The token travels in a header, so its size is a number to know, not a guess. */
class TokenSizeTest extends IdentityIntegrationTest {

    @Autowired AccessTokenIssuer issuer;
    @Autowired UserRepository users;
    @Autowired TeamRepository teams;
    @Autowired TeamMembershipRepository memberships;
    @Autowired RoleRepository roles;

    private AppUser userWithGrants(int teamCount, String roleName) {
        AppUser user = users.save(new AppUser("s-" + UUID.randomUUID() + "@x.io", "Sizer", "hash"));
        for (int i = 0; i < teamCount; i++) {
            Team team = teams.save(new Team("t-" + UUID.randomUUID()));
            memberships.save(new TeamMembership(user, team, roles.findByName(roleName).orElseThrow()));
        }
        return user;
    }

    private int size(int teamCount, String roleName) {
        int chars = issuer.issue(userWithGrants(teamCount, roleName)).value().length();
        System.out.println("TOKEN-SIZE teams=" + teamCount + " role=" + roleName + " characters=" + chars);
        return chars;
    }

    @Test
    void measured_typicalAndWorstCaseSizes() {
        int none = size(0, "VIEWER");
        int oneViewer = size(1, "VIEWER");
        int oneDeployer = size(1, "DEPLOYER");
        int oneAdmin = size(1, "ADMIN");
        int five = size(5, "DEPLOYER");
        int worst = size(AccessTokenIssuer.MAX_TEAMS, "ADMIN");   // the most one token can carry
        assertThat(none).isLessThan(oneViewer);
        assertThat(oneViewer).isLessThan(oneDeployer);
        assertThat(oneDeployer).isLessThan(oneAdmin);
        assertThat(five).isLessThan(worst);
        assertThat(worst).as("worst case stays under 4 KB, the smallest header limit commonly met").isLessThan(4096);
    }

    @Test
    void aUserWithMoreThanTheCap_getsNoToken() {
        AppUser user = userWithGrants(AccessTokenIssuer.MAX_TEAMS + 1, "VIEWER");
        assertThatThrownBy(() -> issuer.issue(user))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("at most " + AccessTokenIssuer.MAX_TEAMS);
    }

    @Test
    void aUserAtTheCap_getsAToken() {
        assertThat(issuer.issue(userWithGrants(AccessTokenIssuer.MAX_TEAMS, "VIEWER")).value()).isNotBlank();
    }
}