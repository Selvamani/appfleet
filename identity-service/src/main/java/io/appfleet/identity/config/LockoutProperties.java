package io.appfleet.identity.config;

import jakarta.validation.constraints.Min;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

import java.time.Duration;

/**
 * After maxFailures wrong sign-ins for one email within one window, further attempts for that email are refused
 * (423) until the window ends. The window is FIXED: it starts at the first failure of a run, it does not slide.
 */
@ConfigurationProperties("appfleet.identity.lockout")
public record LockoutProperties(
        @DefaultValue("5") @Min(1) int maxFailures,
        @DefaultValue("15m" )Duration window
) {
    public LockoutProperties {
        if (window == null || window.isZero() || window.isNegative())
            throw new IllegalArgumentException("appfleet.identity.lockout.window must be above 0, was " + window);
    }
}
