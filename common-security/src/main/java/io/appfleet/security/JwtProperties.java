package io.appfleet.security;


import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;
import org.springframework.core.io.Resource;
import org.springframework.validation.annotation.Validated;

import java.time.Duration;

@ConfigurationProperties("appfleet.security.jwt")
@Validated
public record JwtProperties(
    @NotNull Resource publicKeyLocation,
    @NotBlank String issuer,
    @DefaultValue("appfleet") @NotBlank String audience,
    @DefaultValue("60s") Duration clockSkew
) {}
