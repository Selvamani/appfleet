package io.appfleet.security;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.slf4j.MDC;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.authentication.InsufficientAuthenticationException;
import org.springframework.security.oauth2.server.resource.InvalidBearerTokenException;
import tools.jackson.databind.json.JsonMapper;

import java.util.HashSet;
import java.util.Map;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

public class ProblemAuthenticationEntryPointTest {

    private final JsonMapper mapper = new JsonMapper();
    private final ProblemAuthenticationEntryPoint entryPoint = new ProblemAuthenticationEntryPoint(mapper);
    private final MockHttpServletRequest req = new MockHttpServletRequest("GET", "/api/v1/applications");
    private final MockHttpServletResponse res = new MockHttpServletResponse();

    @AfterEach
    void clearMdc() {
        MDC.clear();
    }

    @SuppressWarnings("unchecked")
    private Map<String, Object> body() throws Exception {
        return mapper.readValue(res.getContentAsString(), Map.class);
    }

    @Test
    void noToken_is401_withProblemShape_andBareBearerChallenge() throws Exception {
        MDC.put("correlationId", "cid-1");
        entryPoint.commence(req, res, new InsufficientAuthenticationException("no token"));

        assertThat(res.getStatus()).isEqualTo(401);
        assertThat(res.getContentType()).startsWith("application/problem+json");
        assertThat(res.getHeader("WWW-Authenticate")).isEqualTo("Bearer");     // no error= for a missing token
        assertThat(body()).containsEntry("type", "urn:appfleet:problem:unauthorized").containsEntry("title", "Unauthorized").containsEntry("status", 401).containsEntry("instance", "/api/v1/applications").containsEntry("correlationId", "cid-1");
    }

    @Test
    void invalidToken_hasErrorInHeader() throws Exception {
        entryPoint.commence(req, res, new InvalidBearerTokenException("signature mismatch"));

        assertThat(res.getStatus()).isEqualTo(401);
        assertThat(res.getHeader("WWW-Authenticate")).contains("error=\"invalid_token\"");
    }

    @Test
    void invalidToken_headerHasNoDescription() throws Exception {      // decision 10; may fail until Flag 2 is fixed
        entryPoint.commence(req, res, new InvalidBearerTokenException("signature mismatch"));

        assertThat(res.getHeader("WWW-Authenticate")).doesNotContain("signature mismatch").doesNotContain("error_description");
    }

    @Test
    void detailNeverNamesTheFailure() throws Exception {
        String[] reasons = {"Jwt expired at 2026-01-01", "The iss claim is not valid", "Signed JWT rejected: Invalid signature"};
        Set<Object> details = new HashSet<>();
        for (String reason : reasons) {
            var r = new MockHttpServletResponse();
            entryPoint.commence(req, r, new InvalidBearerTokenException(reason));
            @SuppressWarnings("unchecked") Map<String, Object> b = mapper.readValue(r.getContentAsString(), Map.class);
            details.add(b.get("detail"));
            assertThat(r.getContentAsString()).doesNotContain("expired", "iss claim", "signature");
        }
        assertThat(details).hasSize(1);
    }

    @Test
    void noCorrelationId_isNull_notMissing() throws Exception {
        entryPoint.commence(req, res, new InsufficientAuthenticationException("x"));
        assertThat(body()).containsKey("correlationId").containsEntry("correlationId", null);
    }

    @Test
    void errorMessageWithQuotes_isEscapedInJson() throws Exception {
        req.setRequestURI("/api/\"x\"");
        entryPoint.commence(req, res, new InsufficientAuthenticationException("x"));
        assertThat(body()).containsEntry("instance", "/api/\"x\"");          // would throw or mismatch if concatenated
    }

}
