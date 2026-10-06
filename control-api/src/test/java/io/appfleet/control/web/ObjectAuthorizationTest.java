package io.appfleet.control.web;

import com.jayway.jsonpath.JsonPath;
import io.appfleet.control.deployment.Deployment;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.http.HttpMethod;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;

import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.UUID;

import static io.appfleet.control.deployment.DeploymentState.HEALTHY;
import static io.appfleet.control.deployment.DeploymentState.ROLLED_BACK;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.request;

/** Permission held for one team must not open another team's objects. */
class ObjectAuthorizationTest extends WebIntegrationTest {

    private static final String APPS = "/api/v1/applications";
    private static final String DEPLOYMENTS = "/api/v1/deployments";
    private static final String PROBLEM = "urn:appfleet:problem:";
    private static final String UUID_PATTERN = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";

    @Autowired
    StringRedisTemplate redis;

    /** Holds every permission, for team A only. */
    private static String teamAOnly() {
        return TestAuth.tokenForTeams(Map.of(TestAuth.TEAM_A, TestAuth.ALL_PERMISSIONS));
    }

    private static String teamBOwner() {
        return TestAuth.tokenForTeams(Map.of(TestAuth.TEAM_B, TestAuth.ALL_PERMISSIONS));
    }

    private MockHttpServletResponse send(HttpMethod method, String path, String token, String body, String... headers) throws Exception {
        MockHttpServletRequestBuilder req = request(method, path).header("Authorization", "Bearer " + token);
        for (int i = 0; i < headers.length; i += 2) {
            req.header(headers[i], headers[i + 1]);
        }
        if (body != null) {
            req.contentType(MediaType.APPLICATION_JSON).content(body);
        }
        return mockMvc.perform(req).andReturn().getResponse();
    }

    private MockHttpServletResponse get(String path, String token) throws Exception {
        return send(HttpMethod.GET, path, token, null);
    }

    private static String deployBody(TestFixtures.Fixture f) {
        return """
                  {"applicationId":"%s","releaseId":"%s","environment":"%s"}
                  """.formatted(f.app().getId(), f.release().getId(), f.env().getName());
    }

    private static String releaseBody() {
        return """
                  {"version":"2.0.0","artifactRef":"registry/app:2.0.0","checksum":"sha256:%s"}
                  """.formatted("b".repeat(64));
    }

    private static String applicationBody(String name, UUID ownerTeam) {
        return """
                  {"name":"%s","description":"x","ownerTeamId":"%s"}
                  """.formatted(name, ownerTeam);
    }

    private static String type(MockHttpServletResponse r) throws Exception {
        return JsonPath.read(r.getContentAsString(), "$.type");
    }

    /** status, type, title and detail with every id replaced: what a caller can compare. */
    private static String shape(MockHttpServletResponse r) throws Exception {
        String body = r.getContentAsString();
        if (r.getStatus() < 400) {
            return r.getStatus() + " (not a problem: the object was returned)";
        }
        String detail = JsonPath.<String>read(body, "$.detail");
        return r.getStatus() + " " + JsonPath.<String>read(body, "$.type") + " " + JsonPath.<String>read(body, "$.title")
                + " " + detail.replaceAll(UUID_PATTERN, "<id>");
    }

    private List<String> allApplicationIds(String token) throws Exception {
        List<String> ids = new ArrayList<>();
        String cursor = null;
        do {
            String path = APPS + "?limit=100" + (cursor == null ? "" : "&cursor=" + cursor);
            MockHttpServletResponse r = get(path, token);
            assertThat(r.getStatus()).isEqualTo(200);
            ids.addAll(JsonPath.<List<String>>read(r.getContentAsString(), "$.items[*].id"));
            cursor = JsonPath.read(r.getContentAsString(), "$.nextCursor");
        } while (cursor != null);
        return ids;
    }

    @Test
    void deployer_ofTeamA_cannotDeploy_teamBsApplication() throws Exception {
        TestFixtures.Fixture f = fixtures.fixtureFor(TestAuth.TEAM_B);
        UUID caller = UUID.randomUUID();
        String token = TestAuth.tokenFor(caller, Map.of(TestAuth.TEAM_A, TestAuth.ALL_PERMISSIONS));
        String key = "idor-" + UUID.randomUUID();

        MockHttpServletResponse r = send(HttpMethod.POST, DEPLOYMENTS, token, deployBody(f), "Idempotency-Key", key);

        assertThat(r.getStatus()).isEqualTo(422);
        assertThat(type(r)).isEqualTo(PROBLEM + "unprocessable");
        assertThat(count("select count(*) from deployment where application_id = ?", f.app().getId())).isZero();
        assertThat(count("select count(*) from audit_event where actor = ?", caller.toString())).isZero();
        assertThat(redis.hasKey("idempotency:v1:deployments:" + caller + ":" + key)).isFalse();
    }

    @Test
    void reader_ofTeamA_cannotRead_teamBsDeployment() throws Exception {
        Deployment d = fixtures.deploymentFor(TestAuth.TEAM_B);

        MockHttpServletResponse r = get(DEPLOYMENTS + "/" + d.getId(), teamAOnly());

        assertThat(r.getStatus()).isEqualTo(404);
        assertThat(type(r)).isEqualTo(PROBLEM + "not-found");
    }

    @Test
    void deployer_ofTeamA_cannotRollback_teamBsDeployment() throws Exception {
        Deployment d = fixtures.deploymentFor(TestAuth.TEAM_B, HEALTHY);
        UUID caller = UUID.randomUUID();
        String token = TestAuth.tokenFor(caller, Map.of(TestAuth.TEAM_A, TestAuth.ALL_PERMISSIONS));

        MockHttpServletResponse r = send(HttpMethod.POST, DEPLOYMENTS + "/" + d.getId() + "/rollback", token, null);

        assertThat(r.getStatus()).isEqualTo(404);
        assertThat(count("select count(*) from task where deployment_id = ? and task_type = 'ROLLBACK'", d.getId())).isZero();
        assertThat(count("select count(*) from audit_event where actor = ?", caller.toString())).isZero();
    }

    @Test
    void reader_ofTeamA_cannotRead_teamBsTaskHistory_orTask() throws Exception {
        Deployment d = fixtures.deploymentFor(TestAuth.TEAM_B);
        List<String> taskIds = fixtures.tasks(d, 2);
        String token = teamAOnly();

        assertThat(get(DEPLOYMENTS + "/" + d.getId() + "/tasks", token).getStatus()).isEqualTo(404);
        assertThat(get(DEPLOYMENTS + "/" + d.getId() + "/tasks/by-offset", token).getStatus()).isEqualTo(404);
        assertThat(get("/api/v1/tasks/" + taskIds.get(0), token).getStatus()).isEqualTo(404);
    }

    @Test
    void reader_ofTeamA_cannotRead_teamBsApplication_orItsRelease() throws Exception {
        TestFixtures.Fixture f = fixtures.fixtureFor(TestAuth.TEAM_B);
        String token = teamAOnly();

        assertThat(get(APPS + "/" + f.app().getId(), token).getStatus()).isEqualTo(404);
        assertThat(get(APPS + "/" + f.app().getId() + "/releases/" + f.release().getId(), token).getStatus()).isEqualTo(404);
    }

    @Test
    void creator_ofTeamA_cannotAddRelease_toTeamBsApplication() throws Exception {
        TestFixtures.Fixture f = fixtures.fixtureFor(TestAuth.TEAM_B);
        long before = count("select count(*) from release where application_id = ?", f.app().getId());

        MockHttpServletResponse r = send(HttpMethod.POST, APPS + "/" + f.app().getId() + "/releases", teamAOnly(), releaseBody());

        assertThat(r.getStatus()).isEqualTo(404);
        assertThat(count("select count(*) from release where application_id = ?", f.app().getId())).isEqualTo(before);
    }

    @Test
    void creator_ofTeamA_cannotCreateApplication_forTeamB() throws Exception {
        String name = "idor-" + UUID.randomUUID().toString().substring(0, 8);

        MockHttpServletResponse r = send(HttpMethod.POST, APPS, teamAOnly(), applicationBody(name, TestAuth.TEAM_B));

        assertThat(r.getStatus()).isEqualTo(403);
        assertThat(type(r)).isEqualTo(PROBLEM + "forbidden");
        assertThat(count("select count(*) from application where name = ?", name)).isZero();
    }

    @Test
    void list_showsOnlyTheCallersTeams() throws Exception {
        TestFixtures.Fixture mine = fixtures.fixtureFor(TestAuth.TEAM_A);
        TestFixtures.Fixture theirs = fixtures.fixtureFor(TestAuth.TEAM_B);

        List<String> ids = allApplicationIds(teamAOnly());

        assertThat(ids).contains(mine.app().getId().toString());
        assertThat(ids).doesNotContain(theirs.app().getId().toString());
    }

    @Test
    void permissionHeldForAnotherTeam_doesNotCount() throws Exception {
        TestFixtures.Fixture f = fixtures.fixtureFor(TestAuth.TEAM_B);
        Deployment d = fixtures.deploymentFor(TestAuth.TEAM_B);
        String token = TestAuth.tokenForTeams(Map.of(
                TestAuth.TEAM_A, List.of("deployment:create"),
                TestAuth.TEAM_B, List.of("deployment:read")));

        assertThat(send(HttpMethod.POST, DEPLOYMENTS, token, deployBody(f)).getStatus()).isEqualTo(422);   // create is A's, not B's
        assertThat(get(DEPLOYMENTS + "/" + d.getId(), token).getStatus()).isEqualTo(200);                  // read is B's
    }

    @Test
    void deniedAnswer_isIndistinguishableFromMissing() throws Exception {
        Deployment foreign = fixtures.deploymentFor(TestAuth.TEAM_B, HEALTHY);
        TestFixtures.Fixture foreignApp = fixtures.fixtureFor(TestAuth.TEAM_B);
        String token = teamAOnly();

        TestFixtures.Fixture foreignFixture = fixtures.fixtureFor(TestAuth.TEAM_B);
        String foreignBody = deployBody(foreignFixture);
        String missingBody = """
                  {"applicationId":"%s","releaseId":"%s","environment":"%s"}
                  """.formatted(UUID.randomUUID(), foreignFixture.release().getId(), foreignFixture.env().getName());
        assertThat(shape(send(HttpMethod.POST, DEPLOYMENTS, token, foreignBody)))
                .isEqualTo(shape(send(HttpMethod.POST, DEPLOYMENTS, token, missingBody)));
        assertThat(shape(get(APPS + "/" + foreignApp.app().getId(), token)))
                .isEqualTo(shape(get(APPS + "/" + UUID.randomUUID(), token)));
        assertThat(shape(send(HttpMethod.POST, DEPLOYMENTS + "/" + foreign.getId() + "/rollback", token, null)))
                .isEqualTo(shape(send(HttpMethod.POST, DEPLOYMENTS + "/" + UUID.randomUUID() + "/rollback", token, null)));
    }

    @Test
    void ownerCheck_runsBeforeStateChecks() throws Exception {
        Deployment alreadyRolledBack = fixtures.deploymentFor(TestAuth.TEAM_B, ROLLED_BACK);

        MockHttpServletResponse r = send(HttpMethod.POST, DEPLOYMENTS + "/" + alreadyRolledBack.getId() + "/rollback", teamAOnly(), null);

        assertThat(r.getStatus()).isEqualTo(404);     // today a 409 illegal-transition, which shows the state
    }

    @Test
    void sameTeam_canDoEverything_itsPermissionsAllow() throws Exception {
        String token = teamBOwner();
        TestFixtures.Fixture f = fixtures.fixtureFor(TestAuth.TEAM_B);
        Deployment healthy = fixtures.deploymentFor(TestAuth.TEAM_B, HEALTHY);
        List<String> taskIds = fixtures.tasks(healthy, 2);
        String name = "own-" + UUID.randomUUID().toString().substring(0, 8);

        assertThat(send(HttpMethod.POST, APPS, token, applicationBody(name, TestAuth.TEAM_B)).getStatus()).isEqualTo(201);
        assertThat(get(APPS + "/" + f.app().getId(), token).getStatus()).isEqualTo(200);
        assertThat(get(APPS + "/" + f.app().getId() + "/releases/" + f.release().getId(), token).getStatus()).isEqualTo(200);
        assertThat(send(HttpMethod.POST, APPS + "/" + f.app().getId() + "/releases", token, releaseBody()).getStatus()).isEqualTo(201);
        assertThat(allApplicationIds(token)).contains(f.app().getId().toString());
        assertThat(send(HttpMethod.POST, DEPLOYMENTS, token, deployBody(f)).getStatus()).isEqualTo(202);
        assertThat(get(DEPLOYMENTS + "/" + healthy.getId(), token).getStatus()).isEqualTo(200);
        assertThat(get(DEPLOYMENTS + "/" + healthy.getId() + "/tasks", token).getStatus()).isEqualTo(200);
        assertThat(get(DEPLOYMENTS + "/" + healthy.getId() + "/tasks/by-offset", token).getStatus()).isEqualTo(200);
        assertThat(get("/api/v1/tasks/" + taskIds.get(0), token).getStatus()).isEqualTo(200);
        assertThat(send(HttpMethod.POST, DEPLOYMENTS + "/" + healthy.getId() + "/rollback", token, null).getStatus()).isEqualTo(202);
    }

    @Test
    void globalPerms_applyToEveryTeam() throws Exception {
        TestFixtures.Fixture f = fixtures.fixtureFor(TestAuth.TEAM_B);

        MockHttpServletResponse r = send(HttpMethod.POST, DEPLOYMENTS, TestAuth.tokenWithGlobalPerms("deployment:create"), deployBody(f));

        assertThat(r.getStatus()).isEqualTo(202);
    }

    @Test
    void callerWithOnlyAnEmptyTeam_seesAnEmptyList_notAnError() throws Exception {
        fixtures.fixtureFor(TestAuth.TEAM_B);
        String token = TestAuth.tokenForTeams(Map.of(UUID.randomUUID(), List.of("application:read")));

        assertThat(allApplicationIds(token)).isEmpty();
    }
}

