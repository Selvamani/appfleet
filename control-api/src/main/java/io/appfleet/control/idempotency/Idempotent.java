package io.appfleet.control.idempotency;

public record Idempotent<T>(T value, boolean replayed) {

    public static <T> Idempotent<T> fresh(T value) {
        return new Idempotent<>(value, false);
    }

    public static <T> Idempotent<T> replayed(T value) {
        return new Idempotent<>(value, true);
    }
}
