package io.appfleet.identity.serviceaccount;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

import java.time.Instant;
import java.util.List;
import java.util.UUID;

/** The request and response bodies of the service-account endpoints. A key (the secret) appears in exactly two response types, once each. */
public final class ServiceAccountDTOs {

    private ServiceAccountDTOs() {}

    public record CreateServiceAccount(
            @NotBlank @Pattern(regexp = "^[a-z0-9][a-z0-9-]{1,62}$", message = "must be lower case letters, digits and hyphens, 2 to 63 characters") String name,
            @NotBlank @Size(max = 32) String role) {}

    /** Never holds the key. {@code prefix} is the public half, enough to tell the keys of an account apart. */
    public record KeyView(UUID id, String prefix, String status, Instant createdAt, Instant revokedAt, Instant lastUsedAt) {}

    public record AccountView(UUID id, UUID teamId, String name, String role, String status, Instant createdAt, Instant disabledAt, List<KeyView> keys) {}

    /** The only place the full key is ever returned. It cannot be shown again; a lost key is replaced, not recovered. */
    public record IssuedKey(UUID keyId, String prefix, String apiKey) {}

    public record CreatedAccount(AccountView account, IssuedKey key) {}

    public record ServiceTokenRequest(@NotBlank @Size(max = 100) String apiKey) {}

    /** No refresh token: a service that needs a new token presents its key again. */
    public record ServiceTokenResponse(String accessToken, String tokenType, long expiresIn) {}
}