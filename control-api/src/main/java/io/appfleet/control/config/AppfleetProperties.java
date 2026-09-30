package io.appfleet.control.config;

import jakarta.validation.constraints.NotBlank;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.validation.annotation.Validated;

@ConfigurationProperties(prefix = "appfleet")
@Validated
public record AppfleetProperties(@NotBlank String environment ) {
}
