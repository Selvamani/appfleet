# control-api — S3.7: OpenAPI documentation

**Spec:** [01-CONTROL-API.md §S3](../../specs/project/01-CONTROL-API.md) — *"OpenAPI via springdoc — grouped, described, with the error shapes documented"* · Slice **S3.7** of [control-api-s3-rest.md](control-api-s3-rest.md)

Companion: [control-api-s3-1-foundations.md](control-api-s3-1-foundations.md) (the problem shape and the status matrix that this step documents), [control-api-s3-5-idempotency.md](control-api-s3-5-idempotency.md) (the `Idempotency-Key` header and its `Idempotent-Replayed` answer), [control-api-s3-6-rate-limiting.md](control-api-s3-6-rate-limiting.md) (the temporary `X-Team-Id` header, which no controller declares). **Status: closed 2026-10-02. Implemented, `mvn verify` green (222 tests); see section 11.**

This is the last step of S3. No behaviour changes. The risk is different from the earlier steps: a spec generated from annotations can quietly drift from what the endpoints do. Most of the design below is about making that drift fail a test.

## 1. What already exists

- **11 endpoints under `/api/v1`**, all with their own endpoint tests:
  - `ApplicationController`: `POST /applications`, `GET /applications`, `GET /applications/{id}`, `POST /applications/{id}/releases`, `GET /applications/{id}/releases/{releaseId}`.
  - `DeploymentController`: `POST /deployments`, `GET /deployments/{id}`, `POST /deployments/{id}/rollback`, `GET /deployments/{id}/tasks`, `GET /deployments/{id}/tasks/by-offset`.
  - `TaskController`: `GET /tasks/{id}`.
- **One error shape.** `ApiExceptionHandler` produces `ProblemDetail` with `type` `urn:appfleet:problem:<slug>`, `title`, `status`, `detail`, `instance`, and the extensions `correlationId` and (validation only) `errors[{field, message}]`. `ProblemShapeTest` (32 tests) pins every slug. The slugs are in the plan's status matrix (section 3.2).
- **Headers the endpoints use or return:** `Idempotency-Key` (request, optional, `POST /deployments`), `Idempotent-Replayed` (response), `Location` (202 and 201 answers), `Retry-After` (409 `request-in-progress`, 429, 503), `X-Correlation-Id` (response, every answer), `X-Team-Id` (request, temporary, read by the rate-limit interceptor).
- **Pages:** `CursorPage<T>(items, nextCursor)` and `OffsetPage<T>(items, page, size, hasNext)`.
- **`TemporaryOpenSecurityConfig`** permits `/api/**`, `/actuator/health` and `/actuator/info`, and ends with `anyRequest().denyAll()`. Anything else, including a docs path, answers 403 today.
- **`RateLimitInterceptor` covers `/api/**` only.** A docs path would not spend tokens.
- **No `springdoc` dependency** (plan section 1). Spring Boot is 4.1.0, and the classpath holds two Jackson versions (S3.5 section 1).

## 2. Behaviour

| Request | Answer |
|---|---|
| `GET /v3/api-docs` | The OpenAPI 3.1 document as JSON, all 11 operations |
| `GET /v3/api-docs/<group>` | Only that group's operations (decision 3) |
| `GET /swagger-ui.html` | The Swagger UI page, in profiles `local` and `test`; **404 in `prod`** (decision 6) |
| Any other path | Unchanged: 403 from `denyAll()` |

The document is generated at runtime from the controllers. A hand-written `openapi.yaml` is not kept (decision 1).

## 3. Decisions

1. **Generate from code with `springdoc-openapi`, do not hand-write the YAML.** A hand-written file is a second copy that nobody updates. Generated output is wrong only where annotations are missing, and decision 8 makes missing annotations fail a test.
2. **springdoc version: the one that supports Spring Boot 4.** This is the first thing to verify (section 9 step 1), not assume. springdoc 2.x targets Boot 3 and will fail on Boot 4; springdoc 3.x is the Boot 4 line. Pin the exact version in `control-api/pom.xml`, with a comment naming why.
3. **Groups.** One group `api-v1` with `pathsToMatch: /api/v1/**`. Rejected: one group per resource. With 11 operations the split adds three documents and no reader benefit; the tags (decision 4) already organise the UI. A second group is cheap to add when `/api/v2` or an internal API appears.
4. **Tags per controller:** `Applications`, `Deployments`, `Tasks`. Each controller gets `@Tag` with a one-sentence description; each operation gets `@Operation(summary, description)`. The four operations that answer 202 or 201 also get an explicit `@ApiResponse` for that status with its `Location` header, because springdoc documents `200` for any `ResponseEntity` (section 11, step 1). The summary says what it does; the description carries what is not obvious from the signature, such as "returns 202, the work is not done yet; follow `Location`".
5. **Errors are documented once, not per endpoint.** Every operation can answer 400, 429 and 500, and most can answer 404, 409, 422 or 503. Repeating `@ApiResponse` on 11 methods would drift. Instead:
   - `components/schemas/Problem`: `type`, `title`, `status`, `detail`, `instance`, `correlationId`, optional `errors[]`. springdoc knows `ProblemDetail` but not the two extensions, so the schema is declared by a small class `ProblemSchema` used only for documentation.
   - `components/responses`: **one named response per HTTP status, not per slug** (decided 2026-10-02, after the step 4 run showed that two slugs on one status overwrite each other, see section 11). The names are `BadRequest400`, `NotFound404`, `Conflict409`, `Unprocessable422`, `TooManyRequests429`, `InternalError500`, `ServiceUnavailable503`. Each uses `application/problem+json`, the `Problem` schema, and an `examples` map with **one named example per slug that can occur with that status**, each with the real `type` and `title`: `Conflict409` holds `conflict`, `illegal-transition`, `concurrent-modification` and `request-in-progress`; `Unprocessable422` holds `unprocessable` and `idempotency-key-reused`; `BadRequest400` holds `validation-failed` and `malformed-request`. The `Retry-After` header is declared on the status response that can carry it (`Conflict409`, `TooManyRequests429`, `ServiceUnavailable503`), with a description saying which slugs set it (`request-in-progress` for 409).
   - An `OperationCustomizer` adds the global answers (400 `ValidationFailed`, 429 `RateLimited`) to every operation, so a new endpoint gets them without anyone remembering.
   - Per-operation extras are listed with a small custom annotation `@ProblemResponses({NOT_FOUND, CONFLICT, REQUEST_IN_PROGRESS})`, which expands to **one `$ref` per distinct status** (the three 409 kinds above give a single `Conflict409`). The slugs on the annotation are documentation of intent and are checked by test 10 (below): an operation that lists `REQUEST_IN_PROGRESS` must reach a status whose response has that example. Rejected: raw `@ApiResponse` on each method, which repeats the schema and the example every time.
6. **Swagger UI is on for `local` and `test`, off for `prod`.** The JSON at `/v3/api-docs` stays on in all profiles for now: it describes only the public API shape. Before S4 the paths must be permitted explicitly in the security chain (`/v3/api-docs/**`, `/swagger-ui/**`, `/swagger-ui.html`), marked TEMPORARY like the rest of that class. In S4 the docs path decision is made again with real roles: the UI behind authentication, or removed from prod.
7. **Headers springdoc cannot see are declared by hand.**
   - `Idempotency-Key` is an `@RequestHeader` on `POST /deployments`, so springdoc finds it; the `@Parameter` description adds the format (the rule in `IdempotencyKeys`), the 24 h and 30 s windows, and the three outcomes (replay, 409, 422).
   - `Idempotent-Replayed`, `Location` and `Retry-After` are response headers set in code, so the annotations must name them with `@Header`, or the OperationCustomizer adds them to the named responses.
   - `X-Team-Id` is read by an interceptor, not a controller, so springdoc never sees it. The customizer adds it as an optional header parameter to every `/api/**` operation, with the text "temporary, replaced by the JWT in S4; absent means the shared `anonymous` bucket". This is the one place where the spec is more than the controllers, and the doc says so.
8. **The spec is checked by a test, not by eye.** `OpenApiContractTest` loads the generated JSON in a Spring context (no browser) and checks:
   - **Every handler is documented, and nothing extra.** The set of `(method, path)` pairs from `RequestMappingHandlerMapping` filtered to `/api/v1/**` equals the set from the document's `paths`. A new endpoint without a spec entry fails; so does an entry for a removed one.
   - **Every operation has a summary and a tag.** The two things springdoc will not invent.
   - **Every slug in `ProblemShapeTest`'s tables exists as a documented response.** Adding a slug to the advice without documenting it fails, via one shared list of slugs (see section 5).
   - **Every operation lists 400 and 429.** The customizer works.
   - **Spot checks on the exact contract:** `POST /deployments` documents 202 with a `Location` header, an optional `Idempotency-Key` and `Idempotent-Replayed`; both task-history operations list their `limit`/`size` bounds (1 to 100) and defaults.
9. **Examples come from the real shapes.** The `Problem` examples are not invented text: the same constants `ProblemShapeTest` asserts are used, so a changed `title` fails one test, not two silent copies.
10. **No generated client, no API versioning policy.** The console has its own `http.ts` and mock. Whether to generate a typed client from this spec is a web-console question, noted in section 10.

## 4. Dependency and configuration

`control-api/pom.xml`: one dependency, `org.springdoc:springdoc-openapi-starter-webmvc-ui` at the Boot-4-compatible version. For `prod`, a second profile can drop the UI while keeping the JSON; the simpler form is a property.

`application.yml`:

```yaml
springdoc:
  api-docs:
    path: /v3/api-docs
  swagger-ui:
    enabled: true            # application-prod.yml sets false
  group-configs:
    - group: api-v1
      paths-to-match: /api/v1/**
```

`application-prod.yml`: `springdoc.swagger-ui.enabled: false`. A test with the `prod` profile (decision 6) asserts `/swagger-ui.html` is not served.

## 5. Java design

Package `io.appfleet.control.web.openapi`, so the cross-cutting documentation code sits next to `ApiExceptionHandler`:

- **`OpenApiConfig`** (`@Configuration`): the `OpenAPI` bean (title "Appfleet control-api", version from the build, description with the link to the status matrix), the `components` (the `Problem` schema and the named responses), and the `GroupedOpenApi` bean for `api-v1`.
- **`ProblemSchema`**: a record with the documented fields, never returned by any controller. Its only job is to give springdoc the shape. A comment says so, because "unused class" is the obvious cleanup that would break the spec.
- **`ProblemResponses`**: a custom annotation, `@ProblemResponses({ProblemKind.NOT_FOUND, ...})`, and the enum `ProblemKind`, one value per documented slug. The enum holds the slug, the status and the example. The advice does not use it; the test compares the two (below).
- **`ErrorResponseCustomizer implements OperationCustomizer`**: adds 400 and 429, `X-Team-Id`, and expands `@ProblemResponses` into `$ref`s.
- Controllers get `@Tag`, `@Operation`, and `@ProblemResponses`. Nothing else in them changes.

### 5.1 Sketch for step 4 (written 2026-10-02 from the step 1 to 3 results, not compiled)

Written against springdoc 3.1.1 and swagger-core 2.2.x (`io.swagger.v3.oas.models`). Every method name below is from memory of that API. Where one is a guess, the comment says so, and the contract test is the check.

**One group definition, in code.** The `GroupedOpenApi` bean (below) is needed to attach the customizer, so `springdoc.group-configs` in `application.yml` and `application-prod.yml` must be removed once the bean exists. Two definitions of the group `api-v1` would clash. `springdoc.swagger-ui.enabled` stays in the yml files.

```java
// ProblemKind: one value per documented slug. Not used by ApiExceptionHandler.
public enum ProblemKind {
    VALIDATION_FAILED("ValidationFailed", 400, "validation-failed", "Bad Request", null),
    NOT_FOUND("NotFound", 404, "not-found", "Not Found", null),
    CONFLICT("Conflict", 409, "conflict", "Conflict", null),
    ILLEGAL_TRANSITION("IllegalTransition", 409, "illegal-transition", "Conflict", null),
    CONCURRENT_MODIFICATION("ConcurrentModification", 409, "concurrent-modification", "Conflict", null),
    REQUEST_IN_PROGRESS("RequestInProgress", 409, "request-in-progress", "Conflict", "1"),
    UNPROCESSABLE("Unprocessable", 422, "unprocessable", "Unprocessable Content", null),
    IDEMPOTENCY_KEY_REUSED("IdempotencyKeyReused", 422, "idempotency-key-reused", "Unprocessable Content", null),
    RATE_LIMITED("RateLimited", 429, "rate-limited", "Too many requests", "1"),
    SERVICE_UNAVAILABLE("ServiceUnavailable", 503, "service-unavailable", "Service Unavailable", "5");

    // responseName = the key under components.responses; retryAfter = example seconds, or null for no header
    // (copy title and retry values from ProblemShapeTest, do not trust these: the test is the source)
    ProblemKind(String responseName, int status, String slug, String title, String retryAfter) { ... }
}
```

```java
// The annotation a controller method uses to list its extra error answers.
@Target(ElementType.METHOD) @Retention(RetentionPolicy.RUNTIME)
public @interface ProblemResponses { ProblemKind[] value(); }
```

```java
@Configuration
public class OpenApiConfig {

    @Bean
    OpenAPI appfleetOpenApi() {
        OpenAPI api = new OpenAPI().info(new Info()
                .title("Appfleet control-api")
                .version("v1")
                .description("Deployment control plane. Errors use one shape, application/problem+json; "
                        + "clients switch on `type`, never on `detail`."));
        Components c = new Components();
        c.addSchemas("Problem", problemSchema());
        for (ProblemKind k : ProblemKind.values()) c.addResponses(k.responseName(), problemResponse(k));
        return api.components(c);
    }

    @Bean
    GroupedOpenApi apiV1(ErrorResponseCustomizer customizer) {
        return GroupedOpenApi.builder()
                .group("api-v1")
                .pathsToMatch("/api/v1/**")
                .addOperationCustomizer(customizer)
                .build();
    }

    // Hand-built, so there is no unused ProblemSchema class to "clean up". The 'errors' list exists only on 400.
    private static Schema<?> problemSchema() {
        return new ObjectSchema()
                .addProperty("type", new StringSchema().example("urn:appfleet:problem:not-found"))
                .addProperty("title", new StringSchema())
                .addProperty("status", new IntegerSchema())
                .addProperty("detail", new StringSchema())
                .addProperty("instance", new StringSchema())
                .addProperty("correlationId", new StringSchema())
                .addProperty("errors", new ArraySchema().items(new ObjectSchema()
                        .addProperty("field", new StringSchema())
                        .addProperty("message", new StringSchema())))
                .required(List.of("type", "title", "status"));
    }

    private static ApiResponse problemResponse(ProblemKind k) {
        Map<String, Object> example = new LinkedHashMap<>();
        example.put("type", "urn:appfleet:problem:" + k.slug());
        example.put("title", k.title());
        example.put("status", k.status());
        ApiResponse r = new ApiResponse().description(k.title()).content(new Content().addMediaType(
                "application/problem+json",
                new MediaType().schema(new Schema<>().$ref("#/components/schemas/Problem")).example(example)));
        if (k.retryAfter() != null)
            r.addHeaderObject("Retry-After", new Header().schema(new IntegerSchema()).example(k.retryAfter()));
        return r;
    }
}
```

```java
@Component
public class ErrorResponseCustomizer implements OperationCustomizer {

    @Override
    public Operation customize(Operation op, HandlerMethod method) {
        // 1. global answers: every operation can be 400 and 429
        add(op, ProblemKind.VALIDATION_FAILED);
        add(op, ProblemKind.RATE_LIMITED);

        // 2. the answers this method lists with @ProblemResponses
        ProblemResponses extra = method.getMethodAnnotation(ProblemResponses.class);
        if (extra != null) for (ProblemKind k : extra.value()) add(op, k);

        // 3. the header the interceptor reads, which no controller declares
        op.addParametersItem(new HeaderParameter().name("X-Team-Id").required(false)
                .description("TEMPORARY, replaced by the JWT in S4. Absent means the shared 'anonymous' bucket.")
                .schema(new StringSchema().format("uuid")));

        // 4. springdoc says */* for a ResponseEntity; the API answers application/json.
        //    Done here, not with produces= on the controllers, so no runtime behaviour changes.
        op.getResponses().values().forEach(r -> {
            if (r.getContent() != null && r.getContent().containsKey("*/*"))
                r.getContent().addMediaType("application/json", r.getContent().remove("*/*"));
        });
        return op;
    }

    private static void add(Operation op, ProblemKind k) {
        op.getResponses().addApiResponse(String.valueOf(k.status()),
                new ApiResponse().$ref("#/components/responses/" + k.responseName()));
    }
}
```

Three of these lines are the most likely to need a change, and test 4, 5, 8 or 9 will say which:

- **Two kinds on one status.** `CONFLICT`, `ILLEGAL_TRANSITION`, `CONCURRENT_MODIFICATION` and `REQUEST_IN_PROGRESS` are all 409, and `UNPROCESSABLE` and `IDEMPOTENCY_KEY_REUSED` are both 422. `addApiResponse("409", ...)` called twice keeps only the last. OpenAPI allows one response per status, so the 409 reference must describe all the 409 types, with several named examples, not one response per slug. **Settled 2026-10-02: keyed by status, with an `examples` map keyed by slug** (decision 5, test 5, and the revised sketch in 5.2). The step 4 run confirmed the loss: with one response per slug, `POST /deployments` showed only `request-in-progress` for 409 and `idempotency-key-reused` for 422.
- **`$ref` in a response** is `new ApiResponse().$ref(...)`; the exact setter may differ.
- **Mutating the map while iterating** in step 4 of the customizer: `remove` and `addMediaType` on the same map inside `forEach` over `responses.values()` is safe, but the inner `content` edit is not inside that iteration, so it is fine as written. If it throws `ConcurrentModificationException`, copy the keys first.

**Controller annotations (step 5), one example.** The 202 case, because springdoc says 200 for any `ResponseEntity`:

```java
@Operation(summary = "Request a deployment",
           description = "Accepted, not done: the work runs later. Follow the Location header to GET /tasks/{id}.")
@ApiResponse(responseCode = "202", description = "Accepted",
        headers = {
            @Header(name = "Location", description = "URL of the task to poll", schema = @Schema(type = "string")),
            @Header(name = "Idempotent-Replayed", description = "true when this answer is a replay of an earlier request with the same key",
                    schema = @Schema(type = "boolean"))},
        content = @Content(mediaType = "application/json", schema = @Schema(implementation = DeploymentAccepted.class)))
@ProblemResponses({ProblemKind.UNPROCESSABLE, ProblemKind.CONFLICT, ProblemKind.REQUEST_IN_PROGRESS,
                   ProblemKind.IDEMPOTENCY_KEY_REUSED, ProblemKind.SERVICE_UNAVAILABLE})
@PostMapping
public ResponseEntity<DeploymentAccepted> requestDeployment(...)
```

Whether springdoc still adds its own `200` next to an explicit `202` is not known; test 9 asserts that no `200` is present. If one is, the customizer removes `200` from any operation whose method carries an `@ApiResponse` with another 2xx code.

### 5.2 Revised sketch: responses keyed by status (written 2026-10-02, not compiled)

This replaces the `ProblemKind`, `problemResponse` and `add` parts of 5.1. The group bean, the annotation, the header and `*/*` steps of the customizer, and the controller example are unchanged.

`ProblemKind` carries the real titles from `ApiExceptionHandler`, the `Retry-After` seconds as an `int` (0 means no header), and no `responseName`:

```java
public enum ProblemKind {
    VALIDATION_FAILED(400, "validation-failed", "Validation failed", 0),
    MALFORMED_REQUEST(400, "malformed-request", "Bad Request", 0),      // Spring MVC default title: check against ProblemShapeTest
    NOT_FOUND(404, "not-found", "Not found", 0),
    CONFLICT(409, "conflict", "Conflict", 0),
    ILLEGAL_TRANSITION(409, "illegal-transition", "Illegal state transition", 0),
    CONCURRENT_MODIFICATION(409, "concurrent-modification", "Concurrent modification", 0),
    REQUEST_IN_PROGRESS(409, "request-in-progress", "Request in progress", 1),   // check the real Retry-After in the handler
    UNPROCESSABLE(422, "unprocessable", "Unprocessable request", 0),
    IDEMPOTENCY_KEY_REUSED(422, "idempotency-key-reused", "Idempotency key reused", 0),
    RATE_LIMITED(429, "rate-limited", "Too many requests", 1),
    INTERNAL_ERROR(500, "internal-error", "Internal server error", 0),
    SERVICE_UNAVAILABLE(503, "service-unavailable", "Service unavailable", 5);

    private final int status; private final String slug; private final String title; private final int retryAfter;
    ProblemKind(int status, String slug, String title, int retryAfter) { /* assign the four fields */ }
    public int status() { return status; }
    public String slug() { return slug; }
    public String title() { return title; }
    public int retryAfter() { return retryAfter; }

    /** components.responses key for a status: one per status, never per slug. */
    public static String responseName(int status) {
        return switch (status) {
            case 400 -> "BadRequest400";
            case 404 -> "NotFound404";
            case 409 -> "Conflict409";
            case 422 -> "Unprocessable422";
            case 429 -> "TooManyRequests429";
            case 500 -> "InternalError500";
            case 503 -> "ServiceUnavailable503";
            default -> throw new IllegalArgumentException("undocumented problem status " + status);
        };
    }
}
```

In `OpenApiConfig`, group the kinds by status and give each status one response with an `examples` map:

```java
// in appfleetOpenApi(): replace the loop over ProblemKind.values()
Map<Integer, List<ProblemKind>> byStatus = Arrays.stream(ProblemKind.values())
        .collect(Collectors.groupingBy(ProblemKind::status, TreeMap::new, Collectors.toList()));
byStatus.forEach((status, kinds) -> c.addResponses(ProblemKind.responseName(status), statusResponse(kinds)));

private static ApiResponse statusResponse(List<ProblemKind> kinds) {
    MediaType mt = new MediaType().schema(new Schema<>().$ref("#/components/schemas/Problem"));
    for (ProblemKind k : kinds) {
        Map<String, Object> body = new LinkedHashMap<>();
        body.put("type", "urn:appfleet:problem:" + k.slug());
        body.put("title", k.title());
        body.put("status", k.status());
        mt.addExamples(k.slug(), new Example().summary(k.title()).value(body));   // addExamples: guessed name
    }
    ApiResponse r = new ApiResponse()
            .description(kinds.stream().map(ProblemKind::slug).collect(Collectors.joining(", ")))
            .content(new Content().addMediaType("application/problem+json", mt));
    List<ProblemKind> withRetry = kinds.stream().filter(k -> k.retryAfter() > 0).toList();
    if (!withRetry.isEmpty())
        r.addHeaderObject("Retry-After", new Header()
                .description("Seconds to wait. Set by: " + withRetry.stream().map(ProblemKind::slug).collect(Collectors.joining(", ")))
                .schema(new IntegerSchema()).example(withRetry.get(0).retryAfter()));   // an int, not a String
    return r;
}
```

In `ErrorResponseCustomizer`, `add` now refs the status response, and adding the same status twice is harmless because both calls write the same `$ref`:

```java
private static void add(Operation op, ProblemKind k) {
    op.getResponses().addApiResponse(String.valueOf(k.status()),
            new ApiResponse().$ref("#/components/responses/" + ProblemKind.responseName(k.status())));
}
```

Guessed names to check against the compiler: `MediaType.addExamples`, `Example.summary`/`value`, `Header.description`. Test 5 and 10 fail with a readable message if the generated shape differs.

`ProblemKind` is a second list of slugs next to `ApiExceptionHandler`. The consistency check is therefore the most important test in section 6: `ProblemKind.values()` must equal the slugs `ProblemShapeTest` covers. If a third list is needed to avoid the duplicate, extract one `ProblemType` constants class used by the advice, the shape test and the documentation; decide this while writing the code, and record the choice in Results.

## 6. Tests

### 6.1 `OpenApiContractTest extends WebIntegrationTest`

Reads `GET /v3/api-docs/api-v1` with MockMvc (the whole context, the real security chain) and parses it with the JSON mapper already in the context.

| # | Test | Asserts |
|---|---|---|
| 1 | `docs_areServed_andAreJson` | 200, `application/json`, `openapi` starts with `3.1` |
| 2 | `everyHandlerIsDocumented_andNothingElse` | the `(method, path)` set from `RequestMappingHandlerMapping` under `/api/v1/**` equals the set in `paths`; 11 pairs |
| 3 | `everyOperationHasSummaryAndTag` | no operation with a blank summary or an empty tags list |
| 4 | `everyOperation_lists400And429` | both responses present, both `$ref` to the named responses |
| 5 | `everyProblemKind_isDocumented_andMatchesTheAdvice` | for every `ProblemKind`: `components.responses` holds the response for its status, that response has an example named by the slug, and the example's `type`, `title` and `status` equal what `ApiExceptionHandler` produces (the titles are the ones `ProblemShapeTest` pins). No example exists for a slug that is not a `ProblemKind`, so a slug added to the advice but not to the enum shows up as a gap between this test and `ProblemShapeTest`'s table |
| 10 | `problemResponsesOnOperations_reachTheirSlugs` | for `POST /deployments`: 409 refs `Conflict409` and 422 refs `Unprocessable422`, and those responses contain the examples `conflict`, `request-in-progress`, `unprocessable` and `idempotency-key-reused`; for every operation the set of response statuses equals the statuses of its `@ProblemResponses` kinds plus 400 and 429 |
| 6 | `postDeployments_documentsTheIdempotencyContract` | 202 with `Location`, optional `Idempotency-Key`, `Idempotent-Replayed`, 409, 422, 503 |
| 7 | `taskHistory_documentsBoundsAndDefaults` | both operations: limit/size schema min 1, max 100, default 20; `page` min 0 |
| 8 | `teamHeader_isOnEveryOperation_asOptional` | `X-Team-Id`, `required: false` |
| 9 | `successStatusesAndLocation_matchTheCode` | `POST /deployments` and `POST /deployments/{id}/rollback` document 202, `POST /applications` and `POST /applications/{id}/releases` document 201, each with a `Location` header and no `200`; every other operation documents 200; every success body is `application/json` (springdoc alone says 200 and `*/*`, see section 11, step 1) |

Each must be seen failing at least once (section 9).

### 6.2 `SwaggerUiProfileTest` and `SwaggerUiDisabledTest`

- Default test profile: `GET /swagger-ui.html` is served (200 or a redirect to `/swagger-ui/index.html`).
- With `springdoc.swagger-ui.enabled=false` (`SwaggerUiDisabledTest`, its own context): the UI paths are 404, and `/v3/api-docs` still 200.

### 6.3 Existing tests

`TemporaryOpenChainTest` must be extended: the docs paths are permitted and `/swagger-ui/**` is no longer a 403, but an unknown path outside `/api/**` is still 403. `ProblemShapeTest` is unchanged; the `@WebMvcTest` slice will not load springdoc, so its `excludeFilters` need no new entry, but confirm that (section 8).

## 7. Interaction with earlier steps

- **S3.6:** docs paths are outside `/api/**`, so they spend no tokens, and the limiter's fail-open path is not involved. If docs are ever moved under `/api`, the interceptor will start counting them.
- **S3.5:** springdoc's reflection must not call the controllers. Documenting `POST /deployments` does not invoke the idempotency executor.
- **S3.1:** a request to `/v3/api-docs` with a bad `Accept` or a missing group goes through the springdoc controller, not our advice, so its error answers are not `application/problem+json`. That is acceptable and noted: the docs endpoints are tooling, not the API.

## 8. Risks to check, not assume

- **Boot 4 and Jackson 3.** springdoc serialises the document with its own `ObjectMapper`. With Jackson 2 and 3 both on the classpath, confirm which one it uses and that the spec has no empty `schema` objects for our records.
- **Records and `@Valid` constraints.** Bean Validation annotations on `CreateDeploymentRequest` and `CreateApplicationRequest` should appear as `required`, `minLength`, `maxLength`. Check one by reading the output, not by trusting it.
- **Enum `DeploymentState`** appears as a closed list in `DeploymentAccepted` and `DeploymentResponse`; if a state is later added, test 2 does not catch a stale copy, because the enum is read from the code each time.
- **`@WebMvcTest` slice.** `ProblemShapeTest` excludes `RateLimitInterceptor` and `WebConfig` because the slice picks them up. A `GroupedOpenApi` bean in a `@Configuration` may be picked up the same way. If the shape test fails to start after the change, add the filter and record it, as in S3.6.
- **`denyAll()` and the UI's static resources.** `/swagger-ui/**` serves many files (CSS, JS, `swagger-config`). Permit the whole prefix, then check in the browser that the page is not half-loaded.

## 9. Order of work: find it broken first

1. **Dependency first, with no annotations.** Add springdoc at the version chosen in decision 2. Start the app. Expect `GET /v3/api-docs` to be 403 (the chain). Record it. Add the permits. Open the JSON. Record what springdoc produced on its own: operations, their summaries (none), and whether the `ProblemDetail` shape appears. If startup fails on Boot 4, record the stack trace line and the version change.
2. **Write test 2 (every handler documented) and run it.** It should pass with no annotations, because springdoc finds every mapping. Then break it on purpose: add a throwaway `@GetMapping("/api/v1/ping")` to a controller. Test 2 passes too, because springdoc documents it. Remove the mapping. This shows what the test does not catch, and why test 3 (summary and tag) exists.
3. **Test 3 and test 4 red:** both fail with no annotations. Record the number of operations without a summary (expect 11).
4. Add `OpenApiConfig`, `ProblemSchema`, the customizer and the enum. Test 4 green.
5. Add `@Tag`, `@Operation` and `@ProblemResponses` controller by controller. After each controller, run the contract test. Test 3 goes green controller by controller.
6. Tests 5 to 8, then `SwaggerUiProfileTest` and the extension to `TemporaryOpenChainTest`.
7. **Drift drill:** add a slug to `ApiExceptionHandler` (or to the shape test's table) without documenting it. Test 5 must fail. Remove it.
8. Manual check: open the UI at `http://localhost:8081/swagger-ui.html` on profile `local`. Run "Try it out" on `POST /applications`, then `GET /applications`, then `POST /deployments` with and without an `Idempotency-Key`. Confirm that the 429 example matches a real 429. Results section. `mvn verify`.

## 10. Not in S3.7

- A generated client for the web-console. Open question for the console plan: `openapi-typescript` against `/v3/api-docs` would replace hand-written types. Not decided here.
- Security schemes (`bearerAuth`, scopes). S4 adds them with the JWT.
- API versioning policy and deprecation markers.
- Docs for `/actuator/**`.
- Publishing the spec outside the app (a static file in the repo, a docs site). The spec is served by the running app only.
- Per-operation request and response examples beyond the errors. The `ProblemKind` examples are required; others are optional.

## 11. Results

**Step 1 (section 9), 2026-10-02: springdoc 3.1.1 with no annotations.** Version `3.1.1` is the latest on Maven Central, and its parent pom targets Spring Boot 4.1.0. The app starts with it. With the docs paths not yet permitted, `/v3/api-docs`, `/v3/api-docs/api-v1` and `/swagger-ui.html` all returned 403 (`denyAll()`), while `/api/v1/applications` stayed 200. After permitting `/v3/api-docs/**`, `/swagger-ui/**` and `/swagger-ui.html` in `TemporaryOpenSecurityConfig`, `/v3/api-docs/api-v1` returned 200 with a 7,861-byte document (`openapi` 3.1.0). `/swagger-ui.html` answers 302 to `/swagger-ui/index.html`, which is 200.

What springdoc produced on its own:

| Check | Observed |
|---|---|
| Operations | 11 under 10 paths (`/applications` has GET and POST), as expected |
| Summaries | **0 of 11** (the number that test 3 will start red with) |
| Tags | one per controller, named after the class: `deployment-controller`, `application-controller`, `task-controller` |
| Document title | "OpenAPI definition", version `v0` |
| Empty record schemas | **none**: all 12 schemas have their properties. The Jackson 2 and 3 risk did not show up |
| Bean Validation | carried over: `required`, `pattern`, `minLength`, `maxLength`; `minLength: 0` noise on some strings |
| `DeploymentState` | closed `enum` of 7 values |
| `limit`, `size`, `page` | defaults and `minimum`/`maximum` present (page 0, size 1 to 100, default 20) |
| `Idempotency-Key` | present as an optional string header, no description |
| `X-Team-Id` | absent, as predicted |
| Error responses, `ProblemDetail` | **none**: no schema, no 4xx or 5xx on any operation |

Two findings the design did not anticipate:

1. **Every success answer is documented as `200 OK`.** The real answers are `202` (`POST /deployments`, `POST /deployments/{id}/rollback`) and `201` (`POST /applications`, `POST /applications/{id}/releases`), set in code with `ResponseEntity.accepted()` and `ResponseEntity.created(...)`. springdoc reads the return type, not the status, and does not see the `Location` header. A spec that says 200 for an asynchronous 202 is wrong in the way that matters most to a client. Decision 4 now also requires an explicit `@ApiResponse(responseCode = "202" or "201", headers = Location)` on those four operations, and test 6 (and a new test 9) assert the success status and the `Location` header.
2. **Response content type is `*/*`**, not `application/json`. The controllers do not declare `produces`. Declare `produces = "application/json"` on the controller mappings, or set it for the group, and assert it in the contract test.

**Steps 2 and 3 (section 9), 2026-10-02: the contract test with no annotations.** `OpenApiContractTest` (8 tests so far: 1, 2, 3, 4, 6, 7, 8, 9; test 5 waits for `ProblemKind`). A first run showed `Tests run: 0, BUILD SUCCESS`: the class imported the JUnit 4 `org.junit.Test`, so Surefire found nothing. Only `org.junit.jupiter.api.Test` runs here. A run with 0 tests is a false green, worth knowing.

Result with no annotations, run from the IDE and from `mvn`: **8 run, 3 passed, 5 failed.**

| Test | Result | Observed |
|---|---|---|
| 1 `docs_areServed_andAreJson` | green | 200, `application/json`, `openapi` 3.1.0 |
| 2 `everyHandlerIsDocumented_andNothingElse` | green | exactly the 11 `(method, path)` pairs; springdoc finds every mapping on its own |
| 7 `taskHistory_documentsBoundsAndDefaults` | green | `limit` and `size`: min 1, max 100, default 20; `page` min 0. Bean Validation already reaches the spec |
| 3 `everyOperationHasSummaryAndTag` | **red** | all 11 operations listed (the tag is auto-generated, the summary is missing) |
| 4 `everyOperation_lists400And429` | **red** | all 11 listed |
| 6 `postDeployments_documentsTheIdempotencyContract` | **red** | at the `202` assertion: the `Idempotency-Key` header and its `required: false` passed (springdoc finds the `@RequestHeader`), but there is no 202 response |
| 8 `teamHeader_isOnEveryOperation_asOptional` | **red** | all 11 listed, as predicted: the interceptor's header is invisible to springdoc |
| 9 `successStatusesAndLocation_matchTheCode` | **red** | all 11 listed: every success is documented as `200` with `*/*` (the 202s and 201s are the ones that are wrong in substance) |

Test 2 stays green when an endpoint has no documentation at all, which is why tests 3 and 9 exist. The throwaway `GET /api/v1/ping` drill (step 2) was not reported, and is recorded as not run.

**Step 4 (section 9), 2026-10-02: `OpenApiConfig`, `ProblemKind`, `@ProblemResponses`, `ErrorResponseCustomizer`, and the annotations on `POST /deployments` only.** The first two compile attempts failed on imports (the `io.swagger.v3.oas.annotations.*` types were imported where the `io.swagger.v3.oas.models.*` ones are needed: `ApiResponse`, `Operation`, `Header`). After the fix: **8 run, 6 passed, 2 failed.**

| Test | Before | Now | What changed it |
|---|---|---|---|
| 4 `everyOperation_lists400And429` | red (11) | **green** | the customizer adds both to every operation |
| 8 `teamHeader_isOnEveryOperation_asOptional` | red (11) | **green** | the customizer adds `X-Team-Id` |
| 6 `postDeployments_documentsTheIdempotencyContract` | red | **green** | explicit `@ApiResponse(202)` with `Location` and `Idempotent-Replayed` |
| 9 `successStatusesAndLocation_matchTheCode` | red (11) | red (3) | `POST /deployments` fixed; the other three 201/202 operations are not annotated yet |
| 3 `everyOperationHasSummaryAndTag` | red (11) | red (10) | only `POST /deployments` has `@Operation` so far |
| 1, 2, 7 | green | green | |

What the run answered:

- **springdoc drops its default `200` when an explicit `@ApiResponse(202)` exists.** The open question from the sketch: `POST /deployments` shows only 202, 400, 409, 422, 429 and 503, and test 9 no longer lists it. No customizer code is needed for that.
- **The `*/*` to `application/json` rewrite works.** Every response body is now `application/json`, and the GET operations pass test 9 on content type.
- **The document grew from 7,861 to 15,127 bytes** with the `Problem` schema and ten named responses.

Two defects the run exposed, neither caught by a current test:

1. **One response per status loses slugs.** `POST /deployments` lists `UNPROCESSABLE`, `CONFLICT`, `REQUEST_IN_PROGRESS`, `IDEMPOTENCY_KEY_REUSED` and `SERVICE_UNAVAILABLE`, but the spec shows 409 as `RequestInProgress` only and 422 as `IdempotencyKeyReused` only. `addApiResponse("409", ...)` called twice keeps the last. The ordinary 409 `conflict` (an active deployment already exists) and the 422 `unprocessable` (unknown release) are missing from the document. This is the design point left open in section 5.1.
2. **The example titles are not the real ones.** `ProblemKind` carries guessed titles (`Bad Request`, `Not Found`, `Unprocessable Content`, `Conflict` for every 409) where `ApiExceptionHandler` produces `Validation failed`, `Not found`, `Unprocessable request`, `Illegal state transition`, `Concurrent modification`, `Request in progress`, `Idempotency key reused` and `Service unavailable`. Test 5, which compares the examples with `ProblemShapeTest`, is the check that is still missing. The `Retry-After` examples are the strings `"1"` and `"5"` against an integer schema.

**Step 4b (2026-10-02): responses keyed by status.** `ProblemKind` was rewritten with the real titles and an `int` `retryAfter` (a first attempt changed only the field type and failed with nine `<nulltype> cannot be converted to int` compile errors in the constants). `OpenApiConfig` groups the kinds by status; `ErrorResponseCustomizer.add` refs `ProblemKind.responseName(status)`.

Read from the running spec (`/v3/api-docs/api-v1`, profile `local`):

| `components/responses` | examples | `Retry-After` |
|---|---|---|
| `BadRequest400` | `validation-failed`, `malformed-request` | none |
| `NotFound404` | `not-found` | none |
| `Conflict409` | `conflict`, `illegal-transition`, `concurrent-modification`, `request-in-progress` | 1 (integer) |
| `Unprocessable422` | `unprocessable`, `idempotency-key-reused` | none |
| `TooManyRequests429` | `rate-limited` | 1 |
| `InternalError500` | `internal-error` | none |
| `ServiceUnavailable503` | `service-unavailable` | 5 |

`POST /deployments` now answers 202, 400, 409, 422, 429, 503, with the 409 and 422 pointing at the two status responses, so `conflict` and `unprocessable` are reachable again. The `Retry-After` example is a number, not a string. Example titles are the real ones (`Validation failed`).

Tests 5 (`everyProblemKind_isDocumented_andMatchesTheAdvice`) and 10 (`problemResponsesOnOperations_reachTheirSlugs`) were written after the behaviour and passed at once; they were not seen red. **Run: 10 run, 8 passed, 2 failed.** The two red tests are the expected ones: test 3 lists 10 operations (only `POST /deployments` has `@Operation` and a tag description) and test 9 lists 3 (`POST /applications`, `POST /applications/{id}/releases`, `POST /deployments/{id}/rollback` still show `200`).

The `malformed-request` title (`Bad Request`) is the Spring MVC default and is not pinned by `ProblemShapeTest`; test 5 pins it now in the documentation only.

**Step 5 (2026-10-02): annotations on all 11 operations.** Written by Claude at the user's request ("annotation is yours"), in the three controllers: a `@Tag` per controller (`Applications`, `Deployments`, `Tasks`), `@Operation(summary, description)` on every operation, `@ApiResponse` with a `Location` header on the 201 operations (`POST /applications`, `POST /applications/{id}/releases`) and on the 202 rollback, and `@ProblemResponses` per operation:

| Operation | Success | `@ProblemResponses` |
|---|---|---|
| `POST /applications` | 201 | `CONFLICT` (unique name) |
| `GET /applications` | 200 | none (the invalid cursor is the global 400) |
| `GET /applications/{id}` | 200 | `NOT_FOUND` |
| `POST /applications/{id}/releases` | 201 | `NOT_FOUND`, `CONFLICT` (`uq_release_app_version`) |
| `GET /applications/{id}/releases/{releaseId}` | 200 | `NOT_FOUND` |
| `POST /deployments` | 202 | `UNPROCESSABLE`, `CONFLICT`, `REQUEST_IN_PROGRESS`, `IDEMPOTENCY_KEY_REUSED`, `SERVICE_UNAVAILABLE` |
| `GET /deployments/{id}` | 200 | `NOT_FOUND` |
| `POST /deployments/{id}/rollback` | 202 | `NOT_FOUND`, `ILLEGAL_TRANSITION`, `CONFLICT` (rollback already requested), `CONCURRENT_MODIFICATION` |
| `GET /deployments/{id}/tasks` | 200 | `NOT_FOUND` |
| `GET /deployments/{id}/tasks/by-offset` | 200 | `NOT_FOUND` |
| `GET /tasks/{id}` | 200 | `NOT_FOUND` |

The kinds were read from the services (`NotFoundException`, `UnprocessableRequestException`, `IllegalTransitionException`, `RollbackAlreadyRequestedException`, the unique constraints in `V1__init.sql`) and from the endpoint tests; they were not each exercised against the running app.

**Result: `OpenApiContractTest` 10 run, 10 passed** (tests 3 and 9 went from red to green), and the full `mvn -pl control-api -am verify -DargLine="-Duser.timezone=UTC"` is **BUILD SUCCESS: 213 tests, 0 failures, 2 skipped** (the two known `@Disabled` tests). The `@WebMvcTest` slice of `ProblemShapeTest` needed no new `excludeFilters` for the config beans.

**UI and chain tests (2026-10-02), written by Claude at the user's request.** Two classes instead of the one in section 6.2, because the disabled case needs its own `@TestPropertySource` and so its own context:

- `SwaggerUiProfileTest` (3): `/swagger-ui.html` answers 302 to `/swagger-ui/index.html`; the index is 200 and mentions "swagger"; `/v3/api-docs` is 200.
- `SwaggerUiDisabledTest` (3, `springdoc.swagger-ui.enabled=false`, what `application-prod.yml` sets): `/swagger-ui.html` and `/swagger-ui/index.html` are 404; `/v3/api-docs` and `/v3/api-docs/api-v1` are still 200.
- `TemporaryOpenChainTest` gained 3: the docs JSON is open, the UI index is open, and an unknown path outside `/api` (`/some/other/path`) is still 403.

Result: **13 run (7 new), 13 passed**, first run. They were not seen red, as with tests 5 and 10. The enabled and disabled classes are each other's red: the same URL is 200 in one context and 404 in the other, so neither can pass by accident. The test for the `prod` profile itself (`application-prod.yml` really sets the property) is not written: only the property is tested.

**The drift drill found a gap, and the handler now uses `ProblemKind` (2026-10-02).** Before the drill, a check of what would catch a new slug showed nothing would: `ProblemShapeTest`'s table pins only the slugs it probes, and test 5 compares `ProblemKind` with the spec, so a slug that exists only in `ApiExceptionHandler` is in neither. Adding a `problem(HttpStatus.GONE, "gone", ...)` handler and documenting nothing would have left every test green. The design had named this as "a second list of slugs next to `ApiExceptionHandler`".

Fix: `ApiExceptionHandler` takes slug, status and title from the enum. A private overload `problem(ProblemKind kind, String detail, WebRequest request)` calls the old five-argument method, and all 16 call sites were converted (the user did the first; the rest were converted by a script that replaced `problem(HttpStatus.X, "slug", "Title", ...)` with `problem(ProblemKind.X, ...)`, and would have stopped on any slug missing from the enum or any title that differed from it; none did). `slugFor` uses `ProblemKind.VALIDATION_FAILED`, `MALFORMED_REQUEST` and `NOT_FOUND` for Spring's default errors. `method-not-allowed`, `unsupported-media-type` and the `error-<status>` fallback stay as literals: no operation lists them.

Result: **`mvn verify` 222 tests, 0 failures, 2 skipped, BUILD SUCCESS** (203 before S3.7, plus 10 contract tests, 6 UI tests and 3 chain tests). `ProblemShapeTest` (32) is the proof that no response changed. A new handler must now name a `ProblemKind`, and test 5 documents every kind, so a new slug is documented by construction. It can still drift only through a new literal, which is a review item and is not tested. The drill as written (a slug in the handler and not in the docs) is therefore no longer possible without a literal; it was not run.

**Manual check against the dev stack, 2026-10-02.** `springdoc.group-configs` had been removed from `application.yml` and `application-prod.yml` by the user (the `GroupedOpenApi` bean is the only definition of `api-v1`). App on profile `local` against the compose Postgres (port 55432) and Redis, driven with `curl` and the spec read as JSON. Swagger UI was **not** clicked through: only `/swagger-ui/index.html` was fetched (200), so "Try it out" in a browser is not verified.

| Request | Observed | Spec says |
|---|---|---|
| `POST /applications` | 201, `Location: /api/v1/applications/<id>` | 201, `Location` |
| same name again | 409 `conflict` | `Conflict409` has `conflict` |
| `POST /applications/{id}/releases` | 201, `Location` | 201, `Location` |
| `GET` unknown application | 404 `not-found` | `NotFound404` |
| `POST /deployments`, no key | 202, `Location: /api/v1/tasks/<id>`, `Idempotent-Replayed: false` | 202 with both headers |
| same application and environment again | 409 `conflict` (active deployment) | `Conflict409` has `conflict` |
| unknown release | 422 `unprocessable` | `Unprocessable422` has `unprocessable` |
| same `Idempotency-Key` twice | 202 with `Idempotent-Replayed` `false`, then `true` | the header is documented |
| same key, other body | 422 `idempotency-key-reused` | `Unprocessable422` has `idempotency-key-reused` |
| 70 quick requests, one new team | 62 × 200, 8 × 429; the 429 had `Retry-After: 1` and `application/problem+json` | `TooManyRequests429` with `Retry-After` |
| `GET /applications?limit=0` | 400 `validation-failed`, `errors[0].field == "limit"` | `BadRequest400`, `limit` min 1 |
| the document | 200; 11 operations; tags `Applications`, `Deployments`, `Tasks`; 7 named responses | |

Not exercised against the running app: the 409 `illegal-transition`, `concurrent-modification` and `request-in-progress`, the 503 (Redis down), and the rollback endpoint. Those are covered by the endpoint tests of S3.3 and S3.5, and the spec's claim that they can occur comes from the annotations. The check left rows in the dev database (an application named `s37-check-*` with two releases and two deployments).

**Results summary**

- **Spec:** 11 operations in group `api-v1`, three tags, seven status responses with one named example per slug (12 slugs), `X-Team-Id` on every operation, `Location` and `Idempotent-Replayed` documented, success statuses 201 and 202 correct, bodies `application/json`.
- **Tests added:** `OpenApiContractTest` (10), `SwaggerUiProfileTest` (3), `SwaggerUiDisabledTest` (3), 3 in `TemporaryOpenChainTest`. `mvn verify`: **222 tests, 0 failures, 2 skipped, BUILD SUCCESS**.
- **Red runs seen:** the contract test with no annotations (5 of 8 red), tests 3 and 9 red until the annotations existed, and the 409 and 422 loss found by reading the spec after step 4. **Not seen red:** tests 5 and 10 (written after the behaviour), the UI tests, and the drift drill (the handler refactor made the drill impossible without a literal).
- **Findings that changed the design:** springdoc documents `200` for any `ResponseEntity` and `*/*` as the content type (fixed with explicit `@ApiResponse` and a customizer); two slugs on one status overwrite each other (responses keyed by status); nothing linked the handler's slugs to the documented ones (the handler uses `ProblemKind`).
- **Left as they are:** `method-not-allowed`, `unsupported-media-type` and `error-<status>` are not documented; Swagger UI in a browser not verified; the `prod` profile file itself is not tested, only the property; the JSON stays on in `prod` (decision 6) until S4 decides. **Closed in S4.6 (2026-10-06):** in `prod` the JSON needs any valid token (`appfleet.docs.public=false`) and the UI stays off.

## Definition of done

- [x] springdoc `3.1.1` (latest on Maven Central; its parent pom targets Spring Boot 4.1.0); version and reason recorded in section 11. The reason is a comment above the dependency in `pom.xml`
- [x] Docs paths permitted and unknown paths still 403 (`TemporaryOpenChainTest`)
- [x] `OpenApiConfig`, `ProblemKind`, `@ProblemResponses`, `ErrorResponseCustomizer` (the `Problem` schema is built by hand in `OpenApiConfig`; there is no `ProblemSchema` class)
- [x] `@Tag`, `@Operation`, `@ProblemResponses` on all 11 operations, `@ApiResponse` with `Location` on the 201 and 202 ones
- [x] Tests 1 to 10 green; tests 3, 4, 6, 8 and 9 seen red with no annotations (test 5 and the drift drill not run red, see section 11)
- [x] `SwaggerUiProfileTest` and `SwaggerUiDisabledTest` green: the UI on by default, off with the property, JSON still served
- [x] `TemporaryOpenChainTest` extended; `ProblemShapeTest` still green
- [x] Manual check against the dev stack with `curl`, including a 429 and an idempotent replay (the UI itself was not clicked through)
- [x] Results section written; plan doc's S3 items "S3.1 to S3.7 each have their own design doc" and "Every endpoint documented in OpenAPI including error shapes" ticked
- [x] `mvn verify` green (222 tests, 2 skipped)
