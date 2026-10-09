package io.appfleet.identity.admin;

import io.appfleet.identity.admin.AdminDTOs.AddMember;
import io.appfleet.identity.admin.AdminDTOs.ChangeRole;
import io.appfleet.identity.admin.AdminDTOs.CreateTeam;
import io.appfleet.identity.admin.AdminDTOs.MemberView;
import io.appfleet.identity.admin.AdminDTOs.TeamView;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.PutMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.UUID;

/**
 * Teams are created and listed by platform administrators; the members of a team are managed by that team's ADMINs (or by
 * the platform's). The team id in the path is what the guard checks against the token, so a team administrator never
 * reaches another team.
 */
@RestController
@RequestMapping("/api/v1/teams")
public class TeamController {

    private final TeamAdminService teams;

    public TeamController(TeamAdminService teams) {
        this.teams = teams;
    }

    @GetMapping
    @PreAuthorize("@guard.platformAdmin(authentication)")
    List<TeamView> list() {
        return teams.listTeams();
    }

    @PostMapping
    @PreAuthorize("@guard.platformAdmin(authentication)")
    ResponseEntity<TeamView> create(@Valid @RequestBody CreateTeam request) {
        return ResponseEntity.status(HttpStatus.CREATED).body(teams.createTeam(request.name()));
    }

    @GetMapping("/{teamId}/members")
    @PreAuthorize("@guard.teamAdmin(authentication, #teamId)")
    List<MemberView> members(@PathVariable UUID teamId) {
        return teams.members(teamId);
    }

    @PostMapping("/{teamId}/members")
    @PreAuthorize("@guard.teamAdmin(authentication, #teamId)")
    ResponseEntity<MemberView> addMember(@PathVariable UUID teamId, @Valid @RequestBody AddMember request) {
        return ResponseEntity.status(HttpStatus.CREATED).body(teams.addMember(teamId, request.userId(), request.role()));
    }

    @PutMapping("/{teamId}/members/{userId}")
    @PreAuthorize("@guard.teamAdmin(authentication, #teamId)")
    MemberView changeRole(@PathVariable UUID teamId, @PathVariable UUID userId, @Valid @RequestBody ChangeRole request) {
        return teams.changeRole(teamId, userId, request.role());
    }

    @DeleteMapping("/{teamId}/members/{userId}")
    @PreAuthorize("@guard.teamAdmin(authentication, #teamId)")
    ResponseEntity<Void> removeMember(@PathVariable UUID teamId, @PathVariable UUID userId) {
        teams.removeMember(teamId, userId);
        return ResponseEntity.noContent().build();
    }
}