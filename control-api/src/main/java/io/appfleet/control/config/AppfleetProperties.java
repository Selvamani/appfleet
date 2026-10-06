package io.appfleet.control.config;

import io.appfleet.control.outbox.OutboxProperties;
import io.appfleet.control.ratelimit.RateLimitProperties;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;
import org.springframework.validation.annotation.Validated;

@ConfigurationProperties(prefix = "appfleet")
@Validated
public record AppfleetProperties(@NotBlank String environment,
                                 @DefaultValue @Valid RateLimitProperties rateLimit,
                                 @DefaultValue @Valid OutboxProperties outbox) {
}
