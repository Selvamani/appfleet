package io.appfleet.identity.user;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/** The request and response bodies of the self-service endpoints. Records, never entities. */
public final class UserDTOs {

    private UserDTOs() {}

    public record Grant(UUID teamId, String role) {}

    public record Profile(UUID id, String email, String displayName, UserStatus status, Instant createdAt, List<Grant> teams) {}

    public record UpdateProfile(@NotBlank @Size(max = 100) String displayName) {}

    public record ChangePassword(
            @NotBlank @Size(max = 200) String currentPassword,
            @NotBlank @Size(min = 12, max = 72) String newPassword) {}
}