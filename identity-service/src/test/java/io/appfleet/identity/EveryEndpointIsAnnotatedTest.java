package io.appfleet.identity;

import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.core.annotation.AnnotatedElementUtils;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.mvc.method.RequestMappingInfo;
import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

/**
 * A new endpoint without @PreAuthorize is authenticated (the chain says /api/**) but not authorised by anything: any
 * signed-in user would reach it. This test fails the build for it. The auth endpoints are public by design and are the
 * only exception; test-only endpoints live in the test tree and are excluded by their path.
 */
class EveryEndpointIsAnnotatedTest extends IdentityIntegrationTest {

    @Autowired @Qualifier("requestMappingHandlerMapping") RequestMappingHandlerMapping mapping;   // the actuator has a second one

    @Test
    void everyApiHandler_exceptTheAuthEndpoints_hasAPreAuthorize() {
        List<String> missing = new ArrayList<>();
        int checked = 0;
        for (Map.Entry<RequestMappingInfo, HandlerMethod> e : mapping.getHandlerMethods().entrySet()) {
            var patterns = e.getKey().getPathPatternsCondition().getPatternValues();
            boolean api = patterns.stream().anyMatch(p -> p.startsWith("/api/"));
            boolean open = patterns.stream().allMatch(p -> p.startsWith("/api/v1/auth/") || p.startsWith("/api/v1/test-only/"));
            if (!api || open) continue;
            checked++;
            HandlerMethod h = e.getValue();
            boolean annotated = AnnotatedElementUtils.hasAnnotation(h.getMethod(), PreAuthorize.class)
                    || AnnotatedElementUtils.hasAnnotation(h.getBeanType(), PreAuthorize.class);
            if (!annotated) missing.add(patterns + " -> " + h.getBeanType().getSimpleName() + "." + h.getMethod().getName());
        }
        assertThat(checked).as("the scan must find the self-service endpoints, or it checks nothing").isGreaterThanOrEqualTo(3);
        assertThat(missing).as("handlers without @PreAuthorize").isEmpty();
    }
}