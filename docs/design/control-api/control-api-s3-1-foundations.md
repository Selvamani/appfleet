# control-api — S3.1: correlation id, the one error shape, and the test setup for the web layer

**Spec:** [01-CONTROL-API.md §S3](../../specs/project/01-CONTROL-API.md) — *"`@RestControllerAdvice` → `ProblemDetail` for every failure: validation, not-found, conflict, illegal transition, optimistic-lock. One shape. Write a test asserting the shape for each."* Plus the build guide's shared conventions: RFC 7807 errors, and `X-Correlation-Id` "in, generated if absent, into MDC, out on the response." · Slice **S3.1** of [control-api-s3-rest.md](control-api-s3-rest.md)

Companion: [control-api-s3-rest.md](control-api-s3-rest.md) (the S3 plan; sections 3.1 and 3.2 fix the error shape and the status matrix this doc implements), [control-api-s2-optimistic-lock.md](control-api-s2-optimistic-lock.md) (why optimistic-lock is a 409), [control-api-s2-service-layer.md](control-api-s2-service-layer.md) (`DeploymentValidationException`). **Status: implemented and green; results in section 9.**

This step has no business endpoints. It builds what every later endpoint fails *through*, so it is testable with a throwaway probe controller and needs no database.

## 1. Facts checked against the installed dependencies

Two things the plan doc left as "check, do not assume". Checked in the local Maven repository for Spring Boot 4.1.0:

- **MockMvc is not on the classpath yet.** `spring-boot-starter-test` in 4.1.0 contains `spring-boot-test` and `spring-boot-test-autoconfigure`, but **not** the web-test support. That lives in a separate starter, `org.springframework.boot:spring-boot-starter-webmvc-test`, which provides `@WebMvcTest` and `@AutoConfigureMockMvc` in the package `org.springframework.boot.webmvc.test.autoconfigure` (not the Boot 3 `...test.autoconfigure.web.servlet` package) and pulls in the REST test client. Add it with `<scope>test</scope>`. The artifact resolves from Central at 4.1.0.
- **Boot ships its own problem-details handler,** `ProblemDetailsExceptionHandler`, switched on by `spring.mvc.problemdetails.enabled`. **Do not enable that property.** This design supplies its own `ResponseEntityExceptionHandler` subclass, and the property would turn on a competing one. Confirm during implementation that only one advice handles standard MVC exceptions.

## 2. The correlation id filter

`CorrelationIdFilter` in `io.appfleet.control.web`, an `OncePerRequestFilter` at `Ordered.HIGHEST_PRECEDENCE`, so every later filter and every error path already has the id.

Behaviour, in order:

1. Read `X-Correlation-Id`.
2. **Accept it only if it is well-formed:** 1 to 64 characters, matching `[A-Za-z0-9._-]+`. Otherwise **ignore it and generate a fresh UUID.** Do not reject the request: a bad correlation header is a tracing problem, not a client error. Never copy arbitrary header text into logs: an unchecked value is a log-injection vector (newlines forging log lines).
3. Put the value in MDC under `correlationId` and in a request attribute (`CorrelationIdFilter.ATTRIBUTE`) for the error advice.
4. **Set the response header before calling the chain**, so it is present on error responses and on responses that fail midway.
5. Call the chain in `try`, and **remove the MDC key in `finally`.** Servlet threads are pooled. A key left behind leaks one request's id into the next, and this is the same class of bug as `node-agent`'s deliberate MDC-bleed.

```java
public class CorrelationIdFilter extends OncePerRequestFilter {

    public static final String HEADER = "X-Correlation-Id";
    public static final String MDC_KEY = "correlationId";
    public static final String ATTRIBUTE = CorrelationIdFilter.class.getName() + ".id";

    private static final Pattern VALID = Pattern.compile("[A-Za-z0-9._-]{1,64}");

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response,
                                    FilterChain chain) throws ServletException, IOException {
        String incoming = request.getHeader(HEADER);
        String id = (incoming != null && VALID.matcher(incoming).matches())
                ? incoming
                : UUID.randomUUID().toString();

        MDC.put(MDC_KEY, id);
        request.setAttribute(ATTRIBUTE, id);
        response.setHeader(HEADER, id);
        try {
            chain.doFilter(request, response);
        } finally {
            MDC.remove(MDC_KEY);
        }
    }
}
```

Registration: a `@Component` on the class picks it up as a servlet filter. Set its order with `@Order(Ordered.HIGHEST_PRECEDENCE)`. For the `@WebMvcTest` slice used below, `Filter` beans are part of the slice, so no extra wiring is needed. **Confirm that in the first test run**, since a filter silently missing from the slice would make every correlation assertion fail for the wrong reason.

Log pattern: add the id to every log line so it is usable, not just present in MDC. In `application.yml`, `logging.pattern.correlation: "[%X{correlationId:-}] "`. **Verify** that the id actually appears in a log line for a request. If Boot's built-in tracing-oriented pattern for that property behaves differently, fall back to `logging.pattern.level`.

Kafka: the convention also says "onto every Kafka message header". Nothing publishes in S3, so that part is deferred to S4 and S6 and is noted here so it is not forgotten.

## 3. The error advice

`ApiExceptionHandler` in `io.appfleet.control.web`, `@RestControllerAdvice`, **extending `ResponseEntityExceptionHandler`.**

### 3.1 Why extend `ResponseEntityExceptionHandler`

It already converts every standard Spring MVC exception (malformed body, missing parameter, unsupported media type 415, method not allowed 405, no handler 404, type mismatch) into a `ProblemDetail`. Extending it means the "one shape" rule holds for exceptions nobody thought about. The alternative, listing each MVC exception by hand, guarantees that one gets missed.

All those handlers funnel through one method, `handleExceptionInternal(...)`. **Override that single method** to stamp the two things every body needs and Spring does not add: the `type` URI and the `correlationId`. The exact signature and the parameter types are to be confirmed against the installed Spring Framework 7 API (the IDE shows it). It is the single funnel in Spring 6.

```java
@Override
protected @Nullable ResponseEntity<Object> handleExceptionInternal(Exception ex, @Nullable Object body,
        HttpHeaders headers, HttpStatusCode status, WebRequest request) {
    ResponseEntity<Object> response = super.handleExceptionInternal(ex, body, headers, status, request);
    if (response != null && response.getBody() instanceof ProblemDetail pd) {
        stamp(pd, request, slugFor(ex, status));
    }
    return response;
}
```

**Call `super` first, then stamp.** The first version of this sketch checked `body instanceof ProblemDetail` *before* calling `super`, and it never fired: every standard handler passes `body = null`, and `super.handleExceptionInternal` is what builds the `ProblemDetail` from the exception (`errorResponse.updateAndGetBody(...)`, confirmed in the Spring 7.0.8 source). The bug showed up as a 404 body with content type `application/problem+json` but no `type`. In Spring 7 the method is also `@Nullable`: it returns `null` when the response is already committed, so the result must be null-checked.

`stamp` sets `type` to `urn:appfleet:problem:<slug>`, sets `correlationId` from the request attribute, and leaves `title`, `status` and `detail` as Spring produced them. `slugFor` maps the two cases that matter: `MethodArgumentNotValidException` (and the Spring 6.1 method-validation exception) to `validation-failed`, every other 400 to `malformed-request`, and the remaining statuses to a slug per status (`not-found`, `method-not-allowed`, `unsupported-media-type`).

**`instance`:** Spring sets it to the request path when it builds these bodies. Confirm live and set it explicitly in `stamp` if it does not.

### 3.2 Domain handlers

Each is a plain `@ExceptionHandler` returning a `ProblemDetail` built through the same `stamp` helper, so no handler can forget the `correlationId`:

| Exception | Status | Slug | Notes |
|---|---|---|---|
| `IllegalTransitionException` | 409 | `illegal-transition` | **New exception**, see 3.3 |
| `ObjectOptimisticLockingFailureException` | 409 | `concurrent-modification` | `detail` tells the client to re-read and retry deliberately, per the fail-fast policy |
| `DataIntegrityViolationException` with a **known** constraint | 409 | `conflict` | see 3.4 |
| `DeploymentValidationException` (checked) | 422 | `unprocessable` | domain rejection of a well-formed request |
| `NotFoundException` | 404 | `not-found` | **New exception**, see 3.3 |
| `jakarta.validation.ConstraintViolationException` | 400 | `validation-failed` | from `@Validated` path variables and parameters, with an `errors` list |
| any other `Exception` | 500 | `internal-error` | generic `detail`, see 3.5 |

### 3.3 Two small new exceptions

- **`IllegalTransitionException extends IllegalStateException`**, thrown by `Deployment.transitionTo` in place of the bare `IllegalStateException`. Reason: the advice must not map **every** `IllegalStateException` to 409. That type is thrown by the JDK and by libraries for plain bugs, and a blanket mapping turns bugs into misleading "conflict" responses. A dedicated subtype lets the advice be precise. Because it *extends* `IllegalStateException`, every existing test (`isInstanceOf(IllegalStateException.class)`, and the message checks in `DeploymentTest`) keeps passing unchanged. The message text is unchanged.
- **`NotFoundException`** in `io.appfleet.control.common` (runtime exception, carries the resource name and id). Services throw it when a repository returns empty. It is in `common`, not `web`, because services use it and services must not import `..web`.

### 3.4 Unique violations: only the known constraints are 409

A `DataIntegrityViolationException` covers unique violations (client-fixable conflict) and also `NOT NULL` or foreign-key violations (server bugs). Mapping all to 409 would hide bugs.

The schema names its constraints (`uq_application_name`, `uq_deployment_active_per_app_env`, `uq_release_app_version`, and so on). Walk the cause chain to Hibernate's `ConstraintViolationException` and read `getConstraintName()`:

- name in a small **whitelist of known unique constraints** gives 409 `conflict`, with a `detail` that names the conflict in domain words ("an active deployment already exists for this application and environment"), built from a `Map<String, String>` of constraint name to sentence;
- anything else falls through to the 500 handler.

**Verify live** what the constraint name looks like when Postgres reports it. Confirm the exact string (not schema-qualified, correct case) before writing the map, and confirm the cause chain really contains that Hibernate exception on this version.

### 3.5 The 500 handler never leaks

- `detail` is a fixed sentence ("An unexpected error occurred."), never `ex.getMessage()`, which can contain SQL, table names or internal paths.
- The stack trace is logged once, at ERROR, with the correlation id (already in the log line through MDC), so a support person given the id from the response can find the trace.
- Same `ProblemDetail` shape as every other error, with `correlationId`.

## 4. Gaps that are known and accepted for now

- **Failures outside Spring MVC.** A request rejected by Tomcat before reaching the `DispatcherServlet` (for example a malformed URL or an oversized header) goes to Boot's `/error` path and gets Boot's default error JSON, not this shape. The advice cannot see it. Probe it once (send a request with an illegal character in the path), record what comes back, and decide separately whether to replace the error controller. Do not claim "one shape for every failure" in the docs until that is settled.
- **Filter-level failures.** A future security filter (S4) that rejects a request never reaches the advice. Its entry point will need to write the same shape. Noted for S4.

## 5. Tests

**Slice test, no database.** `ProblemShapeTest` uses `@WebMvcTest` on a test-only controller and `@Import({ApiExceptionHandler.class, CorrelationIdFilter.class})`. The advice and filter do not touch the database, so a container would add nothing but seconds. The main application class carries `@ConfigurationProperties` for `appfleet.*` with `@NotBlank`, so activate the `test` profile (`@ActiveProfiles("test")`), whose file already sets `appfleet.environment: test`.

Imports live in `org.springframework.boot.webmvc.test.autoconfigure` (section 1).

**The probe controller** is a `@RestController` declared inside the test (a static nested class, or a `@TestConfiguration`), mounted under `/probe/...` so it cannot collide with real routes. One endpoint per exception, each simply throwing:

| Path | Throws |
|---|---|
| `POST /probe/validate` | nothing, but takes a `@Valid @RequestBody` record with `@NotBlank name` |
| `GET /probe/not-found` | `NotFoundException` |
| `GET /probe/illegal-transition` | `IllegalTransitionException` |
| `GET /probe/optimistic-lock` | `ObjectOptimisticLockingFailureException` |
| `GET /probe/unique/{constraint}` | `DataIntegrityViolationException` wrapping a constraint violation with that name |
| `GET /probe/unprocessable` | `DeploymentValidationException` |
| `GET /probe/boom` | `RuntimeException("secret internal detail")` |

The standard MVC cases (malformed JSON, 405, 415, unknown route) need no probe endpoint; they are triggered by sending a bad request to the endpoints above or to a path that does not exist.

**Shape assertions,** one parameterized test with a row per case. For every row assert:

- `status` is the expected code
- `Content-Type` is `application/problem+json`
- `$.type` equals the expected `urn:appfleet:problem:<slug>`
- `$.title` is present
- `$.instance` equals the request path
- `$.correlationId` equals the `X-Correlation-Id` response header
- `$.errors` exists **only** on the validation row, as a list of `{field, message}`, and is **absent** on every other row

Extra assertions on specific rows:

- The `boom` row's `detail` does **not** contain `secret internal detail`. This is the leak test.
- The unique-constraint row for a known name gives 409 `conflict`. A **second** row with an unknown constraint name gives 500 `internal-error`. That proves the whitelist rather than a blanket mapping.

**Correlation filter tests,** each its own small test:

1. Request with a valid `X-Correlation-Id`: the same value comes back in the response header.
2. Request without the header: a UUID comes back.
3. Request with an invalid value (contains a space, or 65 characters): it is **not** echoed, and a UUID comes back.
4. The header is present on an error response, not only on 2xx.
5. After the request completes, `MDC.get("correlationId")` on the test thread is `null`. MockMvc runs the filter on the calling thread, so this really checks the `finally`.

## 6. Order of work: find it broken first

1. **Dependencies and property.** Add `spring-boot-starter-webmvc-test` (test scope). Add `spring.data.redis.repositories.enabled: false` and confirm the "could not safely identify store assignment" INFO lines disappear from startup. Run the existing suite to confirm nothing else moved.
2. **Probe controller and shape test with no advice and no filter.** Run it. **Record what comes back:** the throwing endpoints produce Boot's default error body (a different shape, with `timestamp`, `error`, `path`), or a bare 500, and there is no `correlationId` at all. This is the "before".
3. **Write the filter.** Filter tests green.
4. **Add the two new exceptions** and change `Deployment.transitionTo` to throw `IllegalTransitionException`. Run the full existing suite: it must stay green with no test edits.
5. **Write the advice.** Shape test green, row by row.
6. **Probe the accepted gaps** (section 4). Record the actual output.
7. **Record results** in a Results section here.

## 7. Files touched

New: `CorrelationIdFilter`, `ApiExceptionHandler`, `NotFoundException`, `IllegalTransitionException`, `ProblemShapeTest`, `CorrelationIdFilterTest` (or both in one class).
Changed: `Deployment.transitionTo` (throws the subtype), `application.yml` (Redis property, log pattern), `control-api/pom.xml` (one test dependency).

## 8. Found on the running app: Spring Security is already active

Probing the real app (port 8081, profile `local`) showed that **every request outside `/actuator/health` returns 401 with an empty body**, and the log prints `Using generated security password: ...`. Cause: `control-api` depends on `common-security`, whose pom pulls in `spring-boot-starter-security`. With no `SecurityFilterChain` bean defined, Boot applies its default: authenticate everything. The dependency has been there since the initial skeleton, before S4 gives it a purpose.

Consequences:

- **No S3 endpoint would be reachable from a real client.** The `@WebMvcTest` slice does not apply the security chain, so 19 green tests never showed it. Slice tests cannot see this class of problem. Endpoint tests in S3.2 onwards must also run against the real chain.
- **The 401 body is not a `ProblemDetail`.** Security filters answer before the advice can run. This is the S4 gap listed in section 4, and it is already real.
- The correlation filter still works: `X-Correlation-Id` is present on the 401 responses, because the filter is ordered ahead of security.

### 8.1 Decision: a temporary open chain (option A)

S3 is built before authentication (S4), and S4's first exercise is to build the **insecure** endpoint on purpose and write the exploit test. So the honest state for S3 is "open, and deliberately so, and marked". A dedicated `SecurityFilterChain` says that in code, where excluding the auto-configuration (option B) or dropping the dependency (option C) would hide it.

Class `TemporaryOpenSecurityConfig` in `io.appfleet.control.web`:

```java
/**
 * TEMPORARY, removed in S4. Until authentication exists this app is deliberately open.
 * Delete this class when the real JWT chain lands; TemporaryOpenChainTest will then fail
 * on purpose, and that failure is the reminder.
 */
@Configuration
class TemporaryOpenSecurityConfig {

    @Bean
    SecurityFilterChain temporaryOpenChain(HttpSecurity http) throws Exception {
        http.authorizeHttpRequests(auth -> auth
                        .requestMatchers("/api/**", "/actuator/health", "/actuator/info").permitAll()
                        .anyRequest().denyAll())
                .csrf(csrf -> csrf.disable())
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS));
        return http.build();
    }
}
```

Each choice, and why:

- **`/api/**` permitted.** All S3 endpoints live under `/api/v1`.
- **`/actuator/health` and `/actuator/info` permitted.** They are the only endpoints S0 exposes deliberately.
- **`anyRequest().denyAll()`, not `authenticated()`.** Anything else, for example other actuator paths, is refused outright. With `authenticated()` the generated password would still be the only key in; with `denyAll()` there is no credential to leak in the log and no half-open state. (Whether the "Using generated security password" log line disappears as well is to be checked, see the test below.)
- **CSRF disabled.** Easy to miss: with CSRF on, every `POST` returns **403 even on a permitted path**, because there is no token. This is a stateless JSON API with no browser session, so CSRF protection does not apply. Disabling it is correct for this API and is not part of the "temporary" part.
- **Stateless sessions.** No `JSESSIONID`, no server-side session.

### 8.2 Test: through the real chain and a real server

The slice cannot check this, so the test starts the whole application on a random port with Testcontainers Postgres and sends real HTTP requests. Class `TemporaryOpenChainTest`, `@SpringBootTest(webEnvironment = RANDOM_PORT)`, `@ActiveProfiles("test")`, the usual `PostgreSQLContainer` with `@ServiceConnection`.

Use `java.net.http.HttpClient` against `http://localhost:<port>` rather than a Spring test client: it needs no extra dependency and no package guesswork. Read the port with `@Value("${local.server.port}")` (test code may use `@Value`; the ban is on main code).

Assertions, one test each:

| Request | Expected | What it proves |
|---|---|---|
| `GET /api/v1/nope` | **404** with `Content-Type: application/problem+json`, `type` `urn:appfleet:problem:not-found`, `correlationId` present | permitted by the chain, reaches MVC, and the advice and filter work over real Tomcat |
| `POST /api/v1/nope` with a JSON body | **404**, not 403 | CSRF is off |
| `GET /actuator/health` | 200 | S0 endpoint still open |
| `GET /actuator/env` | **not** 2xx | `denyAll` holds |

Fail-first: run it **before** adding the config class. The first row should fail with 401, which reproduces the finding as a test. Then add the class and watch it pass.

When S4 replaces this chain, rows 1 and 2 fail (401), which is the intended reminder to delete `TemporaryOpenSecurityConfig` and write the real authorisation tests.

### 8.3 Live findings from the same probe

Recorded here as observed on the running app:

- `GET /api/%` and `GET /api/%zz` (illegal percent-encoding) return **HTML 400** from Tomcat, `Content-Type: text/html;charset=utf-8`, with **no `X-Correlation-Id` header**. Confirms the Tomcat-level gap in section 4. Not fixed here.
- An invalid `X-Correlation-Id` value sent to the real server was replaced by a generated UUID.
- The correlation id appears in real log lines through `logging.pattern.correlation` (`[<uuid>]` inside a request, `[]` outside).
- Redis "store assignment" INFO lines: 12 before `spring.data.redis.repositories.enabled: false`, 0 after.
- Real constraint names from Postgres: `uq_application_name` and the partial index `uq_deployment_active_per_app_env`, both exact, with no schema prefix.

## 9. Results

Everything below was observed, not assumed. Final state: `mvn verify` green, `ProblemShapeTest` 19 tests, `RealConstraintNamesTest` 2, `TemporaryOpenChainTest` 4.

**Mistakes caught by running it**

| What | Symptom | Cause |
|---|---|---|
| Advice stamped nothing | 404 body was `problem+json` but had no `type` | The override checked `body instanceof ProblemDetail` before `super`; `body` is `null` until `super` builds it (section 3.1) |
| Probe returned 404 for every `/probe/validate` | 4 of 5 tests failed on status | Bare `@WebMvcTest`, probe controller not imported |
| Test helper failures | all rows failed on `$.errors[0]...` | The validation-only assertion had been moved into the shared helper |
| Wrong static imports (three times) | `RequestMatcher cannot be converted to ResultMatcher`; `Predicate.not` vs Hamcrest `not`; `isNotBetween` does not exist | IDE picked the client-side `MockRestRequestMatchers`, then the JDK `Predicate.not`; `isNotBetween` was simply an invented AssertJ method. An explicit static import shadows a wildcard one |
| `health_isOpen` returned 503 | log: `Unable to connect to localhost:6379` | Health aggregates the Redis indicator and the test container only starts Postgres. Fixed in the test with `management.health.redis.enabled=false`, not in the app |

**Confirmed live**

- `instance` is set by Spring to the request path; no explicit code was needed.
- The correlation id reaches log lines through `logging.pattern.correlation` (`[<uuid>]` inside a request, `[]` outside).
- A `@Valid @RequestBody` failure arrives as `MethodArgumentNotValidException`, handled by `handleMethodArgumentNotValid`, which adds the `errors` list. The Spring 7 `HandlerMethodValidationException` (path variables and request parameters) is **not** covered yet and needs its own handler when S3.2 adds validated path variables.
- Real Postgres constraint names, via Hibernate, exactly `uq_application_name` and `uq_deployment_active_per_app_env` (a partial index), no schema prefix. The whitelist in `KNOWN_CONFLICTS` now rests on real names.
- With `TemporaryOpenSecurityConfig`, `/api/v1/nope` returns 404 `problem+json` over real Tomcat, `POST` is not blocked by CSRF, `/actuator/health` is 200, and `/actuator/env` is refused. Before the config the same test reproduced the 401.
- One leftover: the log line `Using generated security password` still appears, because Boot still creates its default in-memory user even though `denyAll` never uses it. Harmless, and it disappears when S4 replaces the chain.

**Still true, recorded not fixed**

- **Tomcat-level failures** (`/api/%`, `/api/%zz`) return HTML 400 with no `X-Correlation-Id`. The advice cannot see them. Do not claim "one shape for every failure" until the error controller is replaced.
- **Security-filter failures** (the 401 body) are not `ProblemDetail`. S4's entry point must write the same shape.
- **`@ExceptionHandler(Exception.class)`** will turn `AccessDeniedException` and `AuthenticationException` into 500 when S4 arrives unless they are handled explicitly.

## Definition of done

- [x] `spring-boot-starter-webmvc-test` added; the class locations in section 1 confirmed as used
- [x] "Before" state: not recorded for the advice (skipped on purpose once the advice was half written); recorded for the security chain (401)
- [x] `CorrelationIdFilter` with all five filter tests green, including MDC cleared after the request
- [x] `IllegalTransitionException` in place; every existing test passes unedited
- [x] `ApiExceptionHandler` green on every shape row, one advice only handling standard MVC exceptions
- [x] Leak test green: a 500 never echoes the exception message
- [x] Unique-violation whitelist proven by a known name (409) and an unknown name (500), against the constraint-name format seen live
- [x] Redis "store assignment" INFO noise gone
- [x] Accepted gaps (section 4) probed and their real behaviour written down
- [x] `mvn verify` green
- [x] `TemporaryOpenSecurityConfig` added; `TemporaryOpenChainTest` seen failing (401) before it and green after (section 8)
- [x] Section 4 corrected (see section 9): the Tomcat-level HTML 400 is confirmed, not hypothetical
