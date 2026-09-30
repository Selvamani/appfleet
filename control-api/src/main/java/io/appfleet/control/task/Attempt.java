package io.appfleet.control.task;

import io.appfleet.control.common.Uuidv7;
import jakarta.persistence.*;

import java.time.Instant;
import java.util.UUID;

@Entity
@Table(name = "attempt")
public class Attempt {
    @Id
    private UUID id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "task_id", nullable = false)
    private Task task;

    @Column(name = "attempt_number", nullable = false)
    private int attemptNumber;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private TaskStatus status;

    @Column(name = "started_At", nullable = false)
    private Instant startedAt;

    @Column(name = "finished_at")
    private Instant finishedAt;

    @Column(name = "error_detail")
    private String errorDetail;

    protected Attempt() {}

    public Attempt(Task task, int attemptNumber) {
        this.id = Uuidv7.generate();
        this.task = task;
        this.attemptNumber = attemptNumber;
        this.status = TaskStatus.PENDING;
        this.startedAt = Instant.now();
    }

    public void complete() {
        this.status = TaskStatus.SUCCEEDED;
        this.finishedAt = Instant.now();
    }

    public void fail(String errorDetail) {
        this.status = TaskStatus.FAILED;
        this.errorDetail = errorDetail;
        this.finishedAt = Instant.now();
    }

    public UUID getId() {
        return id;
    }

    public Task getTask() {
        return task;
    }

    public int getAttemptNumber() {
        return attemptNumber;
    }

    public TaskStatus getStatus() {
        return status;
    }

    public Instant getStartedAt() {
        return startedAt;
    }

    public Instant getFinishedAt() {
        return finishedAt;
    }

    public String getErrorDetail() {
        return errorDetail;
    }
}
