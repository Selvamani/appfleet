package io.appfleet.identity.config;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;
import org.springframework.validation.annotation.Validated;

/** BCrypt cost. 12 is the production value (the spec); tests lower it, because each hash at cost 12 takes a noticeable time. */
@ConfigurationProperties("appfleet.identity.password")
@Validated
public record PasswordProperties(@DefaultValue("12") @Min(4) @Max(31) int bcryptCost) {}
