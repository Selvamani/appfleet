package io.appfleet.control.web;
import io.appfleet.control.web.openapi.ProblemKind;
import io.appfleet.security.ProblemAccessDeniedHandler;
import io.appfleet.security.ProblemAuthenticationEntryPoint;
import org.junit.jupiter.api.Test;

import static org.assertj.core.api.Assertions.assertThat;

class SecurityProblemSlugTest {

    private static final String PREFIX = "urn:appfleet:problem:";

    @Test void unauthorizedSlug_matchesTheEnum() {
        assertThat(ProblemAuthenticationEntryPoint.TYPE).isEqualTo(PREFIX + ProblemKind.UNAUTHORIZED.slug());
        assertThat(ProblemKind.UNAUTHORIZED.status()).isEqualTo(401);
    }

    @Test void forbiddenSlug_matchesTheEnum() {
        assertThat(ProblemAccessDeniedHandler.TYPE).isEqualTo(PREFIX + ProblemKind.FORBIDDEN.slug());
        assertThat(ProblemKind.FORBIDDEN.status()).isEqualTo(403);
    }
}
