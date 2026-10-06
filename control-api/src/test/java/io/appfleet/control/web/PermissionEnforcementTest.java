package io.appfleet.control.web;

import io.appfleet.security.testing.TestJwt;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.core.annotation.AnnotatedElementUtils;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.mvc.method.RequestMappingInfo;
import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping;

import java.time.Duration;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.UUID;
import java.util.function.Function;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.stream.Stream;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.content;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

/** Every operation needs exactly one permission, and the check is really enforced. */
class PermissionEnforcementTest extends WebIntegrationTest {

    /** One operation of the API and the one permission it needs. */
    record Op(HttpMethod method, String template, String permission, Function<TestFixtures, String> body) {
        String path() {
            return template.replace("{id}", UUID.randomUUID().toString())
                    .replace("{releaseId}", UUID.randomUUID().toString());
        }

        String key() {
            return method.name() + " " + template;
        }

        @Override
        public String toString() {
            return key() + " needs " + permission;
        }
    }

    private static final String APPS = "/api/v1/applications";
    private static final String DEPLOYMENTS = "/api/v1/deployments";

    private static final Function<TestFixtures, String> NO_BODY = f -> null;
    private static final Function<TestFixtures, String> NEW_APPLICATION = f -> """
              {"name":"app-%s","description":"x","ownerTeamId":"%s"}
              """.formatted(UUID.randomUUID().toString().substring(0, 8), TestAuth.TEAM);
    private static final Function<TestFixtures, String> NEW_RELEASE = f -> """
              {"version":"1.0.0","artifactRef":"registry/app:1.0.0","checksum":"sha256:%s"}
              """.formatted("a".repeat(64));
    private static final Function<TestFixtures, String> NEW_DEPLOYMENT = f -> {
        TestFixtures.Fixture fx = f.fixture();
        return """
                  {"applicationId":"%s","releaseId":"%s","environment":"%s"}
                  """.formatted(fx.app().getId(), fx.release().getId(), fx.env().getName());
    };

    static Stream<Op> operations() {
        return Stream.of(
                new Op(HttpMethod.POST, APPS, "application:create", NEW_APPLICATION),
                new Op(HttpMethod.GET, APPS, "application:read", NO_BODY),
                new Op(HttpMethod.GET, APPS + "/{id}", "application:read", NO_BODY),
                new Op(HttpMethod.POST, APPS + "/{id}/releases", "application:create", NEW_RELEASE),
                new Op(HttpMethod.GET, APPS + "/{id}/releases/{releaseId}", "application:read", NO_BODY),
                new Op(HttpMethod.POST, DEPLOYMENTS, "deployment:create", NEW_DEPLOYMENT),
                new Op(HttpMethod.GET, DEPLOYMENTS + "/{id}", "deployment:read", NO_BODY),
                new Op(HttpMethod.POST, DEPLOYMENTS + "/{id}/rollback", "deployment:rollback", NO_BODY),
                new Op(HttpMethod.GET, DEPLOYMENTS + "/{id}/tasks", "deployment:read", NO_BODY),
                new Op(HttpMethod.GET, DEPLOYMENTS + "/{id}/tasks/by-offset", "deployment:read", NO_BODY),
                new Op(HttpMethod.GET, "/api/v1/tasks/{id}", "deployment:read", NO_BODY));
    }

    @Autowired
    @Qualifier("requestMappingHandlerMapping")
    RequestMappingHandlerMapping handlerMapping;

    private ResultActions send(Op op, String token) throws Exception {
        MockHttpServletRequestBuilder req = request(op.method(), op.path())
                .header("Authorization", "Bearer " + token);
        String body = op.body().apply(fixtures);
        if (body != null) {
            req.contentType(MediaType.APPLICATION_JSON).content(body);
        }
        return mockMvc.perform(req);
    }

    @ParameterizedTest
    @MethodSource("operations")
    void everyOperation_withoutItsPermission_is403(Op op) throws Exception {
        send(op, TestAuth.tokenWithout(op.permission()))
                .andExpect(status().isForbidden());
    }

    @ParameterizedTest
    @MethodSource("operations")
    void everyOperation_withOnlyItsPermission_isNot403(Op op) throws Exception {
        int status = send(op, TestAuth.tokenWith(op.permission()))
                .andReturn().getResponse().getStatus();
        assertThat(status).as(op.toString()).isNotIn(401, 403);   // 404 for a random id is fine: the check passed
    }

    @Test
    void forbidden_onARealEndpoint_hasProblemShape() throws Exception {
        Op op = operations().filter(o -> o.key().equals("POST " + DEPLOYMENTS)).findFirst().orElseThrow();
        send(op, TestAuth.tokenWithout("deployment:create"))
                .andExpect(status().isForbidden())
                .andExpect(content().contentTypeCompatibleWith("application/problem+json"))
                .andExpect(jsonPath("$.type").value("urn:appfleet:problem:forbidden"))
                .andExpect(jsonPath("$.status").value(403))
                .andExpect(jsonPath("$.correlationId").isNotEmpty());
    }

    @Test
    void tokenWithNoPermissions_is403() throws Exception {
        mockMvc.perform(request(HttpMethod.GET, APPS).param("limit", "1")
                        .header("Authorization", "Bearer " + TestAuth.tokenWith()))
                .andExpect(status().isForbidden());
    }

    @Test
    void roleNamesAndWildcards_arePermissionsOfNothing() throws Exception {
        String token = TestJwt.forUser(UUID.randomUUID())
                .perm("DEPLOYER", "ROLE_DEPLOYER", "deployment:*")
                .expiresIn(Duration.ofHours(12))
                .sign();
        Op op = operations().filter(o -> o.key().equals("POST " + DEPLOYMENTS)).findFirst().orElseThrow();
        send(op, token).andExpect(status().isForbidden());
    }

    @Test
    void everyApiHandler_declaresOnePermission() {
        Pattern expression = Pattern.compile("^hasAuthority\\('([a-z]+:[a-z]+)'\\)$");
        Map<String, String> declared = new TreeMap<>();
        List<String> undeclared = new ArrayList<>();

        for (Map.Entry<RequestMappingInfo, HandlerMethod> e : handlerMapping.getHandlerMethods().entrySet()) {
            for (String pattern : e.getKey().getPathPatternsCondition().getPatternValues()) {
                if (!pattern.startsWith("/api/")) continue;
                for (RequestMethod m : e.getKey().getMethodsCondition().getMethods()) {
                    String key = m.name() + " " + pattern;
                    PreAuthorize pre = AnnotatedElementUtils.findMergedAnnotation(e.getValue().getMethod(), PreAuthorize.class);
                    Matcher matcher = pre == null ? null : expression.matcher(pre.value());
                    if (matcher != null && matcher.matches()) {
                        declared.put(key, matcher.group(1));
                    } else {
                        undeclared.add(key + (pre == null ? " has no @PreAuthorize" : " has " + pre.value()));
                    }
                }
            }
        }

        Map<String, String> table = new TreeMap<>();
        operations().forEach(op -> table.put(op.key(), op.permission()));

        assertThat(undeclared).as("handlers without hasAuthority('x:y')").isEmpty();
        assertThat(declared).as("annotations versus the Op table").isEqualTo(table);
    }

    @Test
    void noPermission_withInvalidBody_answer() throws Exception {
        mockMvc.perform(request(HttpMethod.POST, DEPLOYMENTS)
                        .header("Authorization", "Bearer " + TestAuth.tokenWithout("deployment:create"))
                        .contentType(MediaType.APPLICATION_JSON).content("{}"))
                .andExpect(status().isBadRequest());
    }
}
