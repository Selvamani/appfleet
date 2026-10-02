package io.appfleet.control.task.web;

import io.appfleet.control.task.Task;
import io.appfleet.control.task.TaskStatus;

import java.time.Instant;
import java.util.UUID;

public record TaskResponse(UUID id, UUID deploymentId, String taskType, TaskStatus status,
                           Instant createdAt, Instant updatedAt) {
    public static TaskResponse from(Task task) {
        return new TaskResponse(task.getId(), task.getDeployment().getId(),
                task.getTaskType(), task.getStatus(), task.getCreatedAt(), task.getUpdatedAt());
    }
}
