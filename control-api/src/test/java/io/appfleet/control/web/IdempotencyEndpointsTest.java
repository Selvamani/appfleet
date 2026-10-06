package io.appfleet.control.web;

import com.jayway.jsonpath.JsonPath;
import io.appfleet.control.deployment.web.CreateDeploymentRequest;
import io.appfleet.control.idempotency.IdempotencyRecord;
import io.appfleet.control.idempotency.IdempotencyStore;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.http.MediaType;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.test.web.servlet.request.MockHttpServletRequestBuilder;
import tools.jackson.databind.json.JsonMapper;

import java.security.MessageDigest;
import java.time.Duration;
import java.util.HexFormat;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.*;
import java.util.stream.Stream;

import static io.appfleet.control.deployment.DeploymentState.*;
import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;

class IdempotencyEndpointsTest extends WebIntegrationTest {

    private static final String URL = "/api/v1/deployments";
    private static final String PROBLEM = "urn:appfleet:problem:";
    private static final String REDIS_PREFIX = "idempotency:v1:deployments:";

    @Autowired StringRedisTemplate redis;
    @Autowired IdempotencyStore store;
    @Autowired JsonMapper json;

    private record Response(int status, String deploymentId, String taskId, String location, String replayed, String type) {}

    private static String newKey() {
        return UUID.randomUUID().toString();
    }

    private static String scoped(String key) {
        return REDIS_PREFIX + TestAuth.USER + ":" + key;       // the default token's sub
    }

    private Response send(CreateDeploymentRequest body, String key) throws Exception {
        MockHttpServletRequestBuilder req = post(URL).contentType(MediaType.APPLICATION_JSON)
                .content(json.writeValueAsString(body));
        if (key != null) {
            req.header("Idempotency-Key", key);
        }
        return toResponse(mockMvc.perform(req).andReturn().getResponse());
    }

    private static Response toResponse(MockHttpServletResponse r) throws Exception {
        String body = r.getContentAsString();
        if (r.getStatus() == 202) {
            return new Response(202, JsonPath.read(body, "$.deploymentId"), JsonPath.read(body, "$.taskId"),
                    r.getHeader("Location"), r.getHeader("Idempotent-Replayed"), null);
        }
        return new Response(r.getStatus(), null, null, null, null, JsonPath.read(body, "$.type"));
    }

    private long deploymentsFor(TestFixtures.Fixture f) {
        return count("select count(*) from deployment where application_id = ? and environment_id = ?",
                f.app().getId(), f.env().getId());
    }

    private IdempotencyRecord record(String key) {
        String value = redis.opsForValue().get(scoped(key));
        return value == null ? null : json.readValue(value, IdempotencyRecord.class);
    }

    /** Same rule as IdempotencyExecutor: SHA-256 over the JSON of the request record. Change both together. */
    private String fingerprint(CreateDeploymentRequest request) throws Exception {
        return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(json.writeValueAsBytes(request)));
    }

    private ResultActions postWithKey(UUID caller, String key, String json) throws Exception {
        return mockMvc.perform(post(URL)
                .header("Authorization", "Bearer " + TestAuth.tokenFor(caller))
                .header("Idempotency-Key", key)
                .contentType(MediaType.APPLICATION_JSON)
                .content(json));
    }

    /** Like send(), but as a specific caller, so two callers can share an Idempotency-Key. */
    private Response sendAs(UUID caller, CreateDeploymentRequest body, String key) throws Exception {
        MockHttpServletRequestBuilder req = post(URL)
                .header("Authorization", "Bearer " + TestAuth.tokenFor(caller))
                .header("Idempotency-Key", key)
                .contentType(MediaType.APPLICATION_JSON)
                .content(json.writeValueAsString(body));
        return toResponse(mockMvc.perform(req).andReturn().getResponse());
    }

    @Test
    void newKey_executes_andStoresCompletedRecord() throws Exception {
        TestFixtures.Fixture f = fixtures.fixture();
        String key = newKey();

        Response r = send(f.request(), key);

        assertThat(r.status()).isEqualTo(202);
        assertThat(r.replayed()).isEqualTo("false");
        IdempotencyRecord stored = record(key);
        assertThat(stored.state()).isEqualTo(IdempotencyRecord.State.COMPLETED);
        assertThat(stored.owner()).isNull();
        assertThat(stored.response()).contains(r.deploymentId());
        assertThat(redis.getExpire(scoped(key), TimeUnit.MINUTES)).isBetween(23 * 60L, 24 * 60L);
    }

    @Test
    void sameKeySameBody_replaysOriginalResponse_andExecutesNothing() throws Exception {
        TestFixtures.Fixture f = fixtures.fixture();
        String key = newKey();

        Response first = send(f.request(), key);
        Response second = send(f.request(), key);

        assertThat(second.status()).isEqualTo(202);
        assertThat(second.replayed()).isEqualTo("true");
        assertThat(second.deploymentId()).isEqualTo(first.deploymentId());
        assertThat(second.taskId()).isEqualTo(first.taskId());
        assertThat(second.location()).isEqualTo(first.location());
        assertThat(deploymentsFor(f)).isEqualTo(1);
        assertThat(count("select count(*) from task where deployment_id = ?",
                UUID.fromString(first.deploymentId()))).isEqualTo(1);
        assertThat(count("select count(*) from audit_event where action = 'DEPLOYMENT_REQUESTED' and target_id = ?",
                UUID.fromString(first.deploymentId()))).isEqualTo(1);
    }

    @Test
    void retryAfterFirstDeploymentFailed_replays_insteadOfDeployingAgain() throws Exception {
        TestFixtures.Fixture f = fixtures.fixture();
        String key = newKey();

        Response first = send(f.request(), key);
        fixtures.driveTo(UUID.fromString(first.deploymentId()), FAILED);      // the partial index no longer blocks

        Response retry = send(f.request(), key);
        assertThat(retry.status()).isEqualTo(202);
        assertThat(retry.replayed()).isEqualTo("true");
        assertThat(retry.deploymentId()).isEqualTo(first.deploymentId());
        assertThat(deploymentsFor(f)).isEqualTo(1);

        // contrast: without a key, the same request now creates a second deployment
        Response withoutKey = send(f.request(), null);
        assertThat(withoutKey.status()).isEqualTo(202);
        assertThat(withoutKey.deploymentId()).isNotEqualTo(first.deploymentId());
        assertThat(deploymentsFor(f)).isEqualTo(2);
    }

    @Test
    void sameKeyDifferentBody_returns422_andCreatesNothing() throws Exception {
        TestFixtures.Fixture f = fixtures.fixture();
        TestFixtures.Fixture other = fixtures.fixture();
        String key = newKey();
        send(f.request(), key);

        Response reused = send(other.request(), key);

        assertThat(reused.status()).isEqualTo(422);
        assertThat(reused.type()).isEqualTo(PROBLEM + "idempotency-key-reused");
        assertThat(deploymentsFor(other)).isZero();
    }

    @Test
    void claimInProgress_returns409_withRetryAfter() throws Exception {
        TestFixtures.Fixture f = fixtures.fixture();
        String key = newKey();
        String inProgress = json.writeValueAsString(IdempotencyRecord.inProgress("test-owner", fingerprint(f.request())));
        assertThat(store.claim("deployments:" + TestAuth.USER + ":" + key, inProgress, Duration.ofSeconds(30))).isNull();

        MockHttpServletResponse r = mockMvc.perform(post(URL).contentType(MediaType.APPLICATION_JSON)
                .header("Idempotency-Key", key).content(json.writeValueAsString(f.request()))).andReturn().getResponse();

        assertThat(r.getStatus()).isEqualTo(409);
        assertThat((String) JsonPath.read(r.getContentAsString(), "$.type")).isEqualTo(PROBLEM + "request-in-progress");
        assertThat(r.getHeader("Retry-After")).isEqualTo("1");
        assertThat(deploymentsFor(f)).isZero();
    }

    @Test
    void concurrentIdenticalPosts_sameKey_exactlyOneDeployment() throws Exception {
        TestFixtures.Fixture f = fixtures.fixture();
        String key = newKey();
        CyclicBarrier barrier = new CyclicBarrier(2);
        Callable<Response> call = () -> {
            barrier.await(5, TimeUnit.SECONDS);
            return send(f.request(), key);
        };
        ExecutorService pool = Executors.newFixedThreadPool(2);
        List<Response> responses;
        try {
            Future<Response> a = pool.submit(call);
            Future<Response> b = pool.submit(call);
            responses = List.of(a.get(10, TimeUnit.SECONDS), b.get(10, TimeUnit.SECONDS));
        } finally {
            pool.shutdownNow();
        }

        assertThat(deploymentsFor(f)).isEqualTo(1);
        assertThat(responses).extracting(Response::status).allMatch(s -> s == 202 || s == 409);
        assertThat(responses).filteredOn(r -> r.status() == 202 && "false".equals(r.replayed())).hasSize(1);
        assertThat(responses).filteredOn(r -> r.status() == 409)
                .allMatch(r -> (PROBLEM + "request-in-progress").equals(r.type()));
    }

    @Test
    void failedRequest_releasesKey_soRetryExecutesAgain() throws Exception {
        TestFixtures.Fixture f = fixtures.fixture();
        String key = newKey();
        CreateDeploymentRequest unknownApp = new CreateDeploymentRequest(UUID.randomUUID(), f.release().getId(),
                f.env().getName());

        Response first = send(unknownApp, key);
        assertThat(first.status()).isEqualTo(422);
        assertThat(first.type()).isEqualTo(PROBLEM + "unprocessable");
        assertThat(redis.hasKey(scoped(key))).isFalse();

        Response retry = send(unknownApp, key);
        assertThat(retry.status()).isEqualTo(422);                 // not 409 request-in-progress
    }

    @Test
    void conflictWithActiveDeployment_releasesKey() throws Exception {
        TestFixtures.Fixture f = fixtures.fixture();
        send(f.request(), null);                                     // active deployment, no key
        String key = newKey();

        Response r = send(f.request(), key);

        assertThat(r.status()).isEqualTo(409);
        assertThat(r.type()).isEqualTo(PROBLEM + "conflict");
        assertThat(redis.hasKey(scoped(key))).isFalse();
    }

    @Test
    void withoutKey_redisIsNotTouched() throws Exception {
        long before = redis.keys("idempotency:*").size();
        assertThat(send(fixtures.fixture().request(), null).status()).isEqualTo(202);
        assertThat(redis.keys("idempotency:*")).hasSize((int) before);
    }

    static Stream<String> invalidKeys() {
        return Stream.of("", "a".repeat(256), "has space", "tab\there");
    }

    @ParameterizedTest
    @MethodSource("invalidKeys")
    void invalidKey_returns400(String key) throws Exception {
        TestFixtures.Fixture f = fixtures.fixture();
        MockHttpServletResponse r = mockMvc.perform(post(URL).contentType(MediaType.APPLICATION_JSON)
                .header("Idempotency-Key", key).content(json.writeValueAsString(f.request()))).andReturn().getResponse();

        assertThat(r.getStatus()).isEqualTo(400);
        assertThat((String) JsonPath.read(r.getContentAsString(), "$.type")).isEqualTo(PROBLEM + "validation-failed");
        assertThat((List<String>) JsonPath.read(r.getContentAsString(), "$.errors[*].field")).containsExactly("Idempotency-Key");
        assertThat(deploymentsFor(f)).isZero();
    }

    @Test
    void differentCaller_sameKey_differentBody_isNotRejected() throws Exception {
        TestFixtures.Fixture forAlice = fixtures.fixture();
        TestFixtures.Fixture forBob = fixtures.fixture();
        String key = newKey();
        UUID alice = UUID.randomUUID();
        UUID bob = UUID.randomUUID();

        assertThat(sendAs(alice, forAlice.request(), key).status()).isEqualTo(202);
        Response bobs = sendAs(bob, forBob.request(), key);

        assertThat(bobs.status()).isEqualTo(202);                  // today: 422 idempotency-key-reused, a leak that the key exists
        assertThat(bobs.replayed()).isEqualTo("false");
        assertThat(deploymentsFor(forBob)).isEqualTo(1);
    }

    @Test
    void differentCaller_sameKey_sameBody_isNotReplayed() throws Exception {
        TestFixtures.Fixture f = fixtures.fixture();
        String key = newKey();
        UUID alice = UUID.randomUUID();
        UUID bob = UUID.randomUUID();

        Response first = sendAs(alice, f.request(), key);
        Response bobs = sendAs(bob, f.request(), key);

        assertThat(first.status()).isEqualTo(202);
        assertThat(bobs.replayed()).isNotEqualTo("true");           // today: "true", A's answer replayed to B
        assertThat(bobs.taskId()).isNotEqualTo(first.taskId());     // today: A's task id
        assertThat(bobs.status()).isEqualTo(409);                   // B really tried: an active deployment already exists
        assertThat(bobs.type()).isEqualTo(PROBLEM + "conflict");
        assertThat(deploymentsFor(f)).isEqualTo(1);
    }

    @Test
    void sameCaller_sameKey_sameBody_stillReplays() throws Exception {
        TestFixtures.Fixture f = fixtures.fixture();
        String key = newKey();
        UUID alice = UUID.randomUUID();

        Response first = sendAs(alice, f.request(), key);
        Response second = sendAs(alice, f.request(), key);

        assertThat(second.status()).isEqualTo(202);
        assertThat(second.replayed()).isEqualTo("true");
        assertThat(second.taskId()).isEqualTo(first.taskId());
        assertThat(deploymentsFor(f)).isEqualTo(1);
    }

    @Test
    void redisKey_isScopedToTheCallersSub() throws Exception {
        String key = newKey();
        UUID alice = UUID.randomUUID();

        sendAs(alice, fixtures.fixture().request(), key);

        assertThat(redis.hasKey(REDIS_PREFIX + alice + ":" + key)).isTrue();   // today: false
        assertThat(redis.hasKey(REDIS_PREFIX + key)).isFalse();                // today: true
    }
}
