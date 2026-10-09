package io.appfleet.security;


import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;
import org.springframework.core.io.Resource;
import org.springframework.validation.annotation.Validated;

import java.net.URI;
import java.time.Duration;

@ConfigurationProperties("appfleet.security.jwt")
@Validated
public record JwtProperties(
    Resource publicKeyLocation,
    URI jwksUri,
    @NotBlank String issuer,
    @DefaultValue("appfleet") @NotBlank String audience,
    @DefaultValue("60s") Duration clockSkew,
    @DefaultValue("5m") Duration jwksCacheTtl,
    @DefaultValue("1h") Duration jwksOutageTtl,
    @DefaultValue("30s") Duration jwksMinRefreshInterval
) {
    public JwtProperties {
        if ((publicKeyLocation == null) == (jwksUri == null))
            throw new IllegalArgumentException("set exactly one of appfleet.security.jwt.public-key-location and appfleet.security.jwt.jwks-uri");
        if (jwksUri != null && !("http".equals(jwksUri.getScheme()) || "https".equals(jwksUri.getScheme())))
            throw new IllegalArgumentException("appfleet.security.jwt.jwks-uri must be an http or https URL, was " + jwksUri);
        if (jwksUri != null && !jwksMinRefreshInterval.isZero() && jwksMinRefreshInterval.compareTo(jwksCacheTtl) >= 0)
            throw new IllegalArgumentException("appfleet.security.jwt.jwks-min-refresh-interval (" + jwksMinRefreshInterval + ") must be shorter than jwks-cache-ttl (" + jwksCacheTtl + ")");
    }
}
