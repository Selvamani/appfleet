package io.appfleet.control.application.web;

import io.appfleet.control.application.ApplicationService;
import io.appfleet.control.web.CursorCodec;
import io.appfleet.control.web.CursorPage;
import jakarta.validation.Valid;
import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.*;

import java.net.URI;
import java.util.UUID;

@RestController
@RequestMapping("/api/v1/applications")
public class ApplicationController {

    private final ApplicationService service;

    public ApplicationController(ApplicationService service) {
        this.service = service;
    }

    @PostMapping
    public ResponseEntity<ApplicationResponse> create(@Valid @RequestBody CreateApplicationRequest request) {
        ApplicationResponse created = service.create(request);
        return ResponseEntity.created(URI.create("/api/v1/applications/" + created.id())).body(created);
    }

    @GetMapping("/{id}")
    public ApplicationResponse get(@PathVariable UUID id) {
        return service.get(id);
    }

    @GetMapping
    public CursorPage<ApplicationResponse> list(@RequestParam(required = false) String cursor, @RequestParam(defaultValue = "20") @Min(1) @Max(100) int limit) {
        UUID decodedCursor = cursor == null ? null : CursorCodec.decode(cursor);
        return service.list(decodedCursor, limit);
    }

    @PostMapping("/{id}/releases")
    public ResponseEntity<ReleaseResponse> createRelease(@PathVariable UUID id, @Valid @RequestBody CreateReleaseRequest request) {
        ReleaseResponse created = service.createRelease(id, request);
        return ResponseEntity.created(URI.create("/api/v1/applications/"+id+"/releases/"+created.id())).body(created);
    }

    @GetMapping("/{id}/releases/{releaseId}")
    public ReleaseResponse getRelease(@PathVariable UUID id, @PathVariable UUID releaseId) {
        return service.getRelease(id, releaseId);
    }
}
