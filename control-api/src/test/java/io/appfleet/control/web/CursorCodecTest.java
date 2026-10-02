package io.appfleet.control.web;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

import org.junit.jupiter.api.Test;

import java.nio.charset.StandardCharsets;
import java.util.Base64;
import java.util.UUID;

public class CursorCodecTest {

    @Test
    public void decode() {
        UUID id = UUID.randomUUID();
        assertThat(CursorCodec.decode(CursorCodec.encode(id)).equals(id)).isTrue();
    }

    @Test
    public void decodeFail() {
        assertThatThrownBy(() ->  CursorCodec.decode("")).isInstanceOf(InvalidCursorException.class);
        assertThatThrownBy(() -> CursorCodec.decode("???")).isInstanceOf(InvalidCursorException.class);
    }

    @Test
    public void decodeFail_validBase64ButNotACanonicalUuid() {
        assertThatThrownBy(() -> CursorCodec.decode(base64Url("not-a-uuid"))).isInstanceOf(InvalidCursorException.class);
        assertThatThrownBy(() -> CursorCodec.decode(base64Url("1-1-1-1-1"))).isInstanceOf(InvalidCursorException.class);
    }

    private static String base64Url(String text) {
        return Base64.getUrlEncoder().withoutPadding().encodeToString(text.getBytes(StandardCharsets.UTF_8));
    }
}
