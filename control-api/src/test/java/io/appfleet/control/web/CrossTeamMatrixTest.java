package io.appfleet.control.web;

import io.appfleet.control.deployment.Deployment;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.mvc.method.RequestMappingInfo;
import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping;

import java.util.List;
import java.util.Map;
import java.util.TreeSet;
import java.util.UUID;
import java.util.function.Function;
import java.util.stream.Stream;

import static io.appfleet.control.deployment.DeploymentState.HEALTHY;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

/**
 * Every operation, once against another team's objects and once against the caller's own.
 * A new endpoint without a row fails the meta-check; a row whose operation forgot the owner check fails its first test.
 */
class CrossTeamMatrixTest extends WebIntegrationTest {

    /** The objects one test works on, all owned by the same team. */
    record Targets(TestFixtures.Fixture fixture, Deployment deployment, String taskId) {
        String appId() {
            return fixture.app().getId().toString();
        }
    }

    /** One operation: how to build its path and body from the targets, and the answer for a foreign and for an own object. */
    record Row(HttpMethod method, String template, Function<Targets, String> path, Function<Targets, String> body,
               int foreignStatus, int ownStatus) {
        String key() {
            return method.name() + " " + template;
        }

        @Override
        public String toString() {
            return key() + " foreign=" + foreignStatus + " own=" + ownStatus;
        }
    }

    private static final String APPS = "/api/v1/applications";
    private static final String DEPLOYMENTS = "/api/v1/deployments";

    private static final Function<Targets, String> NO_BODY = t -> null;

    private static Function<Targets, String> fixedPath(String path) {
        return t -> path;
    }

    private static String deployBody(Targets t) {
        return """
                  {"applicationId":"%s","releaseId":"%s","environment":"%s"}
                  """.formatted(t.appId(), t.fixture().release().getId(), t.fixture().env().getName());
    }

    static Stream<Row> rows() {
        return Stream.of(
                new Row(HttpMethod.POST, APPS, fixedPath(APPS), t -> """
                          {"name":"app-%s","description":"x","ownerTeamId":"%s"}
                          """.formatted(UUID.randomUUID().toString().substring(0, 8), t.fixture().app().getOwnerTeamId()),
                        403, 201),
                new Row(HttpMethod.GET, APPS, fixedPath(APPS + "?limit=1"), NO_BODY, 200, 200),
                new Row(HttpMethod.GET, APPS + "/{id}", t -> APPS + "/" + t.appId(), NO_BODY, 404, 200),
                new Row(HttpMethod.POST, APPS + "/{id}/releases", t -> APPS + "/" + t.appId() + "/releases", t -> """
                          {"version":"9.9.9","artifactRef":"registry/app:9.9.9","checksum":"sha256:%s"}
                          """.formatted("c".repeat(64)), 404, 201),
                new Row(HttpMethod.GET, APPS + "/{id}/releases/{releaseId}",
                        t -> APPS + "/" + t.appId() + "/releases/" + t.fixture().release().getId(), NO_BODY, 404, 200),
                new Row(HttpMethod.POST, DEPLOYMENTS, fixedPath(DEPLOYMENTS), CrossTeamMatrixTest::deployBody, 422, 202),
                new Row(HttpMethod.GET, DEPLOYMENTS + "/{id}", t -> DEPLOYMENTS + "/" + t.deployment().getId(), NO_BODY, 404, 200),
                new Row(HttpMethod.POST, DEPLOYMENTS + "/{id}/rollback",
                        t -> DEPLOYMENTS + "/" + t.deployment().getId() + "/rollback", NO_BODY, 404, 202),
                new Row(HttpMethod.GET, DEPLOYMENTS + "/{id}/tasks",
                        t -> DEPLOYMENTS + "/" + t.deployment().getId() + "/tasks", NO_BODY, 404, 200),
                new Row(HttpMethod.GET, DEPLOYMENTS + "/{id}/tasks/by-offset",
                        t -> DEPLOYMENTS + "/" + t.deployment().getId() + "/tasks/by-offset", NO_BODY, 404, 200),
                new Row(HttpMethod.GET, "/api/v1/tasks/{id}", t -> "/api/v1/tasks/" + t.taskId(), NO_BODY, 404, 200));
    }

    @Autowired
    @Qualifier("requestMappingHandlerMapping")
    RequestMappingHandlerMapping handlerMapping;

    private Targets targetsOf(UUID ownerTeam) {
        TestFixtures.Fixture fixture = fixtures.fixtureFor(ownerTeam);
        Deployment deployment = fixtures.deploymentFor(ownerTeam, HEALTHY);
        String taskId = fixtures.tasks(deployment, 1).get(0);
        return new Targets(fixture, deployment, taskId);
    }

    private int status(Row row, Targets targets, String token) throws Exception {
        MockHttpServletRequestBuilder req = request(row.method(), row.path().apply(targets))
                .header("Authorization", "Bearer " + token);
        String body = row.body().apply(targets);
        if (body != null) {
            req.contentType(MediaType.APPLICATION_JSON).content(body);
        }
        return mockMvc.perform(req).andReturn().getResponse().getStatus();
    }

    private static String teamAOnly() {
        return TestAuth.tokenForTeams(Map.of(TestAuth.TEAM_A, TestAuth.ALL_PERMISSIONS));
    }

    @ParameterizedTest
    @MethodSource("rows")
    void anotherTeamsObject_getsTheDocumentedDenial(Row row) throws Exception {
        Targets foreign = targetsOf(TestAuth.TEAM_B);

        assertThat(status(row, foreign, teamAOnly())).as(row.toString()).isEqualTo(row.foreignStatus());
    }

    @ParameterizedTest
    @MethodSource("rows")
    void theCallersOwnObject_getsTheNormalAnswer(Row row) throws Exception {
        Targets own = targetsOf(TestAuth.TEAM_A);

        assertThat(status(row, own, teamAOnly())).as(row.toString()).isEqualTo(row.ownStatus());
    }

    /** Every /api handler has a row, and every row has a handler. */
    @Test
    void theTableCoversEveryApiHandler() {
        TreeSet<String> handlers = new TreeSet<>();
        for (Map.Entry<RequestMappingInfo, HandlerMethod> e : handlerMapping.getHandlerMethods().entrySet()) {
            for (String pattern : e.getKey().getPathPatternsCondition().getPatternValues()) {
                if (!pattern.startsWith("/api/")) continue;
                for (RequestMethod m : e.getKey().getMethodsCondition().getMethods()) {
                    handlers.add(m.name() + " " + pattern);
                }
            }
        }
        List<String> table = rows().map(Row::key).toList();

        assertThat(handlers).as("handlers versus matrix rows").containsExactlyInAnyOrderElementsOf(table);
    }
}
