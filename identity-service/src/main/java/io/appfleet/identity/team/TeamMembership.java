package io.appfleet.identity.team;

import io.appfleet.identity.common.Uuidv7;
import io.appfleet.identity.rbac.Role;
import io.appfleet.identity.user.AppUser;
import jakarta.persistence.*;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.UUID;

/** The scoped grant: this user holds this role on this team. One role per user per team. */
@Entity
@Table(name = "team_membership")
public class TeamMembership {

    @Id
    private UUID id;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "user_id")
    private AppUser user;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "team_id")
    private Team team;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "role_id")
    private Role role;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    protected TeamMembership() {}

    public TeamMembership(AppUser user, Team team, Role role) {
        this.id = Uuidv7.generate();
        this.user = user;
        this.team = team;
        this.role = role;
        this.createdAt = Instant.now().truncatedTo(ChronoUnit.MICROS);
    }

    public UUID getId() {
        return id;
    }

    public AppUser getUser() {
        return user;
    }

    public Team getTeam() {
        return team;
    }

    public void changeRole(Role role) {
        this.role = role;
    }

    public Role getRole() {
        return role;
    }
}
