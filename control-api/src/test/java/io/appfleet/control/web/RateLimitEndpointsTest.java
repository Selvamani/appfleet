package io.appfleet.control.web;

import com.jayway.jsonpath.JsonPath;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.test.context.TestPropertySource;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.*;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;

@TestPropertySource(properties = {
        "appfleet.rate-limit.enabled=true",
        "appfleet.rate-limit.capacity=3",
        "appfleet.rate-limit.refill-per-second=1"
})
class RateLimitEndpointsTest extends WebIntegrationTest {

    private static final String URL = "/api/v1/applications";
    private static final String PROBLEM = "urn:appfleet:problem:";
    private static final String PREFIX = "ratelimit:v1:team:";

    @Autowired
    StringRedisTemplate redis;

    private static String newTeam() {
        return UUID.randomUUID().toString();
    }

    private MockHttpServletResponse call(String path, String team) throws Exception {
        var req = get(path).param("limit", "1");
        if (team != null) {
            req.header("X-Team-Id", team);
        }
        return mockMvc.perform(req).andReturn().getResponse();
    }

    private MockHttpServletResponse call(String team) throws Exception {
        return call(URL, team);
    }

    private List<Integer> statuses(String team, int n) throws Exception {
        List<Integer> out = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            out.add(call(team).getStatus());
        }
        return out;
    }

    private static String type(MockHttpServletResponse r) throws Exception {
        return JsonPath.read(r.getContentAsString(), "$.type");
    }

    @Test
    void fourthRequest_is429_withRetryAfter() throws Exception {
        String team = newTeam();
        assertThat(statuses(team, 3)).containsExactly(200, 200, 200);

        MockHttpServletResponse r = call(team);
        assertThat(r.getStatus()).isEqualTo(429);
        assertThat(type(r)).isEqualTo(PROBLEM + "rate-limited");
        assertThat(r.getHeader("Retry-After")).isEqualTo("1");
    }

    @Test
    void otherTeam_hasOwnBucket() throws Exception {
        String teamA = newTeam();
        assertThat(statuses(teamA, 4)).containsExactly(200, 200, 200, 429);   // A is empty

        assertThat(call(newTeam()).getStatus()).isEqualTo(200);               // B is not affected
        assertThat(call(teamA).getStatus()).isEqualTo(429);                   // A is still empty
    }

    @Test
    void noHeader_sharesAnonymousBucket() throws Exception {
        redis.delete(PREFIX + "anonymous");          // shared key: start from a known state
        assertThat(statuses(null, 4)).containsExactly(200, 200, 200, 429);
        assertThat(call(newTeam()).getStatus()).isEqualTo(200);
    }

    @Test
    void afterRetryAfter_oneMoreRequestPasses() throws Exception {
        String team = newTeam();
        statuses(team, 3);
        MockHttpServletResponse limited = call(team);
        assertThat(limited.getStatus()).isEqualTo(429);

        Thread.sleep(Long.parseLong(limited.getHeader("Retry-After")) * 1000 + 100);

        assertThat(call(team).getStatus()).isEqualTo(200);
        assertThat(call(team).getStatus()).isEqualTo(429);
    }

    @Test
    void concurrentBurst_allowsExactlyCapacity() throws Exception {
        String team = newTeam();
        int n = 10;
        CyclicBarrier barrier = new CyclicBarrier(n);
        Callable<Integer> task = () -> {
            barrier.await(5, TimeUnit.SECONDS);
            return call(team).getStatus();
        };
        ExecutorService pool = Executors.newFixedThreadPool(n);
        List<Integer> statuses = new ArrayList<>();
        try {
            for (Future<Integer> f : pool.invokeAll(Collections.nCopies(n, task), 10, TimeUnit.SECONDS)) {
                statuses.add(f.get());
            }
        } finally {
            pool.shutdownNow();
        }
        assertThat(statuses).containsOnly(200, 429);                      // never 500
        assertThat(statuses).filteredOn(s -> s == 200).hasSize(3);
    }

    @ParameterizedTest   // 6
    @ValueSource(strings = {"not-a-uuid", "1-1-1-1-1"})
    void invalidTeamHeader_is400(String bad) throws Exception {
        MockHttpServletResponse r = call(bad);
        assertThat(r.getStatus()).isEqualTo(400);
        assertThat(type(r)).isEqualTo(PROBLEM + "validation-failed");
        assertThat((String) JsonPath.read(r.getContentAsString(), "$.errors[0].field")).isEqualTo("X-Team-Id");
    }

    @Test
    void bucketIsHash_withExpiry() throws Exception {
        String team = newTeam();
        call(team);
        String key = PREFIX + team;

        assertThat(redis.<String, String>opsForHash().entries(key))
                .containsEntry("tokens", "2")
                .containsKey("ts");
        assertThat(redis.getExpire(key, TimeUnit.MILLISECONDS)).isBetween(1L, 3000L);
    }

    @Test
    void unknownRoutes_spendTokens() throws Exception {      // rename to match what you observe
        String team = newTeam();
        assertThat(call("/api/v1/nope", team).getStatus()).isEqualTo(404);
        assertThat(call("/api/v1/nope", team).getStatus()).isEqualTo(404);

        int allowed = 0;
        for (int i = 0; i < 5 && call(team).getStatus() == 200; i++) {
            allowed++;
        }
        assertThat(allowed).isEqualTo(1);                    // pin observed value
    }
}