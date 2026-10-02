package io.appfleet.control.idempotency;

public class RequestInProgressException extends RuntimeException {
    public RequestInProgressException() {
        super("A request with this idempotency key is still in progress");
    }
}
