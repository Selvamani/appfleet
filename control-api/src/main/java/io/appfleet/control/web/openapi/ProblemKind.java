package io.appfleet.control.web.openapi;

public enum ProblemKind {
    VALIDATION_FAILED(400, "validation-failed", "Validation failed", 0),
    MALFORMED_REQUEST(400, "malformed-request", "Bad Request", 0),
    UNAUTHORIZED(401, "unauthorized", "Unauthorized", 0),
    FORBIDDEN(403, "forbidden", "Forbidden", 0),
    NOT_FOUND(404, "not-found", "Not found", 0),
    CONFLICT(409, "conflict", "Conflict", 0),
    ILLEGAL_TRANSITION(409, "illegal-transition", "Illegal state transition", 0),
    CONCURRENT_MODIFICATION(409, "concurrent-modification", "Concurrent modification", 0),
    REQUEST_IN_PROGRESS(409, "request-in-progress", "Request in progress", 1),
    UNPROCESSABLE(422, "unprocessable", "Unprocessable request", 0),
    IDEMPOTENCY_KEY_REUSED(422, "idempotency-key-reused", "Idempotency key reused", 0),
    RATE_LIMITED(429, "rate-limited", "Too many requests", 1),
    INTERNAL_ERROR(500, "internal-error", "Internal server error", 0),
    SERVICE_UNAVAILABLE(503, "service-unavailable", "Service unavailable", 5);

    private final int status;
    private final String slug;
    private final String title;
    private final int retryAfter;   // seconds; 0 = no Retry-After header

    ProblemKind(int status, String slug, String title, int retryAfter) {
        this.status = status;
        this.slug = slug;
        this.title = title;
        this.retryAfter = retryAfter;
    }

    public int status()       { return status; }
    public String slug()      { return slug; }
    public String title()     { return title; }
    public int retryAfter()   { return retryAfter; }

    /** components.responses key for a status: one per status, never per slug. */
    public static String responseName(int status) {
        return switch (status) {
            case 400 -> "BadRequest400";
            case 401 -> "Unauthorized401";
            case 403 -> "Forbidden403";
            case 404 -> "NotFound404";
            case 409 -> "Conflict409";
            case 422 -> "Unprocessable422";
            case 429 -> "TooManyRequests429";
            case 500 -> "InternalError500";
            case 503 -> "ServiceUnavailable503";
            default -> throw new IllegalArgumentException("undocumented problem status " + status);
        };
    }
}