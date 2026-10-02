package io.appfleet.control.web;

import com.jayway.jsonpath.JsonPath;
import io.appfleet.control.deployment.Deployment;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.CsvSource;
import org.junit.jupiter.params.provider.ValueSource;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;

class TaskHistoryEndpointsTest extends WebIntegrationTest {

    private static final String URL = "/api/v1/deployments/";
    private static final String PROBLEM = "urn:appfleet:problem:";

    private String fetch(String path) throws Exception {
        return mockMvc.perform(get(path)).andExpect(status().isOk()).andReturn().getResponse().getContentAsString();
    }

    private static List<String> ids(String body) {
        return JsonPath.read(body, "$.items[*].id");
    }

    private static String nextCursor(String body) {
        return JsonPath.read(body, "$.nextCursor");
    }

    private static boolean hasNext(String body) {
        return JsonPath.read(body, "$.hasNext");
    }

    private List<String> walkCursor(UUID deploymentId, int limit) throws Exception {
        List<String> all = new ArrayList<>();
        String cursor = null;
        do {
            String body = fetch(URL + deploymentId + "/tasks?limit=" + limit + (cursor == null ? "" : "&cursor=" + cursor));
            all.addAll(ids(body));
            cursor = nextCursor(body);
        } while (cursor != null);
        return all;
    }

    private List<String> walkOffset(UUID deploymentId, int size) throws Exception {
        List<String> all = new ArrayList<>();
        int page = 0;
        String body;
        do {
            body = fetch(URL + deploymentId + "/tasks/by-offset?page=" + page++ + "&size=" + size);
            all.addAll(ids(body));
        } while (hasNext(body));
        return all;
    }

    @Test
    void cursor_fiveTasksLimit2_threePagesInIdOrder() throws Exception {
        Deployment d = fixtures.deployment();
        List<String> expected = fixtures.tasks(d, 5);

        String p1 = fetch(URL + d.getId() + "/tasks?limit=2");
        String p2 = fetch(URL + d.getId() + "/tasks?limit=2&cursor=" + nextCursor(p1));
        String p3 = fetch(URL + d.getId() + "/tasks?limit=2&cursor=" + nextCursor(p2));

        assertThat(ids(p1)).hasSize(2);
        assertThat(ids(p2)).hasSize(2);
        assertThat(ids(p3)).hasSize(1);
        assertThat(nextCursor(p3)).isNull();
        List<String> all = new ArrayList<>(ids(p1));
        all.addAll(ids(p2));
        all.addAll(ids(p3));
        assertThat(all).containsExactlyElementsOf(expected);
    }

    @Test
    void cursor_defaultLimitIs20() throws Exception {
        Deployment d = fixtures.deployment();
        fixtures.tasks(d, 21);
        String body = fetch(URL + d.getId() + "/tasks");
        assertThat(ids(body)).hasSize(20);
        assertThat(nextCursor(body)).isNotNull();
    }

    @Test
    void cursor_onlyReturnsTasksOfThatDeployment() throws Exception {
        Deployment a = fixtures.deployment();
        Deployment b = fixtures.deployment();
        List<String> expectedA = fixtures.tasks(a, 3);
        List<String> expectedB = fixtures.tasks(b, 3);

        assertThat(walkCursor(a.getId(), 2)).containsExactlyElementsOf(expectedA);
        assertThat(walkCursor(b.getId(), 2)).containsExactlyElementsOf(expectedB);
    }

    @Test
    void cursor_deploymentWithoutTasks_returnsEmptyPage() throws Exception {
        String body = fetch(URL + fixtures.deployment().getId() + "/tasks");
        assertThat(ids(body)).isEmpty();
        assertThat(nextCursor(body)).isNull();
    }

    @ParameterizedTest
    @ValueSource(strings = {"/tasks", "/tasks/by-offset"})
    void unknownDeployment_returns404(String suffix) throws Exception {
        mockMvc.perform(get(URL + UUID.randomUUID() + suffix))
                .andExpect(status().isNotFound())
                .andExpect(jsonPath("$.type").value(PROBLEM + "not-found"));
    }

    @ParameterizedTest
    @ValueSource(strings = {"/tasks", "/tasks/by-offset"})
    void malformedDeploymentId_returns400(String suffix) throws Exception {
        mockMvc.perform(get(URL + "not-a-uuid" + suffix))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.type").value(PROBLEM + "validation-failed"))
                .andExpect(jsonPath("$.errors[?(@.field=='id')]").exists());
    }

    @ParameterizedTest
    @ValueSource(strings = {"0", "101", "abc"})
    void cursor_invalidLimit_returns400(String limit) throws Exception {
        mockMvc.perform(get(URL + fixtures.deployment().getId() + "/tasks").param("limit", limit))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.type").value(PROBLEM + "validation-failed"))
                .andExpect(jsonPath("$.errors[?(@.field=='limit')]").exists());
    }

    @Test
    void cursor_garbageCursor_returns400() throws Exception {
        mockMvc.perform(get(URL + fixtures.deployment().getId() + "/tasks").param("cursor", "???"))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.errors[?(@.field=='cursor')]").exists());
    }

    @Test
    void cursor_insertBetweenPages_noDuplicate_noSkip() throws Exception {
        Deployment d = fixtures.deployment();
        List<String> existing = fixtures.tasks(d, 3);

        String p1 = fetch(URL + d.getId() + "/tasks?limit=2");
        fixtures.tasks(d, 1);                                  // arrives mid-traversal
        String p2 = fetch(URL + d.getId() + "/tasks?limit=2&cursor=" + nextCursor(p1));

        List<String> seen = new ArrayList<>(ids(p1));
        seen.addAll(ids(p2));
        assertThat(seen).doesNotHaveDuplicates();
        assertThat(seen).containsAll(existing);
    }

    @Test
    void offset_pagesAndEnd() throws Exception {
        Deployment d = fixtures.deployment();
        List<String> expected = fixtures.tasks(d, 5);

        String p0 = fetch(URL + d.getId() + "/tasks/by-offset?page=0&size=2");
        String p2 = fetch(URL + d.getId() + "/tasks/by-offset?page=2&size=2");
        String p3 = fetch(URL + d.getId() + "/tasks/by-offset?page=3&size=2");

        assertThat(ids(p0)).containsExactlyElementsOf(expected.subList(0, 2));
        assertThat(hasNext(p0)).isTrue();
        assertThat(ids(p2)).containsExactly(expected.get(4));
        assertThat(hasNext(p2)).isFalse();
        assertThat(ids(p3)).isEmpty();
        assertThat(hasNext(p3)).isFalse();
    }

    @Test
    void offsetAndCursor_returnSameSequence() throws Exception {
        Deployment d = fixtures.deployment();
        List<String> expected = fixtures.tasks(d, 7);
        assertThat(walkCursor(d.getId(), 2)).containsExactlyElementsOf(expected);
        assertThat(walkOffset(d.getId(), 2)).containsExactlyElementsOf(expected);
    }

    @ParameterizedTest
    @CsvSource({"page,-1", "size,0", "size,101"})
    void offset_outOfRange_returns400(String param, String value) throws Exception {
        mockMvc.perform(get(URL + fixtures.deployment().getId() + "/tasks/by-offset").param(param, value))
                .andExpect(status().isBadRequest())
                .andExpect(jsonPath("$.type").value(PROBLEM + "validation-failed"))
                .andExpect(jsonPath("$.errors[?(@.field=='" + param + "')]").exists());
    }

    @Test
    void cursor_fromAnotherDeployment_isJustAPosition() throws Exception {
        Deployment a = fixtures.deployment();
        Deployment b = fixtures.deployment();
        List<String> idsA = fixtures.tasks(a, 2);
        List<String> idsB = fixtures.tasks(b, 2);
        String foreignCursor = CursorCodec.encode(UUID.fromString(idsA.get(0)));

        String body = fetch(URL + b.getId() + "/tasks?cursor=" + foreignCursor);
        assertThat(idsB).containsAll(ids(body));                // only b's tasks, never a's
    }
}
