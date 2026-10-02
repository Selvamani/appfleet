# control-api — S3.6: rate limiting

**Spec:** [01-CONTROL-API.md §S3](../../specs/project/01-CONTROL-API.md) — *"Rate limiting: token bucket per team in Redis — atomic via a small Lua script or `DECR`-with-expiry pattern; 429 + `Retry-After` when empty"* · Slice **S3.6** of [control-api-s3-rest.md](control-api-s3-rest.md)

Companion: [control-api-s3-5-idempotency.md](control-api-s3-5-idempotency.md) (the Redis Testcontainer, the Lua approach, the 503 mapping for Redis failures, and a design that fails the other way), [control-api-s3-4-task-history.md](control-api-s3-4-task-history.md) (why reads need limiting too: the offset endpoint's cost grows with depth), [control-api-s3-1-foundations.md](control-api-s3-1-foundations.md) (the problem shape, the temporary open security chain). **Status: code wired and the existing suite green (2026-10-02); the rate-limit tests are in progress, see section 11.**

Rate limiting reuses all of S3.5's Redis plumbing, so the code is small. The design questions are elsewhere: who is "a team" before S4 gives requests an identity, which way the limiter fails when Redis is down, and how to keep it from throttling the existing test suite.

## 1. What already exists

- Redis 7 in compose and in `WebIntegrationTest` (S3.5); `StringRedisTemplate`; Redis timeouts of 2 s / 1 s.
- **`RedisConnectionFailureException` is mapped to 503 `service-unavailable`** by the advice (S3.5). That matters here: see decision 7.
- `AppfleetProperties(environment)`, a validated `@ConfigurationProperties` record with prefix `appfleet`.
- `Application.ownerTeamId`, a UUID column. There is no `Team` entity and no caller identity: `TemporaryOpenSecurityConfig` permits everything under `/api/**` until S4.
- The status matrix already reserves 429 `rate-limited` (plan doc §3.2).

## 2. Behaviour

| Request | Result |
|---|---|
| Bucket of the request's team has a token | Proceeds; one token is spent |
| Bucket empty | 429 `rate-limited`, `Retry-After: <seconds until one token>` |
| `X-Team-Id` absent | Counted against the shared bucket `anonymous` |
| `X-Team-Id` not a UUID | 400 `validation-failed`, `errors[].field == "X-Team-Id"` |
| Redis unreachable | **Proceeds** (fail open), one `warn` log line |
| Rate limiting disabled (`appfleet.rate-limit.enabled: false`) | Proceeds; Redis not touched |

## 3. Decisions

1. **Token bucket, not a fixed window.** A fixed window (`INCR` plus `EXPIRE` per minute) is simpler but allows twice the limit across a window boundary: a full burst at 00:59 and another at 01:00. A token bucket refills continuously, so the sustained rate is exact and only the configured burst is allowed at once.
2. **One Lua script, one round trip, atomic.** Read the bucket, refill it for the elapsed time, take a token, write it back. Done in Java as `HGET` then `HSET`, two concurrent requests read the same token count and both spend the same token. Section 9 starts with that broken version on purpose.
3. **The clock is Redis's (`TIME`), not the JVM's.** Every app instance computes refills from one clock, so clock skew between instances cannot mint tokens. Redis 7 replicates scripts by their effects, which is what allows `TIME` inside a script.
4. **Who is a team, before S4.** A `TeamResolver` interface with one temporary implementation that reads an `X-Team-Id` header (a UUID, the same kind of value as `Application.ownerTeamId`); no header means the shared bucket `anonymous`. S4 replaces it with the authenticated principal's team, and deletes the header, exactly as `TemporaryOpenSecurityConfig` is deleted.
   - **The header is spoofable, and that is stated plainly:** a client can rotate team ids to get more tokens. That is no weaker than S3's security, which is no authentication at all. The point of S3.6 is the bucket, the atomicity and the 429 contract; real per-team enforcement needs S4.
   - **Rejected: the team of the target application** (`ownerTeamId` of the application in `POST /deployments`). It cannot be spoofed, but it covers only endpoints that name an application, and the application must be loaded from the database before the limiter can decide, so the work the limiter exists to prevent has already happened.
   - **Rejected: a constant, one global bucket** (the S3.3 choice for the audit actor). It would make "per team" untestable until S4.
5. **Every request under `/api/**` costs one token, reads included.** S3.4 showed the offset endpoint's cost grows linearly with depth; reads are where expensive requests are. Per-endpoint costs are out of scope.
6. **A `HandlerInterceptor`, not a servlet `Filter`.** An exception thrown from an interceptor's `preHandle` goes through the `@RestControllerAdvice`, so the 429 gets the one problem shape and the correlation id for free. A filter runs before Spring MVC, so it would have to write `problem+json` by hand (the same gap S3.1 recorded for the security chain's 401). **Unknown routes are probably counted too:** Boot's default static-resource handler matches `/**`, and registered interceptors apply to it, so a request to `/api/v1/nope` likely spends a token before it becomes 404. That is acceptable, even useful (probing for endpoints is exactly what a limiter should slow down). Case 8 records which behaviour is real: **they are counted** (observed 2026-10-02, section 7.1).
7. **Fail open when Redis is down, the opposite of S3.5.** Idempotency fails closed because the client asked for a guarantee. A rate limiter is protection, not a guarantee: with Redis down it is better to serve requests unlimited than to refuse all of them. The limiter catches Spring's `DataAccessException` around its own Redis call, logs a warning and allows the request. **This catch is required, not optional:** without it, `RedisConnectionFailureException` reaches the S3.5 handler and becomes 503, so a Redis outage would turn into a **full API outage**, failing closed by accident. Section 9 shows this on purpose.
8. **Configuration and defaults.** `appfleet.rate-limit.enabled` (default `true`), `capacity` (default 60 tokens, the burst) and `refill-per-second` (default 1.0, so 60 requests per minute sustained per team). The numbers are a judgement call for a deployment-control API with few, deliberate clients; write them down rather than pretend they are derived.
9. **Disabled in the `test` profile.** Without that, every web test shares the `anonymous` bucket, and the suite (about 190 requests in seconds, the pagination test alone makes over 20) exhausts it and fails with 429s that have nothing to do with what is tested. The rate-limit tests enable it for their own context with small numbers. Section 9 shows the suite failing first.
10. **Idle buckets expire.** After `capacity / refill-per-second` seconds without requests a bucket is full again, which is exactly the state "no key" means. The script sets that as the key's TTL, so Redis holds only active teams.
11. **`Retry-After` is whole seconds, rounded up, at least 1.** The script returns milliseconds until one token is available; HTTP's `Retry-After` takes seconds.
12. **No `RateLimit-*` informational headers.** The IETF RateLimit header fields are still a draft and have changed shape between versions. Only `Retry-After` on 429, as the spec asks.

## 4. The Lua script

Tested by hand against the compose Redis 7 before this doc was written (section 11).

```lua
-- KEYS[1] = bucket key; ARGV[1] = capacity (tokens); ARGV[2] = refill rate (tokens per second)
local capacity = tonumber(ARGV[1])
local rate = tonumber(ARGV[2])

local t = redis.call('TIME')                                   -- Redis server clock: one clock for every app instance
local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)

local bucket = redis.call('HMGET', KEYS[1], 'tokens', 'ts')
local tokens = tonumber(bucket[1]) or capacity                 -- no key: a full bucket
local ts = tonumber(bucket[2]) or now

tokens = math.min(capacity, tokens + (now - ts) / 1000 * rate)

local allowed = 0
local retry_ms = 0
if tokens >= 1 then
    tokens = tokens - 1
    allowed = 1
else
    retry_ms = math.ceil((1 - tokens) / rate * 1000)
end

redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', now)
redis.call('PEXPIRE', KEYS[1], math.ceil(capacity / rate * 1000))   -- idle long enough to be full again: drop it

-- Lua numbers become Redis integers on return (fractions are truncated), so return integers only
return {allowed, math.floor(tokens), retry_ms}
```

- **The bucket is a hash** with the fractional token count and the last refill time in milliseconds. Fractions matter: at 1 token per second, 400 ms of waiting is 0.4 of a token, and losing it would make the limiter stricter than configured.
- **The return trap:** a Lua number returned to Redis is converted to an integer, truncating any fraction. That is why the script returns `math.floor(tokens)` and a whole number of milliseconds, never a raw fraction. Inside the hash, `tostring` keeps the fraction.
- **Redis key:** `ratelimit:v1:team:<teamId>`, with `anonymous` in place of the id when no header is sent.

### 4.1 Line by line

What each line does, and why it is written that way. All times are milliseconds from the Redis server clock; `rate` is tokens per second.

| # | Line | What it does | Why |
|---|---|---|---|
| 1 | `local capacity = tonumber(ARGV[1])` | Reads the bucket size | Script arguments arrive as strings. Capacity is the burst: the most requests a team can send at once |
| 2 | `local rate = tonumber(ARGV[2])` | Reads the refill rate | Tokens added per second: the rate a team can sustain forever |
| 3 | `local t = redis.call('TIME')` | Reads the Redis clock as `{seconds, microseconds}` | One clock for every app instance (decision 3), so a fast clock on one instance cannot create tokens |
| 4 | `local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)` | Converts to milliseconds | One unit for everything below |
| 5 | `local bucket = redis.call('HMGET', KEYS[1], 'tokens', 'ts')` | Reads both fields in one call | A missing key or field comes back as nil, which Lua receives as `false` |
| 6 | `local tokens = tonumber(bucket[1]) or capacity` | Tokens left after the last call | `tonumber(false)` is nil, so a missing key means a full bucket |
| 7 | `local ts = tonumber(bucket[2]) or now` | Time of the last call | A new bucket starts now, so line 8 adds nothing to it |
| 8 | `tokens = math.min(capacity, tokens + (now - ts) / 1000 * rate)` | The refill | Tokens earned since the last call, worked out now instead of by a timer (a lazy refill). The cap stops an idle team from banking more than one burst |
| 9 | `if tokens >= 1 then` | Is there a whole token? | One request costs one token |
| 10 | `tokens = tokens - 1` and `allowed = 1` | Spends it | The fraction left over is kept for the next call |
| 11 | `retry_ms = math.ceil((1 - tokens) / rate * 1000)` | Refused: time until a whole token | The missing part of a token divided by the rate. Rounded up so the client never comes back a moment too early |
| 12 | `redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', now)` | Stores the new state | Written on refused calls too, so the refill just computed is not lost. `tostring` keeps the fraction |
| 13 | `redis.call('PEXPIRE', KEYS[1], math.ceil(capacity / rate * 1000))` | Expires the key when idle | `capacity / rate` seconds is the time to refill from empty. After that the bucket is full, which a missing key already means, so Redis can drop it (decision 10). The TTL restarts on every call |
| 14 | `return {allowed, math.floor(tokens), retry_ms}` | Answers the Java caller | Redis converts returned Lua numbers to integers by truncation, so only whole numbers are returned |

Java then turns `retry_ms` into the header (decision 11): `Retry-After = max(1, ceil(retry_ms / 1000))`, written in section 5 as `Math.max(1, (millis + 999) / 1000)`.

**Three calls traced** with capacity 3 and rate 1 per second (the planned test values):

| Before the call | Line 8 | Result | Stored after | `Retry-After` |
|---|---|---|---|---|
| No key (a new team) | `min(3, 3 + 0) = 3` | allowed, `{1, 2, 0}` | tokens 2 | none |
| tokens 0.25, last call 400 ms ago | `min(3, 0.25 + 0.4) = 0.65` | refused, `retry_ms = ceil(0.35 × 1000) = 350`, `{0, 0, 350}` | tokens 0.65 | 1 s |
| tokens 0.25, last call 1 s ago | `min(3, 0.25 + 1) = 1.25` | allowed, `{1, 0, 0}` | tokens 0.25 | none |

The second row also shows why refused calls write the bucket: the next call starts from 0.65, not from 0.25.

**Edge cases worth knowing**

1. **Atomicity.** Redis runs a script from start to finish with no other command in between. Two requests arriving together are run one after the other, so they cannot both read the last token and both spend it (decision 2; section 9 builds the broken two-call version).
2. **`rate` must be positive.** Lines 11 and 13 divide by it. `@Positive` on `refillPerSecond` (section 5) stops a zero rate before it reaches Redis.
3. **The clock can step backwards.** `TIME` is wall-clock time. After a failover to a replica with a slower clock, `now - ts` can be negative and line 8 removes tokens instead of adding them. That errs safe: fewer tokens, never more. The single compose Redis cannot fail over.
4. **Fractions.** Token counts are floating point in Lua and stored as text by `tostring`, which keeps 14 significant digits in Redis 7's Lua 5.1. Rounding at that scale is far below one request.

You can step through these lines with your own numbers in [the rate-limiting lesson](../concepts/appfleet-concepts.html#/lessons/rd-ratelimit) under "Step through the Lua script".

## 5. Java design

| Type | Package | Role |
|---|---|---|
| `RateLimitProperties(boolean enabled, int capacity, double refillPerSecond)` | `io.appfleet.control.config` | Nested in `AppfleetProperties` as `rateLimit`, with `@DefaultValue`s; `@Positive` on both numbers |
| `RateLimitDecision(boolean allowed, long remaining, Duration retryAfter)` | `io.appfleet.control.ratelimit` | Result of one check |
| `RateLimiter` | `io.appfleet.control.ratelimit` | Runs the script; fails open; no Spring MVC types |
| `RateLimitedException(Duration retryAfter)` | `io.appfleet.control.ratelimit` | Mapped to 429 by the advice |
| `TeamResolver` (interface), `HeaderTeamResolver` | `io.appfleet.control.web` | `HeaderTeamResolver` marked TEMPORARY, replaced in S4 |
| `InvalidHeaderException(String header)` | `io.appfleet.control.web` | 400 `validation-failed` with the header name as `field` |
| `RateLimitInterceptor`, `WebConfig` (a `WebMvcConfigurer` registering it for `/api/**`) | `io.appfleet.control.web` | The HTTP side |

`AppfleetProperties` grows one component:

```java
public record AppfleetProperties(@NotBlank String environment,
                                 @DefaultValue @Valid RateLimitProperties rateLimit) {
}

public record RateLimitProperties(@DefaultValue("true") boolean enabled,
                                  @DefaultValue("60") @Positive int capacity,
                                  @DefaultValue("1.0") @Positive double refillPerSecond) {
}
```

`RateLimiter`:

```java
@Component
public class RateLimiter {

    private static final Logger log = LoggerFactory.getLogger(RateLimiter.class);
    private static final String PREFIX = "ratelimit:v1:team:";
    private static final RedisScript<List> TAKE_TOKEN = RedisScript.of(new ClassPathResource("ratelimit/take-token.lua"), List.class);

    private final StringRedisTemplate redis;
    private final RateLimitProperties limits;

    // constructor takes AppfleetProperties and keeps properties.rateLimit()

    public RateLimitDecision tryConsume(String team) {
        try {
            List<?> r = redis.execute(TAKE_TOKEN, List.of(PREFIX + team),
                    String.valueOf(limits.capacity()), String.valueOf(limits.refillPerSecond()));
            return new RateLimitDecision(((Long) r.get(0)) == 1, (Long) r.get(1), Duration.ofMillis((Long) r.get(2)));
        } catch (DataAccessException e) {                      // Redis down or too slow: fail open (decision 7)
            log.warn("Rate limiter unavailable, request allowed: {}", e.getMessage());
            return new RateLimitDecision(true, -1, Duration.ZERO);
        }
    }
}
```

- The script lives in `src/main/resources/ratelimit/take-token.lua`, not in a Java text block: it is long enough to deserve syntax highlighting, and the same file can be run by hand with `redis-cli --eval`. (S3.5's three short scripts could move there too; not required.)
- Catching `DataAccessException` here is safe in a way it was not in S3.5's advice: the `try` block contains only this Redis call, so a JDBC timeout cannot be caught by accident.
- During a Redis outage this logs once per request. Acceptable for now; log throttling is out of scope.

`RateLimitInterceptor.preHandle`:

```java
if (!properties.rateLimit().enabled()) {
    return true;
}
String team = teamResolver.resolve(request);                   // throws InvalidHeaderException for a bad X-Team-Id
RateLimitDecision decision = rateLimiter.tryConsume(team);
if (!decision.allowed()) {
    throw new RateLimitedException(decision.retryAfter());
}
return true;
```

`HeaderTeamResolver.resolve`: header absent gives `"anonymous"`; present and a valid UUID gives the UUID text; anything else throws `InvalidHeaderException("X-Team-Id")`. Parse with `UUID.fromString` and compare its `toString()` to the input, as `CursorCodec` does, to reject lenient forms.

Advice:

```java
@ExceptionHandler(RateLimitedException.class)
ResponseEntity<ProblemDetail> rateLimited(RateLimitedException ex, WebRequest req) {
    long seconds = Math.max(1, (ex.retryAfter().toMillis() + 999) / 1000);
    ResponseEntity<ProblemDetail> response = problem(HttpStatus.TOO_MANY_REQUESTS, "rate-limited", "Too many requests",
            "The rate limit for this team is exhausted. Retry after the time given in Retry-After.", req);
    return ResponseEntity.status(response.getStatusCode())
            .header(HttpHeaders.RETRY_AFTER, String.valueOf(seconds))
            .body(response.getBody());
}
```

Plus an `InvalidHeaderException` handler in the `InvalidCursorException` pattern, `field` set to the header name.

## 6. Interaction with S3.5

- **A replayed idempotent request spends a token.** The interceptor runs before the controller, so it cannot know the request will be a replay. That is the usual behaviour (Stripe counts retries too) and it is what stops a retry storm.
- **A 429 never reaches the idempotency code**, so it creates no Redis key and no claim; the client retries later with the same key and gets normal treatment.

## 7. Tests

### 7.1 `RateLimitEndpointsTest extends WebIntegrationTest`

**Setup.** `@TestPropertySource(properties = {"appfleet.rate-limit.enabled=true", "appfleet.rate-limit.capacity=3", "appfleet.rate-limit.refill-per-second=1"})`. A test property source outranks `application-test.yml`, so the limiter is on for this class only. The properties change the context cache key, so the class gets its own Spring context; the Postgres and Redis containers are still the shared static ones of `WebIntegrationTest`. The endpoint is `GET /api/v1/applications?limit=1`: an empty page is still 200, so no fixtures are needed.

**Helpers.**

| Helper | What it does |
|---|---|
| `newTeam()` | A random UUID string. Each test uses its own, so each test has its own bucket and test order does not matter |
| `call(path, team)` | `GET path?limit=1`, with `X-Team-Id: team` unless `team` is `null`; returns the raw `MockHttpServletResponse` |
| `call(team)` | `call("/api/v1/applications", team)` |
| `statuses(team, n)` | Sends `n` requests one after another and returns their status codes in order |
| `type(response)` | Reads `$.type` from a problem body |

Assertions are AssertJ on the raw response, the same style as `IdempotencyEndpointsTest`.

**Cases.** Capacity is 3 and the refill is 1 token per second in all of them.

| # | Test method | Case | Expected |
|---|---|---|---|
| 1 | `fourthRequest_is429_withRetryAfter` | 3 requests, then a 4th, one team | 200, 200, 200, then 429 `rate-limited` with `Retry-After: 1` |
| 2 | *(not written yet)* | team A exhausted, then team B | B gets 200: buckets are independent |
| 3 | `noHeader_sharesAnonymousBucket` | 4 requests without the header | 200, 200, 200, 429; afterwards a request with a fresh team id is 200 |
| 4 | `afterRetryAfter_oneMoreRequestPasses` | exhaust, wait as long as `Retry-After` says, request twice | 200 (one token refilled), then 429 again |
| 5 | `concurrentBurst_allowsExactlyCapacity` | 10 concurrent requests, one fresh team, released together by a barrier | exactly 3 × 200, the rest 429, never 500 |
| 6 | `invalidTeamHeader_is400` (2 rows) | `X-Team-Id: not-a-uuid` and `X-Team-Id: 1-1-1-1-1` | 400 `validation-failed`, `errors[0].field == "X-Team-Id"` |
| 7 | `bucketIsHash_withExpiry` | one request, then look at Redis | hash `ratelimit:v1:team:<id>` holds `tokens = "2"` and a `ts`; `PTTL` between 1 and 3,000 ms |
| 8 | `unknownRoutes_spendTokens` | `/api/v1/nope` × 2 (both 404), then real requests until one is refused | exactly 1 real request gets 200: the two 404s spent tokens |

#### Case 1: the fourth request in a burst is refused

1. Send 3 requests with one team id; assert the statuses are exactly `200, 200, 200`.
2. Send a fourth; assert 429, `type` equal to `urn:appfleet:problem:rate-limited`, and `Retry-After` equal to `"1"`.

The `"1"` is exact, not approximate. At 1 token per second the script returns `retry_ms = ceil((1 - tokens) * 1000)`, which is above 0 and at most 1,000. The handler rounds that up to whole seconds with a floor of 1, so the header is always 1 at this rate. The rounding of larger values is tested in section 7.3.

#### Case 2: one team's empty bucket does not affect another team

Exhaust team A with 4 requests, then send one request as team B and assert 200. It proves the Redis key is per team and not global. **Not in the class yet.**

#### Case 3: requests without the header share one bucket

1. Delete the key `ratelimit:v1:team:anonymous`.
2. Send 4 requests without `X-Team-Id`; assert `200, 200, 200, 429`.
3. Send one request with a fresh team id; assert 200.

The delete in step 1 is needed because `anonymous` is the only key in this class that is not random. Without it, a second run inside the bucket's lifetime (an IDE repeat, a surefire rerun) would start with an empty or half-empty bucket. Step 3 shows that the anonymous bucket being empty does not block identified teams.

#### Case 4: tokens come back with time

1. Exhaust the bucket (3 requests), then send one more and assert 429.
2. Sleep for the `Retry-After` value of that 429, in seconds, plus 100 ms.
3. Send two requests; assert 200, then 429.

The sleep is read from the header and not hard-coded, so the test checks that `Retry-After` tells the truth: a client that waits exactly that long gets through. Only one request passes afterwards, because about 1.1 tokens have refilled: one is spent and the remaining 0.1 is below a whole token. The refused request in step 1 costs no refill time: the script stores the refilled token count together with the new `ts` on every call, allowed or not.

#### Case 5: a concurrent burst spends exactly the capacity

1. Create 10 tasks that each wait on a `CyclicBarrier(10)` and then send one request, all with the same team id.
2. Run them on a 10-thread pool with `invokeAll` and collect the 10 status codes.
3. Assert the statuses contain only 200 and 429, and that exactly 3 of them are 200.

This is the test that justifies the Lua script (decision 2). A Java limiter that does `HMGET`, computes, then `HSET` lets several threads read `tokens = 3` and each write back 2, so more than 3 requests pass. Redis runs a script atomically, so the 10 calls execute one after another and exactly 3 find a token. `containsOnly(200, 429)` is the "never 500" check: no thread may fail in any other way.

#### Case 6: an invalid team header is a client error

For each of `not-a-uuid` and `1-1-1-1-1`: assert 400, `type` equal to `urn:appfleet:problem:validation-failed`, and `errors[0].field` equal to `X-Team-Id`.

The second value is there on purpose. `UUID.fromString("1-1-1-1-1")` succeeds and returns `00000001-0001-0001-0001-000000000001`, so only the canonical-form check in `HeaderTeamResolver` rejects it. Without this row that branch is never executed. The resolver throws before the limiter is called, so a rejected request spends no token and creates no Redis key.

#### Case 7: what is stored in Redis

1. Send one request with a fresh team id.
2. Read the hash `ratelimit:v1:team:<id>`; assert it contains `tokens = "2"` and a field `ts`.
3. Assert the key's remaining time to live is between 1 and 3,000 ms.

`"2"` is exact: a new key starts full at 3 with `ts = now`, the refill adds 0, one token is spent, and Lua's `tostring(2)` is `"2"`. The time to live is `ceil(capacity / rate * 1000) = 3,000` ms at most (decision 10): a bucket idle for that long is full again, which is the same state as no key.

#### Case 8: unknown routes spend tokens

1. Send `GET /api/v1/nope` twice with one team id; assert 404 both times.
2. With the same team id, send real requests until one is not 200 (at most 5); count the 200s.
3. Assert the count is 1.

**Observed: 1.** The two 404s each spent a token, which confirms decision 6. Spring Boot's static-resource handler matches `/**`, so `/api/v1/nope` has a handler; interceptors registered through `WebMvcConfigurer` apply to that handler too, so `preHandle` runs and spends a token before the resource handler answers 404. A count of 3 would have meant that no handler matched and the interceptor never ran. The behaviour is wanted: a scanner probing for endpoints is limited like any other client. The test pins the number, so setting `spring.web.resources.add-mappings: false` later would fail this test and force the decision to be looked at again.

#### Timing

Cases 1, 3, 4, 5 and 8 assume that the requests of one burst finish well within one second; otherwise a token refills in the middle and one more request gets 200. MockMvc requests take milliseconds, so this holds. The one slow request is the first in a new Spring context (cold Hibernate and Jackson paths). If a case ever fails that way:

1. Add a `@BeforeEach` that sends one request with a throwaway team id, so the context is warm.
2. If that is not enough, lower `refill-per-second` (for example to 0.2) and adjust the numbers that depend on it: `Retry-After` becomes 5, the key's time to live 15,000 ms, and case 4 waits about 5 s.

Do not add sleeps to the burst cases.

### 7.2 Redis down: fail open

Add `appfleet.rate-limit.enabled=true` to `IdempotencyRedisDownTest`'s properties and one case:

| # | Test method | Case | Expected |
|---|---|---|---|
| 9 | `rateLimiter_redisDown_failsOpen` | `GET /api/v1/applications?limit=1` with Redis down | 200, and exactly one `Rate limiter unavailable` line in the captured log output |

The log line is counted with Spring Boot's `OutputCaptureExtension` (`CapturedOutput` as a test parameter); the capture starts empty for each test method, so the count of 1 is reliable.

**The case must live in the Redis-down class.** That class points Redis at port 1, where nothing listens. In `RateLimitEndpointsTest` Redis is up, the limiter never logs the warning, and the same test fails with `expected: 1 but was: 0`.

Case 13 there (POST without a key) then also passes through the limiter, so it proves fail-open on a write too. Case 12 (POST with a key, expects 503 in under 3 s) now makes two Redis calls, the limiter's and the idempotency claim, and each can wait for the 1 s connect timeout; if it ever becomes flaky, that is the reason. Consider renaming the class `RedisDownTest`, since it now covers two features.

### 7.3 `ProblemShapeTest`

The slice excludes `RateLimitInterceptor` and `WebConfig` (a `@WebMvcTest` would otherwise need `TeamResolver` and `RateLimiter` beans), so the probes throw the exceptions straight from the controller and only the mapping in `ApiExceptionHandler` is tested.

| Probe | Throws | Checked by | Expected |
|---|---|---|---|
| `/probe/rate-limited` | `RateLimitedException(Duration.ofMillis(1500))` | a row in `domainRows` | 429 `rate-limited`, the one problem shape, no `errors` |
| `/probe/rate-limited` | the same | a row in `retryAfterRows` | `Retry-After: 2` (1,500 ms rounds up, never down) |
| `/probe/rate-limited-zero` | `RateLimitedException(Duration.ZERO)` | a row in `retryAfterRows` | `Retry-After: 1` (the floor: never 0) |
| `/probe/invalid-header` | `InvalidHeaderException("X-Team-Id")` | `invalidHeader_is400_withHeaderAsField` | 400 `validation-failed`, `errors[0].field == "X-Team-Id"`, `errors[0].message == "Must be a UUID."` |

The two `Retry-After` rows cover what the endpoint tests cannot: at 1 token per second the header is always 1, so neither the rounding nor the floor is exercised there. `/probe/invalid-header` must not be added to `domainRows`, because that test asserts that `errors` is absent.

## 8. Manual check against the dev stack

With the app on profile `local`, the defaults apply (60 tokens, 1 per second). Send 61 quick requests with one `X-Team-Id` and confirm the 61st is 429 with `Retry-After: 1`; then `redis-cli HGETALL ratelimit:v1:team:<id>` and `PTTL`. The script itself can be run without the app: `redis-cli --eval take-token.lua ratelimit:v1:team:x , 3 1`.

## 9. Order of work: find it broken first

1. `RateLimitProperties` in `AppfleetProperties`, `rate-limit.enabled: false` **not yet** in `application-test.yml`.
2. **A naive limiter first:** read the hash, compute, write it back, all in Java. Interceptor, resolver and the 429 handler wired. Run case 5: **expect more than 3 × 200**, because concurrent requests read the same token count. Record it. This is the lesson of the step.
3. **Run the whole suite with the limiter enabled for everyone:** expect unrelated tests to fail with 429. Record how many. Then add `appfleet.rate-limit.enabled: false` to `application-test.yml` and `@TestPropertySource` to `RateLimitEndpointsTest`.
4. Replace the naive limiter with the Lua script. Case 5 green: exactly 3.
5. Cases 1 to 4 and 6 to 8.
6. **Redis down without the `catch`:** case 9 returns **503**, because S3.5's handler maps the exception. Record it: a Redis outage would take down the whole API. Then add the `catch`; case 9 green.
7. `ProblemShapeTest` rows.
8. Manual check (section 8). Results section. `mvn verify`.

## 10. Not in S3.6

- Real per-team identity, and deleting `HeaderTeamResolver` and the header. S4.
- Per-endpoint costs, separate read and write buckets.
- `RateLimit-*` informational headers (decision 12).
- Log throttling during a Redis outage.
- Redis Cluster key placement (`{hash tags}`). One Redis here.
- Rate limiting non-API paths (`/actuator/**`).

## 11. Results

*(final results to be written when the slice closes)*

**Test run, 2026-10-02** (`mvn test -Dtest=RateLimitEndpointsTest,ProblemShapeTest`):

| Class | Result |
|---|---|
| `RateLimitEndpointsTest` | 9 run, 8 passed, 1 failed |
| `ProblemShapeTest` | 29 run, 29 passed |

- **Cases 1 and 3 to 8 are green** (8 tests; case 6 counts twice). The concurrent case allowed exactly 3 of 10.
- **Case 8 observed 1:** unknown routes under `/api/**` spend tokens. Decision 6's "probably" is now a fact, and the test pins it.
- **The one failure is case 9, in the wrong class.** `rateLimiter_redisDown_failsOpen` currently sits in `RateLimitEndpointsTest`, where Redis is up, so the warning is never logged: `expected: 1 but was: 0`. It belongs in `IdempotencyRedisDownTest` (section 7.2).

Open after this run:

1. Case 2 (independent buckets) is not written.
2. Move case 9 to `IdempotencyRedisDownTest` and add `appfleet.rate-limit.enabled=true` to that class's properties.
3. `ProblemShapeTest` has the three probes and `invalidHeader_is400_withHeaderAsField`, but the `rate-limited` row in `domainRows` and the two rows in `retryAfterRows` are not added yet, so `/probe/rate-limited` and `/probe/rate-limited-zero` are not called by any test.
4. Manual check against the dev stack (section 8).

Recorded while designing: the script above was run by hand against the compose Redis 7 with capacity 3 and 1 token per second. Four calls in a row returned `allowed` 1, 1, 1, 0, the fourth with a retry of 416 ms (about 0.58 of a token had refilled during the roughly 200 ms each `docker exec` took). After 1.2 s, one more call was allowed. Ten parallel calls on a fresh key with a refill of 0.01 per second: exactly 3 allowed, 7 denied. The hash held a fractional `tokens` value (`0.584`) and the key's TTL was below 3,000 ms. The test keys were deleted afterwards.

## Definition of done

- [x] `RateLimitProperties` bound and validated; defaults documented
- [ ] Naive Java read-modify-write limiter shown overshooting in case 5, then replaced by the Lua script
- [ ] Suite shown failing with the limiter enabled globally; `test` profile disables it
- [x] `RateLimiter`, `RateLimitInterceptor`, `HeaderTeamResolver` (marked TEMPORARY), `WebConfig`, handlers for 429 and the invalid header
- [ ] `RateLimitEndpointsTest` cases 1 to 8 green, including the concurrent case
- [ ] Redis down shown as 503 without the `catch`, then fail-open (case 9) green
- [ ] `ProblemShapeTest` rows for `rate-limited` and the invalid header
- [ ] Manual check against the dev Redis
- [ ] Results section written; plan doc's S3 definition-of-done item "rate limiter returns 429 with `Retry-After`" ticked
- [ ] `mvn verify` green
