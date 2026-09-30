package io.appfleet.control.application;

import io.appfleet.control.common.Uuidv7;
import io.appfleet.control.deployment.Deployment;
import jakarta.persistence.*;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

@Entity
@Table(name = "application")
public class Application {

    @Id
    private UUID id;

    @Column(nullable = false, unique = true)
    private String name;

    private String description;

    @OneToMany(mappedBy = "application", fetch = FetchType.LAZY)
    private List<Deployment> deployments = new ArrayList<>();

    @OneToMany(mappedBy = "application", fetch = FetchType.LAZY)
    private List<Release> releases = new ArrayList<>();

    @Column(name = "owner_team_id", nullable = false)
    private UUID ownerTeamId;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    protected Application() {}

    public Application(String name, String description, UUID ownerTeamId) {
        this.id = Uuidv7.generate();
        this.name = name;
        this.description = description;
        this.ownerTeamId = ownerTeamId;
        this.createdAt = Instant.now().truncatedTo(ChronoUnit.MICROS);
    }

    public UUID getId() {
        return id;
    }

    public String getName() {
        return name;
    }

    public String getDescription() {
        return description;
    }

    public List<Deployment> getDeployments() {
        return deployments;
    }

    public List<Release> getReleases() {
        return releases;
    }

    public UUID getOwnerTeamId() {
        return ownerTeamId;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }
}
