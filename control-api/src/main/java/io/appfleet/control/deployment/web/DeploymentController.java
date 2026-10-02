package io.appfleet.control.deployment.web;

import io.appfleet.control.deployment.DeploymentService;
import io.appfleet.control.idempotency.IdempotencyExecutor;
import io.appfleet.control.idempotency.IdempotencyKeys;
import io.appfleet.control.idempotency.Idempotent;
import io.appfleet.control.task.TaskService;
import io.appfleet.control.task.web.TaskResponse;
import io.appfleet.control.web.CursorCodec;
import io.appfleet.control.web.CursorPage;
import io.appfleet.control.web.OffsetPage;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.net.URI;
import java.util.UUID;

@RestController
@RequestMapping("/api/v1/deployments")
public class DeploymentController {

    private static final String SYSTEM_ACTOR = "system";   // until S4 provides a principal

    private final DeploymentService service;
    private final TaskService taskService;
    private final IdempotencyExecutor idempotencyExecutor;

    public DeploymentController(DeploymentService service, TaskService taskService, IdempotencyExecutor idempotencyExecutor) {
        this.service = service;
        this.taskService = taskService;
        this.idempotencyExecutor = idempotencyExecutor;
    }

    @PostMapping
    public ResponseEntity<DeploymentAccepted> requestDeployment(
            @Valid @RequestBody CreateDeploymentRequest request,
            @RequestHeader(name = "Idempotency-Key", required = false) String idempotencyKey) {
        Idempotent<DeploymentAccepted> outcome;
        if (idempotencyKey == null) {
            outcome = new Idempotent<>(service.requestDeployment(request, SYSTEM_ACTOR), false);
        } else {
            IdempotencyKeys.validate(idempotencyKey);
            outcome = idempotencyExecutor.execute("deployments:" + idempotencyKey, request, DeploymentAccepted.class,
                    () -> service.requestDeployment(request, SYSTEM_ACTOR));
        }
        DeploymentAccepted accepted = outcome.value();
        return ResponseEntity.accepted()
                .location(URI.create("/api/v1/tasks/"+accepted.taskId()))
                .header("Idempotent-Replayed", String.valueOf(outcome.replayed()))
                .body(accepted);
    }

    @GetMapping("/{id}")
    public DeploymentResponse get(@PathVariable UUID id) {
        return service.get(id);
    }

    @PostMapping("/{id}/rollback")
    public ResponseEntity<RollbackAccepted> requestRollback(@PathVariable UUID id) {
        RollbackAccepted accepted = service.requestRollback(id, SYSTEM_ACTOR);
        return ResponseEntity.accepted().location(URI.create("/api/v1/tasks/"+accepted.taskId())).body(accepted);
    }

    @GetMapping("/{id}/tasks")
    public CursorPage<TaskResponse> tasks(@PathVariable UUID id,
                                        @RequestParam(required = false) String cursor,
                                        @RequestParam(defaultValue = "20") @Min(1) @Max(100) int limit) {
        UUID decodedCursor = cursor == null ? null : CursorCodec.decode(cursor);
        return taskService.history(id, decodedCursor, limit);
    }

    @GetMapping("/{id}/tasks/by-offset")
    public OffsetPage<TaskResponse> tasksByOffset(@PathVariable UUID id,
                                                  @RequestParam(defaultValue = "0") @Min(0) int page,
                                                  @RequestParam(defaultValue = "20") @Min(1) @Max(100) int size) {
        return taskService.historyByOffset(id, page, size);
    }
}
