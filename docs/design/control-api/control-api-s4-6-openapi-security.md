# control-api — S4.6: OpenAPI security

**Spec:** [01-CONTROL-API.md §S4](../../specs/project/01-CONTROL-API.md) · Step **S4.6** of [control-api-s4-plan.md](control-api-s4-plan.md) · Predecessors: [control-api-s3-7-openapi.md](control-api-s3-7-openapi.md) (the document, the customizer, decision 6 that this step closes), [control-api-s4-1-jwt-validation.md](control-api-s4-1-jwt-validation.md) (401 and 403, decision 8: docs paths stay open until here), [control-api-s4-3-method-security.md](control-api-s4-3-method-security.md) and [control-api-s4-4-idor.md](control-api-s4-4-idor.md) (the 403s this step must list). **Status: designed 2026-10-06, all open questions decided (section 8), section 5 verified on a scratch copy (346 tests green) but not yet built in the real tree. Code in section 5 is not compiled; every springdoc and swagger-core method name is from memory of that API and the contract test is the check.**

After S4.1 to S4.5 every operation answers 401 without a token and 403 without the permission, but the generated document says neither. A client generated from it, or a person using Swagger UI, sees a public API. This step makes the document tell the truth about security, and decides who may read the document itself. No runtime behaviour of the 11 endpoints changes.

## 1. What already exists

- **The document and its group.** `OpenApiConfig` builds the `OpenAPI` bean with `components.schemas.Problem` and one `components.responses` entry per HTTP status (`BadRequest400` … `ServiceUnavailable503`); `GroupedOpenApi apiV1` attaches `ErrorResponseCustomizer` to `/api/v1/**`.
- **`ErrorResponseCustomizer`** adds 400 and 429 to every operation, expands `@ProblemResponses`, and replaces `*/*` with `application/json`.
- **`ProblemKind` already has `UNAUTHORIZED` (401) and `FORBIDDEN` (403), and `ProblemKind.responseName` already maps 401 to `Unauthorized401` and 403 to `Forbidden403`.** So `components.responses` already contains both; no operation references them. (S4.1 section 6 said this would happen "automatically".)
- **All 11 operations carry exactly one `@PreAuthorize("hasAuthority('<permission>')")`.** `PermissionEnforcementTest` already proves that, with a regex over the annotation.
- **401 carries `WWW-Authenticate`.** `ProblemAuthenticationEntryPoint` sets `Bearer`, or `Bearer error="invalid_token"` for a rejected token. The document does not say so.
- **Docs paths are open.** `SecurityConfig` permits `/v3/api-docs/**`, `/swagger-ui/**`, `/swagger-ui.html` for every profile. `JwtAuthenticationTest` (line 177 to 179) asserts that they answer 200 without a token. `SwaggerUiDisabledTest` asserts that the JSON still answers in a profile without the UI. `application-prod.yml` sets `springdoc.swagger-ui.enabled: false`, so `prod` has the JSON open and no UI (S3.7 decision 6, left open for this step).
- **`X-Team-Id` already left the document** (S4.2); `teamHeader_isOnNoOperation` pins it.
- **340 tests** after S4.5.

## 2. Behaviour

| Request | Answer |
|---|---|
| `GET /v3/api-docs/api-v1` | Now also contains `components.securitySchemes.bearerAuth`, a top-level `security` requirement, `401` and `403` on all 11 operations, `WWW-Authenticate` on the 401 response, and on each operation the extension `x-required-permission` |
| `GET /swagger-ui/index.html` (profiles `local`, `test`) | An **Authorize** button; a pasted token is sent as `Authorization: Bearer …` by "Try it out" |
| `GET /v3/api-docs/**` with `appfleet.docs.public=true` (default, `local` and `test`) | Unchanged: open, 200 |
| `GET /v3/api-docs/**` with `appfleet.docs.public=false` (`prod`) | **401** without a token (problem shape, `WWW-Authenticate: Bearer`), 200 with any valid token (decision 4) |
| Every operation under `/api/v1/**` | Unchanged at runtime |

## 3. Decisions

1. **One scheme, `bearerAuth`: `type: http`, `scheme: bearer`, `bearerFormat: JWT`.** Declared once in `components.securitySchemes`. A client generator then knows to send `Authorization: Bearer <token>`, and Swagger UI draws the Authorize button from it.
2. **The requirement is global, not per operation.** `OpenAPI.security = [{bearerAuth: []}]` applies to every operation. Rejected: `@SecurityRequirement` on each controller. It is a second place that a new controller can forget, and every `/api/**` path is `authenticated()` by the chain (`SecurityConfig` line 26), so "no operation is public" is a fact about the chain, not about each method. The contract test checks that every operation lists the answers; `JwtAuthenticationTest` checks that the chain really refuses a request without a token. Together they cover both directions.
3. **401 and 403 join 400 and 429 as global answers in `ErrorResponseCustomizer`.** Same argument as S3.7 decision 5: a new endpoint gets them without anyone remembering. They are true for all 11 operations: 401 comes from the chain before any handler, 403 from `@PreAuthorize` on every handler, and `POST /applications` adds the team check of S4.4. The 403 description in `components.responses` says both causes (missing permission; a team named in the body that the token does not grant). `@ProblemResponses` on a method may still list `FORBIDDEN`; the customizer writes statuses into a map, so there is no duplicate.
4. **The 401 response documents its header.** `Unauthorized401` gets `WWW-Authenticate` (string, example `Bearer`, description "`Bearer error="invalid_token"` when a token was sent and rejected"). It is added in `OpenApiConfig.statusResponse`, next to `Retry-After`. A new field on `ProblemKind` for one header is over-engineering, so the code uses a literal check for status 401, with a comment.
5. **The required permission is read from the code, never typed again.** The customizer reads `@PreAuthorize` from the handler method, extracts the authority with the same pattern `PermissionEnforcementTest` uses, and writes `x-required-permission: <permission>` plus one sentence at the end of the operation description: "Requires the permission `deployment:create` for the application's team." If the annotation is missing or does not match `hasAuthority('...')`, the customizer throws (`IllegalStateException`) when the document is generated, so an unprotected or oddly protected endpoint turns the document into a 500, which fails every contract test. This is deliberately stricter than the existing meta-test: the document cannot be generated for an endpoint whose permission it cannot state. Rejected: writing the permission into each `@Operation(description)`. It would drift from `@PreAuthorize`, which is the thing S4.3 made the single source.
6. **Docs exposure: a property, not a profile check.** `appfleet.docs.public` (boolean, default `true`). `SecurityConfig` permits the docs paths only when it is `true`; otherwise they fall under `authenticated()` with the same entry point as `/api/**`. `application-prod.yml` sets it `false` and keeps `swagger-ui.enabled: false`. Reasoning, in one line each:
   - Locally, Swagger UI fetches `/v3/api-docs` with a plain browser request that cannot carry a token, so authenticating the JSON there would break the UI that this step adds the Authorize button to.
   - In `prod` there is no UI, and the document lists every route, parameter and error shape. It is not secret, but it is not for the public either; any valid token (no particular permission) is enough, because a permission for "read the API description" would be a new concept for no gain.
   - A property rather than `Environment.acceptsProfiles("prod")` keeps the rule testable: `@TestPropertySource(properties = "appfleet.docs.public=false")` flips it in one test class, like `SwaggerUiDisabledTest` does for the UI.
7. **`springdoc.swagger-ui.persist-authorization: true` in `application.yml`.** Without it the pasted token is lost on every page reload, which makes the UI tiresome in the one place it is used. Dev profile only matters, because `prod` has no UI.
8. **The contract test is red first.** The same tests, written before any code, fail on the S4.5 document (section 4, "Red run"). That is the plan's stated red run: "the contract test fails until the scheme is added".

## 4. Tests

New tests in `OpenApiContractTest` (it already reads `/v3/api-docs/api-v1` and has the helpers `spec()`, `operations()`, `op()`, `header()`):

1. `bearerAuthScheme_isDeclared`: `components.securitySchemes.bearerAuth` has `type = http`, `scheme = bearer`, `bearerFormat = JWT`.
2. `security_isGlobal_andNoOperationOverridesIt`: `spec.security` is `[{bearerAuth: []}]`, and no operation has its own `security` array (which could switch it off with `[]`).
3. `everyOperation_lists401And403`: replaces the 400/429 check by one for `400, 401, 403, 429` (the existing test `everyOperation_lists400And429` is edited, not duplicated; its name changes to `everyOperation_listsTheGlobalAnswers`).
4. `unauthorizedResponse_documentsTheChallenge`: `components.responses.Unauthorized401.headers` has `WWW-Authenticate`.
5. `everyOperation_statesItsPermission`: for every `(method, path)`, `x-required-permission` equals the authority parsed from the handler's `@PreAuthorize`, and the description ends with that permission in backticks. The handler comes from the `handlers` map that `problemResponsesOnOperations_reachTheirSlugs` already builds, so the helper is extracted to a private method and both tests use it.
6. `problemResponsesOnOperations_reachTheirSlugs` is edited: the expected set starts as `{400, 401, 403, 429}`, not `{400, 429}`.
7. New class `DocsExposureTest`, a `@SpringBootTest(webEnvironment = RANDOM_PORT, properties = "appfleet.docs.public=false")` with its own Testcontainers, copied from the setup of `JwtAuthenticationTest` and using `java.net.http.HttpClient`. **Not MockMvc:** `WebIntegrationTest`'s MockMvc does not run the security filter chain (verified 2026-10-06: with the property false, MockMvc still answered 200). Cases: `GET /v3/api-docs` and `/v3/api-docs/api-v1` without a token are 401 with `application/problem+json` and `WWW-Authenticate: Bearer`; with `TestJwt.forUser(UUID.randomUUID()).sign()` (no team, no permission) the second is 200. The open default stays covered by `SwaggerUiProfileTest.apiDocs_areServed` and `JwtAuthenticationTest.docsPathsAreOpen`.
8. **`JwtAuthenticationTest` needs one edit:** its test-only endpoint `ForbiddenEndpoint` uses `@PreAuthorize("hasAuthority('nobody:has:this')")`, three parts. Decision 5 makes the customizer throw for it, and `/v3/api-docs` answers 500 (the application itself still starts) (seen 2026-10-06, `docsPathsAreOpen:177`: expected 200, was 500). Change the string to `nobody:has`. The fixture, not the pattern, is wrong: every real permission has two parts.

**Red run, before any main code:** write tests 1 to 7 and run `mvn -pl control-api test -Dtest=OpenApiContractTest,DocsExposureTest`. Expected failures, one line each: no `bearerAuth`; `spec.security` missing; 11 operations without 401 and 403; no `WWW-Authenticate`; no `x-required-permission`; `DocsExposureTest` gets 200 instead of 401. Record the real numbers in the Results section; do not copy these.

**Mutation checks on a scratch copy** (each must turn at least one test red; then restore):

- (a) Delete the global `addSecurityItem`: tests 2 fail.
- (b) Remove `add(op, ProblemKind.FORBIDDEN)` from the customizer: tests 3 and 6 fail.
- (c) Remove one `@PreAuthorize` from a controller: `/v3/api-docs` answers 500 (the customizer throws while the document is generated), so every `OpenApiContractTest` test that reads the document is red. **Measured 2026-10-06: 14 of 14.** The application context still starts; only the document fails. Other web tests are unaffected.
- (d) Change a permission string in one `@PreAuthorize`: `PermissionEnforcementTest` and test 5 stay consistent because both read the annotation, so the mutation is **not** caught by test 5; it is caught by `PermissionEnforcementTest`'s own table. Recorded so the overlap is not mistaken for a gap.
- (e) Set `appfleet.docs.public` to `false` in `application.yml`: only `JwtAuthenticationTest.docsPathsAreOpen` fails. **Measured 2026-10-06.** `SwaggerUiProfileTest` and `OpenApiContractTest` stay green because their MockMvc skips the security chain.

**Manual check on the dev stack:** open Swagger UI, call `GET /api/v1/applications` without Authorize (401 with the problem body), then Authorize with a token from `TestJwt` printed by a one-off main or the `curl` recipe from S4.1 section 9, and call again (200). Note which token source was used.

## 5. Java design

All changes in `io.appfleet.control.web.openapi` and `io.appfleet.control.web.SecurityConfig`. Compiled and run on a scratch copy on 2026-10-06 (see section 9); paste as written.

### 5.1 `OpenApiConfig`: the scheme, the global requirement, the challenge header

In `appfleetOpenApi()` replace `return api.components(c);` with:

```java
        c.addSecuritySchemes("bearerAuth", new SecurityScheme()
                .type(SecurityScheme.Type.HTTP)
                .scheme("bearer")
                .bearerFormat("JWT")
                .description("An access token issued for control-api. Send it as `Authorization: Bearer <token>`."));
        return api.components(c).addSecurityItem(new SecurityRequirement().addList("bearerAuth"));
```

Imports to add: `io.swagger.v3.oas.models.security.SecurityRequirement`, `io.swagger.v3.oas.models.security.SecurityScheme`.

In `statusResponse(List<ProblemKind> kinds)`, after the `Retry-After` block and before `return r;`:

```java
        // The 401 challenge is set by ProblemAuthenticationEntryPoint, not by a controller, so springdoc cannot see it.
        if (kinds.stream().anyMatch(k -> k.status() == 401))
            r.addHeaderObject("WWW-Authenticate", new Header()
                    .description("`Bearer`, or `Bearer error=\"invalid_token\"` when a token was sent and rejected.")
                    .schema(new StringSchema()).example("Bearer"));
```

### 5.2 `ErrorResponseCustomizer`: global 401 and 403, and the permission

Replace step 1 and add the permission step. The class becomes:

```java
@Component
public class ErrorResponseCustomizer implements OperationCustomizer {

    /** The one form S4.3 allows: hasAuthority('deployment:create'). Same pattern as PermissionEnforcementTest. */
    private static final Pattern AUTHORITY = Pattern.compile("hasAuthority\\('([a-z]+:[a-z]+)'\\)");

    @Override
    public Operation customize(Operation op, HandlerMethod method) {
        // 1. global answers: every operation can be 400, 401, 403 and 429
        add(op, ProblemKind.VALIDATION_FAILED);
        add(op, ProblemKind.UNAUTHORIZED);
        add(op, ProblemKind.FORBIDDEN);
        add(op, ProblemKind.RATE_LIMITED);

        // 2. the answers this method lists with @ProblemResponses
        ProblemResponses extra = method.getMethodAnnotation(ProblemResponses.class);
        if (extra != null) for (ProblemKind k : extra.value()) add(op, k);

        // 3. the permission, read from @PreAuthorize so the document cannot drift from the enforcement
        String permission = permissionOf(method);
        op.addExtension("x-required-permission", permission);
        String sentence = "Requires the permission `" + permission + "` for the object's team.";
        op.setDescription(op.getDescription() == null || op.getDescription().isBlank()
                ? sentence : op.getDescription() + "\n\n" + sentence);

        // 4. springdoc says */* for a ResponseEntity; the API answers application/json.
        //    Done here, not with produces= on the controllers, so no runtime behaviour changes.
        op.getResponses().values().forEach(r -> {
            if (r.getContent() != null && r.getContent().containsKey("*/*"))
                r.getContent().addMediaType("application/json", r.getContent().remove("*/*"));
        });
        return op;
    }

    private static String permissionOf(HandlerMethod method) {
        PreAuthorize pre = method.getMethodAnnotation(PreAuthorize.class);
        if (pre == null)
            throw new IllegalStateException("No @PreAuthorize on " + method.getShortLogMessage()
                    + ": every /api/v1 operation must state its permission (S4.3)");
        Matcher m = AUTHORITY.matcher(pre.value());
        if (!m.matches())
            throw new IllegalStateException("@PreAuthorize on " + method.getShortLogMessage()
                    + " is not hasAuthority('<resource>:<action>'): " + pre.value());
        return m.group(1);
    }

    private static void add(Operation op, ProblemKind k) {
        op.getResponses().addApiResponse(String.valueOf(k.status()),
                new ApiResponse().$ref("#/components/responses/" + ProblemKind.responseName(k.status())));
    }
}
```

Imports to add: `org.springframework.security.access.prepost.PreAuthorize`, `java.util.regex.Matcher`, `java.util.regex.Pattern`. The numbering of the old steps (1, 2, 4) now runs 1 to 4.

Check before pasting: the pattern must match every real annotation. The permissions in `PermissionEnforcementTest` are `application:create`, `application:read`, `deployment:create`, `deployment:read`, `deployment:rollback`; all are `[a-z]+:[a-z]+`. `Matcher.matches()` needs the whole string, so a `@PreAuthorize("hasAuthority('x:y') and ...")` fails the context on purpose.

### 5.3 `SecurityConfig`: docs behind a property

Add a field and use it in the chain. The chain method gains one parameter and the matcher block becomes:

```java
    @Bean
    SecurityFilterChain apiChain(HttpSecurity http, AppfleetJwtAuthenticationConverter converter,
                                 ProblemAuthenticationEntryPoint entryPoint,
                                 ProblemAccessDeniedHandler denied,
                                 @Value("${appfleet.docs.public:true}") boolean docsPublic) throws Exception {
        http.authorizeHttpRequests(a -> {
                    a.requestMatchers("/actuator/health", "/actuator/info").permitAll();
                    var docs = a.requestMatchers("/v3/api-docs/**", "/swagger-ui/**", "/swagger-ui.html");
                    if (docsPublic) docs.permitAll(); else docs.authenticated();
                    a.requestMatchers("/api/**").authenticated()
                            .anyRequest().denyAll();
                })
                // the rest of the chain is unchanged: oauth2ResourceServer, exceptionHandling, csrf, sessionManagement
```

Keep the existing `.oauth2ResourceServer(...)` and following lines exactly as they are; only the `authorizeHttpRequests` argument changes. Import `org.springframework.beans.factory.annotation.Value`.

### 5.4 Configuration

`application.yml`, under the existing `springdoc.swagger-ui`:

```yaml
springdoc:
  api-docs:
    path: /v3/api-docs
  swagger-ui:
    enabled: true
    persist-authorization: true

appfleet:
  docs:
    public: true
```

(`appfleet:` already exists in this file with other keys; add `docs.public` under it, not a second `appfleet:` root.) `application-prod.yml`:

```yaml
appfleet:
  environment: prod
  docs:
    public: false

springdoc:
  swagger-ui:
    enabled: false
```

## 6. Order of work

1. Write tests 1 to 7 (section 4). Run them. Record the red numbers.
2. `OpenApiConfig` (5.1). Tests 1, 2, 4 go green.
3. `ErrorResponseCustomizer` (5.2). Tests 3, 5, 6 go green; if the context fails to start, the message names the method without `@PreAuthorize`.
4. `SecurityConfig` and the two yml files (5.3, 5.4). `DocsExposureTest` goes green.
5. Full `mvn verify`. Expected: 340 plus the new tests, 0 failures, 2 skipped by design. Count the new tests when done; do not trust this paragraph.
6. Mutation checks (a) to (e) on a scratch copy.
7. Manual Swagger UI check.
8. Results section; update the plan's S4.6 row, S3.7's "left as they are" note (decision 6 is closed here), the concepts guide, and Outline.

## 7. What this step deliberately does not do

- **OAuth2 flows in Swagger UI** (authorization-code against identity-service). Needs identity-service. The scheme is plain bearer; when identity-service exists, a second scheme can be added next to it.
- **Per-operation scopes in `security`.** The permission is in `x-required-permission`, not in the OpenAPI `security` scope list, because scopes in OpenAPI belong to OAuth2 schemes and a `http` bearer scheme must have an empty list.
- **Documenting `method-not-allowed`, `unsupported-media-type` and `error-<status>`.** Still outside S3.7's scope; unchanged.
- **Generating a client from the spec** (a web-console decision).
- **Protecting `/actuator/metrics`.** S4 plan decision 9.

## 8. Open questions (all decided 2026-10-06 with the recommendations)

1. **Docs exposure in `prod`.** Decision 6: JSON behind any valid token, UI off. Alternatives: (a) JSON fully open as today (nothing changes, simplest, the document is not secret); (b) JSON off in `prod` and the spec exported at build time instead. Recommendation: the one in decision 6; it is one boolean and a test, and it keeps the live document available to anyone who can already call the API.
2. **Strict startup failure for a missing `@PreAuthorize` (decision 5)?** Alternative: log a WARN and omit the extension. Recommendation: fail. S4.3's whole point is that an unprotected endpoint cannot exist; a document that quietly omits the line would hide one.
3. **`persist-authorization: true`.** Recommendation: yes. Alternative: leave the default and paste the token after every reload.

## Definition of done

- [x] Tests 1 to 7 written first and seen red, numbers recorded
- [x] `components.securitySchemes.bearerAuth` and the global `security` requirement in the document; no operation overrides it
- [x] All 11 operations list 400, 401, 403 and 429; `Unauthorized401` documents `WWW-Authenticate`
- [x] Every operation has `x-required-permission` equal to the authority in its `@PreAuthorize`; a handler without one makes the document answer 500
- [x] `appfleet.docs.public=false` makes the docs 401 without a token and 200 with one; the default stays open
- [x] Mutation checks (a), (b), (c), (e) seen red on a scratch copy and restored; (d) by reasoning
- [x] Checked on the running app with `curl` (401 without a token, 200 with one); the browser Authorize flow worked, as reported by the user (not run by Claude)
- [x] `mvn test` green, 346 tests (`mvn verify` not run)
- [x] Results written; the plan's S4.6 row, S3.7's decision 6 note, the concepts guide and Outline updated

## 9. Scratch-copy verification, 2026-10-06

- Scratch copy of control-api (plus common-events, common-security, leet-audit-starter) taken from the working tree; the half-typed line `c.addSecuritySchemes("bearer")` in the real OpenApiConfig was removed there only.
- **Red run:** tests 1 to 7 against the S4.5 code: 7 of 16 failed (earerAuthScheme_isDeclared, everyOperation_listsTheGlobalAnswers, everyOperation_statesItsPermission, problemResponsesOnOperations_reachTheirSlugs, security_isGlobal_andNoOperationOverridesIt, unauthorizedResponse_documentsTheChallenge, DocsExposureTest.apiDocs_withoutToken_are401InTheProblemShape).
- **Green with section 5 applied:** OpenApiContractTest 14, DocsExposureTest 2.
- **Two corrections found by running it:** (1) MockMvc skips the security chain, so DocsExposureTest must use real HTTP (test 7); (2) the strict customizer exposed the three-part permission in JwtAuthenticationTest (test 8).
- **Full suite:** 346 tests, 0 failures, 2 skipped by design (340 + 4 new contract tests + 2 DocsExposureTest; everyOperation_lists400And429 is renamed, not added).
- **Not done:** mutation checks (a) to (e), the manual Swagger UI check. They belong to the real build.

## 10. Results (built by hand, verified 2026-10-06)

- Real tree: mvn test in control-api: **346 tests, 0 failures, 2 skipped by design** (340 before; 4 new contract tests, 2 in DocsExposureTest).
- Mutations on a fresh scratch copy, each seen red and restored: (a) no global security item: 1 failure (security_isGlobal_andNoOperationOverridesIt); (b) no 403 added: 2 failures (everyOperation_listsTheGlobalAnswers, problemResponsesOnOperations_reachTheirSlugs); (c) one @PreAuthorize removed: 14 of 14 OpenApiContractTest red, document 500; (e) docs public flipped to false: 1 failure (JwtAuthenticationTest.docsPathsAreOpen). (d) is by reasoning, not a run.
- Corrections the build made to the design: MockMvc skips the security chain, so the exposure test uses real HTTP (test 7); the strict check surfaces as a 500 document, not a failed startup (mutation c); one test fixture had a three-part permission (test 8).
- **Manual check on the dev stack, 2026-10-06** (Postgres and Redis from compose, jar run with profile `local` on port 8081, token signed with `dev-private.pem` by a small node script; all stopped afterwards): `GET /v3/api-docs/api-v1` 200 with `bearerAuth` (http, bearer, JWT), `security: [{bearerAuth: []}]`, 401 and 403 on `GET /api/v1/applications`, `x-required-permission: application:read`, and `WWW-Authenticate` on `Unauthorized401`. `/swagger-ui/index.html` 200 and `swagger-config` has `persistAuthorization: true`. `GET /api/v1/applications` without a token: 401, `application/problem+json`, `WWW-Authenticate: Bearer`; with the signed token: 200; with a corrupted signature: 401. **Browser check, reported by the user 2026-10-06:** the Swagger UI Authorize button, 401 without a token, 200 after Authorize and the persisted login all worked (reported, not run by Claude; no screenshot or log). The `prod` flag is proven by `DocsExposureTest`, not by a prod run.
