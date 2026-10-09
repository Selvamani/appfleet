package io.appfleet.identity.admin;

import io.appfleet.identity.user.UserStatus;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotEmpty;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/** The request and response bodies of the admin endpoints. Records, never entities; no password hash appears in any of them. */
public final class AdminDTOs {

    private AdminDTOs() {}

    /** One page and where the next one starts (null on the last page). The cursor is the id of the last item. */
    public record PageOf<T>(List<T> items, String nextCursor) {}

    public record UserSummary(UUID id, String email, String displayName, UserStatus status, Instant createdAt, Instant deactivatedAt) {}

    public record TeamView(UUID id, String name, Instant createdAt) {}

    public record CreateTeam(@NotBlank @Size(min = 2, max = 100) String name) {}

    public record MemberView(UUID userId, String email, String displayName, String role) {}

    public record AddMember(@NotNull UUID userId, @NotBlank @Size(max = 32) String role) {}

    public record ChangeRole(@NotBlank @Size(max = 32) String role) {}

    public record RoleView(String name, String description, List<String> permissions) {}

    public record CreateRole(
            @NotBlank @Pattern(regexp = "^[A-Z][A-Z0-9_]{1,31}$", message = "must be upper case letters, digits and underscores, 2 to 32 characters") String name,
            @NotBlank @Size(max = 200) String description,
            @NotEmpty List<@NotBlank @Size(max = 64) String> permissions) {}

    public record AuditRow(UUID id, Instant occurredAt, String event, String outcome, String email, UUID userId,
                           UUID serviceAccountId, String ip, String userAgent, String correlationId) {}
}