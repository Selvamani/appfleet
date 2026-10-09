package io.appfleet.identity.config;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;
import org.springframework.core.io.Resource;
import org.springframework.validation.annotation.Validated;

import java.time.Duration;

/**
 * What identity-service needs to sign an access token. The matching public key and the same issuer and audience are
 * what common-security's appfleet.security.jwt.* settings hold on the validating side.
 */
@ConfigurationProperties("appfleet.identity.jwt")
@Validated
public record IdentityJwtProperties(
        @NotNull Resource privateKeyLocation,
        @NotBlank String issuer,
        @DefaultValue("appfleet") @NotBlank String audience,
        @DefaultValue("15m") Duration accessTokenTtl
) {

    /** The spec: access tokens live at most 15 minutes. */
    public static final Duration MAX_TTL = Duration.ofMinutes(15);

    public IdentityJwtProperties {
        if (accessTokenTtl == null || accessTokenTtl.isZero() || accessTokenTtl.isNegative() || accessTokenTtl.compareTo(MAX_TTL) > 0)
            throw new IllegalArgumentException("appfleet.identity.jwt.access-token-ttl must be above 0 and at most 15 minutes, was " + accessTokenTtl);
    }
}
