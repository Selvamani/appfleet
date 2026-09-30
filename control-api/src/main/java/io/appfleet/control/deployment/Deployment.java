package io.appfleet.control.deployment;

import io.appfleet.control.application.Application;
import io.appfleet.control.application.Release;
import io.appfleet.control.common.Uuidv7;
import io.appfleet.control.environment.Environment;
import io.appfleet.control.task.Task;
import jakarta.persistence.*;
import org.hibernate.annotations.BatchSize;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

@Entity
@Table(name = "deployment")
public class Deployment {
    @Id
    private UUID id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "application_id", nullable = false)
    private Application application;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "release_id", nullable = false)
    private Release release;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "environment_id", nullable = false)
    private Environment environment;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private DeploymentState status;

    @Enumerated(EnumType.STRING)
    @Column(name = "current_status", nullable = false)
    private DeploymentState currentStatus;

    @OneToMany(mappedBy = "deployment", fetch = FetchType.LAZY)
    @BatchSize(size = 25)
    private List<Task> tasks = new ArrayList<>();

    @Version
    private Long version;

    @Column(name = "created_at")
    private Instant createdAt;

    @Column(name = "updated_at")
    private Instant updatedAt;

    protected Deployment() {}

    public Deployment(Application application, Release release, Environment environment) {
        this.id = Uuidv7.generate();
        this.application = application;
        this.release = release;
        this.environment = environment;
        this.status = DeploymentState.PENDING;
        this.currentStatus = DeploymentState.PENDING;
        this.createdAt = Instant.now().truncatedTo(ChronoUnit.MICROS);
        this.updatedAt = Instant.now().truncatedTo(ChronoUnit.MICROS);
    }

    public void transitionTo(DeploymentState target) {
        if(!status.canTransitionTo(target)) {
            throw new IllegalTransitionException("Illegal transition from "+ status + " to "+ target);
        }
        this.status =  target;
        this.updatedAt = Instant.now();
    }

    public UUID getId() {
        return id;
    }

    public Application getApplication() {
        return application;
    }

    public Release getRelease() {
        return release;
    }

    public Environment getEnvironment() {
        return environment;
    }

    public DeploymentState getStatus() {
        return status;
    }

    public DeploymentState getCurrentStatus() {
        return currentStatus;
    }

    public List<Task> getTasks() {
        return tasks;
    }

    public Long getVersion() {
        return version;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public Instant getUpdatedAt() {
        return updatedAt;
    }
}
