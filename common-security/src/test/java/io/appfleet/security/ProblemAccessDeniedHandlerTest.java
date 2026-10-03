package io.appfleet.security;

import io.appfleet.security.testing.TestKeys;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.slf4j.MDC;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.access.AccessDeniedException;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

public class ProblemAccessDeniedHandlerTest {

    private final JsonMapper mapper = new JsonMapper();
    private final ProblemAccessDeniedHandler handler = new ProblemAccessDeniedHandler(mapper);
    private final MockHttpServletRequest req = new MockHttpServletRequest("DELETE", "/api/v1/applications/1");
    private final MockHttpServletResponse res = new MockHttpServletResponse();

    @AfterEach
    void clearMdc() { MDC.clear(); }

    @SuppressWarnings("unchecked")
    private Map<String, Object> body() throws Exception {
        return mapper.readValue(res.getContentAsString(), Map.class);
    }

    @Test
    void is403_withProblemShape() throws Exception {
        MDC.put("correlationId", "cid-2");
        handler.handle(req, res, new AccessDeniedException("Access Denied"));

        assertThat(res.getStatus()).isEqualTo(403);
        assertThat(res.getContentType()).startsWith("application/problem+json");
        assertThat(body()).containsEntry("type", "urn:appfleet:problem:forbidden")
                .containsEntry("title", "Forbidden")
                .containsEntry("status", 403)
                .containsEntry("instance", "/api/v1/applications/1")
                .containsEntry("correlationId", "cid-2");
    }

    @Test
    void sendsNoWwwAuthenticate() throws Exception {
        handler.handle(req, res, new AccessDeniedException("x"));
        assertThat(res.getHeader("WWW-Authenticate")).isNull();
    }

    @Test
    void detailDoesNotNameTheMissingPermission() throws Exception {
        handler.handle(req, res, new AccessDeniedException("requires deployment:create"));
        assertThat(res.getContentAsString()).doesNotContain("deployment:create");
    }

    @Test
    void noCorrelationId_isNull_notMissing() throws Exception {
        handler.handle(req, res, new AccessDeniedException("x"));
        assertThat(body()).containsKey("correlationId").containsEntry("correlationId", null);
    }

    @Test
    void typeConstant_isTheDocumentedSlug() {
        assertThat(ProblemAccessDeniedHandler.TYPE).isEqualTo("urn:appfleet:problem:forbidden");
    }

    /**
     * control-api ships dev-public.pem in src/main; common-security's test fixtures sign with the matching private key.
     * Two copies of the public key exist, so a regenerated pair must reach both.
     */
    static class DevKeyDriftTest {

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
}
