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
import io.appfleet.control.web.openapi.ProblemKind;
import io.appfleet.control.web.openapi.ProblemResponses;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.headers.Header;
import io.swagger.v3.oas.annotations.media.Content;
import io.swagger.v3.oas.annotations.media.Schema;
import io.swagger.v3.oas.annotations.responses.ApiResponse;
import io.swagger.v3.oas.annotations.tags.Tag;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.*;
import org.springframework.security.core.Authentication;

import java.net.URI;
import java.util.UUID;

@Tag(name = "Deployments", description = "Request a deployment or a rollback, and read a deployment and its task history.")
@RestController
@RequestMapping("/api/v1/deployments")
public class DeploymentController {

    private final DeploymentService service;
    private final TaskService taskService;
    private final IdempotencyExecutor idempotencyExecutor;

    public DeploymentController(DeploymentService service, TaskService taskService, IdempotencyExecutor idempotencyExecutor) {
        this.service = service;
        this.taskService = taskService;
        this.idempotencyExecutor = idempotencyExecutor;
    }

    @Operation(summary = "Request a deployment",
            description = "Accepted, not done: the work runs later. Follow the Location header to GET /tasks/{id}.")
    @ApiResponse(responseCode = "202", description = "Accepted",
            headers = {
                    @Header(name = "Location", description = "URL of the task to poll", schema = @Schema(type = "string")),
                    @Header(name = "Idempotent-Replayed", description = "true when this answer is a replay of an earlier request with the same key",
                            schema = @Schema(type = "boolean"))},
            content = @Content(mediaType = "application/json", schema = @Schema(implementation = DeploymentAccepted.class)))
    @ProblemResponses({ProblemKind.UNPROCESSABLE, ProblemKind.CONFLICT, ProblemKind.REQUEST_IN_PROGRESS,
            ProblemKind.IDEMPOTENCY_KEY_REUSED, ProblemKind.SERVICE_UNAVAILABLE})
    @PreAuthorize("hasAuthority('deployment:create')")
    @PostMapping
    public ResponseEntity<DeploymentAccepted> requestDeployment(
            @Valid @RequestBody CreateDeploymentRequest request,
            @RequestHeader(name = "Idempotency-Key", required = false) String idempotencyKey,
            Authentication authentication) {
        Idempotent<DeploymentAccepted> outcome;
        String actor = authentication.getName();
        if (idempotencyKey == null) {
            outcome = new Idempotent<>(service.requestDeployment(request, actor), false);
        } else {
            IdempotencyKeys.validate(idempotencyKey);
            outcome = idempotencyExecutor.execute("deployments:" + actor + ":" + idempotencyKey, request, DeploymentAccepted.class,
                    () -> service.requestDeployment(request, actor));
        }
        DeploymentAccepted accepted = outcome.value();
        return ResponseEntity.accepted()
                .location(URI.create("/api/v1/tasks/"+accepted.taskId()))
                .header("Idempotent-Replayed", String.valueOf(outcome.replayed()))
                .body(accepted);
    }

    @Operation(summary = "Get a deployment", description = "Returns one deployment with its current status.")
    @ProblemResponses({ProblemKind.NOT_FOUND})
    @PreAuthorize("hasAuthority('deployment:read')")
    @GetMapping("/{id}")
    public DeploymentResponse get(@PathVariable UUID id) {
        return service.get(id);
    }

    @Operation(summary = "Request a rollback",
            description = "Accepted, not done: a ROLLBACK task is recorded and the deployment status does not change yet. "
                    + "Follow the Location header to GET /tasks/{id}. A @second rollback while one is open is a 409.")
    @ApiResponse(responseCode = "202", description = "Accepted",
            headers = @Header(name = "Location", description = "URL of the task to poll", schema = @Schema(type = "string")),
            content = @Content(mediaType = "application/json", schema = @Schema(implementation = RollbackAccepted.class)))
    @ProblemResponses({ProblemKind.NOT_FOUND, ProblemKind.ILLEGAL_TRANSITION, ProblemKind.CONFLICT,
            ProblemKind.CONCURRENT_MODIFICATION})
    @PreAuthorize("hasAuthority('deployment:rollback')")
    @PostMapping("/{id}/rollback")
    public ResponseEntity<RollbackAccepted> requestRollback(@PathVariable UUID id, Authentication authentication) {
        String actor = authentication.getName();
        RollbackAccepted accepted = service.requestRollback(id, actor);
        return ResponseEntity.accepted().location(URI.create("/api/v1/tasks/"+accepted.taskId())).body(accepted);
    }

    @Operation(summary = "List the tasks of a deployment (cursor)",
            description = "A cursor page, ordered by id. Cost does not grow with depth: prefer it to the by-offset form. "
                    + "Pass nextCursor as cursor for the next page; a null nextCursor is the last page.")
    @ProblemResponses({ProblemKind.NOT_FOUND})
    @PreAuthorize("hasAuthority('deployment:read')")
    @GetMapping("/{id}/tasks")
    public CursorPage<TaskResponse> tasks(@PathVariable UUID id,
                                        @RequestParam(required = false) String cursor,
                                        @RequestParam(defaultValue = "20") @Min(1) @Max(100) int limit) {
        UUID decodedCursor = cursor == null ? null : CursorCodec.decode(cursor);
        return taskService.history(id, decodedCursor, limit);
    }

    @Operation(summary = "List the tasks of a deployment (offset)",
            description = "A zero-based page of tasks. Kept for comparison with the cursor form: the cost of a page grows with its depth.")
    @ProblemResponses({ProblemKind.NOT_FOUND})
    @PreAuthorize("hasAuthority('deployment:read')")
    @GetMapping("/{id}/tasks/by-offset")
    public OffsetPage<TaskResponse> tasksByOffset(@PathVariable UUID id,
                                                  @RequestParam(defaultValue = "0") @Min(0) int page,
                                                  @RequestParam(defaultValue = "20") @Min(1) @Max(100) int size) {
        return taskService.historyByOffset(id, page, size);
    }
}
