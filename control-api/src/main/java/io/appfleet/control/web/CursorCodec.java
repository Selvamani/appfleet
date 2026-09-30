package io.appfleet.control.web;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.UUID;

public final class CursorCodec {

    private CursorCodec() {}

    public static String encode(UUID id) {
        return Base64.getUrlEncoder().withoutPadding()
                .encodeToString(id.toString().getBytes(StandardCharsets.UTF_8));
    }

    public static UUID decode(String cursor) {
        try {
            String text = new String(Base64.getUrlDecoder().decode(cursor), StandardCharsets.UTF_8);
            UUID parsed = UUID.fromString(text);
            if (!parsed.toString().equals(text)) {          // reject lenient forms like "1-1-1-1-1"
                throw new IllegalArgumentException("not canonical");
            }
            return parsed;
        } catch (IllegalArgumentException e) {
            throw new InvalidCursorException();
        }
    }
}


