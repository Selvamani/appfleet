package io.appfleet.control.application.web;

import io.appfleet.control.application.Application;

import java.time.Instant;
import java.util.UUID;

public record ApplicationResponse(UUID id, String name, String description, UUID ownerTeamId, Instant createdAt) {
    public static ApplicationResponse from(Application application) {
        return new ApplicationResponse(application.getId(), application.getName(),
                application.getDescription(), application.getOwnerTeamId(), application.getCreatedAt());
    }
}
