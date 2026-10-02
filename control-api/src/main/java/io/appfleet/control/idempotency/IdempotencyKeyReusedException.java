package io.appfleet.control.idempotency;

public class IdempotencyKeyReusedException extends RuntimeException {
    public IdempotencyKeyReusedException() {
        super("Idempotency key was already used with a different request body");
    }
}
