package io.appfleet.control.web;

import com.jayway.jsonpath.JsonPath;
import io.appfleet.control.deployment.Deployment;
import io.appfleet.control.deployment.DeploymentRepository;
import io.appfleet.control.deployment.DeploymentState;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.EnumSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.MvcResult;
import org.springframework.test.web.servlet.ResultActions;

import java.util.List;
import java.util.UUID;
import java.util.concurrent.*;

import static io.appfleet.control.deployment.DeploymentState.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.hamcrest.Matchers.startsWith;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

public class DeploymentEndpointsTest extends WebIntegrationTest {

    private static final String URL = "/api/v1/deployments";
    private static final String TASKS = "/api/v1/tasks/";
    private static final String PROBLEM = "urn:appfleet:problem:";
    private static final String COUNT_DEPLOY_AUDIT =
            "select count(*) from audit_event where action = 'DEPLOYMENT_REQUESTED'";

    @Autowired
    DeploymentRepository deploymentRepository;

    private record Accepted(UUID deploymentId, UUID taskId, String location) {}

    private record Outcome(int status, String type) {}
    
    private static String body(UUID appId, UUID releaseId, String env) {
        return """
                  {"applicationId":"%s","releaseId":"%s","environment":"%s"}
                  """.formatted(appId, releaseId, env);
    }

    private static String body(TestFixtures.Fixture f) {
        return body(f.app().getId(), f.release().getId(), f.env().getName());
    }

    private ResultActions postDeployment(String json) throws Exception {
        return mockMvc.perform(post(URL).contentType(MediaType.APPLICATION_JSON).content(json));
    }

    private ResultActions postRollback(UUID deploymentId) throws Exception {
        return mockMvc.perform(post(URL + "/" + deploymentId + "/rollback"));
    }

    private Accepted accepted(TestFixtures.Fixture f) throws Exception {
        MvcResult r = postDeployment(body(f)).andExpect(status().isAccepted()).andReturn();
        String json = r.getResponse().getContentAsString();
        return new Accepted(UUID.fromString(JsonPath.read(json, "$.deploymentId")),
                UUID.fromString(JsonPath.read(json, "$.taskId")),
                r.getResponse().getHeader("Location"));
    }
    
    private List<Outcome> race(Callable<MvcResult> request) throws Exception {
        CyclicBarrier barrier = new CyclicBarrier(2);
        Callable<Outcome> call = () -> {
            barrier.await(5, TimeUnit.SECONDS);
            MockHttpServletResponse r = request.call().getResponse();
            String type = r.getStatus() >= 400 ? JsonPath.read(r.getContentAsString(), "$.type") : null;
            return new Outcome(r.getStatus(), type);
        };
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            Future<Outcome> a = pool.submit(call);
            Future<Outcome> b = pool.submit(call);
            return List.of(a.get(10, TimeUnit.SECONDS), b.get(10, TimeUnit.SECONDS));
        } finally {
            pool.shutdownNow();
        }
    }

    @Test
    void requestDeployment_returns202_andWritesDeploymentTaskAndAudit() throws Exception {
        TestFixtures.Fixture f = fixtures.fixture();
        MvcResult r = postDeployment(body(f))
                .andExpect(status().isAccepted())
                .andExpect(header().string("Location", startsWith(TASKS)))
                .andExpect(jsonPath("$.status").value("PENDING"))
                .andReturn();
        String json = r.getResponse().getContentAsString();
        UUID deploymentId = UUID.fromString(JsonPath.read(json, "$.deploymentId"));
        UUID taskId = UUID.fromString(JsonPath.read(json, "$.taskId"));

        assertThat(r.getResponse().getHeader("Location")).isEqualTo(TASKS + taskId);
        assertThat(deploymentRepository.findById(deploymentId)).get()
                .extracting(Deployment::getStatus).isEqualTo(PENDING);
        assertThat(count("select count(*) from task where deployment_id = ? and task_type = 'DEPLOY' and status = 'PENDING'",
                deploymentId)).isEqualTo(1);
        assertThat(count(COUNT_DEPLOY_AUDIT + " and target_id = ?", deploymentId)).isEqualTo(1);
    }

    @Test
    void location_resolvesToPendingDeployTask() throws Exception {
        Accepted a = accepted(fixtures.fixture());
        mockMvc.perform(get(a.location()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.id").value(a.taskId().toString()))
                .andExpect(jsonPath("$.deploymentId").value(a.deploymentId().toString()))
                .andExpect(jsonPath("$.taskType").value("DEPLOY"))
                .andExpect(jsonPath("$.status").value("PENDING"));
    }

    @Test
    void getDeployment_returnsEnvironmentName_andNoCurrentStatus() throws Exception {
        TestFixtures.Fixture f = fixtures.fixture();
        Accepted a = accepted(f);
        mockMvc.perform(get(URL + "/" + a.deploymentId()))
                .andExpect(status().isOk())
                .andExpect(jsonPath("$.applicationId").value(f.app().getId().toString()))
                .andExpect(jsonPath("$.releaseId").value(f.release().getId().toString()))
                .andExpect(jsonPath("$.environment").value(f.env().getName()))
                .andExpect(jsonPath("$.status").value("PENDING"))
                .andExpect(jsonPath("$.currentStatus").doesNotExist());
    }

    @Test
    void secondActiveDeployment_returns409_andLeavesNoOrphanAudit() throws Exception {
        TestFixtures.Fixture f = fixtures.fixture();
        accepted(f);
        long auditBefore = count(COUNT_DEPLOY_AUDIT);

        postDeployment(body(f))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.type").value(PROBLEM + "conflict"))
                .andExpect(jsonPath("$.detail").value("An active deployment already exists for this application and environment."));

        assertThat(count(COUNT_DEPLOY_AUDIT)).isEqualTo(auditBefore);
        assertThat(count("select count(*) from deployment where application_id = ? and environment_id = ?",
                f.app().getId(), f.env().getId())).isEqualTo(1);
    }

    @Test
    void newDeployment_allowed_afterPreviousFailed() throws Exception {
        TestFixtures.Fixture f = fixtures.fixture();
        fixtures.driveTo(accepted(f).deploymentId(), FAILED);
        postDeployment(body(f)).andExpect(status().isAccepted());
    }

    @Test
    void emptyObject_returns400_listingEveryField() throws Exception {
        postDeployment("{}")
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.type").value(PROBLEM + "validation-failed"))
                .andExpect(jsonPath("$.errors.length()").value(3))
                .andExpect(jsonPath("$.errors[?(@.field=='applicationId')]").exists())
                .andExpect(jsonPath("$.errors[?(@.field=='releaseId')]").exists())
                .andExpect(jsonPath("$.errors[?(@.field=='environment')]").exists());
    }

    @Test
    void blankEnvironment_returns400() throws Exception {
        TestFixtures.Fixture f = fixtures.fixture();
        postDeployment(body(f.app().getId(), f.release().getId(), " "))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.type").value(PROBLEM + "validation-failed"))
                .andExpect(jsonPath("$.errors[?(@.field=='environment')]").exists());
    }

    @Test
    void noBody_returns400_malformedRequest() throws Exception {
        mockMvc.perform(post(URL).contentType(MediaType.APPLICATION_JSON))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.type").value(PROBLEM + "malformed-request"));
    }

    @Test
    void unknownApplication_returns422() throws Exception {
        TestFixtures.Fixture f = fixtures.fixture();
        postDeployment(body(UUID.randomUUID(), f.release().getId(), f.env().getName()))
                .andExpect(status().is(422))
                .andExpect(jsonPath("$.type").value(PROBLEM + "unprocessable"));
    }

    @Test
    void unknownRelease_returns422() throws Exception {
        TestFixtures.Fixture f = fixtures.fixture();
        postDeployment(body(f.app().getId(), UUID.randomUUID(), f.env().getName()))
                .andExpect(status().is(422))
                .andExpect(jsonPath("$.type").value(PROBLEM + "unprocessable"));
    }

    @Test
    void unknownEnvironment_returns422() throws Exception {
        TestFixtures.Fixture f = fixtures.fixture();
        postDeployment(body(f.app().getId(), f.release().getId(), "no-such-env"))
                .andExpect(status().is(422))
                .andExpect(jsonPath("$.type").value(PROBLEM + "unprocessable"));
    }

    @Test
    void releaseOfAnotherApplication_returns422() throws Exception {
        TestFixtures.Fixture mine = fixtures.fixture();
        TestFixtures.Fixture other = fixtures.fixture();
        postDeployment(body(mine.app().getId(), other.release().getId(), mine.env().getName()))
                .andExpect(status().is(422))
                .andExpect(jsonPath("$.type").value(PROBLEM + "unprocessable"));
    }

    @Test
    void getUnknownDeployment_returns404() throws Exception {
        mockMvc.perform(get(URL + "/" + UUID.randomUUID()))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.type").value(PROBLEM + "not-found"));
    }

    @Test
    void getDeployment_malformedId_returns400() throws Exception {
        mockMvc.perform(get(URL + "/not-a-uuid"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.type").value(PROBLEM + "validation-failed"))
                .andExpect(jsonPath("$.errors[?(@.field=='id')]").exists());
    }

    @Test
    void getUnknownTask_returns404() throws Exception {
        mockMvc.perform(get(TASKS + UUID.randomUUID()))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.type").value(PROBLEM + "not-found"));
    }

    @ParameterizedTest
    @EnumSource(value = DeploymentState.class, names = {"PENDING", "FAILED", "ROLLED_BACK"})
    void rollback_fromNonRollbackableState_returns409(DeploymentState state) throws Exception {
        postRollback(fixtures.deploymentIn(state))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.type").value(PROBLEM + "illegal-transition"));
    }

    @ParameterizedTest
    @EnumSource(value = DeploymentState.class, names = {"HEALTHY", "DEGRADED"})
    void rollback_fromRollbackableState_returns202(DeploymentState state) throws Exception {
        postRollback(fixtures.deploymentIn(state))
                .andExpect(status().isAccepted())
                .andExpect(header().string("Location", startsWith(TASKS)));
    }

    @Test
    void rollback_onHealthy_recordsTask_keepsStatus_bumpsVersion() throws Exception {
        UUID id = fixtures.deploymentIn(HEALTHY);
        long versionBefore = deploymentRepository.findById(id).orElseThrow().getVersion();

        postRollback(id)
                .andExpect(status().isAccepted())
                .andExpect(jsonPath("$.deploymentId").value(id.toString()))
                .andExpect(jsonPath("$.taskId").isNotEmpty());

        Deployment after = deploymentRepository.findById(id).orElseThrow();
        assertThat(after.getStatus()).isEqualTo(HEALTHY);
        assertThat(after.getVersion()).isEqualTo(versionBefore + 1);
        assertThat(count("select count(*) from task where deployment_id = ? and task_type = 'ROLLBACK' and status = 'PENDING'",
                id))
                .isEqualTo(1);
        assertThat(count("select count(*) from audit_event where action = 'ROLLBACK_REQUESTED' and target_id = ?", id))
                .isEqualTo(1);
    }

    @Test
    void secondRollback_returns409_conflict() throws Exception {
        UUID id = fixtures.deploymentIn(HEALTHY);
        postRollback(id).andExpect(status().isAccepted());
        postRollback(id)
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.type").value(PROBLEM + "conflict"))
                .andExpect(jsonPath("$.detail").value("A rollback is already pending for this deployment."));
    }

    @Test
    void concurrentDeployments_sameTarget_one202_one409() throws Exception {
        TestFixtures.Fixture f = fixtures.fixture();
        long auditBefore = count(COUNT_DEPLOY_AUDIT);

        List<Outcome> outcomes = race(() -> postDeployment(body(f)).andReturn());

        assertThat(outcomes).extracting(Outcome::status).containsExactlyInAnyOrder(202, 409);
        assertThat(outcomes).extracting(Outcome::type).contains(PROBLEM + "conflict");
        assertThat(count("select count(*) from deployment where application_id = ? and environment_id = ?",
                f.app().getId(), f.env().getId())).isEqualTo(1);
        assertThat(count(COUNT_DEPLOY_AUDIT)).isEqualTo(auditBefore + 1);
    }

    @Test
    void concurrentRollbacks_one202_one409_exactlyOneTask() throws Exception {
        UUID id = fixtures.deploymentIn(HEALTHY);

        List<Outcome> outcomes = race(() -> postRollback(id).andReturn());

        assertThat(outcomes).extracting(Outcome::status).containsExactlyInAnyOrder(202, 409);
        Outcome loser = outcomes.stream().filter(o -> o.status() == 409).findFirst().orElseThrow();
        assertThat(loser.type()).isIn(PROBLEM + "conflict", PROBLEM + "concurrent-modification");
        assertThat(count("select count(*) from task where deployment_id = ? and task_type = 'ROLLBACK'", id))
                .isEqualTo(1);

        // Pins the known gap: a loser that fails at commit has already committed its REQUIRES_NEW audit row.
        long expectedAudit = loser.type().equals(PROBLEM + "concurrent-modification") ? 2 : 1;
        assertThat(count("select count(*) from audit_event where action = 'ROLLBACK_REQUESTED' and target_id = ?", id))
                .isEqualTo(expectedAudit);
    }
}

