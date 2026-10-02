package io.appfleet.control.application.web;

import io.appfleet.control.application.ApplicationService;
import io.appfleet.control.web.CursorCodec;
import io.appfleet.control.web.CursorPage;
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
import org.springframework.web.bind.annotation.*;

import java.net.URI;
import java.util.UUID;

@Tag(name = "Applications", description = "Applications and their releases: the things that get deployed.")
@RestController
@RequestMapping("/api/v1/applications")
public class ApplicationController {

    private final ApplicationService service;

    public ApplicationController(ApplicationService service) {
        this.service = service;
    }

    @Operation(summary = "Create an application",
            description = "The name is unique. Answers 201 with the new application; the Location header is its URL.")
    @ApiResponse(responseCode = "201", description = "Created",
            headers = @Header(name = "Location", description = "URL of the new application", schema = @Schema(type = "string")),
            content = @Content(mediaType = "application/json", schema = @Schema(implementation = ApplicationResponse.class)))
    @ProblemResponses({ProblemKind.CONFLICT})
    @PostMapping
    public ResponseEntity<ApplicationResponse> create(@Valid @RequestBody CreateApplicationRequest request) {
        ApplicationResponse created = service.create(request);
        return ResponseEntity.created(URI.create("/api/v1/applications/" + created.id())).body(created);
    }

    @Operation(summary = "Get an application", description = "Returns one application by id.")
    @ProblemResponses({ProblemKind.NOT_FOUND})
    @GetMapping("/{id}")
    public ApplicationResponse get(@PathVariable UUID id) {
        return service.get(id);
    }

    @Operation(summary = "List applications",
            description = "A cursor page, ordered by id. Pass the nextCursor of one page as the cursor of the next; "
                    + "a null nextCursor is the last page. An invalid cursor is a 400.")
    @GetMapping
    public CursorPage<ApplicationResponse> list(@RequestParam(required = false) String cursor, @RequestParam(defaultValue = "20") @Min(1) @Max(100) int limit) {
        UUID decodedCursor = cursor == null ? null : CursorCodec.decode(cursor);
        return service.list(decodedCursor, limit);
    }

    @Operation(summary = "Create a release of an application",
            description = "The version is unique within the application. Answers 201; the Location header is the URL of the release.")
    @ApiResponse(responseCode = "201", description = "Created",
            headers = @Header(name = "Location", description = "URL of the new release", schema = @Schema(type = "string")),
            content = @Content(mediaType = "application/json", schema = @Schema(implementation = ReleaseResponse.class)))
    @ProblemResponses({ProblemKind.NOT_FOUND, ProblemKind.CONFLICT})
    @PostMapping("/{id}/releases")
    public ResponseEntity<ReleaseResponse> createRelease(@PathVariable UUID id, @Valid @RequestBody CreateReleaseRequest request) {
        ReleaseResponse created = service.createRelease(id, request);
        return ResponseEntity.created(URI.create("/api/v1/applications/"+id+"/releases/"+created.id())).body(created);
    }

    @Operation(summary = "Get a release", description = "Returns one release of the application. A release of another application is a 404.")
    @ProblemResponses({ProblemKind.NOT_FOUND})
    @GetMapping("/{id}/releases/{releaseId}")
    public ReleaseResponse getRelease(@PathVariable UUID id, @PathVariable UUID releaseId) {
        return service.getRelease(id, releaseId);
    }
}
