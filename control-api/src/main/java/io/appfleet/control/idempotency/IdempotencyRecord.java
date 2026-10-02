package io.appfleet.control.idempotency;

public record IdempotencyRecord(State state, String owner, String fingerprint, String response) {

    public enum State { IN_PROGRESS, COMPLETED }

    public static IdempotencyRecord inProgress(String owner, String fingerprint) {
        return new IdempotencyRecord(State.IN_PROGRESS, owner, fingerprint, null);
    }

    public static IdempotencyRecord completed(String fingerprint, String response) {
        return new IdempotencyRecord(State.COMPLETED, null, fingerprint, response);
    }
}
