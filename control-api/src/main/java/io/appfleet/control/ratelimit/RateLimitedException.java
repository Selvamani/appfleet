package io.appfleet.control.ratelimit;

import java.time.Duration;

public class RateLimitedException extends RuntimeException {
    private final Duration retryAfter;

    public RateLimitedException(Duration retryAfter) {
        super("rate limit exhausted, retry after " + retryAfter.toMillis() + " ms");
        this.retryAfter = retryAfter;
    }

    public Duration retryAfter() {
        return retryAfter;
    }
}
