package io.appfleet.security;

import org.junit.jupiter.api.Test;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;

import static org.assertj.core.api.Assertions.assertThat;

class NoPrivateKeyInMainResourcesTest {
    @Test
    void noModuleShipsAPrivateKey() throws IOException {
        Path root = Path.of("..").toAbsolutePath().normalize();     // test cwd = the module dir
        try (var modules = Files.list(root)) {
            for (Path m : modules.toList()) {
                Path res = m.resolve("src/main/resources");
                if (!Files.isDirectory(res)) continue;
                try (var files = Files.walk(res)) {
                    for (Path f : files.filter(Files::isRegularFile).toList()) {
                        assertThat(Files.readString(f, StandardCharsets.ISO_8859_1))
                                .as(f.toString()).doesNotContain("PRIVATE KEY");
                    }
                }
            }
        }
    }
}
