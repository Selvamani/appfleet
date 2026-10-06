package io.appfleet.control.web;

import io.appfleet.control.web.openapi.ProblemKind;
import io.appfleet.control.web.openapi.ProblemResponses;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Qualifier;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.web.bind.annotation.RequestMethod;
import org.springframework.web.method.HandlerMethod;
import org.springframework.web.servlet.mvc.method.annotation.RequestMappingHandlerMapping;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.util.*;
import java.util.stream.Collectors;

import static org.assertj.core.api.Assertions.assertThat;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.get;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.status;

class OpenApiContractTest extends WebIntegrationTest {

    @Autowired MockMvc mvc;
    @Autowired @Qualifier("requestMappingHandlerMapping") RequestMappingHandlerMapping mapping;
    @Autowired JsonMapper json;

    private JsonNode spec() throws Exception {
        String body = mvc.perform(get("/v3/api-docs/api-v1"))
                .andExpect(status().isOk()).andReturn().getResponse().getContentAsString();
        return json.readTree(body);
    }

    /** "METHOD /path" -> operation node, for every operation in the spec. */
    private Map<String, JsonNode> operations() throws Exception {
        Map<String, JsonNode> ops = new java.util.TreeMap<>();
        spec().get("paths").properties().forEach(p ->
                p.getValue().properties().forEach(m ->
                        ops.put(m.getKey().toUpperCase() + " " + p.getKey(), m.getValue())));
        return ops;
    }

    private JsonNode op(String key) throws Exception {
        JsonNode o = operations().get(key);
        assertThat(o).as("operation " + key).isNotNull();
        return o;
    }

    private static JsonNode header(JsonNode op, String name) {
        for (JsonNode p : op.path("parameters"))
            if ("header".equals(p.path("in").asString()) && name.equals(p.path("name").asString())) return p;
        return null;
    }

    private static JsonNode param(JsonNode op, String name) {
        for (JsonNode p : op.path("parameters"))
            if (name.equals(p.path("name").asString())) return p;
        return null;
    }

    @Test
    void docs_areServed_andAreJson() throws Exception {
        var r = mvc.perform(get("/v3/api-docs/api-v1")).andExpect(status().isOk()).andReturn().getResponse();
        assertThat(r.getContentType()).startsWith("application/json");
        assertThat(spec().get("openapi").asString()).startsWith("3.1");
    }

    @Test
    void everyHandlerIsDocumented_andNothingElse() throws Exception {
        Set<String> code = new TreeSet<>();
        mapping.getHandlerMethods().keySet().forEach(info -> {
            for (String path : info.getPathPatternsCondition().getPatternValues())
                for (RequestMethod m : info.getMethodsCondition().getMethods())
                    if (path.startsWith("/api/v1/")) code.add(m + " " + path);
        });
        assertThat(operations().keySet()).containsExactlyInAnyOrderElementsOf(code).hasSize(11);
    }

    @Test
    void everyOperationHasSummaryAndTag() throws Exception {
        List<String> bad = new ArrayList<>();
        operations().forEach((k, o) -> {
            if (o.path("summary").asString().isBlank() || !o.path("tags").isArray() || o.path("tags").isEmpty())
                bad.add(k);
        });
        assertThat(bad).as("operations without summary or tag").isEmpty();
    }

    @Test
    void everyOperation_listsTheGlobalAnswers() throws Exception {
        List<String> bad = new ArrayList<>();
        operations().forEach((k, o) -> {
            for (String s : List.of("400", "401", "403", "429"))
                if (!o.path("responses").has(s)) bad.add(k + " missing " + s);
        });
        assertThat(bad).as("operations missing a global answer").isEmpty();
    }

    @Test
    void everyProblemKind_isDocumented_andMatchesTheAdvice() throws Exception {
        JsonNode responses = spec().path("components").path("responses");
        Set<String> documentedSlugs = new TreeSet<>();

        for (ProblemKind k : ProblemKind.values()) {
            JsonNode examples = responses.path(ProblemKind.responseName(k.status()))
                    .path("content").path("application/problem+json").path("examples");
            JsonNode ex = examples.path(k.slug()).path("value");
            assertThat(ex.isMissingNode()).as("example for " + k.slug()).isFalse();
            assertThat(ex.path("type").asString()).isEqualTo("urn:appfleet:problem:" + k.slug());
            assertThat(ex.path("title").asString()).as("title of " + k.slug()).isEqualTo(k.title());
            assertThat(ex.path("status").asInt()).isEqualTo(k.status());
        }

        // nothing documented that is not a ProblemKind
        responses.properties().forEach(r ->
                r.getValue().path("content").path("application/problem+json").path("examples")
                        .propertyNames().forEach(documentedSlugs::add));
        Set<String> kinds = Arrays.stream(ProblemKind.values()).map(ProblemKind::slug)
                .collect(Collectors.toCollection(TreeSet::new));
        assertThat(documentedSlugs).isEqualTo(kinds);
    }


    @Test
    void postDeployments_documentsTheIdempotencyContract() throws Exception {
        JsonNode o = op("POST /api/v1/deployments");
        JsonNode key = header(o, "Idempotency-Key");
        assertThat(key).as("Idempotency-Key header").isNotNull();
        assertThat(key.path("required").asBoolean()).isFalse();
        JsonNode r = o.path("responses");
        assertThat(r.has("202")).isTrue();
        assertThat(r.path("202").path("headers").has("Location")).isTrue();
        assertThat(r.path("202").path("headers").has("Idempotent-Replayed")).isTrue();
        for (String s : List.of("409", "422", "503")) assertThat(r.has(s)).as("status " + s).isTrue();
    }

    @Test
    void taskHistory_documentsBoundsAndDefaults() throws Exception {
        JsonNode cursor = op("GET /api/v1/deployments/{id}/tasks");
        JsonNode limit = param(cursor, "limit").path("schema");
        assertThat(limit.path("minimum").asInt()).isEqualTo(1);
        assertThat(limit.path("maximum").asInt()).isEqualTo(100);
        assertThat(limit.path("default").asInt()).isEqualTo(20);

        JsonNode offset = op("GET /api/v1/deployments/{id}/tasks/by-offset");
        JsonNode size = param(offset, "size").path("schema");
        assertThat(size.path("minimum").asInt()).isEqualTo(1);
        assertThat(size.path("maximum").asInt()).isEqualTo(100);
        assertThat(size.path("default").asInt()).isEqualTo(20);
        assertThat(param(offset, "page").path("schema").path("minimum").asInt()).isEqualTo(0);
    }

    @Test
    void teamHeader_isOnNoOperation() throws Exception {
        List<String> bad = new ArrayList<>();
        operations().forEach((k, o) -> {
            if (header(o, "X-Team-Id") != null) bad.add(k);
        });
        assertThat(bad).as("operations still documenting X-Team-Id").isEmpty();
    }

    @Test
    void successStatusesAndLocation_matchTheCode() throws Exception {
        Map<String, String> expected = Map.of(
                "POST /api/v1/deployments", "202",
                "POST /api/v1/deployments/{id}/rollback", "202",
                "POST /api/v1/applications", "201",
                "POST /api/v1/applications/{id}/releases", "201");
        List<String> bad = new ArrayList<>();
        operations().forEach((k, o) -> {
            JsonNode r = o.path("responses");
            String want = expected.getOrDefault(k, "200");
            boolean created = !want.equals("200");
            if (!r.has(want) || (created && r.has("200"))
                    || (created && !r.path(want).path("headers").has("Location"))
                    || !r.path(want).path("content").has("application/json")) bad.add(k + " (want " + want + ")");
        });
        assertThat(bad).as("operations whose documented success answer differs from the code").isEmpty();
    }

    @Test
    void problemResponsesOnOperations_reachTheirSlugs() throws Exception {
        JsonNode responses = spec().path("components").path("responses");

        // POST /deployments: its 409 and 422 hold every slug the annotation lists
        JsonNode post = op("POST /api/v1/deployments").path("responses");
        assertThat(post.path("409").path("$ref").asString()).endsWith("/Conflict409");
        assertThat(post.path("422").path("$ref").asString()).endsWith("/Unprocessable422");
        Set<String> in409 = names(responses.path("Conflict409"));
        Set<String> in422 = names(responses.path("Unprocessable422"));
        assertThat(in409).contains("conflict", "request-in-progress");
        assertThat(in422).contains("unprocessable", "idempotency-key-reused");

        // every operation: error statuses = 400 + 401 + 403 + 429 + the statuses of its @ProblemResponses kinds
        Map<String, HandlerMethod> handlers = handlers();
        List<String> bad = new ArrayList<>();
        operations().forEach((key, o) -> {
            Set<String> expected = new TreeSet<>(Set.of("400", "401", "403", "429"));
            ProblemResponses pr = handlers.get(key).getMethodAnnotation(ProblemResponses.class);
            if (pr != null) for (ProblemKind k : pr.value()) expected.add(String.valueOf(k.status()));
            Set<String> actual = new TreeSet<>();
            o.path("responses").propertyNames().forEach(s -> { if (Integer.parseInt(s) >= 400) actual.add(s); });
            if (!actual.equals(expected)) bad.add(key + " expected " + expected + " but was " + actual);
        });
        assertThat(bad).as("operations whose error statuses differ from their @ProblemResponses").isEmpty();

    }

    private static Set<String> names(JsonNode response) {
        Set<String> s = new TreeSet<>();
        response.path("content").path("application/problem+json").path("examples").propertyNames().forEach(s::add);
        return s;
    }

    @Test
    void bearerAuthScheme_isDeclared() throws Exception {
        JsonNode s = spec().path("components").path("securitySchemes").path("bearerAuth");
        assertThat(s.path("type").asString()).isEqualTo("http");
        assertThat(s.path("scheme").asString()).isEqualTo("bearer");
        assertThat(s.path("bearerFormat").asString()).isEqualTo("JWT");
    }

    @Test
    void security_isGlobal_andNoOperationOverridesIt() throws Exception {
        JsonNode sec = spec().path("security");
        assertThat(sec.isArray() && sec.size() == 1 && sec.get(0).has("bearerAuth")).as("global security").isTrue();
        List<String> bad = new ArrayList<>();
        operations().forEach((k, o) -> { if (o.has("security")) bad.add(k); });
        assertThat(bad).as("operations with their own security").isEmpty();
    }

    @Test
    void unauthorizedResponse_documentsTheChallenge() throws Exception {
        assertThat(spec().path("components").path("responses").path("Unauthorized401")
                .path("headers").has("WWW-Authenticate")).isTrue();
    }

    @Test
    void everyOperation_statesItsPermission() throws Exception {
        Map<String, HandlerMethod> handlers = handlers();
        List<String> bad = new ArrayList<>();
        operations().forEach((key, o) -> {
            String want = java.util.regex.Pattern.compile("hasAuthority\\('([a-z]+:[a-z]+)'\\)")
                    .matcher(handlers.get(key).getMethodAnnotation(
                            org.springframework.security.access.prepost.PreAuthorize.class).value())
                    .results().map(m -> m.group(1)).findFirst().orElse("?");
            if (!want.equals(o.path("x-required-permission").asString())
                    || !o.path("description").asString().contains("`" + want + "`")) bad.add(key + " want " + want);
        });
        assertThat(bad).as("operations whose permission is not stated").isEmpty();
    }

    private Map<String, HandlerMethod> handlers() {
        Map<String, HandlerMethod> handlers = new java.util.TreeMap<>();
        mapping.getHandlerMethods().forEach((info, hm) -> {
            for (String path : info.getPathPatternsCondition().getPatternValues())
                for (RequestMethod m : info.getMethodsCondition().getMethods())
                    if (path.startsWith("/api/v1/")) handlers.put(m + " " + path, hm);
        });
        return handlers;
    }


}
