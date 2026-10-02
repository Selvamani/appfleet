# control-api — S3.5: idempotency keys

**Spec:** [01-CONTROL-API.md §S3](../../specs/project/01-CONTROL-API.md) — *"Idempotency keys in Redis: `SET NX` with TTL; same key → the original response replayed; in-flight duplicate → 409. Test: two concurrent identical POSTs, exactly one deployment"* · Slice **S3.5** of [control-api-s3-rest.md](control-api-s3-rest.md)

Companion: [control-api-s3-3-deployments.md](control-api-s3-3-deployments.md) (`POST /deployments`, written "to be wrapped" by this step; the partial index and its 409), [control-api-s3-1-foundations.md](control-api-s3-1-foundations.md) (problem types, the shape test, the log-injection rule for header values), [control-api-s3-rest.md](control-api-s3-rest.md) §3.2 (`request-in-progress`). The header semantics follow the IETF draft *The Idempotency-Key HTTP Header Field* (draft-ietf-httpapi-idempotency-key-header). **Status: implemented 2026-10-02, `mvn verify` green (188 tests, 2 skipped by design). Results in section 11.**

This is the first step that uses Redis for real, and the first with two stores that cannot commit together: Postgres holds the deployment, Redis holds the record of the request. Most of the design below is about what happens when those two disagree.

## 1. What already exists

- `spring-boot-starter-data-redis` (Lettuce 7.5) in `control-api/pom.xml`. `spring.data.redis.host`/`port` in `application.yml`, `spring.data.redis.repositories.enabled: false` (S3.1). Redis 7 in `docker-compose.yml`.
- **No Redis Testcontainer.** `WebIntegrationTest` and `TemporaryOpenChainTest` set `management.health.redis.enabled=false` because tests had no Redis.
- **Two Jackson versions on the classpath:** Jackson 3 (`tools.jackson.databind`, used by Boot 4's web stack, and pulled by Flyway) and Jackson 2 (`com.fasterxml.jackson.databind`, from `common-events`). New code uses the Boot-configured Jackson 3 `JsonMapper`. Confirm which mapper bean the context exposes before writing code; do not assume.
- `POST /deployments` (S3.3): one transaction creates the deployment, a `DEPLOY` task and an audit row; the partial index `uq_deployment_active_per_app_env` turns a second active deployment into 409 `conflict`.
- The advice maps unknown exceptions to 500. Nothing maps Redis failures yet.

## 2. Why idempotency, when the partial index already blocks duplicates

S3.3's case 15 already shows that two concurrent identical `POST /deployments` produce one 202 and one 409. So what does a key add? Two things the index cannot give:

1. **A retry learns that it succeeded.** A client whose first request timed out after the server committed retries and gets 409 `conflict`. It cannot tell "my request worked" from "someone else's deployment is active". With a key, the retry gets the original 202, with the same `deploymentId` and `taskId`.
2. **A late retry cannot create a second deployment.** The index only covers *active* deployments. If the first deployment has already moved to `FAILED` when the retry arrives, the index allows a new one, and the retry deploys again. With a key, the retry replays the original response and creates nothing.

Case 3 in section 7 is built on the second point: it fails today and passes once this step is done.

## 3. Behaviour

| Request | Result |
|---|---|
| No `Idempotency-Key` header | Exactly as S3.3. Redis is not touched |
| Key never seen | Executes. 202, `Idempotent-Replayed: false` |
| Key seen, same body, first request finished with 202 | **Replay:** 202, same body, same `Location`, `Idempotent-Replayed: true`. Nothing executes |
| Key seen, same body, first request still running | 409 `request-in-progress`, `Retry-After: 1` |
| Key seen, **different** body | 422 `idempotency-key-reused` |
| Key seen, first request failed (any error) | Executes again, as if the key were new |
| Key malformed | 400 `validation-failed`, `errors[].field == "Idempotency-Key"` |
| Key present and Redis unreachable | 503 `service-unavailable`, `Retry-After: 5` |

## 4. Decisions

1. **The header is optional.** Without it the endpoint behaves as in S3.3. Making it mandatory would break every existing client and test for a guarantee the partial index already half-provides. The IETF draft allows either.
2. **Key format: 1 to 255 printable ASCII characters** (`[\x21-\x7E]{1,255}`). The key is logged on the failure path, so the S3.1 log-injection rule applies: no spaces, no control characters. UUIDs are recommended to clients, not required.
3. **Validate the key by hand, not with `@Pattern` on the `@RequestHeader` parameter.** In Spring 6.1 and later, a constraint annotation directly on a controller parameter turns on method validation for the whole method. Then the `@Valid @RequestBody` errors are expected to arrive as `HandlerMethodValidationException` instead of `MethodArgumentNotValidException`, and the existing handler would report the field as `request` instead of `applicationId`, `releaseId`, `environment`. S3.3 case 6 (`errors.length() == 3`, per-field names) would catch it. **Confirm this once on purpose** (section 9, step 9), then keep the hand validation: a small `IdempotencyKeys.validate(String)` throwing `InvalidIdempotencyKeyException`, mapped like `InvalidCursorException` to 400 `validation-failed` with field `Idempotency-Key`.
4. **Replay only successes.** The record is completed only when the action returns normally. On any exception (422 unknown application, 409 `conflict`, 500) the claim is released, so a retry executes again and gets the then-current answer. Storing errors would replay a stale 422 after the client fixed the problem (for example created the missing environment). This follows Stripe's rule: errors from validation or conflicts are not saved.
5. **Same key, different body is 422 `idempotency-key-reused`,** a new problem type. The IETF draft specifies 422 for this. A distinct `type` is needed because 422 `unprocessable` already means "unknown application or release" and the client must handle the two differently.
6. **The fingerprint is SHA-256 over the JSON of the validated request record,** not over the raw body. Records serialise their components in declaration order, so whitespace and field order in the client's JSON do not matter, and two bodies that mean the same request match.
7. **Redis key: `idempotency:v1:deployments:<key>`.** `v1` allows the record format to change without misreading old records. The key is **not** scoped to a caller, because there is no caller identity until S4. Recorded for S4: without a principal in the Redis key, client B sending client A's key would receive A's response. S4 must make it `idempotency:v1:<team>:deployments:<key>`.
8. **Three Lua scripts, one round trip each, all atomic:**
   - **claim:** `SET key inProgress NX PX 30000`; if that fails, return the existing value. Claim and read happen in one script, so the record cannot expire between them.
   - **complete:** replace the value with the completed record (TTL 24 h) **only if** the current value is still this request's in-progress record.
   - **release:** delete the key **only if** the current value is still this request's in-progress record.

   The in-progress record carries a random `owner` token, so "still this request's record" is an exact string comparison. Without the owner check, a slow request whose claim had expired could overwrite or delete a newer request's claim. Redis 7 also offers `SET ... NX GET` as a single command for the claim; Lua is used because the other two operations need a script anyway, and S3.6's token bucket is Lua too.
9. **TTLs: 30 s in progress, 24 h completed.** The in-progress TTL must be longer than the slowest real request; a POST that runs longer than 30 s loses its claim, and a retry could execute in parallel (the partial index is then the backstop). The longer it is, the longer a client is blocked with 409 after a server crash. 24 h for completed records is Stripe's figure and covers any sensible client retry policy.
10. **The record is completed after the database commit.** `IdempotencyExecutor` runs in the controller, outside `DeploymentService`'s `@Transactional`. If it were inside the transaction, a commit failure after the completion write would leave Redis replaying a response for a deployment that does not exist. **Do not put `@Transactional` on the executor or the controller.**
11. **If the completion write fails, still return 202 and log a warning.** The deployment is committed; reporting failure would be a lie, and the client's retry would then hit the stale in-progress record (409) until it expires. The cost is recorded as a gap (section 6).
12. **Redis unreachable with a key present: fail closed, 503.** The client asked for a guarantee the server cannot give right now; silently processing without it could create the duplicate the client was guarding against. Requests without a key never touch Redis and are unaffected.
13. **Short Redis timeouts.** Lettuce's default command timeout is 60 s, so an unreachable Redis would hang keyed requests for a minute before the 503. Set `spring.data.redis.timeout: 2s` and `spring.data.redis.connect-timeout: 1s` in `application.yml`.
14. **Replay returns the original response, not current state.** A replayed 202 says `status: PENDING` even if the deployment is `HEALTHY` by then. That is the contract: the client asked "what was the answer to my request", and `GET /deployments/{id}` exists for current state.
15. **Scope: `POST /deployments` only.** Rollback is already protected by the open-rollback check and the force-increment lock (S3.3), and a retried rollback gets a clear 409 `conflict`. Adding keys to rollback is a later, separate decision.

## 5. Design

### 5.1 Package and types

`io.appfleet.control.idempotency`, with no Spring MVC types (plan doc §3.3):

| Type | Role |
|---|---|
| `IdempotencyRecord(State state, String owner, String fingerprint, String response)` | What is stored. `inProgress(owner, fingerprint)` and `completed(fingerprint, responseJson)` factories |
| `IdempotencyStore` | Redis access, the three Lua scripts. Knows nothing about deployments |
| `IdempotencyExecutor` | The algorithm: fingerprint, claim, run, complete or release |
| `Idempotent<T>(T value, boolean replayed)` | Result handed back to the controller |
| `IdempotencyKeys` | Key validation |
| `RequestInProgressException`, `IdempotencyKeyReusedException`, `InvalidIdempotencyKeyException` | Mapped by the advice |

### 5.2 `IdempotencyStore`

```java
@Component
public class IdempotencyStore {

    private static final String PREFIX = "idempotency:v1:";

    private static final RedisScript<String> CLAIM = RedisScript.of("""
            if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then
                return nil
            end
            return redis.call('GET', KEYS[1])
            """, String.class);

    private static final RedisScript<Long> COMPLETE = RedisScript.of("""
            if redis.call('GET', KEYS[1]) == ARGV[1] then
                redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])
                return 1
            end
            return 0
            """, Long.class);

    private static final RedisScript<Long> RELEASE = RedisScript.of("""
            if redis.call('GET', KEYS[1]) == ARGV[1] then
                return redis.call('DEL', KEYS[1])
            end
            return 0
            """, Long.class);

    private final StringRedisTemplate redis;

    public IdempotencyStore(StringRedisTemplate redis) {
        this.redis = redis;
    }

    /** Returns null if this call claimed the key, otherwise the record already stored. */
    public String claim(String key, String inProgressJson, Duration ttl) {
        return redis.execute(CLAIM, List.of(PREFIX + key), inProgressJson, String.valueOf(ttl.toMillis()));
    }

    public boolean complete(String key, String inProgressJson, String completedJson, Duration ttl) {
        return Long.valueOf(1).equals(redis.execute(COMPLETE, List.of(PREFIX + key),
                inProgressJson, completedJson, String.valueOf(ttl.toMillis())));
    }

    public void release(String key, String inProgressJson) {
        redis.execute(RELEASE, List.of(PREFIX + key), inProgressJson);
    }
}
```

The store passes JSON strings through and does not parse them, so it has no Jackson dependency. The executor owns the format.

### 5.3 `IdempotencyExecutor`

```java
@Component
public class IdempotencyExecutor {

    private static final Logger log = LoggerFactory.getLogger(IdempotencyExecutor.class);
    static final Duration IN_PROGRESS_TTL = Duration.ofSeconds(30);
    static final Duration COMPLETED_TTL = Duration.ofHours(24);

    private final IdempotencyStore store;
    private final JsonMapper json;

    // constructor

    public <T> Idempotent<T> execute(String key, Object request, Class<T> responseType, Supplier<T> action) {
        String fingerprint = fingerprint(request);
        String inProgress = json.writeValueAsString(IdempotencyRecord.inProgress(UUID.randomUUID().toString(), fingerprint));

        String existing = store.claim(key, inProgress, IN_PROGRESS_TTL);
        if (existing != null) {
            IdempotencyRecord record = json.readValue(existing, IdempotencyRecord.class);
            if (!record.fingerprint().equals(fingerprint)) {
                throw new IdempotencyKeyReusedException();
            }
            if (record.state() == IdempotencyRecord.State.IN_PROGRESS) {
                throw new RequestInProgressException();
            }
            return new Idempotent<>(json.readValue(record.response(), responseType), true);
        }

        T result;
        try {
            result = action.get();
        } catch (RuntimeException e) {
            store.release(key, inProgress);
            throw e;
        }

        try {
            String completed = json.writeValueAsString(IdempotencyRecord.completed(fingerprint, json.writeValueAsString(result)));
            if (!store.complete(key, inProgress, completed, COMPLETED_TTL)) {
                log.warn("Idempotency claim for key {} expired before completion; the work is committed", key);
            }
        } catch (RuntimeException e) {
            log.warn("Could not complete idempotency record for key {}; the work is committed", key, e);
        }
        return new Idempotent<>(result, false);
    }

    private String fingerprint(Object request) {
        byte[] bytes = json.writeValueAsBytes(request);
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);   // SHA-256 is mandatory on every JVM
        }
    }
}
```

- Jackson 3's `JacksonException` is unchecked, so no `try`/`catch` around `readValue`. Confirm on the installed version.
- The key is safe to log because `IdempotencyKeys.validate` ran first (decision 2).
- A Redis failure in `claim` propagates as Spring's `RedisConnectionFailureException` (or another `DataAccessException` subtype from Lettuce). The advice maps it to 503. **Check the actual exception type** in the Redis-down test before writing the handler.
- `JsonMapper` injection: Boot 4 auto-configures a Jackson 3 `JsonMapper` bean. If the context fails with "no bean of type `JsonMapper`", inject `tools.jackson.databind.ObjectMapper` instead. Confirm on the first run.

#### 5.3.1 How `execute` works, step by step

The executor wraps one action (here `service.requestDeployment`) so that for a given key the action runs **at most once successfully**, and every later request with that key gets the same answer. It knows nothing about deployments: it receives a key, a request object (for the fingerprint), a response type and a `Supplier`.

1. **Fingerprint.** The validated request record is serialised to JSON and hashed with SHA-256. Two requests mean the same thing exactly when their fingerprints are equal. Whitespace and field order in the client's JSON do not matter, because the record is hashed, not the raw body.
2. **Build the claim.** An `IN_PROGRESS` record with a fresh random `owner` is serialised **once**. That exact string (`inProgress`) is this request's identity in Redis: `complete` and `release` later compare against it byte for byte.
3. **Claim.** One Lua call does "set if absent, otherwise return what is there".
   - `null`: this request now owns the key for 30 s. Continue at step 5.
   - not `null`: the key was used before. Continue at step 4.
4. **Key already used.** Decide from the stored record, in this order:

   | Stored record | Result |
   |---|---|
   | different fingerprint | `IdempotencyKeyReusedException`, 422. Checked first, so a wrong body never gets "retry later" |
   | same fingerprint, `IN_PROGRESS` | `RequestInProgressException`, 409 with `Retry-After` |
   | same fingerprint, `COMPLETED` | Replay: rebuild `T` from the stored JSON, return it with `replayed = true` |

   Nothing executes on this path, and nothing is released, because this request never owned the key.
5. **Run the action.** `action.get()` does the real work, including `DeploymentService`'s transaction, which commits when the method returns. On any exception, `release` deletes the claim (only if it still holds this request's `inProgress` string) and the exception is rethrown unchanged, so the advice maps it (422, 409 `conflict`, 500). Releasing is what lets a retry execute again after a failure (decision 4); without it, retries get 409 for 30 s (section 9, step 6).
6. **Complete.** The database has committed by now. The `COMPLETED` record, carrying the response JSON, replaces the claim with a 24 h TTL, again only if the key still holds this request's `inProgress` string.
   - `complete` returns `false` if the claim expired (the request took longer than 30 s) or was replaced: logged, not thrown.
   - An exception (Redis failed just now) is logged, not thrown: the deployment exists, so the client must get its 202 (decision 11). The leftover claim expires within 30 s; that is the first gap in section 6.
7. **Return** the fresh result with `replayed = false`.

Why each mechanism exists:

| Mechanism | What it prevents |
|---|---|
| Claim and read in one Lua script | The record expiring between "set failed" and "read it" |
| `owner` inside the in-progress record | A slow request whose claim expired overwriting or deleting a newer request's claim |
| Serialising the in-progress record once | `complete` or `release` silently failing because re-serialised bytes differ (for example after a naming-strategy or `NON_NULL` change) |
| `release` on failure | A retry after an error being blocked for 30 s, or receiving a stale error |
| Completing after the action returns | Replaying a response for a transaction that then failed to commit. Holds only if the executor is **not** `@Transactional` |
| Logging, not throwing, when completion fails | Telling the client "failed" for work that is committed |

**Owner versus fingerprint: what is compared, and when.** A new `owner` UUID is generated on every `execute()` call, so two requests never share one, and they never need to. The two fields answer different questions:

- **`fingerprint` answers "is this the same request?", across requests.** A retry is a new `execute()` call with a new owner. Its `claim` fails because the key exists, and it decides only from the stored record's `fingerprint` and `state`. It never compares owners, and it never calls `complete` or `release`, because it owns nothing.
- **`owner` answers "is this claim still mine?", within one request.** `UUID.randomUUID()` runs once per call, and the serialised in-progress string is held in one local variable that is passed to `claim`, `complete` and `release`. Within that call the Lua comparison `GET(key) == ARGV[1]` is therefore true, unless someone else has replaced the value in the meantime.

| | Request A (first) | Request B (retry, same key) |
|---|---|---|
| owner | `aaaa…` | `bbbb…` (new) |
| claim | succeeds, stores `{IN_PROGRESS, owner: aaaa…}` | fails, receives A's record |
| decision | runs the action | compares **fingerprint** (equal), then **state**: `IN_PROGRESS` gives 409, `COMPLETED` gives a replay |
| complete or release | compares Redis's value with A's own string: equal, so it writes | never called |

The owner check only says "no" when A's claim was replaced while A was still running:

1. A claims the key but runs longer than 30 s; the claim expires.
2. C arrives with the same key; its claim **succeeds** and stores `{IN_PROGRESS, owner: cccc…}`.
3. A finishes and calls `complete`. Redis now holds C's string, not A's, so the comparison fails and A writes nothing. Without the owner, A would overwrite C's in-progress claim with a completed record while C is still running, and a failing A would delete C's claim through `release`.

**Pitfall caught in review:** the first version of the fingerprint check read `if (record.fingerprint().equals(fingerprint))`, without the `!`. That inverts both outcomes: a genuine retry (same body) gets 422, and a **different** body with a reused key receives the first request's response, a deployment the client never asked for. Cases 2 and 4 in section 7 each catch it. Record it in the Results section.

### 5.4 Controller

```java
@PostMapping
public ResponseEntity<DeploymentAccepted> requestDeployment(
        @Valid @RequestBody CreateDeploymentRequest request,
        @RequestHeader(name = "Idempotency-Key", required = false) String idempotencyKey) {
    Idempotent<DeploymentAccepted> outcome;
    if (idempotencyKey == null) {
        outcome = new Idempotent<>(service.requestDeployment(request, SYSTEM_ACTOR), false);
    } else {
        IdempotencyKeys.validate(idempotencyKey);
        outcome = idempotency.execute("deployments:" + idempotencyKey, request, DeploymentAccepted.class,
                () -> service.requestDeployment(request, SYSTEM_ACTOR));
    }
    DeploymentAccepted accepted = outcome.value();
    return ResponseEntity.accepted()
            .location(URI.create("/api/v1/tasks/" + accepted.taskId()))
            .header("Idempotent-Replayed", String.valueOf(outcome.replayed()))
            .body(accepted);
}
```

The response is rebuilt from the stored DTO, so `Location` is identical on replay without storing headers.

### 5.5 Advice

| Exception | Status | `type` slug | Extra |
|---|---|---|---|
| `InvalidIdempotencyKeyException` | 400 | `validation-failed` | `errors: [{field: "Idempotency-Key", ...}]` |
| `IdempotencyKeyReusedException` | 422 | `idempotency-key-reused` | fixed `detail` |
| `RequestInProgressException` | 409 | `request-in-progress` | `Retry-After: 1` |
| Redis connection failure (type confirmed in the test) | 503 | `service-unavailable` | `Retry-After: 5` |

Add the two new slugs to the plan doc's §3.2 matrix, and a row per new slug to `ProblemShapeTest` (S3.1's test-only controller can throw each exception).

## 6. Known gaps (Redis and Postgres do not commit together)

- **Completion write lost.** If the server crashes, or Redis fails, between the database commit and the completion write, the record stays in progress for up to 30 s. Retries get 409 during that time. After it expires, a retry executes again. The partial index then gives 409 `conflict` if the deployment is still active; if it has already reached `FAILED` or `ROLLED_BACK`, **a second deployment is created**. The only design without this gap stores the idempotency record in Postgres, in the same transaction as the deployment. Not taken because the spec asks for Redis and S3.6 builds on the same plumbing. This is the interview answer to "what does your idempotency not guarantee".
- **Redis loses data.** Records vanish on a Redis restart without persistence, or under an evicting `maxmemory-policy`. Production Redis for idempotency needs `noeviction` (or `volatile-*` with enough memory) and AOF. The compose Redis runs with defaults (`noeviction`, no AOF); recorded, not changed.
- **Slow requests outlive the claim** (decision 9).
- **Keys are not scoped to a caller** until S4 (decision 7).

## 7. Tests

### 7.1 Redis in `WebIntegrationTest`

```java
@ServiceConnection(name = "redis")
static final GenericContainer<?> redis = new GenericContainer<>("redis:7").withExposedPorts(6379);

static {
    Startables.deepStart(postgres, redis).join();   // both in parallel, once per JVM
}
```

Spring Boot recognises a `GenericContainer` as Redis through `@ServiceConnection(name = "redis")`. Drop `management.health.redis.enabled=false` from the base class now that Redis exists. `TemporaryOpenChainTest` keeps it: it has its own context without Redis. `GenericContainer` and `Startables` come from `org.testcontainers:testcontainers`, already on the test classpath.

### 7.2 `IdempotencyEndpointsTest extends WebIntegrationTest`

Fixtures as in `DeploymentEndpointsTest`. Each test uses a fresh random key, so Redis needs no cleanup between tests. Inspect Redis with an injected `StringRedisTemplate`.

| # | Case | Expected |
|---|---|---|
| 1 | POST with a new key | 202, `Idempotent-Replayed: false`; Redis record `COMPLETED`, TTL between 23 h and 24 h |
| 2 | same key, same body, again | 202, same `deploymentId`, `taskId` and `Location`, `Idempotent-Replayed: true`; database: one deployment, one task, one audit row |
| 3 | same key, after the first deployment was driven to `FAILED` | replay with the original ids; one deployment for that application and environment. Contrast in the same test: the same POST **without** a key now creates a second deployment (the index allows it) |
| 4 | same key, different body | 422 `idempotency-key-reused`; no deployment for the second body |
| 5 | a claim already in progress (created with `IdempotencyStore.claim` directly) | 409 `request-in-progress`, `Retry-After` present |
| 6 | two concurrent identical POSTs with one key (barrier, as S3.3 case 15) | exactly one deployment; statuses only from {202, 409 `request-in-progress`}; at most one 202 with `Idempotent-Replayed: false`; never 500 |
| 7 | key with unknown application | 422 `unprocessable`; Redis key absent afterwards; the same request again gives 422, not 409 |
| 8 | key, but an active deployment already exists (created without a key) | 409 `conflict`; Redis key absent afterwards |
| 9 | POST without a key | 202; no `idempotency:*` key created |
| 10 | key empty, 256 characters, containing a space | 400 `validation-failed`, field `Idempotency-Key` |
| 11 | after case 1, S3.3's `DeploymentEndpointsTest` case 6 still lists `applicationId`, `releaseId`, `environment` | unchanged (guards decision 3) |

### 7.3 `IdempotencyRedisDownTest`

Its own class, **not** extending the base: own Postgres container, no Redis container, `spring.data.redis.port` pointing at a closed port, `management.health.redis.enabled=false`.

| # | Case | Expected |
|---|---|---|
| 12 | POST with a key | 503 `service-unavailable`, `Retry-After`, in under 3 s |
| 13 | POST without a key | 202 |

## 8. Manual check against the dev stack

With `docker compose up -d postgres redis` and the app on profile `local`: send one keyed POST, then `docker exec appfleet-redis-1 redis-cli --scan --pattern 'idempotency:*'` and `redis-cli GET` / `PTTL` on the key. Confirms the record format and TTL outside Testcontainers. (Check the container name with `docker ps`.)

## 9. Order of work: find it broken first

1. Redis container in `WebIntegrationTest`, health property removed from the base. `mvn verify` green; the log shows one Redis container.
2. **Case 3 with no idempotency code.** The header is ignored, so the retry after `FAILED` creates a second deployment: red. Record it. This is the lesson of the step.
3. `IdempotencyRecord`, `IdempotencyStore`, `IdempotencyExecutor`, `Idempotent`, controller wiring. Cases 1 to 3.
4. Case 4, the mismatch exception and its handler.
5. Case 5, the in-progress exception, handler and `Retry-After`.
6. **Case 7 without the release** (no `catch` around `action.get()`): the retry gets 409 `request-in-progress` for 30 s. Red, record it, then add the release.
7. Cases 8 and 9.
8. Case 6, the concurrent pair. Run it as `@RepeatedTest(10)` once and record the split between 409 and replayed 202.
9. **Case 10 with `@Pattern` on the header first** (decision 3): confirm whether S3.3's case 6 breaks. Record what happened, then switch to `IdempotencyKeys.validate`.
10. `IdempotencyRedisDownTest` **before** the timeouts and the 503 handler: record the status (expected 500) and the time it took. Then add the timeouts and the handler.
11. `ProblemShapeTest` rows for the new slugs. Plan doc §3.2 rows.
12. Manual check (section 8). Results section. `mvn verify`.

## 10. Not in S3.5

- Idempotency on `POST /deployments/{id}/rollback` (decision 15).
- Keys scoped by caller. S4.
- A Postgres-backed idempotency record (section 6).
- Replaying error responses (decision 4).
- Redis persistence and eviction settings for production (section 6).
- Rate limiting. S3.6, which reuses the Redis container and the Lua approach.

## 11. Results

### 11.1 Found broken first

| Step (section 9) | Deliberate break | Observed | After the fix |
|---|---|---|---|
| Step 2, case 3 | Controller validated the key, then called `service.requestDeployment` directly; the executor call was commented out | `retryAfterFirstDeploymentFailed_replays_insteadOfDeployingAgain` failed: `expected: "true" but was: "false"` on `Idempotent-Replayed`. SQL log (one line per request, by correlation id): `insert into control.deployment` for the first POST, two `update control.deployment` from the test driving it to `FAILED`, then a **second** `insert into control.deployment` for the retry with the same key. The partial index did not stop it, because the first deployment was no longer active | Executor restored: class 13 of 13 green, `mvn verify` 187 tests green |
| Step 6, case 7 | `release` removed from the executor's `catch` | **Not run.** Release-on-failure is covered only by the green test | — |
| Step 9, case 10 | `@Pattern` on the `Idempotency-Key` header parameter | **Not run.** The premise of decision 3 (a parameter constraint switches `@Valid @RequestBody` errors to `HandlerMethodValidationException`) remains unverified. Hand validation was kept; `DeploymentEndpointsTest` case 6 confirms body errors still arrive per field | — |
| Step 10, Redis down | No 503 handler | **Not run as a red run:** the handler existed when the test was written. The green run confirmed the exception type, `RedisConnectionFailureException: Unable to connect to Redis`, logged once at `warn` with the request's correlation id; 503 returned in 0.214 s (test total, fixture inserts included) | — |

**What the case 3 red run also showed.** With the executor bypassed, the whole `IdempotencyEndpointsTest` class split 6 failed, 7 passed:

| Failed (need the executor) | Passed without it |
|---|---|
| 1 new key stores a completed record; 2 replay; 3 retry after `FAILED`; 4 different body gives 422; 5 seeded in-progress claim gives 409; 6 concurrent pair, one deployment | 7 failed request releases the key; 8 conflict releases the key; 9 no key leaves Redis untouched; 10 invalid keys (4 rows) give 400 |

Cases 7 to 10 pass with no idempotency at all. They do not prove the feature exists; they only catch it misbehaving once it does. Case 7, for example, asserts "key absent after a failure", which is trivially true when nothing writes keys. Only case 7's own red run (feature present, `release` removed) would show that test has teeth, and that run was skipped. Cases 1 to 6 are the ones that prove idempotency works.

### 11.2 Final state

`mvn verify` green: 188 tests, 2 skipped by design. New or extended in this step:

| Test class | Tests | Covers |
|---|---|---|
| `IdempotencyEndpointsTest` | 13 | cases 1 to 10 (case 10 has 4 invalid keys) |
| `IdempotencyRedisDownTest` | 2 | cases 12 and 13 |
| `ProblemShapeTest` | 28 (was 19) | rows for `idempotency-key-reused`, `request-in-progress`, `service-unavailable`, plus the S3.3 types `unprocessable` (`UnprocessableRequestException`) and `conflict` (`RollbackAlreadyRequestedException`) that never had rows; `Retry-After` on the 409 and 503; the field name for an invalid `Idempotency-Key` and an invalid cursor |
| `DeploymentEndpointsTest` | 24, unchanged | case 11: body validation still reports `applicationId`, `releaseId`, `environment` per field |

Test infrastructure: `WebIntegrationTest` now starts Postgres and Redis together (`Startables.deepStart`, one Redis container for the whole run, Redis health re-enabled). The fixture code that had been copied into four test classes moved into `TestFixtures` (`@TestComponent`, brought in with `@Import` so it never leaks into contexts that did not ask for it); the refactor left the test count unchanged at 188.

### 11.3 Confirmed live

- **The spec's concurrency test, repeated.** Case 6 run 10 times, each in a fresh JVM, outcome read from the exception resolver's log: exactly one deployment every time, and the losing request got **409 `request-in-progress` in 10 of 10 runs**, never a replayed 202. The barrier makes both requests arrive while the first is still running.
- **Against the dev stack** (compose Postgres and Redis, app on profile `local`):
  - first keyed POST: 202, `Idempotent-Replayed: false`; same key and body again: 202, `Idempotent-Replayed: true`, identical `deploymentId`, `taskId` and `Location`; same key, different body: 422 `idempotency-key-reused`; one deployment in the database.
  - Redis key `idempotency:v1:deployments:<key>`, value `{"state":"COMPLETED","owner":null,"fingerprint":"9bac…","response":"{\"deploymentId\":…}"}`, `PTTL` 86,399,351 ms (24 h minus about 650 ms).
  - The check needed a new `environment` row (`manual-check`) inserted by hand, because every seeded application and environment pair already has an active deployment.
- **Redis down:** `RedisConnectionFailureException: Unable to connect to Redis`, mapped to 503 `service-unavailable` with `Retry-After: 5`, logged once at `warn` with the request's correlation id. 0.214 s for the whole test including fixture inserts: the closed port is refused at once on this machine, so the 1 s connect timeout never came into play. Without a key, the same request succeeds (202).
- **An empty `Idempotency-Key` header** reaches the controller as `""`, not `null`, and is rejected with 400 by the hand validation.
- **A body that cannot be parsed never reaches Redis.** Two malformed POSTs with a key returned 400 `malformed-request` and created no Redis key: the body is read before the controller method runs.

### 11.4 Still true, recorded not fixed

- **Redis and Postgres do not commit together** (section 6): a lost completion write can still lead to a duplicate once the claim expires and the first deployment is no longer active.
- **Keys are not scoped to a caller** until S4 (decision 7).
- **Decision 3's premise is unverified** (section 11.1, step 9).
- **A slow Redis is not mapped.** A command timeout raises `QueryTimeoutException`, not `RedisConnectionFailureException`, and would surface as 500. Mapping it to 503 would also catch JDBC query timeouts, so it was left as is.
- **The compose Redis runs with default persistence and eviction**, not the `noeviction` plus AOF that idempotency needs in production (section 6).

## Definition of done

- [x] Redis Testcontainer in `WebIntegrationTest`, started together with Postgres; `mvn verify` green
- [x] Case 3 seen failing (second deployment) with the idempotency code bypassed (section 11.1)
- [x] `IdempotencyStore` with the three Lua scripts, `IdempotencyExecutor`, controller wiring
- [x] Release-on-failure proven necessary: **not run**; covered only by the green case 7 (section 11.1)
- [x] `@Pattern`-on-header effect on body validation: **not run**; hand validation in place, body validation confirmed unchanged (case 11)
- [x] Redis-down behaviour: "before" **not run**; "after" recorded (section 11.3)
- [x] `IdempotencyEndpointsTest` cases 1 to 11 and `IdempotencyRedisDownTest` cases 12 and 13 green
- [x] Case 6 (concurrent pair) run repeatedly, outcome split recorded (10 of 10, loser always 409)
- [x] New problem types in the advice, `ProblemShapeTest` and the plan doc's §3.2 matrix
- [x] Record format and TTL checked by hand against the dev Redis
- [x] Results section written; plan doc's S3 definition-of-done item "two concurrent identical POSTs, exactly one deployment" ticked
- [x] `mvn verify` green
