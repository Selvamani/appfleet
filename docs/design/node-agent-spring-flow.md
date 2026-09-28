# node-agent — Spring Boot wiring and runtime flow

Companion to [node-agent.md](node-agent.md) (class-by-class design) and the spec
[04-NODE-AGENT.md](../specs/project/04-NODE-AGENT.md). That doc says what each class is;
this doc says how Spring actually assembles them at startup and how a request/message
moves through the assembled graph. Written against the current tree (`node-agent-phase-0`),
so it calls out what's implemented vs. still a stub from the spec.

Written to be readable by a Java developer who knows the language but hasn't worked
in Spring Boot before — each mechanism is explained the first time it's used, not
just named.

---

## 1. Spring concepts this module leans on

If these are already familiar, skip to §2. If not, read this first — every later
section assumes you know what these words mean.

### The ApplicationContext (the "IoC container")

A plain Java program builds its own objects with `new`. Spring inverts that: at
startup, Spring builds a big registry of objects — called **beans** — and hands
them to whatever else needs them. That registry is the `ApplicationContext`. You
don't call `new SessionService()` anywhere in this codebase; you declare that a
`SessionService` needs a `ContainerRuntime`, and Spring figures out which object to
plug in.

`NodeAgentApplication.main()` calling `SpringApplication.run(...)` is what builds
this context. Everything else in this doc happens *inside* that one call, before
`main()` returns.

### Beans, and the three ways one gets registered here

A **bean** is just "an object Spring created and manages," as opposed to an object
you built yourself with `new`. Three ways a bean enters the context in this module:

1. **Component scanning.** A class annotated `@Component` (or the specializations
   `@Service`, `@Repository`, `@RestController`) is found automatically by
   classpath scanning under the application's base package (`io.appfleet.agent`)
   and turned into a bean, with no extra registration code.
2. **`@Configuration` + `@Bean` methods.** Instead of annotating the class you want
   as a bean, you write a factory method that constructs it, inside a class marked
   `@Configuration`. Spring calls that method once and keeps the result. This is
   used here specifically because *which* class to instantiate is a runtime
   decision (`DockerRuntime` vs `SimulatedRuntime`) — you can't put a conditional
   choice on a plain `@Component` class annotation.
3. **`@ConfigurationProperties`.** A record or class that mirrors a section of
   `application.yml`, bound by field name. `AgentProperties` is this module's one
   example — see §1's "Configuration binding" below.

### Dependency injection (constructor injection, specifically)

Every class in this design takes its collaborators as **constructor parameters**,
never via field injection (`@Autowired` on a field) and never via a static
locator. Example, from the real `DockerRuntime`:

```java
public class DockerRuntime implements ContainerRuntime {
    private final DockerClient dockerClient;

    public DockerRuntime(DockerClient dockerClient) {
        this.dockerClient = dockerClient;
    }
    ...
}
```

Spring sees this constructor, looks in the context for a bean of type
`DockerClient`, and passes it in when it builds the `DockerRuntime` bean. Nothing
here is Spring-specific about `DockerRuntime` itself — it's plain Java, testable
with `new DockerRuntime(mockClient)` in a unit test with no Spring context at all.
That's the point of constructor injection: the class doesn't know it's managed by
a framework.

### `@ConditionalOnProperty` — a bean that only exists sometimes

Normally every `@Bean` method in a `@Configuration` class runs and registers its
bean. `@ConditionalOnProperty` is a guard Spring checks *before* calling the
method: if the named property doesn't equal `havingValue`, the method is skipped
entirely — no object gets created, no bean gets registered, as if the method
weren't there. Real example, from `DockerRuntimeConfig`:

```java
@Bean
@ConditionalOnProperty(prefix = "appfleet.runtime", name = "mode", havingValue = "docker")
DockerClient dockerClient(AgentProperties agentProperties) { ... }
```

This only fires if `application.yml` has `appfleet.runtime.mode: docker`. With
`mode: simulated` (the current value), this method is never invoked, and asking
Spring for a `DockerClient` bean anywhere else in the app would fail with
`NoSuchBeanDefinitionException`.

### Configuration binding (`@ConfigurationProperties`)

`AgentProperties` is a `record` annotated `@ConfigurationProperties(prefix =
"appfleet")`. Spring Boot reads every key under `appfleet.*` in `application.yml`
and constructs the record from it — nested records for nested YAML sections.
`appfleet.runtime.mode` in YAML becomes `agentProperties.runtime().mode()` in Java.
This is how a hand-written YAML file turns into typed, IDE-navigable Java objects
instead of `env.getProperty("appfleet.runtime.mode")` string lookups scattered
through the code.

### `@RestController` and the HTTP request path

`@RestController` is `@Controller` + `@ResponseBody` combined: Spring's embedded
Tomcat receives an HTTP request, its `DispatcherServlet` matches the path/method
against `@GetMapping`/`@PostMapping`/`@DeleteMapping`-annotated methods on
`@RestController` beans, calls the matching method, and serializes whatever it
returns straight to the HTTP response body as JSON (via Jackson, included
transitively by `spring-boot-starter-web`). A `@RequestBody` parameter is the
inverse — the incoming JSON body deserialized into that Java type before your
method runs.

### `@RestControllerAdvice` — centralized exception-to-HTTP mapping

Normally an uncaught exception in a controller method becomes a generic 500. A
class annotated `@RestControllerAdvice` with `@ExceptionHandler` methods lets you
intercept specific exception types across *every* controller and turn them into a
specific HTTP response, in one place, instead of try/catch in every controller
method. `GlobalExceptionHandler` is this module's one instance of the pattern.

### Servlet `Filter` vs Kafka `RecordInterceptor`

A `Filter` (here, `CorrelationIdFilter` extending `OncePerRequestFilter`) sits in
front of every HTTP request, regardless of which controller handles it — it runs
before and after the controller method, wrapping it. A Kafka `RecordInterceptor`
is the equivalent idea for message consumption: it runs before/after each record
is handed to a `@KafkaListener` method. Two different mechanisms because HTTP and
Kafka consumption are two different Spring subsystems with no shared request
pipeline — hence why this module needs *both*
`CorrelationIdFilter` and `CorrelationIdRecordInterceptor` to get the same
correlation-id-in-MDC behavior on both paths.

### MDC (Mapped Diagnostic Context)

MDC is a thread-local key/value map that your logging framework (Logback/SLF4J)
automatically attaches to every log line printed from that thread, without you
passing it explicitly to every log statement. Putting `correlationId` into MDC at
the start of a request/record, and clearing it at the end, is how every log line
in between gets tagged with that id — the mechanism that makes distributed tracing
possible from plain log greping. The danger: on a **pooled thread** (which Kafka
listener threads are), if you forget to clear MDC after processing a record, the
next record processed on that same thread inherits the previous record's
correlation id in its logs. That's the deliberate bug this module plants in
`CorrelationIdRecordInterceptor` (§5).

### `@Scheduled` — recurring background work

A method annotated `@Scheduled(fixedRate = ...)` (or `fixedDelay`/`cron`) on a
Spring-managed bean gets invoked repeatedly by a background task scheduler that
Spring sets up, with no manual `Timer`/`ExecutorService` bookkeeping.
`HeartbeatPublisher` and `SessionReaper` are both this shape: plain classes whose
only "framework" surface is one annotated method.

### `@KafkaListener` — the consumer side of Kafka

A method annotated `@KafkaListener(topics = "task.work")` is registered by
Spring Kafka's `KafkaListenerContainerFactory` as a consumer for that topic; the
framework manages polling, deserialization, offset commits, and thread pooling —
your method just receives one already-deserialized record at a time.
`KafkaListenerConfig` (§5) is where the container factory bean (and the
interceptor registration) lives.

---

## 2. Startup sequence

```
NodeAgentApplication.main()
 │
 ├─ SpringApplication.run(...) builds the ApplicationContext
 │
 ├─ Binds application.yml → @ConfigurationProperties beans
 │    application.yml  ──▶  AgentProperties (prefix "appfleet")
 │                           ├─ runtime.mode = "simulated" | "docker" | "swarm"
 │                           ├─ runtime.docker.host
 │                           ├─ runtime.simulated.{startLatency, failureRate, crashAfterStartProbability}
 │                           ├─ lease.{ttl, renewInterval}
 │                           ├─ session.idleTimeout
 │                           └─ heartbeat.{interval, threshold}
 │
 ├─ Component scan discovers @Configuration / @Component / @RestController classes
 │    under io.appfleet.agent.** (the package NodeAgentApplication itself lives in —
 │    Spring Boot scans that package and everything below it by convention, no
 │    explicit @ComponentScan needed)
 │
 ├─ Conditional bean evaluation (order not guaranteed across different
 │    @Configuration classes, but each conditional is self-contained so order
 │    doesn't matter for correctness):
 │    DockerRuntimeConfig.dockerClient(AgentProperties)
 │         gated on  appfleet.runtime.mode == "docker"
 │    RuntimeAutoConfig.*ContainerRuntime(...)
 │         one @Bean method per impl, each gated on the same property,
 │         exactly one method's condition is true → exactly one ContainerRuntime bean
 │
 ├─ Remaining singletons wire in via constructor injection, using whichever
 │    ContainerRuntime got created above (SessionService, TaskWorkConsumer, ...) —
 │    Spring resolves this whole dependency graph as one pass and fails fast at
 │    startup (not at first use) if any required bean is missing or ambiguous
 │
 ├─ @Scheduled beans (HeartbeatPublisher, SessionReaper) register with the task
 │    scheduler once the context is refreshed, but don't fire immediately —
 │    first execution happens after their configured initial delay/rate
 │
 └─ Embedded Tomcat opens port 8084 (spring-boot-starter-web), Kafka listener
      containers start polling their assigned partitions (spring-kafka) —
      this is the last step; the app is "up" once both of these are live
```

Key point: **property values decide the object graph, once, at startup**. Nothing
in Java code picks `DockerRuntime` vs `SimulatedRuntime` at request time —
`appfleet.runtime.mode` in `application.yml` (or an env-var override, since Spring
Boot binds environment variables to the same property paths) does, and Spring
resolves it once when the context is built, not per request or per message.

## 3. Conditional bean creation — `ContainerRuntime`

```
application.yml: appfleet.runtime.mode: simulated
                              │
                              ▼
        ┌─────────────────────────────────────────┐
        │            RuntimeAutoConfig             │
        │            (@Configuration)              │
        │                                           │
        │  @Bean                                    │
        │  @ConditionalOnProperty(havingValue=      │
        │    "docker")                              │
        │  dockerContainerRuntime(DockerClient) ────┼──▶ condition false, method never called
        │                                           │
        │  @Bean                                    │
        │  @ConditionalOnProperty(havingValue=      │
        │    "simulated")                           │
        │  simulatedContainerRuntime(...) ──────────┼──▶ condition true, INVOKED
        │                                           │        │
        │  @Bean                                    │        ▼
        │  @ConditionalOnProperty(havingValue=      │   new SimulatedRuntime(...)
        │    "swarm")                               │        │
        │  swarmContainerRuntime() ──────────────────┼──▶ condition false, skipped   ▼
        └─────────────────────────────────────────┘   registered in the context
                                                        as THE ContainerRuntime bean
```

Why three separate `@Bean` methods instead of one method with an `if/else`? Two
reasons: (1) each method can declare only the constructor parameters *that impl*
needs — `dockerContainerRuntime` needs a `DockerClient`, `swarmContainerRuntime`
needs nothing — so Spring only has to resolve the dependency for the branch that's
actually active; (2) it keeps each impl's wiring independently testable and
independently conditional, which is what makes the "exactly one bean per profile"
`ApplicationContextRunner` test (below) meaningful.

`DockerRuntimeConfig.dockerClient(...)` carries its own matching condition
(`havingValue = "docker"`). If `mode` is `simulated`, that `DockerClient` bean is
never created either — so `dockerContainerRuntime(DockerClient dockerClient)` must
never be reachable when `mode != docker`, otherwise Spring fails at startup with
`NoSuchBeanDefinitionException: No qualifying bean of type 'DockerClient' available`.
Every implementation's dependency chain has to be gated on the *same* property
value for this to stay consistent — a mismatched pair of conditions is exactly the
kind of mistake the context-runner test below exists to catch.

**Status in this tree:** `RuntimeAutoConfig` is currently an empty stub (no `@Bean`
methods yet) and `SimulatedRuntime` doesn't exist yet, even though `application.yml`
already sets `mode: simulated`. `DockerRuntime` + `DockerRuntimeConfig` are written
and staged, ready for a `mode: docker` bean method once `RuntimeAutoConfig` is
filled in. Until then, starting this app produces **no** `ContainerRuntime` bean at
all, and anything that constructor-injects one (once `SessionService` /
`TaskWorkConsumer` exist) will fail context startup.

**Safety net (spec-mandated, `04-NODE-AGENT.md:20`):** one `ApplicationContextRunner`
test per profile value. Shape of that test:

```java
new ApplicationContextRunner()
    .withUserConfiguration(RuntimeAutoConfig.class, DockerRuntimeConfig.class)
    .withPropertyValues("appfleet.runtime.mode=simulated")
    .run(context -> assertThat(context).hasSingleBean(ContainerRuntime.class));
```

`ApplicationContextRunner` boots a throwaway, minimal Spring context in-process
(no embedded server, no real Kafka/Redis) just to assert on bean wiring — much
faster than a full `@SpringBootTest`. This is what catches a typo'd `havingValue`,
or two conditions both true (`NoUniqueBeanDefinitionException`), or none true
(`NoSuchBeanDefinitionException`) — as a fast unit test instead of a boot-time
surprise.

## 4. REST flow — session provisioning

```
Client                SessionController          SessionService           ContainerRuntime        Redis
  │                        │                            │                        │                  │
  │ POST /api/v1/sessions  │                            │                        │                  │
  │ {appImageId}           │                            │                        │                  │
  ├───────────────────────▶│                            │                        │                  │
  │                        │ provision(appImageId, uid) │                        │                  │
  │                        ├───────────────────────────▶│                        │                  │
  │                        │                            │ start(ContainerSpec)   │                  │
  │                        │                            ├───────────────────────▶│                  │
  │                        │                            │                        │ (docker create/  │
  │                        │                            │                        │  start, or sim   │
  │                        │                            │                        │  state machine)  │
  │                        │                            │◀───────────────────────┤ ContainerHandle  │
  │                        │                            │                        │                  │
  │                        │                            │ save Session record ───┼─────────────────▶│
  │                        │                            │ (state=PROVISIONING)   │                  │
  │                        │◀───────────────────────────┤ Session                │                  │
  │  201 {sessionId,       │                            │                        │                  │
  │   endpoint}            │                            │                        │                  │
  │◀───────────────────────┤                            │                        │                  │
```

Step by step, in terms of actual method calls (once `session/` is built):

1. Embedded Tomcat accepts the TCP connection, `DispatcherServlet` parses the
   HTTP request and matches `POST /api/v1/sessions` to
   `SessionController.create(CreateSessionRequest)`.
2. Before that match happens, `CorrelationIdFilter` has already run: it read
   `X-Correlation-Id` off the request headers (or generated a UUID if absent),
   put it into MDC, and will write it back onto the response headers after the
   controller method returns — regardless of which controller handles the
   request, because it's a servlet filter, not controller-specific code.
3. Jackson deserializes the JSON body `{"appImageId": "..."}` into a
   `CreateSessionRequest` record — this happens automatically because the
   controller method parameter is annotated `@RequestBody`.
4. `SessionController` is intentionally thin — its only job is to call
   `sessionService.provision(request.appImageId(), currentUserId)` and map the
   returned `Session` to the `SessionResponse` DTO the client sees. No container
   logic, no Redis calls, no validation logic lives in the controller.
5. `SessionService.provision(...)` builds a `ContainerSpec` from the catalogue
   image lookup (resolved via control-api, not invented locally — see Scope in
   node-agent.md) and calls `containerRuntime.start(spec)`.
6. `ContainerRuntime` here is the interface — `SessionService`'s constructor
   only declares `ContainerRuntime`, never `DockerRuntime` or `SimulatedRuntime`
   by name, so this exact code path runs unmodified whether the bean underneath
   is real Docker or the in-memory simulator (§3).
7. `SessionService` writes the resulting `Session` record to Redis (state
   `PROVISIONING`) and returns it. `SessionController` responds `201` with
   `{sessionId, endpoint}`.
8. If anything throws — e.g. `SessionNotFoundException` on a later `GET` for an
   unknown id — `GlobalExceptionHandler` intercepts it and produces the mapped
   HTTP status as a `ProblemDetail` JSON body, instead of a raw stack-trace 500.

`SessionReaper` (a separate `@Scheduled` bean, not part of this request at all)
later scans that same Redis-stored session state on a timer and idle-reaps
sessions past `AgentProperties.session().idleTimeout()`.

**Status:** `SessionController` / `SessionService` / `Session` / `SessionReaper` are
spec'd (`04-NODE-AGENT.md:34-44`, `node-agent.md:80-91`) but not yet in the tree —
no `session/` package exists yet.

## 5. Kafka flow — task consumption

```
task-service          Kafka(task.work)      TaskWorkConsumer     TaskWorkMapper   ContainerRuntime   TaskEventsProducer   Kafka(task.events)
     │                       │                     │                    │                │                   │                   │
     │ publish TaskWork ────▶│                     │                    │                │                   │                   │
     │                       │  poll/deliver ─────▶│                    │                │                   │                   │
     │                       │  (correlation id    │                    │                │                   │                   │
     │                       │   header)           │                    │                │                   │                   │
     │                       │                     │ CorrelationIdRecordInterceptor:      │                   │                   │
     │                       │                     │  header → MDC (per record, BEFORE    │                   │                   │
     │                       │                     │  the listener method runs)           │                   │                   │
     │                       │                     │                    │                │                   │                   │
     │                       │                     │ dedupe check (Redis short-TTL key,   │                   │                   │
     │                       │                     │  idempotent consume — SET NX on the  │                   │                   │
     │                       │                     │  message id before acting on it)     │                   │                   │
     │                       │                     │                    │                │                   │                   │
     │                       │                     │ toContainerSpec() │                │                   │                   │
     │                       │                     ├───────────────────▶│                │                   │                   │
     │                       │                     │◀───────────────────┤ ContainerSpec  │                   │                   │
     │                       │                     │                    │                │                   │                   │
     │                       │                     │ start(spec) ───────┼───────────────▶│                   │                   │
     │                       │                     │◀───────────────────┼────────────────┤ ContainerHandle   │                   │
     │                       │                     │                    │                │                   │                   │
     │                       │                     │ publishStarted(handle, fencingToken) │                   │                   │
     │                       │                     ├───────────────────────────────────────────────────────▶│                   │
     │                       │                     │                    │                │  stamp fencing    │                   │
     │                       │                     │                    │                │  token + corr id  │                   │
     │                       │                     │                    │                │  header ─────────┼──────────────────▶│
     │                       │                     │                    │                │                   │                   │
     │                       │                     │ CorrelationIdRecordInterceptor:      │                   │                   │
     │                       │                     │  MDC cleared AFTER this record       │                   │                   │
```

What's actually happening under the hood:

1. `KafkaListenerConfig` (`@Configuration`) builds the
   `ConcurrentKafkaListenerContainerFactory` bean and registers
   `CorrelationIdRecordInterceptor` on it — this is what makes the interceptor run
   for every record on every listener that uses this factory, without each
   `@KafkaListener` method having to call it manually.
2. `TaskWorkConsumer.onMessage(...)`, annotated `@KafkaListener(topics =
   "task.work")`, is invoked by the listener container's poll loop once per
   record — Spring Kafka handles deserialization (via a configured
   `Deserializer`/message converter for the `common-events` `TaskWork` type)
   before your method ever sees the object.
3. `CorrelationIdRecordInterceptor.intercept(record)` runs immediately before
   step 2's method body, reading the correlation id out of the record's Kafka
   headers into MDC for that thread. Its `afterRecord(...)`/equivalent hook runs
   immediately after, clearing MDC.
4. Inside the listener method: an idempotency check against Redis (a short-TTL
   `SET NX` keyed by message id) guards against reprocessing the same message
   twice — Kafka's at-least-once delivery means redelivery is expected, not an
   edge case.
5. `TaskWorkMapper.toContainerSpec(TaskWork event)` converts the wire-format
   event into the internal `ContainerSpec` record — this mapping is the *only*
   place that knows about both the Kafka schema and the `runtime/` package's
   types; neither side depends on the other directly.
6. `containerRuntime.start(spec)` — the exact same interface method
   `SessionController`'s path calls in §4. This is the payoff of the
   `ContainerRuntime` abstraction: two completely different triggers (HTTP
   request, Kafka message) converge on one call, one bean, one behavior.
7. `TaskEventsProducer.publishStarted(...)` (or `publishFailed`/`publishSucceeded`
   depending on outcome) stamps the current `FencingToken` (from
   `NodeLeaseService`) and the correlation id (still in MDC from step 3) onto the
   outbound Kafka record's headers, then sends it to `task.events` via a
   `KafkaTemplate`.

`TaskWorkMapper` is the only seam between the `common-events` wire schema
(`TaskWork`) and the agent's internal `runtime/` types — `runtime/` package never
imports anything Kafka-related, so it stays testable and reusable without a
Kafka broker.

**Deliberate bug, by design:** `CorrelationIdRecordInterceptor` is supposed to
clear MDC after every record (step 3, second half). Skipping that clear on a
**pooled consumer thread** is the planted bug (`node-agent.md:114`, `195`) —
Kafka listener containers reuse a small pool of threads across many records, so
if thread T handles record A (correlation id X) then record B (correlation id Y)
right after, and the clear was skipped, B's log lines still show correlation id
X until something happens to overwrite MDC. Fix is a per-message clear in the
interceptor's "after" hook; the broken version is kept as a `@Disabled` regression
test so the fix has something concrete to prove itself against.

**Fencing token, concretely:** `NodeLeaseService` hands out an incrementing token
(`INCR node:lease:token:{nodeId}` in Redis) on lease acquire. Every message
`TaskEventsProducer` sends carries whatever token value this agent instance held
at that moment. Downstream consumers (task-service, query-service) compare the
incoming token against the highest one they've already seen for that node/session
and reject (don't apply) anything with a lower/stale token. This is what prevents
two agent instances that both — briefly, incorrectly — believe they hold the same
node's lease from both writing state for it.

**Status:** none of `kafka/` (`TaskWorkConsumer`, `TaskEventsProducer`,
`TaskWorkMapper`, `KafkaListenerConfig`, `CorrelationIdRecordInterceptor`) exists
in the tree yet — `common-events` dependency is in `pom.xml` (line 13-17) but
unused so far. `lease/` package (`NodeLeaseService`, `FencingToken`,
`LeaseException`) also not started.

## 6. Cross-cutting pieces and who calls them

| Piece | Mechanism | Triggered by | Talks to | Not called by |
|---|---|---|---|---|
| `CorrelationIdFilter` | servlet `Filter` (`OncePerRequestFilter`) | every HTTP request, before the controller | MDC only | Kafka path (uses `CorrelationIdRecordInterceptor` instead — different subsystem, no shared pipeline) |
| `CorrelationIdRecordInterceptor` | Spring Kafka `RecordInterceptor` | every Kafka record, before the `@KafkaListener` method | MDC only | HTTP path |
| `GlobalExceptionHandler` | `@RestControllerAdvice` + `@ExceptionHandler` | any uncaught exception thrown from a `@RestController` method | — | Kafka path (no controller-advice equivalent; consumer errors go through the listener container's own error handler instead) |
| `NodeLeaseService` | plain `@Service`-style bean wrapping `StringRedisTemplate` | agent startup (acquire), `HeartbeatPublisher` (renew), shutdown (release) | Redis | not called directly by `SessionService` or `TaskWorkConsumer` — they consume the `FencingToken` it hands out, not the lease mechanics itself |
| `HeartbeatPublisher` | `@Scheduled(fixedRate = ...)` | Spring's task scheduler, on a fixed interval from `AgentProperties.heartbeat().interval()` | Redis sorted set (`ZADD`), `NodeLeaseService.renew` | — |
| `FleetHealthIndicator` | implements `HealthIndicator`, auto-picked-up by Actuator | Actuator, whenever `/actuator/health` is polled | Redis (`ZRANGEBYSCORE`) | not part of the request/message hot path — pull-based, read-only, only runs when someone checks health |
| `ServiceRegistry` | plain bean, called from lifecycle hooks | agent boot (register), shutdown (deregister) | Redis hash | control-api reads this Redis key directly — no agent-side lookup endpoint |

## 7. What's not an HTTP endpoint, on purpose

Per `node-agent.md:164-175`: heartbeat, node lease, and service registry are all
internal Redis operations, not REST-exposed — nothing external needs to call them,
so there's no `POST /heartbeat` or similar. `ContainerRuntime.list()/logs()/status()`
are invoked internally by session and task-consumption code only; no
`GET /containers` admin surface exists in S5 — it's named in the spec as a
plausible later add, not a requirement. Only `/api/v1/sessions/**` and Actuator
(`/actuator/health|info|metrics`) are client-facing in this slice.

## 8. Build-order dependency map

This is the order pieces have to exist in for the above flows to *compile and
run*, not necessarily the order to build them in — the spec deliberately wants
lease/fencing and the MDC bleed built broken-first, then fixed, as a teaching
device (`node-agent.md:197-204`):

```
AgentProperties ──▶ RuntimeAutoConfig ──▶ ContainerRuntime bean ──┬──▶ SessionService ──▶ SessionController
                         │                                        │
                DockerRuntimeConfig                               └──▶ TaskWorkConsumer ◀── TaskWorkMapper ◀── common-events
             (DockerClient, mode=docker)                                    │
                                                                             ▼
NodeLeaseService ◀── AgentProperties.lease            TaskEventsProducer ──▶ Kafka(task.events)
       │
       ▼
HeartbeatPublisher ──▶ ServiceRegistry, FleetHealthIndicator
```

Everything above the `ContainerRuntime` bean line is unblocked today (`runtime/` +
`config/` packages exist). Everything below/right of it — `session/`, `lease/`,
`kafka/`, `registry/`, `health/` — is spec'd but not yet started, and per
`node-agent.md:17`, the agent is meant to be developed against `SimulatedRuntime` +
hand-published Kafka messages, so none of this is blocked on task-service existing
as a real, running service.

## 9. Multi-tenancy of `ContainerRuntime`

Two different questions hide under "multi-tenancy" here — worth separating,
because this design answers them differently.

### 9.1 Can one agent JVM run more than one runtime *type* at once?

No, by construction. §3 shows exactly one `@ConditionalOnProperty` branch
evaluates true per process, so exactly one `ContainerRuntime` bean exists in the
context for the whole lifetime of that JVM. There is no runtime-time switch, no
per-request choice of "use Docker for this one, simulate that one" — `mode` is
read once at startup and fixes the bean for good. To run `docker` and `simulated`
side by side you'd run two separate agent processes, each with its own
`application.yml` / env override, not one process serving both.

This is a deliberate simplification, not a limitation someone forgot to lift:
`SessionService`, `TaskWorkConsumer`, and everything else that depends on
`ContainerRuntime` are written against the interface and have no branch anywhere
for "which impl am I talking to." Multi-type support inside one process would mean
either injecting a `Map<String, ContainerRuntime>` keyed by mode and picking one
per call (not spec'd, not needed for S5) or running multiple `ContainerRuntime`
beans with qualifiers — both are extra machinery the spec explicitly doesn't ask
for.

### 9.2 Can one runtime instance host work for more than one tenant/node/user at once?

Yes — this is the multi-tenancy that actually exists, and it's handled by data,
not by beans:

- **Per spec header**, one agent instance maps to one (simulated) node
  (`04-NODE-AGENT.md:3`). But the *containers* that one instance's runtime
  manages are not all the same tenant — every session (`POST /api/v1/sessions`)
  is tied to a different `userId`, and every task (`task.work` message) belongs
  to a different aggregate. `ContainerRuntime` itself has no concept of
  "tenant" in its method signatures (`start`/`stop`/`status`/`logs`/`list` all
  key off `containerId` only) — isolation between tenants is enforced entirely
  by `SessionService`/`Session` (which `userId` owns which `sessionId` →
  `containerId`) and by Redis-stored state, not by the runtime layer.
- **`DockerRuntime.list()`** (`DockerRuntime.java:82-85`) filters
  `dockerClient.listContainersCmd()` by the `io.appfleet.nodeId` label every
  container is created with (`DockerRuntime.java:19,32`). That label is what lets
  a single shared Docker daemon host containers for **multiple agent instances**
  (multiple simulated nodes) without one instance's `list()` call leaking another
  node's containers — the multi-tenancy boundary there is the Docker daemon being
  shared infrastructure, and the label is the tenancy tag on top of it.
- **`SimulatedRuntime`** (not yet built) is spec'd as a `ConcurrentHashMap`
  keyed by container id (`node-agent.md:55`) — concurrent sessions/tasks each get
  their own map entry and their own scheduled state-transition timeline, so
  multiple "tenants" run independently in memory with no cross-talk, same shape
  as real Docker's per-container isolation.
- **`SwarmRuntime`** is a stub only (`node-agent.md:57`, `146`) — genuine
  multi-node scheduling/multi-tenancy at the orchestration layer is explicitly
  out of scope for S5, not faked.

So: no multi-tenancy across runtime *implementations* in one process (§9.1), but
ordinary multi-tenancy across concurrent *containers* within whichever single
implementation is active — enforced by container id + node-id labeling +
Redis-stored ownership, not by anything in the `ContainerRuntime` interface
itself.
