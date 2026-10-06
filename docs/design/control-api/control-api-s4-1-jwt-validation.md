# control-api — S4.1: JWT validation in `common-security`

**Spec:** [01-CONTROL-API.md §S4](../../specs/project/01-CONTROL-API.md) — *"Gains JWT validation via `common-security` — the RSA public key, no network call to identity"* · [02-IDENTITY-SERVICE.md](../../specs/project/02-IDENTITY-SERVICE.md) *Token design* · Step **S4.1** of [control-api-s4-plan.md](control-api-s4-plan.md)

Companion: [control-api-s3-1-foundations.md](control-api-s3-1-foundations.md) (the problem shape and the correlation id that 401 and 403 must carry), [control-api-s3-7-openapi.md](control-api-s3-7-openapi.md) (the docs paths this step must keep reachable and the `ProblemKind` list this step extends). **Status: closed 2026-10-03 (section 11).**

The plan's open questions are answered here by taking their recommendations (the same way S3 did): control-api first with test-signed tokens, a static public key, the teams claim as a map of permissions, one key pair for tests. Section 5 lists what this step still leaves for you.

This step makes the API refuse requests that carry no valid token. It does **not** decide what a valid caller may do: authorities are mapped from the token here, and checked in S4.3 and S4.4. The bulk of the work is not the validation, which is a few lines of Spring Security, but the cost of turning authentication on in a suite of 222 tests that have never had a token.

## 1. What already exists

- **`TemporaryOpenSecurityConfig`** (`io.appfleet.control.web`): permits `/api/**`, `/actuator/health`, `/actuator/info`, `/v3/api-docs/**`, `/swagger-ui/**`, `/swagger-ui.html`; everything else `denyAll()`; CSRF disabled; sessions stateless. Marked TEMPORARY.
- **`common-security`:** a `pom.xml` with `spring-boot-starter-security`, `spring-security-oauth2-jose` and `common-events`. **No Java, no `META-INF`.** control-api depends on it. `fleet-audit-starter` shows the pattern for a library that registers itself: `META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports`.
- **Spring Security 7.1.0** and **nimbus-jose-jwt 10.9** are on the classpath. `spring-security-oauth2-resource-server` (the module with the bearer filter and `oauth2ResourceServer()`) is **not**: `spring-security-oauth2-jose` provides `NimbusJwtDecoder` and `Jwt`, but not the filter. It must be added.
- **`CorrelationIdFilter`** is `@Order(HIGHEST_PRECEDENCE)`, so it runs before the security filter chain. An entry point called from inside the chain can read the correlation id from the request attribute.
- **`ApiExceptionHandler`** only sees exceptions from MVC. A 401 or 403 raised by the security filters never reaches it, which is why those two need their own handlers (section 3, 4).
- **The test suite:** 70 `mockMvc.perform(...)` call sites across 11 web test classes, all through `WebIntegrationTest` (`@SpringBootTest` + `@AutoConfigureMockMvc`), plus `TemporaryOpenChainTest` (a real HTTP client against a random port) and `ProblemShapeTest` (a `@WebMvcTest` slice with `CorrelationIdFilter` and `ApiExceptionHandler` imported and no security configuration of its own).
- **No `Authorization` anywhere.** `Idempotency-Key`, `X-Team-Id` and `X-Correlation-Id` are the only request headers the code reads.

## 2. Behaviour

| Request | Answer |
|---|---|
| `/api/**` without `Authorization` | **401** `unauthorized`, `WWW-Authenticate: Bearer`, `application/problem+json`, `correlationId` |
| `Authorization: Bearer <valid token>` | passes; the request has a `JwtAuthenticationToken` principal |
| bad signature, expired, not yet valid, wrong issuer, wrong audience, wrong algorithm, malformed, or `alg: none` | **401** `unauthorized`, `WWW-Authenticate: Bearer error="invalid_token"` |
| a scheme other than `Bearer` (for example `Basic`) | **401** `unauthorized`, no `error` in the header |
| two `Authorization` headers | **401** (the filter takes the first; the test records what Spring does, section 7) |
| valid token, but the operation needs an authority the token lacks | **403** `forbidden` (enforced from S4.3; the handler exists from S4.1) |
| `/actuator/health`, `/actuator/info` | open, as today |
| `/v3/api-docs/**`, `/swagger-ui/**`, `/swagger-ui.html` | open, as today (decision 8) |
| any other path | **401** if no token, **403** if authenticated (was always 403) |

The 401 for "no token" and for "bad token" has the **same body**. Only the `WWW-Authenticate` header differs, as RFC 6750 says: a missing token must not carry an `error`, an invalid one must.

## 3. Decisions

1. **The pieces live in `common-security`; each service writes its own chain.** `common-security` provides a `JwtDecoder` bean, a `JwtAuthenticationConverter`, the 401 entry point and the 403 handler, and the properties. A service still declares its own `SecurityFilterChain`, because the permit lists differ (control-api opens the docs paths; identity-service opens `/api/v1/auth/**` and the JWKS endpoint). Rejected: a ready-made chain in the library, which would make every service fight its defaults.
2. **A static RSA public key, from a property.** `appfleet.security.jwt.public-key-location` (a Spring `Resource`: `classpath:` or `file:`) holds a PEM `-----BEGIN PUBLIC KEY-----` (SubjectPublicKeyInfo). It is read once at startup with `RsaKeyConverters.x509()` and wrapped in `NimbusJwtDecoder.withPublicKey(key).build()`. A missing or unreadable key **fails startup**, not the first request. JWKS and `kid` rotation are identity-service's job and a later configuration change here (plan, section 3, 2).
3. **RS256 only, pinned.** `withPublicKey` accepts RS256 by default; the decoder is never built from a JWK set that could offer HS256. This is the algorithm-confusion defence, and it has a test: an HS256 token signed with the **public key bytes as the secret** must be rejected. *Be able to say why RSA and not HMAC for several services:* HMAC needs every verifier to hold the secret, so every service could also mint tokens; RSA lets everyone verify with a public key only identity-service can sign for.
4. **Validators beyond the default.** `JwtValidators.createDefault()` checks `exp` and `nbf` with a **60 second clock skew** (the Spring default; kept, and written down). On top of it: `iss` must equal `appfleet.security.jwt.issuer` (required, no default) and `aud` must contain `appfleet.security.jwt.audience` (default `appfleet`). A token for another audience is another service's token.
5. **The claim contract**, so that the test helper and identity-service build the same thing:

   | Claim | Meaning |
   |---|---|
   | `iss` | `appfleet.security.jwt.issuer`, for example `appfleet-identity` |
   | `sub` | the user id, a UUID string |
   | `aud` | `["appfleet"]` |
   | `jti` | a UUID, the id for the later denylist |
   | `iat`, `exp` | `exp` at most 15 minutes after `iat` (the spec); not enforced by control-api, which only checks `exp` has not passed |
   | `teams` | `{ "<teamId>": ["deployment:create", "deployment:rollback"], ... }`: the **team-scoped permissions** |
   | `perms` | optional: global permissions, a list, for the degenerate "global role" case |

   control-api never reads `roles` (decision 6 of the plan: permissions are enforced, roles are bundles). Unknown claims are ignored.
6. **The authorities are the union of all permissions.** The converter turns `perms` and every list in `teams` into `SimpleGrantedAuthority` with the permission string as it is (`deployment:create`, no `ROLE_` prefix). That makes S4.3's `hasAuthority('deployment:create')` mean *"this caller holds this permission somewhere"*, a coarse check on the endpoint. The precise check, *"for **this** application's team"*, reads the raw `teams` claim from the `Jwt` and is S4.4. The union is an over-approximation on purpose and is the reason S4.4 exists. The raw `Jwt` stays on the principal, untouched.
7. **A principal that is the `Jwt`.** No custom `UserDetails` and no database lookup per request. *Zero network calls to identity on the request path* is the spec's definition of done for the whole of S4, and a lookup in control-api's own database would break the spirit of it.
8. **The docs paths stay open for now.** The OpenAPI JSON and the Swagger UI keep working without a token, so S4.6 can add the `bearerAuth` scheme and an Authorize button without a chicken-and-egg problem. Whether the document is public in `prod` is decided in S4.6 (S3.7 decision 6).
9. **401 and 403 in the problem shape, written by the filter chain.** `ProblemAuthenticationEntryPoint` and `ProblemAccessDeniedHandler` write `application/problem+json`: `type` `urn:appfleet:problem:unauthorized` or `forbidden`, `title`, `status`, `detail`, `instance`, `correlationId`. The `WWW-Authenticate` header comes from Spring's `BearerTokenAuthenticationEntryPoint`, which the new entry point wraps (it sets the status and the header, including `error="invalid_token"`; our class then writes the body). The two types are added to `ProblemKind` in control-api (so S3.7's single list stays single), but the handlers live in `common-security`, which has no `ProblemKind`: they carry the two slugs as constants, and a control-api test checks that the constants equal the enum's slugs. The body is written with the Boot `JsonMapper`, never by string concatenation (the `detail` would need escaping).
10. **`detail` never says why the token failed.** Whether it expired, was signed with the wrong key or has the wrong audience is logged at `warn` with the correlation id and **not** returned: an attacker should not learn which check they failed. The `WWW-Authenticate` `error` is the one signal RFC 6750 requires.
11. **CSRF stays disabled, and the reason is written here.** The API is stateless, takes no cookie for authentication and answers only to an `Authorization` header that a browser does not attach on its own, so there is no ambient credential for a cross-site request to ride on. The session creation policy is `STATELESS`. This stops being true the moment any endpoint accepts a cookie.
12. **No `X-Team-Id` removal in this step.** `HeaderTeamResolver` keeps working (S4.2 replaces it). During S4.1 the rate limiter still keys on the header, which the authenticated tests keep sending as they do today.
13. **Tests get a token by default, and the security tests opt out.** See section 6: a `MockMvcBuilderCustomizer` adds a default `Authorization` header to every `MockMvc` request in the suite; the security tests build a `MockMvc` without it.

## 4. Dependencies and configuration

`common-security/pom.xml` gains `org.springframework.security:spring-security-oauth2-resource-server` (version managed by Boot) and `spring-boot-starter-validation` if the properties are validated. Jackson: the entry point uses the Boot `JsonMapper` through an `ObjectProvider`, as the S3.5 note on the two Jackson versions requires.

`application.yml` of control-api (not committed with a real key; the **test and local profiles** carry a throwaway public key):

```yaml
appfleet:
  security:
    jwt:
      public-key-location: ${JWT_PUBLIC_KEY_LOCATION:classpath:keys/dev-public.pem}
      issuer: appfleet-identity
      audience: appfleet
```

`prod` takes the location from the environment and has **no default**; a missing key fails startup. The matching **private** key exists only in `common-security`'s test sources and in local tooling. It must never be on a production classpath: a test asserts that `src/main/resources` of every module contains no `PRIVATE KEY`.

## 5. Java design

Package `io.appfleet.security` in `common-security`:

- **`JwtProperties`** (`@ConfigurationProperties("appfleet.security.jwt")`, validated): `publicKeyLocation` (`Resource`), `issuer`, `audience`, `clockSkew` (default 60 s).
- **`JwtSecurityAutoConfiguration`** (`@AutoConfiguration`, registered in `AutoConfiguration.imports`, `@ConditionalOnProperty` for `appfleet.security.jwt.public-key-location`): the `JwtDecoder` bean with the validators of decision 4; the `AppfleetJwtAuthenticationConverter` bean; the two handler beans.
- **`AppfleetJwtAuthenticationConverter implements Converter<Jwt, AbstractAuthenticationToken>`:** builds a `JwtAuthenticationToken(jwt, authorities, name = sub)` from `perms` and the values of `teams`; tolerant of a missing or malformed claim (an empty authority set, not an exception: a token that authenticates but grants nothing is a 403 later, not a 500 now). A claim that is present but of the wrong type is logged and treated as empty.
- **`ProblemAuthenticationEntryPoint implements AuthenticationEntryPoint`** and **`ProblemAccessDeniedHandler implements AccessDeniedHandler`**, as in decision 9.

control-api:

- **`SecurityConfig`** replaces `TemporaryOpenSecurityConfig`:

```java
@Configuration
@EnableWebSecurity
class SecurityConfig {
    @Bean
    SecurityFilterChain apiChain(HttpSecurity http, AppfleetJwtAuthenticationConverter converter,
                                 ProblemAuthenticationEntryPoint entryPoint,
                                 ProblemAccessDeniedHandler denied) throws Exception {
        http.authorizeHttpRequests(a -> a
                .requestMatchers("/actuator/health", "/actuator/info",
                                 "/v3/api-docs/**", "/swagger-ui/**", "/swagger-ui.html").permitAll()
                .requestMatchers("/api/**").authenticated()
                .anyRequest().denyAll())
            .oauth2ResourceServer(o -> o
                .jwt(j -> j.jwtAuthenticationConverter(converter))
                .authenticationEntryPoint(entryPoint)
                .accessDeniedHandler(denied))
            .exceptionHandling(e -> e.authenticationEntryPoint(entryPoint).accessDeniedHandler(denied))
            .csrf(c -> c.disable())
            .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS));
        return http.build();
    }
}
```

  Method names are from memory of Spring Security 7; the compiler and the tests are the check.
- **`ProblemKind`** gains `UNAUTHORIZED` (401) and `FORBIDDEN` (403), and `responseName` two cases. S3.7's contract test then asks for them in the document; the `bearerAuth` scheme and the global 401 are S4.6, so until S4.6 the test for "every operation lists 400 and 429" is unchanged and a new test is added there. This keeps S4.1 from touching the OpenAPI customizer.
- **Test support** in `common-security`'s test sources, exposed as a `test-jar`: **`TestKeys`** (a fixed RSA key pair, 2048 bit, PEM files under `src/test/resources`) and **`TestJwt`**, a builder: `TestJwt.forUser(uuid).team(teamId, "deployment:create", ...).perm("x").expiresIn(Duration)....sign()` with a method per defect for the red tests (`wrongKey()`, `expired()`, `notYetValid()`, `issuer("other")`, `audience("other")`, `hs256WithPublicKeyAsSecret()`, `algNone()`).

## 6. Tests

### 6.1 The cost of turning it on (the red run)

Before any test is changed: with `SecurityConfig` in place and no token anywhere, run `mvn verify`. **Expect a large share of the 222 tests to fail with 401.** Record the count and the classes: this is the measure of how much of the suite was written against an open API, and it is the reason decision 13 exists. Then:

- A **`@TestConfiguration`** in `WebIntegrationTest` (imported like `TestFixtures`) defines a `MockMvcBuilderCustomizer` that applies `defaultRequest(get("/").header("Authorization", "Bearer " + defaultToken))`. The default token is for a test user with every permission on a test team: the existing tests are about *behaviour*, not authorization, and must keep passing unchanged.
- `ProblemShapeTest` is a slice with no security configuration: confirm what it does with Spring Security on the classpath and the `SecurityConfig` not scanned. If it now answers 401 or 403, add `@AutoConfigureMockMvc(addFilters = false)` (it tests the advice, not the chain) and record it, as S3.6 recorded its `excludeFilters`.
- `TemporaryOpenChainTest` (real HTTP, random port) is **replaced** by the new chain test below; its cases that stay true (health open, other actuator endpoints closed, unknown path) are kept.

### 6.2 `JwtAuthenticationTest` (new, real HTTP or a `MockMvc` without the default header)

| # | Test | Asserts |
|---|---|---|
| 1 | `noToken_is401_withProblemShape` | 401, `application/problem+json`, `type` `unauthorized`, `correlationId` present and equal to the `X-Correlation-Id` header, `WWW-Authenticate: Bearer` with **no** `error` |
| 2 | `validToken_passes` | 200 on `GET /api/v1/applications` |
| 3 | `wrongKey_is401_invalidToken` | signed with another key; `WWW-Authenticate` contains `invalid_token` |
| 4 | `expired_is401` | `exp` 1 hour ago (beyond the skew) |
| 5 | `withinClockSkew_passes` | `exp` 30 s ago passes, 90 s ago does not: pins the 60 s decision |
| 6 | `notYetValid_is401` | `nbf` 1 hour ahead |
| 7 | `wrongIssuer_is401`, `wrongAudience_is401` | |
| 8 | `algNone_is401` | an unsigned token with a valid-looking payload |
| 9 | `hs256SignedWithThePublicKey_is401` | the algorithm-confusion attack of decision 3 |
| 10 | `tamperedPayload_is401` | a valid token with one payload character changed |
| 11 | `basicScheme_is401_withoutError` | `Authorization: Basic ...` |
| 12 | `malformedToken_is401` | `Bearer not-a-jwt` |
| 13 | `detailNeverNamesTheFailure` | the bodies of tests 3, 4, 7 and 12 have identical `detail`; the header differs only in being `invalid_token` |
| 14 | `twoAuthorizationHeaders` | records what Spring does (records, does not assume) |
| 15 | `healthAndInfoAreOpen_otherActuatorDenied` | 200 on the two, 401 or 403 on `/actuator/env` |
| 16 | `docsPathsAreOpen` | `/v3/api-docs`, `/swagger-ui/index.html` 200 with no token |
| 17 | `unknownPath_isDenied` | `/some/other/path`: 401 with no token, 403 with a valid one |
| 18 | `tokenWithNoPermissions_authenticates` | a valid token with empty `teams` and no `perms`: 200 on a GET (no authority check exists until S4.3), proving authentication and authorization are separate |
| 19 | `forbidden_hasProblemShape` | a throwaway test-only endpoint protected with `hasAuthority('nobody:has:this')`: 403, `type` `forbidden`, `correlationId` |

### 6.3 `common-security` unit tests

- **`AppfleetJwtAuthenticationConverterTest`:** `perms` and `teams` flatten to the right authorities with no prefix; a missing claim gives none; a claim of the wrong type gives none and logs; duplicates collapse.
- **`JwtPropertiesTest`:** a missing issuer or key location fails the context; a non-RSA key fails with a clear message.
- **A repository check:** no `PRIVATE KEY` under any `src/main/resources`.

### 6.4 In control-api

- A test that the slugs in `common-security`'s handlers equal `ProblemKind.UNAUTHORIZED.slug()` and `FORBIDDEN.slug()`.
- `ProblemShapeTest` rows for 401 and 403 are **not** possible in the slice (the chain is not there); the shape is pinned by tests 1 and 19 above, which is recorded in the shape-test doc so nobody looks for the rows.

## 7. Risks to check, not assume

- **`oauth2ResourceServer().authenticationEntryPoint(...)` versus `exceptionHandling()`:** Spring Security registers its own entry point for the bearer filter. If only one of the two places is set, a missing token and an invalid token can take different paths and produce different bodies. Test 13 is what catches it.
- **Boot 4 and `MockMvc` security:** `@AutoConfigureMockMvc` must apply the security filter (S3.2 observed that it does). Confirm with test 1 in `WebIntegrationTest`, not only over HTTP.
- **Two Jackson versions:** the entry point must use the Boot (Jackson 3) mapper; a Jackson 2 `ObjectMapper` on the classpath serialises `ProblemDetail` differently (the `properties` map, `type` as a URI). Test 1 asserts the exact field names.
- **The correlation id:** present only if `CorrelationIdFilter` runs before the security chain. `HIGHEST_PRECEDENCE` makes it so; test 1 would show a `null` otherwise.
- **`/error`:** an unauthenticated request that causes an error dispatch (a `sendError`) is checked again by the chain and answered 401 instead of the original status. The entry point writes the response directly, never `sendError`, to avoid it.
- **`denyAll()` for non-`/api` paths** now answers 401 to an anonymous caller (the chain asks for authentication first), where it answered 403 before. Test 17 pins the new behaviour.
- **Clock in tests:** `expired` and `notYetValid` are computed from the real clock with margins of an hour, so no test sleeps. The skew test (5) uses 30 s and 90 s, a 60 s margin on both sides; it must not run with a frozen `Clock` that the decoder does not share.
- **The catch-all advice swallows security exceptions** (found, not predicted). `@PreAuthorize` throws `AccessDeniedException` inside the controller call, so MVC sees it first. `ApiExceptionHandler`'s `@ExceptionHandler(Exception.class)` turned it into a **500** and `ProblemAccessDeniedHandler` never ran. Test 19 caught it. S4.3 depends on the fix (section 11, item 4).
- **`BearerTokenAuthenticationEntryPoint` leaks the reason in the header** (found, not predicted). For an `InvalidBearerTokenException` it writes `error_description="<message>"` and `error_uri`, so the `WWW-Authenticate` header named the failed check while the body did not. Decision 9 said the entry point wraps it; the implementation builds the header itself from the OAuth2 error code only (`Bearer` or `Bearer error="invalid_token"`).
- **Configuration that unit tests cannot see.** Three slips passed every `common-security` test and failed only in control-api: the `jwt` block indented under `spring:` (the property became `spring.security.jwt...`, the auto-configuration stayed off), a resource directory named ` META-INF` with a leading space (Spring never read `AutoConfiguration.imports`), and bean methods missing from the auto-configuration. The `registersAllBeans` and `autoConfigurationIsRegistered` tests now pin the last two; the first is pinned by every web test, which fails to start without the `JwtDecoder`.
- **Two copies of `dev-public.pem`** (control-api's `src/main` and `common-security`'s `src/test`). `DevKeyDriftTest` compares them ignoring line endings and checks that the shipped key is the public half of the key `TestJwt` signs with. It failed on a stray character, as designed.

## 8. Order of work: find it broken first

1. **`common-security` pieces and `TestKeys`/`TestJwt`, no chain yet.** Unit tests 6.3 green.
2. **The red run (6.1):** add `SecurityConfig`, delete `TemporaryOpenSecurityConfig`, run `mvn verify` with **no** test change. Record how many tests fail with 401 and in which classes.
3. Add the default token to `WebIntegrationTest` and adjust `ProblemShapeTest`. Back to 222 green, minus the replaced `TemporaryOpenChainTest`.
4. Write `JwtAuthenticationTest` in the order 1, 2, then the defect cases. **Each defect test is first run against a decoder without the corresponding validator** (no issuer check, no audience check, a decoder built with HS256 allowed) and must fail there: that is the proof that the test tests the validator. Record which ones were run red.
5. Test 13 (`detail` identical): first return the exception message in `detail`, see it fail, then remove it.
6. The 403 test (19) with its throwaway endpoint, in `src/test` only.
7. Manual check against the dev stack: sign a token with the private key, `curl` an endpoint with and without it. Results section. `mvn verify`.

## 9. Not in S4.1

- Any authorization decision on a real endpoint (S4.3 and S4.4).
- Replacing `SYSTEM_ACTOR`, `HeaderTeamResolver` and the idempotency key scope (S4.2).
- The `bearerAuth` scheme and the 401 and 403 responses in the OpenAPI document (S4.6).
- JWKS, `kid`, key rotation, the `jti` denylist, refresh (identity-service).
- Issuing a real token. The only issuer is `TestJwt` and a local script.
- A custom `AuthenticationManager`, opaque tokens or API keys.

## 10. Open questions (yours to decide)

1. **Audience.** Decision 4 requires `aud` to contain `appfleet` and defaults it. If you would rather have one audience per service (`control-api`, `task-service`), the token must list all of them, which changes the claim contract. Recommendation: one audience for the platform now.
2. **Where `TestKeys` lives.** A `test-jar` of `common-security` (the plan's recommendation) means control-api and identity-service depend on test classes of a library, which Maven allows with `<type>test-jar</type>`. The alternative is a small `common-security-testing` module. Recommendation: the `test-jar`, and move it if a third consumer appears.
3. **The 60 second skew** is the Spring default and is a clock-drift allowance. A tighter value is safer for 15 minute tokens and riskier with unsynchronised hosts. Recommendation: keep 60 s.
4. **Whether `/actuator/info` should stay open.** It exposes build information. Unchanged here; decide with the actuator question in S4's plan.

## 11. Results

**Closed 2026-10-03.** Every definition-of-done item is ticked; the closing items are listed under "Closing items" below.

**Numbers**

| Run | Result |
|---|---|
| `common-security` | 39 tests green (converter 5, decoder and properties 16, handlers 5 and 6, fixtures 4, no-private-key scan 1, key drift 2) |
| Red run (6.1): chain on, no token anywhere | 222 tests, **92 failed and 1 errored with 401** (about 42% of the suite). Failing classes: `DeploymentEndpointsTest` 24, `TaskHistoryEndpointsTest` 19, `ApplicationEndpointsTest` 13, `IdempotencyEndpointsTest` 12 + 1, `ApplicationPaginationTest` 9, `RateLimitEndpointsTest` 9, `IdempotencyRedisDownTest` 3, `TemporaryOpenChainTest` 3. The 130 that passed never reach the chain |
| With the default token (`TestAuth` customizer) | 6 failed: 3 in `IdempotencyRedisDownTest` (own `@AutoConfigureMockMvc`, needed `TestAuth` in its `@Import`) and 3 in the replaced `TemporaryOpenChainTest` |
| Final, control-api | **238 tests, 0 failures, 2 skipped** (222 - 7 old chain tests + 21 `JwtAuthenticationTest` + 2 slug tests). The 2 skipped predate S4.1 |

**What was recorded, not assumed**

- Two `Authorization` headers: Spring takes the **first**; a valid token first and a bad one second answers **200**. Test 14 prints it and asserts only "no 5xx".
- An unknown path outside `/api` answers 401 with no token and 403 with one (test 17).
- `ProblemShapeTest` needed no change.

**Deviations from the design**

- Decision 4: the timestamp check is `new JwtTimestampValidator(clockSkew)` with `clockSkew` bound from `JwtProperties` (default `60s`), not `JwtValidators.createDefault()`, so the property takes effect.
- Decision 9: the entry point does not wrap `BearerTokenAuthenticationEntryPoint` (see section 7, the header leak).
- `ApiExceptionHandler` rethrows `AccessDeniedException` and `AuthenticationException` so the filter chain's handlers answer (section 7).
- `ProblemKind` gained `UNAUTHORIZED` and `FORBIDDEN`; their `components.responses` appear automatically, the operations list them in S4.6. `SecurityProblemSlugTest` pins the two handler constants to the enum.
- Jackson: `common-security` and the handlers use the Jackson 3 `tools.jackson.databind.json.JsonMapper`. `common-events` still brings Jackson 2 onto the classpath; no `common-security` code imports it.
- Tests use real HTTP on a random port (as the old chain test did), because a `MockMvc` default `Authorization` header cannot be removed per request.

**Closing items**

1. **Defect tests seen red: done 2026-10-03,** on a scratch copy of `common-security` (the real sources untouched), one mutation at a time, each run against a clean baseline (16 and 6 tests green):

   | Mutation | Tests that turned red |
   |---|---|
   | no issuer validator | `wrongIssuer_rejected` |
   | no audience validator | `wrongAudience_rejected` |
   | no timestamp validator | `expired_rejected`, `notYetValid_rejected`, `clockSkew_30sPasses_90sFails` |
   | HS256 allowed, secret = the public key bytes (`withSecretKey` + `MacAlgorithm.HS256`) | `hs256WithPublicKey_rejected`, plus `validToken_decodes` and `clockSkew_...` (the RS256 tokens no longer verify) |
   | entry point `detail` = `ex.getMessage()` | `detailNeverNamesTheFailure` |
   | header from `BearerTokenAuthenticationEntryPoint` | `invalidToken_headerHasNoDescription` and `noToken_is401_withProblemShape_andBareBearerChallenge` |

   A first attempt gave wrong numbers because a mutation leaked into the next run (each case must start from the real source, not from the scratch file's last state). **Not red-able by removing our code:** `alg: none`, a tampered payload and a wrong key are rejected by Nimbus itself (an unsigned token is never accepted, and the signature is always checked); those tests pin library behaviour, not a validator of ours.
2. **Manual check: done 2026-10-03,** against the built jar (`java -Duser.timezone=UTC -jar`, profile `local`, Postgres on 55432 and Redis from `docker compose`), tokens signed with `openssl dgst -sha256 -sign` and the test private key:

   | Request to `GET /api/v1/applications` | Answer |
   |---|---|
   | no `Authorization` | **401**, `application/problem+json`, `type` `unauthorized`, `correlationId`, `WWW-Authenticate: Bearer` |
   | valid token | **200**, the seeded applications |
   | expired token | **401**, `WWW-Authenticate: Bearer error="invalid_token"`, same body and `detail` |
   | wrong audience | **401**, same |
   | tampered payload | **401**, same |
   | `Basic` scheme | **401**, `WWW-Authenticate: Bearer` (no `error`) |
   | `/actuator/health`, `/v3/api-docs` without a token | **200** |
   | `/actuator/env` without a token | **401** |

   Kafka was not running and the app started and answered anyway.
3. **`mvn verify` green: done 2026-10-03** for `common-security` and control-api (238 tests, 0 failures, 2 skipped).
4. **S4.3 inherits the advice rethrow:** the meta-test that a protected endpoint answers 403 must run through the real chain, not only `MockMvc` slices.

## Definition of done

- [x] `common-security` has the decoder, converter, entry point, access-denied handler, properties and auto-configuration, with unit tests
- [x] `TemporaryOpenSecurityConfig` deleted; `SecurityConfig` in place; no token gives 401 in the problem shape with the correlation id
- [x] The red run of section 6.1 recorded (92 failed and 1 errored of 222)
- [x] `JwtAuthenticationTest` tests 1 to 19 green; each defect test seen red against a decoder without its validator (section 11, item 1; `alg: none`, tamper and wrong key are library behaviour and not red-able)
- [x] The HS256-with-public-key and `alg: none` tokens rejected
- [x] `detail` does not name the failure, and its test was seen red
- [x] Every existing test green with the default token; `ProblemShapeTest` needed no change
- [x] No `PRIVATE KEY` in any `src/main/resources`
- [x] Manual check with a locally signed token
- [x] Results section written; the plan's S4.1 row updated
- [x] `mvn verify` green
