package io.appfleet.control.idempotency;

import java.util.regex.Pattern;

public final class IdempotencyKeys {

    // 1 to 255 visible ASCII characters: no spaces, no control characters, nothing that could forge a log line
    private static final Pattern VALID = Pattern.compile("[\\x21-\\x7E]{1,255}");

    private IdempotencyKeys() {}

    public static void validate(String key) {
        if (!VALID.matcher(key).matches()) {
            throw new InvalidIdempotencyKeyException();
        }
    }

}
