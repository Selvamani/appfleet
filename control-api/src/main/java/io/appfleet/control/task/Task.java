package io.appfleet.control.task;

import io.appfleet.control.common.Uuidv7;
import io.appfleet.control.deployment.Deployment;
import jakarta.persistence.*;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

@Entity
@Table(name = "task")
public class Task {

    public static final String DEPLOY = "DEPLOY";
    public static final String ROLLBACK = "ROLLBACK";

    @Id
    private UUID id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "deployment_id", nullable = false)
    private Deployment deployment;

    @Column(name = "task_type", nullable = false)
    private String taskType;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private TaskStatus status;

    @OneToMany(mappedBy = "task", fetch = FetchType.LAZY)
    private List<Attempt> attempts = new ArrayList<>();

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    @Column(name = "updated_at", nullable = false)
    private Instant updatedAt;

    protected Task() {}

    public Task(Deployment deployment, String taskType) {
        this.id = Uuidv7.generate();
        this.deployment = deployment;
        this.taskType = taskType;
        this.status = TaskStatus.PENDING;
        Instant now = Instant.now().truncatedTo(ChronoUnit.MICROS);
        this.createdAt = now;
        this.updatedAt = now;

    }

    public UUID getId() {
        return id;
    }

    public Deployment getDeployment() {
        return deployment;
    }

    public String getTaskType() {
        return taskType;
    }

    public TaskStatus getStatus() {
        return status;
    }

    public List<Attempt> getAttempts() {
        return attempts;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }

    public Instant getUpdatedAt() {
        return updatedAt;
    }
}
