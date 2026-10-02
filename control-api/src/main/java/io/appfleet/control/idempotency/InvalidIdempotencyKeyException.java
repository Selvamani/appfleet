package io.appfleet.control.idempotency;

public class InvalidIdempotencyKeyException extends RuntimeException {
    public InvalidIdempotencyKeyException() {
        super("invalid idempotency key");
    }
}
