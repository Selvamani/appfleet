package io.appfleet.identity.admin;

import io.appfleet.identity.admin.AdminDTOs.MemberView;
import io.appfleet.identity.admin.AdminDTOs.TeamView;
import io.appfleet.identity.auth.AccessTokenIssuer;
import io.appfleet.identity.common.ApiExceptions.ConflictException;
import io.appfleet.identity.common.ApiExceptions.InvalidFieldException;
import io.appfleet.identity.common.ApiExceptions.NotFoundException;
import io.appfleet.identity.common.ApiExceptions.UnprocessableException;
import io.appfleet.identity.rbac.Role;
import io.appfleet.identity.rbac.RoleRepository;
import io.appfleet.identity.team.Team;
import io.appfleet.identity.team.TeamMembership;
import io.appfleet.identity.team.TeamMembershipRepository;
import io.appfleet.identity.team.TeamRepository;
import io.appfleet.identity.token.SessionRevocationService;
import io.appfleet.identity.user.AppUser;
import io.appfleet.identity.user.UserRepository;
import io.appfleet.identity.user.UserStatus;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.UUID;

/**
 * Teams and who holds which role in them. Two rules live here and nowhere else:
 * a change or removal of a grant ends the sessions of that user (their tokens still carry the old permissions), and a team
 * always keeps one ADMIN (otherwise nobody could manage it again).
 */
@Service
public class TeamAdminService {

    static final String ADMIN = "ADMIN";

    private final TeamRepository teams;
    private final TeamMembershipRepository memberships;
    private final UserRepository users;
    private final RoleRepository roles;
    private final SessionRevocationService sessions;

    public TeamAdminService(TeamRepository teams, TeamMembershipRepository memberships, UserRepository users,
                            RoleRepository roles, SessionRevocationService sessions) {
        this.teams = teams;
        this.memberships = memberships;
        this.users = users;
        this.roles = roles;
        this.sessions = sessions;
    }

    @Transactional
    public TeamView createTeam(String name) {
        String clean = name.trim();
        if (teams.existsByName(clean)) throw new ConflictException("a team with that name exists");
        try {
            return view(teams.save(new Team(clean)));
        } catch (DataIntegrityViolationException e) {
            throw new ConflictException("a team with that name exists");   // two requests raced past existsByName; the unique key decided
        }
    }

    @Transactional(readOnly = true)
    public List<TeamView> listTeams() {
        return teams.findAllByOrderByNameAsc().stream().map(TeamAdminService::view).toList();
    }

    @Transactional(readOnly = true)
    public List<MemberView> members(UUID teamId) {
        team(teamId);
        return memberships.findMembers(teamId).stream().map(TeamAdminService::view).toList();
    }

    /** A new grant needs no session change: tokens already issued carry less than the user now has, and the next refresh carries the new grant. */
    @Transactional
    public MemberView addMember(UUID teamId, UUID userId, String roleName) {
        Team team = team(teamId);
        AppUser user = users.findById(userId).orElseThrow(() -> new NotFoundException("user"));
        if (user.getStatus() != UserStatus.ACTIVE) throw new ConflictException("the user is deactivated");
        Role role = role(roleName);
        if (memberships.findByTeam_IdAndUser_Id(teamId, userId).isPresent()) throw new ConflictException("the user is already a member of the team");
        if (memberships.countByUser_Id(userId) >= AccessTokenIssuer.MAX_TEAMS)
            throw new UnprocessableException("team-limit", "a user can be a member of at most " + AccessTokenIssuer.MAX_TEAMS + " teams (one token carries that many grants)");
        try {
            return view(memberships.save(new TeamMembership(user, team, role)));
        } catch (DataIntegrityViolationException e) {
            throw new ConflictException("the user is already a member of the team");
        }
    }

    @Transactional
    public MemberView changeRole(UUID teamId, UUID userId, String roleName) {
        TeamMembership membership = membership(teamId, userId);
        Role role = role(roleName);
        if (ADMIN.equals(membership.getRole().getName()) && !ADMIN.equals(role.getName())) keepsAnAdmin(teamId);
        membership.changeRole(role);
        MemberView changed = view(membership);   // before the revocation: its bulk update clears the persistence context
        sessions.revokeAllSessions(userId);      // the tokens in the air still say the old role
        return changed;
    }

    @Transactional
    public void removeMember(UUID teamId, UUID userId) {
        TeamMembership membership = membership(teamId, userId);
        if (ADMIN.equals(membership.getRole().getName())) keepsAnAdmin(teamId);
        memberships.delete(membership);
        sessions.revokeAllSessions(userId);
    }

    /** Called before an ADMIN stops being one: there must be another. */
    private void keepsAnAdmin(UUID teamId) {
        if (memberships.countByTeam_IdAndRole_Name(teamId, ADMIN) <= 1) throw new ConflictException("a team must keep at least one ADMIN");
    }

    private Team team(UUID id) {
        return teams.findById(id).orElseThrow(() -> new NotFoundException("team"));
    }

    private Role role(String name) {
        return roles.findByName(name).orElseThrow(() -> new InvalidFieldException("role", "unknown role"));
    }

    private TeamMembership membership(UUID teamId, UUID userId) {
        return memberships.findByTeam_IdAndUser_Id(teamId, userId).orElseThrow(() -> new NotFoundException("membership"));
    }

    private static TeamView view(Team t) {
        return new TeamView(t.getId(), t.getName(), t.getCreatedAt());
    }

    private static MemberView view(TeamMembership m) {
        return new MemberView(m.getUser().getId(), m.getUser().getEmail(), m.getUser().getDisplayName(), m.getRole().getName());
    }
}