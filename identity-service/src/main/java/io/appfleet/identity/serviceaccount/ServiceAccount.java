package io.appfleet.identity.serviceaccount;

import io.appfleet.identity.common.Uuidv7;
import io.appfleet.identity.rbac.Role;
import io.appfleet.identity.team.Team;
import io.appfleet.identity.user.AppUser;
import jakarta.persistence.*;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.UUID;

@Entity
@Table(name = "service_account")
public class ServiceAccount {

    @Id
    private UUID id;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "team_id")
    private Team team;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "role_id")
    private Role role;

    @Column(nullable = false)
    private String name;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private ServiceAccountStatus status;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "created_by")
    private AppUser createdBy;

    @Column(name = "disabled_at")
    private Instant disabledAt;

    protected ServiceAccount() {}

    public ServiceAccount(Team teamId, Role roleId, String name, AppUser createdBy) {
        this.id = Uuidv7.generate();
        this.team = teamId;
        this.role = roleId;
        this.name = name;
        this.status = ServiceAccountStatus.ACTIVE;
        this.createdAt = Instant.now().truncatedTo(ChronoUnit.MICROS);
        this.createdBy  = createdBy ;
    }

    /** Calling it twice changes nothing. */
    public void disable() {
        if (status == ServiceAccountStatus.DISABLED) return;
        status = ServiceAccountStatus.DISABLED;
        disabledAt = Instant.now().truncatedTo(ChronoUnit.MICROS);
    }

    public boolean isActive() {
        return status == ServiceAccountStatus.ACTIVE;
    }

    public UUID getId() {
        return id;
    }

    public Team getTeam() {
        return team;
    }

    public Role getRole() {
        return role;
    }

    public String getName() {
        return name;
    }

    public ServiceAccountStatus getStatus() {
        return status;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public AppUser getCreatedBy() {
        return createdBy;
    }

    public Instant getDisabledAt() {
        return disabledAt;
    }
}
