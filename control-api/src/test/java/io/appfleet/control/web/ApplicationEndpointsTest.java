package io.appfleet.control.web;

import org.junit.jupiter.api.Test;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MvcResult;

import java.util.List;
import java.util.UUID;
import java.util.concurrent.*;

import static org.assertj.core.api.Assertions.assertThat;
import static org.hamcrest.Matchers.startsWith;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

public class ApplicationEndpointsTest extends WebIntegrationTest {

    private static final String URL = "/api/v1/applications";

    private static final String GOOD_SUM = "sha256:" + "a".repeat(64);

    private static String appJson(String name, UUID owner) {
        return """
                {"name":"%s","description":"x","ownerTeamId":"%s"}
                """.formatted(name, owner);
    }

    private static String uniqueName() {
        return "app-" + UUID.randomUUID().toString().substring(0, 8);
    }

    private static String releaseJson(String version, String checksum) {
        return """
                {"version":"%s","artifactRef":"registry/app:%s","checksum":"%s"}
                """.formatted(version, version, checksum);
    }

    private String createApp() throws Exception {   // returns app id
        MvcResult r = mockMvc.perform(post(URL).contentType(MediaType.APPLICATION_JSON)
                        .content(appJson(uniqueName(), TestAuth.TEAM)))
                .andExpect(status().isCreated()).andReturn();
        return com.jayway.jsonpath.JsonPath.read(r.getResponse().getContentAsString(), "$.id");
    }

    @Test
    void apiPath_reachesMvc_andReturnsOurProblemShape() throws Exception {
        mockMvc.perform(get("/api/v1/nope"))
                .andExpect(status().isNotFound());
    }

    @Test
    void createApplication_returns201_andLocationResolves() throws Exception {
        String body = """
                {"name":"orders","description":"x","ownerTeamId":"%s"}
                """.formatted(TestAuth.TEAM);

        MvcResult created = mockMvc.perform(post("/api/v1/applications")
                        .contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isCreated())
                .andExpect(header().string("Location", startsWith("/api/v1/applications/")))
                .andExpect(jsonPath("$.id").isNotEmpty())
                .andExpect(jsonPath("$.createdAt").isNotEmpty())
                .andReturn();

        String location = created.getResponse().getHeader("Location");
        mockMvc.perform(get(location))
                .andExpect(status().isOk())
                .andExpect(content().json(created.getResponse().getContentAsString()));
    }

    @Test
    void createApplication_returns409_andConflictOccurs() throws Exception {
        String name = uniqueName();
        mockMvc.perform(post(URL).contentType(MediaType.APPLICATION_JSON).content(appJson(name, TestAuth.TEAM))).andExpect(status().isCreated());
        mockMvc.perform(post(URL).contentType(MediaType.APPLICATION_JSON).content(appJson(name, TestAuth.TEAM)))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.type").value("urn:appfleet:problem:conflict"))
                .andExpect(jsonPath("$.detail").value("An application with this name already exists."));

    }

    @Test
    void createApplication_returns400_andValidationFailed() throws Exception {
        String body = """
                {"name":"","description":"x"}
                """;
        mockMvc.perform(post(URL).contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.type").value("urn:appfleet:problem:validation-failed"))
                .andExpect(jsonPath("$.errors[?(@.field=='name')]").exists())
                .andExpect(jsonPath("$.errors[?(@.field=='ownerTeamId')]").exists());
    }

    @Test
    void createApplication_returns400_andMalformedRequestCheck() throws Exception {
        String body = """
                {"name":.}
                """;
        mockMvc.perform(post(URL).contentType(MediaType.APPLICATION_JSON).content(body))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.type").value("urn:appfleet:problem:malformed-request"));
    }

    @Test
    void getApplication_returns400_whenIdNotUuid() throws Exception {
        mockMvc.perform(get(URL + "/test1").contentType(MediaType.APPLICATION_JSON))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.type").value("urn:appfleet:problem:validation-failed"))
                .andExpect(jsonPath("$.errors[?(@.field=='id')]").exists());
    }

    @Test
    void getApplication_returns404() throws Exception {
        mockMvc.perform(get(URL + "/" + UUID.randomUUID()).contentType(MediaType.APPLICATION_JSON))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.type").value("urn:appfleet:problem:not-found"));
    }

    @Test
    void createRelease_returns404_andApplicationNotFound() throws Exception {
        mockMvc.perform(post(URL + "/" + UUID.randomUUID() + "/releases").contentType(MediaType.APPLICATION_JSON).content(releaseJson("v1.0.0", GOOD_SUM)))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.type").value("urn:appfleet:problem:not-found"));
    }

    @Test
    void createRelease_returns201_andValidRelease() throws Exception {
        String appId = createApp();
        var response = mockMvc.perform(post(URL + "/" + appId + "/releases").contentType(MediaType.APPLICATION_JSON).content(releaseJson("v1.0.0", GOOD_SUM)))
                .andExpect(status().isCreated())
                .andExpect(header().string("Location", startsWith("/api/v1/applications/" + appId + "/releases")))
                .andExpect(jsonPath("$.id").isNotEmpty())
                .andExpect(jsonPath("$.createdAt").isNotEmpty()).andReturn().getResponse();
        mockMvc.perform(get(response.getHeader("Location")))
                .andExpect(status().isOk())
                .andExpect(content().json(response.getContentAsString()));
    }

    @Test
    void createRelease_returns409_andConflictOccurs() throws Exception {
        String appId = createApp();
        mockMvc.perform(post(URL + "/" + appId + "/releases").contentType(MediaType.APPLICATION_JSON).content(releaseJson("v1.0.0", GOOD_SUM)))
                .andExpect(status().isCreated());
        mockMvc.perform(post(URL + "/" + appId + "/releases").contentType(MediaType.APPLICATION_JSON).content(releaseJson("v1.0.0", GOOD_SUM)))
                .andExpect(status().isConflict())
                .andExpect(jsonPath("$.type").value("urn:appfleet:problem:conflict"))
                .andExpect(jsonPath("$.detail").value("This application already has a release with that version."));
    }

    @Test
    void createRelease_returns400_andBadChecksum() throws Exception {
        String appId = createApp();
        mockMvc.perform(post(URL + "/" + appId + "/releases").contentType(MediaType.APPLICATION_JSON).content(releaseJson("v1.0.0", "bad-checksum")))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.errors[?(@.field=='checksum')] ").isNotEmpty());
    }

    @Test
    void getRelease_returns404() throws Exception {
        String appId1 = createApp();
        String appId2 = createApp();
        mockMvc.perform(post(URL + "/" + appId1 + "/releases").contentType(MediaType.APPLICATION_JSON).content(releaseJson("v1.0.0", GOOD_SUM)));

        MvcResult b = mockMvc.perform(post(URL + "/" + appId2 + "/releases").contentType(MediaType.APPLICATION_JSON).content(releaseJson("v1.0.1", GOOD_SUM)))
                .andExpect(status().isCreated())
                .andReturn();
        String loc = b.getResponse().getHeader("Location");
        String releaseIdOfB = loc.substring(loc.lastIndexOf('/') + 1);
        mockMvc.perform(get(URL + "/" + appId1 + "/releases/" + releaseIdOfB).contentType(MediaType.APPLICATION_JSON)).andExpect(status().isNotFound());
    }

    @Test
    void concurrentCreate_sameName_oneCreated_oneConflict() throws Exception {
        String name = uniqueName();
        CyclicBarrier barrier = new CyclicBarrier(2);
        Callable<Integer> call = () -> {
            barrier.await(5, TimeUnit.SECONDS);
            return mockMvc.perform(post(URL).contentType(MediaType.APPLICATION_JSON)
                            .content(appJson(name, TestAuth.TEAM)))
                    .andReturn().getResponse().getStatus();
        };
        ExecutorService pool = Executors.newFixedThreadPool(2);
        try {
            Future<Integer> f1 = pool.submit(call);
            Future<Integer> f2 = pool.submit(call);
            List<Integer> statuses = List.of(f1.get(10, TimeUnit.SECONDS), f2.get(10, TimeUnit.SECONDS));
            assertThat(statuses).containsExactlyInAnyOrder(201, 409);
        } finally {
            pool.shutdownNow();
        }
    }


}