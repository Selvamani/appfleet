package io.appfleet.control.task.web;

import io.appfleet.control.task.TaskService;
import io.appfleet.control.web.openapi.ProblemKind;
import io.appfleet.control.web.openapi.ProblemResponses;
import io.swagger.v3.oas.annotations.Operation;
import io.swagger.v3.oas.annotations.tags.Tag;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.UUID;

@Tag(name = "Tasks", description = "The units of work that a deployment or a rollback creates. Poll a task to see how far it got.")
@RestController
@RequestMapping("/api/v1/tasks")
public class TaskController {

    private final TaskService service;

    public TaskController(TaskService service) {
        this.service = service;
    }

    @Operation(summary = "Get a task",
            description = "The target of the Location header of POST /deployments and POST /deployments/{id}/rollback.")
    @ProblemResponses({ProblemKind.NOT_FOUND})
    @GetMapping("/{id}")
    public TaskResponse get(@PathVariable UUID id) {
        return service.get(id);
    }
}
