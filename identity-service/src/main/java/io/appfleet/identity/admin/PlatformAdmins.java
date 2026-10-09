package io.appfleet.identity.admin;

import io.appfleet.identity.rbac.RoleRepository;
import io.appfleet.identity.team.PlatformTeam;
import io.appfleet.identity.team.TeamMembership;
import io.appfleet.identity.team.TeamMembershipRepository;
import io.appfleet.identity.team.TeamRepository;
import io.appfleet.identity.user.AppUser;
import io.appfleet.identity.user.UserRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

/**
 * The way in: the first platform administrator cannot be made by an administrator. A deployment names an email address
 * (appfleet.identity.bootstrap.admin-email); PlatformBootstrapRunner calls this at start-up. The user registers as anyone
 * does, with their own password; no password is ever configured. It is a separate bean from the runner so that the
 * @Transactional here is not a self-invocation.
 */
@Service
public class PlatformAdmins {

    private final UserRepository users;
    private final TeamRepository teams;
    private final RoleRepository roles;
    private final TeamMembershipRepository memberships;

    public PlatformAdmins(UserRepository users, TeamRepository teams, RoleRepository roles, TeamMembershipRepository memberships) {
        this.users = users;
        this.teams = teams;
        this.roles = roles;
        this.memberships = memberships;
    }

    /** True when a grant was made; false when the user is unknown or already holds a role in the platform team. */
    @Transactional
    public boolean promote(String email) {
        AppUser user = users.findByEmail(AppUser.normalize(email)).orElse(null);
        if (user == null) return false;
        if (memberships.findByTeam_IdAndUser_Id(PlatformTeam.ID, user.getId()).isPresent()) return false;
        var team = teams.findById(PlatformTeam.ID).orElseThrow(() -> new IllegalStateException("the platform team is missing: V6 did not run"));
        var admin = roles.findByName(TeamAdminService.ADMIN).orElseThrow(() -> new IllegalStateException("the ADMIN role is missing"));
        memberships.save(new TeamMembership(user, team, admin));
        return true;
    }
}