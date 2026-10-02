package io.appfleet.control.web;

import com.jayway.jsonpath.JsonPath;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.ValueSource;
import org.springframework.http.MediaType;
import org.springframework.test.web.servlet.MvcResult;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.post;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.jsonPath;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

public class ApplicationPaginationTest extends WebIntegrationTest {

    private static final String URL = "/api/v1/applications";

    private static final String GOOD_SUM = "sha256:" + "a".repeat(64);

    @BeforeEach
    void clean() {
        jdbc.execute("TRUNCATE application CASCADE");
    }

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
                        .content(appJson(uniqueName(), UUID.randomUUID())))
                .andExpect(status().isCreated()).andReturn();
        return com.jayway.jsonpath.JsonPath.read(r.getResponse().getContentAsString(), "$.id");
    }

    private String getPage(String query) throws Exception {
        return mockMvc.perform(get(URL + query))
                .andExpect(status().isOk())
                .andReturn().getResponse().getContentAsString();
    }

    private static List<String> ids(String body) {
        return JsonPath.read(body, "$.items[*].id");
    }

    private static String nextCursor(String body) {
        return JsonPath.read(body, "$.nextCursor");   // null if JSON null
    }

    @Test
    void limitZero_returns400_withLimitField() throws Exception {
        mockMvc.perform(get(URL).param("limit", "0"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.errors[?(@.field=='limit')]").exists());
    }

    @ParameterizedTest
    @ValueSource(strings = {"0", "101", "abc"})
    void invalidLimit_returns400(String limit) throws Exception {
        mockMvc.perform(get(URL).param("limit", limit))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.type").value("urn:appfleet:problem:validation-failed"))
                .andExpect(jsonPath("$.errors[?(@.field=='limit')]").exists());
    }

    @Test
    void emptyTable_returnsEmptyPage() throws Exception {
        mockMvc.perform(get(URL + "?limit=0"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.errors[?(@.field=='limit')]").exists());
    }

    @Test
    void fiveApps_limit2_threePages() throws Exception {
        List<String> applications = new ArrayList<>();
        for(int i=0; i<5; i++) {
            applications.add(createApp());
        }
        List<String> all = new ArrayList<>();
        String cursor = null;
        int[] sizes = new int[3];
        for (int i = 0; i < 3; i++) {
            String body = getPage("?limit=2" + (cursor == null ? "" : "&cursor=" + cursor));
            all.addAll(ids(body));
            cursor = nextCursor(body);
        }
        assertThat(cursor).isNull();
        assertThat(all).containsExactlyElementsOf(applications.stream().sorted().toList());
    }

    @Test
    void defaultLimit_used_whenAbsent() throws Exception {
        for (int i = 0; i < 21; i++) {
            createApp();
        }
        String body = getPage("");
        assertThat(ids(body)).hasSize(20);
        assertThat(nextCursor(body)).isNotNull();
    }

    @Test
    void garbageCursor_returns400() throws Exception {
        mockMvc.perform(get(URL).param("cursor", "???"))
                .andExpect(status().isBadRequest());
    }

    @Test
    void insertBetweenPages_noDuplicate_noSkip() throws Exception {
        List<String> applications = new ArrayList<>();
        for(int i=0; i<3; i++) {
            applications.add(createApp());
        }
        String page1 = getPage("?limit=2");
        String cursor = nextCursor(page1);
        assertThat(cursor).isNotNull();

        createApp();

        String page2 = getPage("?limit=2&cursor=" + cursor);

        List<String> p1 = ids(page1);
        List<String> p2 = ids(page2);
        List<String> union = new ArrayList<>(p1);
        union.addAll(p2);

        assertThat(p1).doesNotContainAnyElementsOf(p2);
        assertThat(union).containsAll(applications);
    }
}
