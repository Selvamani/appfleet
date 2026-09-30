package io.appfleet.control.application.web;

import io.appfleet.control.application.Release;

import java.time.Instant;
import java.util.UUID;

public record ReleaseResponse(UUID id, UUID applicationId, String version, String artifactRef, String checksum,
                              Instant createdAt) {
    public static ReleaseResponse from(Release release) {
        return new ReleaseResponse(release.getId(), release.getApplication().getId(),
                release.getVersion(), release.getArtifactRef(), release.getChecksum(), release.getCreatedAt());
    }
}
