package io.appfleet.control.web;

import com.jayway.jsonpath.JsonPath;
import org.junit.jupiter.api.Test;
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
    private static final String PREFIX = "ratelimit:v1:user:";

    @Autowired
    StringRedisTemplate redis;

    private static UUID newCaller() {
        return UUID.randomUUID();
    }

    /** A request as a specific caller, optionally with an X-Team-Id header (which the server must ignore). */
    private MockHttpServletResponse callAs(String path, UUID caller, String xTeamId) throws Exception {
        var req = get(path).param("limit", "1")
                .header("Authorization", "Bearer " + TestAuth.tokenFor(caller));
        if (xTeamId != null) {
            req.header("X-Team-Id", xTeamId);
        }
        return mockMvc.perform(req).andReturn().getResponse();
    }

    private MockHttpServletResponse callAs(UUID caller, String xTeamId) throws Exception {
        return callAs(URL, caller, xTeamId);
    }

    private MockHttpServletResponse call(UUID caller) throws Exception {
        return callAs(URL, caller, null);
    }

    private List<Integer> statuses(UUID caller, int n) throws Exception {
        List<Integer> out = new ArrayList<>();
        for (int i = 0; i < n; i++) {
            out.add(call(caller).getStatus());
        }
        return out;
    }

    private static String type(MockHttpServletResponse r) throws Exception {
        return JsonPath.read(r.getContentAsString(), "$.type");
    }

    @Test
    void fourthRequest_is429_withRetryAfter() throws Exception {
        UUID caller = newCaller();
        assertThat(statuses(caller, 3)).containsExactly(200, 200, 200);

        MockHttpServletResponse r = call(caller);
        assertThat(r.getStatus()).isEqualTo(429);
        assertThat(type(r)).isEqualTo(PROBLEM + "rate-limited");
        assertThat(r.getHeader("Retry-After")).isEqualTo("1");
    }

    @Test
    void twoCallers_haveIndependentBuckets() throws Exception {
        UUID alice = newCaller();
        assertThat(statuses(alice, 4)).containsExactly(200, 200, 200, 429);   // alice is empty

        assertThat(call(newCaller()).getStatus()).isEqualTo(200);             // bob is not affected
        assertThat(call(alice).getStatus()).isEqualTo(429);                   // alice is still empty
    }

    @Test
    void afterRetryAfter_oneMoreRequestPasses() throws Exception {
        UUID caller = newCaller();
        statuses(caller, 3);
        MockHttpServletResponse limited = call(caller);
        assertThat(limited.getStatus()).isEqualTo(429);

        Thread.sleep(Long.parseLong(limited.getHeader("Retry-After")) * 1000 + 100);

        assertThat(call(caller).getStatus()).isEqualTo(200);
        assertThat(call(caller).getStatus()).isEqualTo(429);
    }

    @Test
    void concurrentBurst_allowsExactlyCapacity() throws Exception {
        UUID caller = newCaller();
        int n = 10;
        CyclicBarrier barrier = new CyclicBarrier(n);
        Callable<Integer> task = () -> {
            barrier.await(5, TimeUnit.SECONDS);
            return call(caller).getStatus();
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

    @Test
    void bucketIsHash_withExpiry() throws Exception {
        UUID caller = newCaller();
        call(caller);
        String key = PREFIX + caller;

        assertThat(redis.<String, String>opsForHash().entries(key))
                .containsEntry("tokens", "2")
                .containsKey("ts");
        assertThat(redis.getExpire(key, TimeUnit.MILLISECONDS)).isBetween(1L, 3000L);
    }

    @Test
    void unknownRoutes_spendTokens() throws Exception {
        UUID caller = newCaller();
        assertThat(callAs("/api/v1/nope", caller, null).getStatus()).isEqualTo(404);
        assertThat(callAs("/api/v1/nope", caller, null).getStatus()).isEqualTo(404);

        int allowed = 0;
        for (int i = 0; i < 5 && call(caller).getStatus() == 200; i++) {
            allowed++;
        }
        assertThat(allowed).isEqualTo(1);
    }

    @Test
    void rotatingXTeamId_doesNotEscapeTheLimit() throws Exception {
        UUID alice = newCaller();

        for (int i = 0; i < 3; i++) {
            assertThat(callAs(alice, UUID.randomUUID().toString()).getStatus()).isEqualTo(200);
        }
        assertThat(callAs(alice, UUID.randomUUID().toString()).getStatus()).isEqualTo(429);
    }

    @Test
    void xTeamIdHeader_isIgnored() throws Exception {
        assertThat(callAs(newCaller(), "not-a-uuid").getStatus()).isEqualTo(200);
    }
}
