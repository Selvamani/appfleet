# control-api — S3.2: applications and releases endpoints

**Spec:** [01-CONTROL-API.md §S3](../../specs/project/01-CONTROL-API.md) — `POST /api/v1/applications` (201 + `Location`), `GET /api/v1/applications?cursor=&limit=`, `POST /api/v1/applications/{id}/releases`; *"Bean Validation on every request DTO; DTOs are records; MapStruct or hand mapping — never entities out of controllers."* · Slice **S3.2** of [control-api-s3-rest.md](control-api-s3-rest.md)

Companion: [control-api-s3-1-foundations.md](control-api-s3-1-foundations.md) (the error shape, the advice, the correlation filter and the temporary open security chain this step stands on), [control-api-s3-rest.md](control-api-s3-rest.md) (sections 3.3 to 3.5 fix the layout, the DTO rule and the cursor design). **Status: implemented 2026-09-30; closed and revalidated 2026-10-02. Results in section 10.**

These are the first real endpoints. They are plain create-and-list on two simple entities with no state machine, so they exercise the whole stack (JSON, validation, `Location`, conflicts, cursor) on the easy case before deployments add state.

## 1. What already exists

- Entities `Application(name, description, ownerTeamId)` and `Release(application, version, artifactRef, checksum)`, repositories `ApplicationRepository` and `ReleaseRepository`.
- Database constraints that decide the conflict cases: `uq_application_name` (unique name) and `uq_release_app_version` (unique application and version). Both are already in the error handler's whitelist, and their real names were confirmed against Postgres.
- The error advice, so nothing here writes its own error handling.
- `TemporaryOpenSecurityConfig`: `/api/**` is open until S4.

What does not exist: any service class for applications, any DTO, any controller, and a handler for `HandlerMethodValidationException` (section 5).

## 2. Endpoints

| Method and path | Success | Errors |
|---|---|---|
| `POST /api/v1/applications` | 201, `Location: /api/v1/applications/{id}`, body `ApplicationResponse` | 400 validation, 409 duplicate name |
| `GET /api/v1/applications/{id}` | 200 `ApplicationResponse` | 400 malformed id, 404 |
| `GET /api/v1/applications?cursor=&limit=` | 200 `CursorPage<ApplicationResponse>` | 400 bad `limit` or `cursor` |
| `POST /api/v1/applications/{id}/releases` | 201, `Location: /api/v1/applications/{id}/releases/{releaseId}`, body `ReleaseResponse` | 400 validation or malformed id, 404 unknown application, 409 duplicate version |
| `GET /api/v1/applications/{id}/releases/{releaseId}` | 200 `ReleaseResponse` | 400 malformed id, 404 |

Two endpoints are **not** in the spec's list: the two `GET`-by-id. They are added because a `201` with a `Location` header that returns 404 is a broken contract (same reasoning as the task `Location` in the plan doc). Each is a few lines and reuses the same DTO. No list-releases endpoint: nothing in S3 needs it.

## 3. DTOs

Records in `io.appfleet.control.application.web`, with the response types owning a static factory (hand mapping, per the plan doc).

```java
public record CreateApplicationRequest(
        @NotBlank @Pattern(regexp = "[a-z0-9][a-z0-9-]{0,62}") String name,
        @Size(max = 1000) String description,
        @NotNull UUID ownerTeamId) {}

public record CreateReleaseRequest(
        @NotBlank @Size(max = 64) @Pattern(regexp = "[A-Za-z0-9][A-Za-z0-9._+-]*") String version,
        @NotBlank @Size(max = 512) String artifactRef,
        @NotBlank @Pattern(regexp = "sha256:[0-9a-f]{64}") String checksum) {}

public record ApplicationResponse(UUID id, String name, String description, UUID ownerTeamId, Instant createdAt) {
    static ApplicationResponse from(Application a) { ... }
}

public record ReleaseResponse(UUID id, UUID applicationId, String version, String artifactRef,
                              String checksum, Instant createdAt) {
    static ReleaseResponse from(Release r) { ... }
}
```

`CursorPage<T>` is generic and shared, so it lives in `io.appfleet.control.web`:

```java
public record CursorPage<T>(List<T> items, String nextCursor) {}
```

### 3.1 Validation rules, with the reasoning

These are decisions, not facts about the database (the columns are plain `text`), so each has a reason:

- **`name`: lowercase letters, digits and hyphens, 1 to 63 characters, must not start with a hyphen.** Names will become service, container and path identifiers later, and that character set is what those systems accept. **Loosening a rule later is safe. Tightening it once data exists is not**, so start strict.
- **`description`: optional, at most 1000.** `null` is allowed.
- **`ownerTeamId`: required.** The column is `NOT NULL`, and `Team` lives in identity-service after S4, so the only representation is a bare id. No existence check is possible (nothing to check against), and the doc for S4 already says it is "a reference by id, never a JPA relationship".
- **`version`: any reasonable tag, not strictly semver.** Semver would reject `2024-09-29` or `latest-candidate` for no benefit yet.
- **`checksum`: must be `sha256:` followed by 64 lowercase hex characters.** A checksum that cannot be verified is decoration. The agent will later verify artifacts (S5), and a format fixed now means it never has to guess the algorithm. The existing entity tests use the literal `"checksum"` but they build entities directly and never go through the API, so they are unaffected.
- **`artifactRef`: non-blank, at most 512.** No URI validation yet. The artifact store does not exist, and guessing its scheme now would be speculation.

All of these can be changed by editing annotations, and a wrong guess costs one line and a test row.

## 4. Service layer

New class `ApplicationService` in `io.appfleet.control.application` (a `@Service`, not under `..web`). It returns DTOs, so no entity leaves a transaction:

```java
@Transactional
public ApplicationResponse create(CreateApplicationRequest req)

@Transactional(readOnly = true)
public ApplicationResponse get(UUID id)                       // NotFoundException if absent

@Transactional(readOnly = true)
public CursorPage<ApplicationResponse> list(UUID afterId, int limit)

@Transactional
public ReleaseResponse createRelease(UUID applicationId, CreateReleaseRequest req)

@Transactional(readOnly = true)
public ReleaseResponse getRelease(UUID applicationId, UUID releaseId)
```

Design points:

- **No "does the name exist" pre-check.** A check-then-insert has a race: two concurrent requests both pass the check, and one fails on the constraint anyway. The **unique constraint is the truth**, and the advice already maps its violation to 409. Adding a pre-check would add a second code path that must agree with the first. The concurrent-create case is a test row (section 7).
- **Unknown application when creating a release:** `applicationRepository.findById(...).orElseThrow(() -> new NotFoundException("Application", id))`, which becomes 404.
- **`getRelease` checks the release belongs to the application in the path.** A release id that exists but belongs to another application returns 404, not the other application's data. Otherwise `/applications/A/releases/{id-of-B's-release}` leaks B's release. This is the small object-level check available before S4 exists.
- **Audit rows are not written here.** The S2 audit design was for deployments. Whether application creation is audited is a question for S4, when there is an actor.

### 4.1 `save` on an entity with an assigned id does a `merge`

Worth knowing while reading the SQL log: `Application` and `Release` get their id in the constructor (`Uuidv7.generate()`) and have no `@Version`. Spring Data's `save` decides "new or existing" by whether the id is null. Here it is never null, so `save` calls `merge`, which issues a `select` by id before the `insert`. That is a wasted query, not a bug. `Deployment` avoids it because it has a `@Version` wrapper that is `null` when new. Fixes exist (`Persistable`, or a `@Version` column) but are not S3.2's business. **Verify it in the SQL log** when the first endpoint runs, and note the observed statements.

## 5. Cursor pagination for `GET /applications`

Per the plan doc: opaque cursor, keyset on `id`, fetch `limit + 1`.

- **`CursorCodec`** in `io.appfleet.control.web`: `encode(UUID) -> String` (base64url of the UUID text, no padding) and `decode(String) -> UUID`. Any string that does not decode to a valid UUID throws a small `InvalidCursorException`.
- **Repository:** two derived methods, using Spring Data's `Limit` parameter:
  ```java
  List<Application> findAllByOrderByIdAsc(Limit limit);
  List<Application> findByIdGreaterThanOrderByIdAsc(UUID after, Limit limit);
  ```
  First page uses the first, later pages the second. The service calls with `Limit.of(limit + 1)`.
- **`nextCursor`:** if `limit + 1` rows come back, drop the extra one and encode the id of the last kept row. Otherwise `null`.
- **Postgres compares `uuid` bytewise,** which agrees with UUIDv7's time-first layout, so `order by id` is creation order.

One property to state honestly: `Uuidv7.generate()` puts a millisecond timestamp in the leading bits and **random bits after it**. Two rows created in the same millisecond therefore sort in random order relative to each other. It is still a total order (ids are unique), so paging is consistent: no row is returned twice and no existing row is skipped. What it does *not* guarantee is that a row created *during* a traversal appears in it. A new row can sort before the cursor and be missed by a client already past that point. That is normal keyset behaviour and acceptable here.

- **`limit`:** default 20, minimum 1, maximum 100. Out of range gives 400 `validation-failed` with `errors[0].field == "limit"`.
- **Bad cursor:** `InvalidCursorException` gives 400 `validation-failed` with `errors: [{field: "cursor", message: ...}]`. One 400 slug for all invalid input keeps the client's handling to one branch.

### 5.1 The new handler this step needs

`limit` is a `@RequestParam` with `@Min` and `@Max`. In Spring 6.1 and later, constraint annotations directly on controller parameters are enforced by built-in method validation, which throws **`HandlerMethodValidationException`**, a different exception from `MethodArgumentNotValidException` and from Jakarta's `ConstraintViolationException`. **No handler exists for it yet** (recorded as a known gap in the S3.1 results).

Add an override to `ApiExceptionHandler`, same pattern as the body-validation one: call `super`, then add an `errors` list built from the exception's validation results, with `field` the parameter name and `message` the constraint message. Slug `validation-failed`, status 400. **Confirm live** which exception `@Min` on a `@RequestParam` really throws by looking at the failing test's output before writing the handler, and confirm the parameter-name accessor on the result object in the installed Spring 7 API.

Do **not** put `@Validated` on the controller class. That switches enforcement back to the older AOP path (`ConstraintViolationException`), and the two mechanisms should not both be in play. The existing `ConstraintViolationException` handler stays as a safety net for `@Validated` services.

## 6. Controller

`ApplicationController` in `io.appfleet.control.application.web`, `@RequestMapping("/api/v1/applications")`, thin: it validates (annotations), calls the service, builds the `Location`, and returns. It contains no repository access and no entity types.

- `Location` is a **relative path** built from the new id (`/api/v1/applications/{id}`). It is valid per the HTTP spec and does not depend on `Host` or forwarded headers, which would matter behind a proxy.
- `@PathVariable UUID id`: a non-UUID gives a `MethodArgumentTypeMismatchException`, which the base class already turns into 400. It gets a test row rather than new code.
- Request bodies use `@Valid @RequestBody`. Body failures go to the existing `handleMethodArgumentNotValid` override, which already produces the `errors` list.

## 7. Tests

**Style.** Endpoint tests use `@SpringBootTest` plus `@AutoConfigureMockMvc` (from `org.springframework.boot.webmvc.test.autoconfigure`, see the S3.1 doc) with Testcontainers Postgres. This runs the **real security chain, real advice and real database**, unlike the slice tests. **Confirm as the first step that MockMvc applies the security filter chain here.** Do it with a fail-first check: with `TemporaryOpenSecurityConfig` disabled, a request should come back 401. If MockMvc bypasses the chain, use the real-server `HttpClient` approach from `TemporaryOpenChainTest` instead.

Test class `ApplicationEndpointsTest`. Cases:

| # | Case | Expected |
|---|---|---|
| 1 | valid `POST /applications` | 201, `Location` header, body with `id`, `createdAt` |
| 2 | follow the `Location` from case 1 | 200, same body |
| 3 | duplicate name | 409, `type` `conflict`, `detail` from the whitelist map |
| 4 | blank name, uppercase name, missing `ownerTeamId` in one body | 400 `validation-failed`, `errors` contains **all** the offending fields, not just the first |
| 5 | malformed JSON | 400 `malformed-request` |
| 6 | `GET /applications/not-a-uuid` | 400 `malformed-request` |
| 7 | `GET /applications/{unknown uuid}` | 404 `not-found` |
| 8 | `POST` release for an unknown application | 404 |
| 9 | valid release, then `Location` resolves | 201, then 200 |
| 10 | duplicate `(application, version)` | 409 `conflict` |
| 11 | bad checksum (`"abc"`) | 400 with `errors[].field == "checksum"` |
| 12 | release id of application B requested under application A | 404 |
| 13 | two concurrent `POST /applications` with the same name | exactly one 201 and one 409, never a 500 |

Row 13 is the one that justifies "no pre-check": it uses two threads and a barrier as in the optimistic-lock test, and it fails with a 500 if the constraint violation is not translated the way the advice expects at commit time.

**Pagination class `ApplicationPaginationTest`,** separate, because listing depends on everything in the table:

- `@BeforeEach` deletes releases then applications (foreign key order), so each test starts empty.
- 5 applications, `limit=2`: three pages of 2, 2 and 1 items, `nextCursor` null on the last, the concatenated ids are unique and strictly ascending, and equal all 5 created ids.
- Empty table: `items: []` and `nextCursor: null`, still 200.
- `limit=0`, `limit=101` and `limit=abc`: 400 with the `limit` field in `errors`.
- Garbage cursor (`"???"`, and a valid base64 that is not a UUID): 400 with the `cursor` field.
- A row inserted between page 1 and page 2, with a larger id than the cursor: **no duplicate and no skipped pre-existing row**. Assert only those two properties, because whether the new row appears depends on the same-millisecond ordering described above.

**Unit tests `CursorCodecTest`:** round trip, and rejection of blank, non-base64 and non-UUID input.

## 8. Order of work: find it broken first

1. Confirm MockMvc applies the security chain (the fail-first check above).
2. Write `ApplicationEndpointsTest` cases 1 and 2 with no controller. Run: 404, or 401. Record it.
3. `ApplicationService`, DTOs and `ApplicationController` create and get. Cases 1 to 7 green. Look at the SQL log for the `merge` `select` from 4.1.
4. Releases, cases 8 to 12.
5. Case 13, the concurrent create. It is expected to pass, but it is the assumption that carries the "no pre-check" decision.
6. `CursorCodec`, `InvalidCursorException`, the two repository methods, the `HandlerMethodValidationException` handler (test first: `limit=0` should fail with an unhandled or wrongly shaped response before the handler exists).
7. `ApplicationPaginationTest`.
8. Record results in a Results section here.

## 9. Not in S3.2

- Update and delete of applications or releases. Nothing in the spec asks for them.
- Team existence validation (identity-service, S4).
- OpenAPI annotations (S3.7).
- Rate limiting and idempotency keys (S3.5 and S3.6). `POST /applications` gets no `Idempotency-Key`: the spec puts it on `POST /deployments`, and the unique name already makes a retry safe (the second attempt gets a 409, not a duplicate).

## 10. Results

This section was written when S3.2 was closed, two days after the code was finished. Everything under "Revalidated" was re-run on 2026-10-02 against the current code; everything under "Recorded at the time" comes from the S3.2 session itself and was not repeated.

### 10.1 Revalidated (2026-10-02)

- **Tests:** `ApplicationEndpointsTest` 13 of 13 (including `concurrentCreate_sameName_oneCreated_oneConflict`), `ApplicationPaginationTest` 9 of 9 (including `insertBetweenPages_noDuplicate_noSkip`, `invalidLimit_returns400` for `0`, `101` and `abc`, `limitZero_returns400_withLimitField`, `garbageCursor_returns400`), `CursorCodecTest` 2 of 2. Full suite `mvn verify`: 188 tests, 2 skipped by design (it was 121 when S3.2 finished; later steps added the rest).
- **MockMvc runs the real security chain.** With `org.springframework.security.web.FilterChainProxy` at `DEBUG`, the three classes logged 66 `Securing GET|POST /api/v1/applications…` lines, for example `Securing POST /api/v1/applications` followed by `Secured POST /api/v1/applications`. Every MockMvc request passes through Spring Security's filter chain, so the `HttpClient` fallback of section 7 was not needed.
- **The `merge` `select` from section 4.1**, in the SQL log, under one request's correlation id: `select a1_0.id,… from control.application a1_0 where a1_0.id=?`, then `insert into control.application …`. `Application` has an assigned UUID and no `@Version`, so `save` merges.
- **Code state:**
  - `ApiExceptionHandler` overrides `handleHandlerMethodValidationException` and `handleTypeMismatch` and handles `InvalidCursorException`.
  - `Application` and `Release` truncate `createdAt` to microseconds.
  - `Location` is built as `"/api/v1/applications/" + id` and `"/api/v1/applications/" + id + "/releases/" + releaseId`.
  - `ApplicationController` now lives in `io.appfleet.control.application.web` (moved during S3.3; it was in the parent package when S3.2 finished).

### 10.2 Recorded at the time (2026-09-30, not repeated)

- The fail-first security check of section 8 step 1: with `TemporaryOpenSecurityConfig` disabled, a MockMvc request returned 401.
- Bugs the tests caught while writing the code:

  | What | Cause |
  |---|---|
  | `Location` header missing a slash | String concatenation without `/` before the id |
  | `GET` by id unreachable | `@GetMapping` without `/{id}` |
  | `createdAt` in the 201 body differed from the later `GET` | 100 ns precision in memory against microseconds in Postgres; fixed with `truncatedTo(ChronoUnit.MICROS)` in the constructors (S3.3 applied the same fix to `Task` and `Deployment.transitionTo`) |

- `TypeMismatchException` handling changed `/applications/not-a-uuid` from `malformed-request` to `validation-failed` with `errors[].field == "id"`.
- The `limit` test failing before the `HandlerMethodValidationException` handler existed: recorded then; it cannot be re-observed now that the handler exists.

### 10.3 Found while closing, and fixed (2026-10-02)

- **`CursorCodecTest.decode` asserted nothing.** It read `assertThat(CursorCodec.decode(CursorCodec.encode(id)).equals(id));`: `assertThat(boolean)` without `.isTrue()` passes whatever the boolean is, so the round trip was untested at unit level. The endpoint tests (`fiveApps_limit2_threePages`) exercised it, which is why nothing broke. Fixed with `.isTrue()`.
- **`CursorCodecTest` did not test "valid base64, not a UUID"** (section 7 asked for it). Added `decodeFail_validBase64ButNotACanonicalUuid`: base64url of `not-a-uuid`, and of `1-1-1-1-1`. The second matters: Java 25's `UUID.fromString` accepts it (as `00000001-0001-0001-0001-000000000001`, checked in `jshell`), so only the codec's canonical-form comparison rejects it, and this test is what covers that branch.
- **`ApplicationEndpointsTest`'s concurrent test used Hamcrest `MatcherAssert.assertThat`.** Replaced with AssertJ, `assertThat(statuses).containsExactlyInAnyOrder(201, 409)`, per the project convention (AssertJ for assertions, Hamcrest only inside MockMvc matchers).
- **`@GetMapping("{id}/releases/{releaseId}")` had no leading slash.** It worked (Spring joins it to the class-level mapping) but was the only mapping without one. Fixed.

After the fixes: `CursorCodecTest` 3 tests, `mvn verify` 189 tests, 2 skipped by design, green.

### 10.4 Changed by later steps

- **`ApplicationPaginationTest` cleanup** was changed in S3.3 from `deleteAllInBatch` to `TRUNCATE application CASCADE`, because the shared test database now holds deployments that reference releases.

## Definition of done

- [x] Section 8, step 1: MockMvc applies the real security chain (401 recorded at the time; the chain confirmed again in the security debug log, section 10.1)
- [x] `ApplicationService`, DTOs, `ApplicationController` (five endpoints) implemented
- [x] `ApplicationEndpointsTest` cases 1 to 13 green, including the concurrent create
- [x] `HandlerMethodValidationException` handler added, proven by a failing-then-passing `limit` test (failing state recorded at the time only)
- [x] `CursorCodec` and `CursorCodecTest` (round-trip assertion and the non-UUID case fixed while closing, section 10.3)
- [x] `ApplicationPaginationTest` green, including the insert-between-pages case
- [x] The `merge` `select` from `save` observed in the SQL log and recorded in a Results section
- [x] `mvn verify` green
