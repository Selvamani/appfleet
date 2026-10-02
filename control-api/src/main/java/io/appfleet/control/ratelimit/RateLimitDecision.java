package io.appfleet.control.ratelimit;

import java.time.Duration;

public record RateLimitDecision(boolean allowed, long remaining, Duration retryAfter) {
}
