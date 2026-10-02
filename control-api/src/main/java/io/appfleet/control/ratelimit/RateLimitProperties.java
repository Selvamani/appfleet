package io.appfleet.control.ratelimit;

import jakarta.validation.constraints.Positive;
import org.springframework.boot.context.properties.bind.DefaultValue;

public record RateLimitProperties(@DefaultValue("true") boolean enabled,
                                  @DefaultValue("60") @Positive int capacity,
                                  @DefaultValue("1.0") @Positive double refillPerSecond) {
}
