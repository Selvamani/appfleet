package io.appfleet.identity;

import io.appfleet.identity.rbac.PermissionResolver;
import io.appfleet.identity.rbac.Role;
import io.appfleet.identity.rbac.RoleRepository;
import io.appfleet.identity.team.*;
import io.appfleet.identity.user.AppUser;
import io.appfleet.identity.user.UserRepository;
import jakarta.persistence.EntityManagerFactory;
import org.hibernate.SessionFactory;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.security.access.hierarchicalroles.RoleHierarchy;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.authority.SimpleGrantedAuthority;

import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class RbacTest extends IdentityIntegrationTest {

    @Autowired
    PermissionResolver resolver;
    @Autowired
    RoleHierarchy hierarchy;
    @Autowired
    RoleRepository roles;
    @Autowired
    UserRepository users;
    @Autowired
    TeamRepository teams;
    @Autowired
    TeamMembershipRepository memberships;
    @Autowired
    EntityManagerFactory emf;

    @Test
    void viewer_hasOnlyTheReadPermissions() {
        assertThat(resolver.permissionsFor("VIEWER")).containsExactly("application:read", "deployment:read");
    }

    @Test
    void deployer_inheritsViewer() {
        assertThat(resolver.permissionsFor("DEPLOYER")).containsExactly(
                "application:create", "application:read", "deployment:create", "deployment:read");
    }

    @Test
    void operator_inheritsDeployerAndViewer() {
        assertThat(resolver.permissionsFor("OPERATOR")).containsExactly(
                "application:create", "application:read", "deployment:create", "deployment:read",
                "deployment:rollback", "node:drain");
    }

    @Test
    void admin_holdsEveryPermission() {
        Set<String> all = new HashSet<>(jdbc.queryForList("select name from permission", String.class));
        assertThat(resolver.permissionsFor("ADMIN")).isEqualTo(all).hasSize(8);
    }

    @Test
    void unknownRole_isRefused() {
        assertThatThrownBy(() -> resolver.permissionsFor("ROOT"))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("ROOT");
    }

    /**
     * The hierarchy lives in code, the roles in the database; they must name the same four roles.
     */
    @Test
    void hierarchy_andDatabase_nameTheSameRoles() {
        Set<String> inDb = new HashSet<>(jdbc.queryForList("select name from role", String.class));
        Set<String> fromTop = hierarchy.getReachableGrantedAuthorities(List.of(new SimpleGrantedAuthority("ADMIN")))
                .stream().map(GrantedAuthority::getAuthority).collect(Collectors.toSet());
        assertThat(fromTop).isEqualTo(inDb);
    }

    @Test
    void grants_ofOneUser_comeBackInOneSelect() {
        AppUser user = users.save(new AppUser("g-" + UUID.randomUUID() + "@x.io", "Gus", "hash"));
        Team a = teams.save(new Team("a-" + UUID.randomUUID()));
        Team b = teams.save(new Team("b-" + UUID.randomUUID()));
        Role deployer = roles.findByName("DEPLOYER").orElseThrow();
        Role viewer = roles.findByName("VIEWER").orElseThrow();
        memberships.save(new TeamMembership(user, a, deployer));
        memberships.save(new TeamMembership(user, b, viewer));

        var statistics = emf.unwrap(SessionFactory.class).getStatistics();
        statistics.clear();
        List<TeamRole> grants = memberships.findGrantsByUserId(user.getId());
        assertThat(statistics.getPrepareStatementCount()).as("statements").isEqualTo(1);
        assertThat(grants).containsExactlyInAnyOrder(new TeamRole(a.getId(), "DEPLOYER"), new TeamRole(b.getId(), "VIEWER"));
    }

    @Test
    void aUserWithNoMembership_hasNoGrants() {
        AppUser user = users.save(new AppUser("n-" + UUID.randomUUID() + "@x.io", "Nil", "hash"));
        assertThat(memberships.findGrantsByUserId(user.getId())).isEmpty();
    }
}