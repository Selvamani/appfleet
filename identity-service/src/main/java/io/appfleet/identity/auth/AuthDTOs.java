package io.appfleet.identity.auth;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

import java.util.UUID;

/** The request and response bodies of the auth endpoints. Records, never entities. */
public final class AuthDTOs {

    private AuthDTOs() {}

    public record RegisterRequest(
       @NotBlank @Email @Size(max = 254) String email,
       @NotBlank @Size(max = 100) String displayName,
       @NotBlank @Size(min = 12, max = 72) String password) {}

    public record LoginRequest(
            @NotBlank String email,
            @NotBlank String password) {}

    /** A refresh token is 43 characters; the limit only stops absurd bodies. */
    public record RefreshRequest(
            @NotBlank @Size(max = 200) String refreshToken) {}

    public record LogoutRequest(
            @NotBlank @Size(max = 200) String refreshToken) {}

    public record RegisteredUser(
            UUID id,
            String email,
            String displayName) {}

    public record TokenResponse(String accessToken,
                                String tokenType,
                                long expiresIn,
                                String refreshToken) {}
}
