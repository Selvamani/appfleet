package io.appfleet.security;

import io.appfleet.security.testing.TestKeys;
import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * control-api ships dev-public.pem in src/main; common-security's test fixtures sign with the matching private key.
 * Two copies of the public key exist, so a regenerated pair must reach both.
 */
class DevKeyDriftTest {

    private static final Path CONTROL_API_COPY =
            Path.of("..", "control-api", "src", "main", "resources", "keys", "dev-public.pem");
    private static final Path TEST_COPY =
            Path.of("src", "test", "resources", "keys", "dev-public.pem");

    private static String normalized(Path p) throws IOException {
        return Files.readString(p, StandardCharsets.UTF_8).replaceAll("\\s+", "");   // line endings, trailing newline
    }

    @Test
    void controlApiPublicKey_equalsTheTestFixtureCopy() throws IOException {
        assertThat(CONTROL_API_COPY).as("run from the common-security module directory").exists();
        assertThat(normalized(CONTROL_API_COPY)).isEqualTo(normalized(TEST_COPY));
    }

    @Test
    void controlApiPublicKey_verifiesTokensSignedWithTheTestPrivateKey() throws IOException {
        // the real guarantee: the shipped key is the public half of the key TestJwt signs with
        var shipped = org.springframework.security.converter.RsaKeyConverters.x509()
                .convert(Files.newInputStream(CONTROL_API_COPY));
        assertThat(shipped.getModulus()).isEqualTo(TestKeys.PRIVATE.getModulus());
    }
}

