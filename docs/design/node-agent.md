# node-agent — design

**Spec:** [04-NODE-AGENT.md](../specs/project/04-NODE-AGENT.md) · Slice **S5** · Port **8084+**, one instance per (simulated) node · Package root `io.appfleet.agent`

This is the working design for the service, written before the code, so the interface shapes get decided once instead of drifting slice by slice. The spec says *what* and *why*; this doc says *how it's actually going to be put together* in this repo.

## Scope

**Owns:** Node, Session, container lifecycle, the node lease.

**Does not own:** the catalogue (`BaseImage`/`AppImage`/`ImageVersion` live in control-api — the agent only reads a resolved `ContainerSpec`, never invents image config), the task/attempt state machine (task-service owns that; the agent just reports events against it).

**Consumes:** `task.work` (from task-service, once it exists).
**Produces:** `task.events`.
**Talks to directly:** Redis (lease, heartbeat, registry), Docker daemon (via `docker-java`), Postgres — not needed for S5 in the current plan; sessions are tracked in Redis + the runtime's own state, not a dedicated schema. Revisit if session history needs to survive a restart.

Until task-service is built, the agent is developed and tested against `SimulatedRuntime` plus hand-published Kafka messages — no blocking dependency on the rest of the build order.

## Package layout

Package-by-feature, not package-by-layer. A layer split (`controller/`, `service/`, `repository/`) scatters one feature across packages and enforces no boundary. Feature packages mirror the module-per-service boundary discipline already in place one level down, and let implementation classes go package-private:

```
io.appfleet.agent
├── NodeAgentApplication
├── runtime/     ContainerRuntime, ContainerSpec, ContainerHandle, ContainerStatus, ContainerState,
│                SimulatedRuntime, DockerRuntime, SwarmRuntime, RuntimeAutoConfig
├── lease/       NodeLeaseService, FencingToken, LeaseException
├── session/     SessionController, SessionService, Session, SessionState, SessionReaper,
│                CreateSessionRequest, SessionResponse, SessionNotFoundException
├── registry/    ServiceRegistry, HeartbeatPublisher
├── health/      FleetHealthIndicator
├── kafka/       TaskWorkConsumer, TaskEventsProducer, TaskWorkMapper, KafkaListenerConfig,
│                CorrelationIdRecordInterceptor
└── config/      AgentProperties (@ConfigurationProperties), CorrelationIdFilter, GlobalExceptionHandler
```

`SimulatedRuntime` / `DockerRuntime` / `SwarmRuntime` stay package-private (`class`, not `public class`) — only `ContainerRuntime` and `RuntimeAutoConfig` are public. Callers can never `new` a concrete runtime, only get the wired bean picked by `@ConditionalOnProperty`. Same pattern applies to `session/` and `lease/`: only the class other packages actually call is public.

**Skeleton note:** the current `ContainerRuntime.java` sits in `registry/` as an empty stub. Per this layout it belongs in `runtime/`, with the method set below. Not fixed yet — flagged for a follow-up edit.

## Class structure

Per-package class list: what each type is, what it owns, and its public surface. Records are immutable; `class` entries are Spring-managed beans unless noted otherwise. Only the constructor-injected collaborators are listed, not every field.

### `runtime/`

| Class | Kind | Visibility | Responsibility |
|---|---|---|---|
| `ContainerRuntime` | interface | public | The one abstraction task-consumption and sessions code against. |
| `ContainerSpec` | record | public | `(String image, String nodeId, double cpuLimit, long memoryLimitMb, Map<String,String> env)`. Arrives already resolved — built from the inbound `TaskWork` event by `TaskWorkMapper`, or from the session catalogue lookup. Never constructed from a raw image name inside the agent. |
| `ContainerHandle` | record | public | `(String containerId, String nodeId, String image, Instant startedAt)` — what `start()` returns. |
| `ContainerState` | enum | public | `PENDING, RUNNING, FAILED, STOPPED, CRASHED`. |
| `ContainerStatus` | record | public | `(String containerId, ContainerState state, String detail, Instant observedAt)`. |
| `SimulatedRuntime` | class | package-private | `ConcurrentHashMap<String, ContainerStatus>` as backing state; state transitions driven by a scheduled executor honoring configured start latency / failure rate / crash-after-start probability from `AgentProperties`. |
| `DockerRuntime` | class | package-private | Wraps a `com.github.dockerjava.api.DockerClient` bean; translates `ContainerSpec` → `CreateContainerCmd`. |
| `SwarmRuntime` | class | package-private | Every method `throw new UnsupportedOperationException("Swarm runtime not implemented")` — stub honestly, per spec. |
| `RuntimeAutoConfig` | `@Configuration` | public | One `@Bean ContainerRuntime` method per impl, each `@ConditionalOnProperty(prefix = "appfleet.runtime", name = "mode", havingValue = "simulated"/"docker"/"swarm")`. |

```java
public interface ContainerRuntime {
    ContainerHandle start(ContainerSpec spec);
    void stop(String containerId);
    ContainerStatus status(String containerId);
    String logs(String containerId);
    List<ContainerHandle> list();
}
```

Full narrative on the three implementations and build order is in [Core abstraction](#core-abstraction--containerruntime) below.

### `lease/`

| Class | Kind | Visibility | Responsibility |
|---|---|---|---|
| `NodeLeaseService` | class | public | `FencingToken acquire(String nodeId, String instanceId)`, `void renew(String nodeId, String instanceId)`, `void release(String nodeId, String instanceId)`. Wraps `StringRedisTemplate`; `SET NX PX` on acquire, token is `INCR node:lease:token:{nodeId}` read back at acquire time. |
| `FencingToken` | record | public | `(long value) implements Comparable<FencingToken>` — carried on every outbound `task.events` message. |
| `LeaseException` | exception | public | Unchecked; thrown on failed acquire/renew (lease held by another instance, or lost mid-task). |

### `session/`

| Class | Kind | Visibility | Responsibility |
|---|---|---|---|
| `SessionController` | `@RestController` | public | `POST /api/v1/sessions`, `GET /api/v1/sessions/{id}`, `DELETE /api/v1/sessions/{id}`. Thin — delegates to `SessionService`. |
| `SessionService` | class | public | `Session provision(String appImageId, String userId)`, `Session get(String sessionId)`, `void terminate(String sessionId)`, `void touch(String sessionId)` (updates `lastActivityAt`, called on session activity). Orchestrates `ContainerRuntime` + Redis-backed `Session` storage — no Postgres (see Scope). |
| `Session` | record | public | `(String id, String appImageId, String userId, String containerId, String nodeId, SessionState state, Instant startedAt, Instant lastActivityAt)`. State transitions produce a new record, overwritten in Redis. |
| `SessionState` | enum | public | `PROVISIONING, RUNNING, IDLE, REAPED`. |
| `SessionReaper` | class, `@Scheduled` | public | Scans Redis for sessions idle past `AgentProperties.session().idleTimeout()`; claims each candidate with a short-TTL Redis `SET NX` before tearing it down, so two scaled agent instances never double-reap the same session. |
| `CreateSessionRequest` | record | package-private | `(String appImageId)` — request body. |
| `SessionResponse` | record | package-private | `(String sessionId, String endpoint)` — response body. |
| `SessionNotFoundException` | exception | package-private | Mapped to `404` by `GlobalExceptionHandler`. |

### `registry/`

| Class | Kind | Visibility | Responsibility |
|---|---|---|---|
| `ServiceRegistry` | class | public | `void register(String logicalName, String endpoint)`, `void deregister(String logicalName)`. Writes on boot/shutdown; control-api reads the Redis hash directly, so no lookup method is needed here. |
| `HeartbeatPublisher` | class, `@Scheduled` | public | On a fixed interval: `ZADD` this agent into the heartbeat sorted set, and call `NodeLeaseService.renew(...)` for the node it holds. |

### `health/`

| Class | Kind | Visibility | Responsibility |
|---|---|---|---|
| `FleetHealthIndicator` | class implements `HealthIndicator` | public | `Health health()` — `ZRANGEBYSCORE` the heartbeat set, report the fraction of leased nodes heartbeating within threshold. Surfaces under `/actuator/health`. |

### `kafka/`

| Class | Kind | Visibility | Responsibility |
|---|---|---|---|
| `TaskWorkConsumer` | class, `@KafkaListener(topics = "task.work")` | public | Consumes `TaskWork` (from `common-events`), maps it to `ContainerSpec` via `TaskWorkMapper`, calls `ContainerRuntime.start`, reports outcome through `TaskEventsProducer`. Idempotent: dedupes on message id via a short-TTL Redis key before acting. |
| `TaskEventsProducer` | class | public | `publishStarted`, `publishSucceeded`, `publishFailed` — each stamps the current `FencingToken` and the correlation id header onto the outbound `task.events` record. |
| `TaskWorkMapper` | class | package-private | `ContainerSpec toContainerSpec(TaskWork event)` — the one seam between the `common-events` schema and the agent's internal `runtime/` types. Keeps `runtime/` ignorant of Kafka. |
| `KafkaListenerConfig` | `@Configuration` | public | Listener container factory bean; registers `CorrelationIdRecordInterceptor`. |
| `CorrelationIdRecordInterceptor` | class implements `RecordInterceptor<String, Object>` | package-private | Reads the correlation id header into MDC before each record, clears MDC after — per-message, not per-poll. This is the class the deliberate MDC-bleed bug skips. |

### `config/`

| Class | Kind | Visibility | Responsibility |
|---|---|---|---|
| `AgentProperties` | `@ConfigurationProperties(prefix = "appfleet")` | public | Nested records: `runtime(mode, simulated(startLatency, failureRate, crashAfterStartProbability))`, `lease(ttl, renewInterval)`, `session(idleTimeout)`, `heartbeat(interval, threshold)`. |
| `CorrelationIdFilter` | `OncePerRequestFilter` | package-private | `X-Correlation-Id` in, generated if absent, MDC, out on response — per repo convention. Defined locally rather than shared: `common-security` is JWT-only per the build guide, and one filter class isn't worth a shared module yet. |
| `GlobalExceptionHandler` | `@RestControllerAdvice` | public | Maps `SessionNotFoundException` → 404, `LeaseException` → 409, validation failures → 400, all as `ProblemDetail`. |

`ContainerSpec`, `Session`, `FencingToken` are the only types referenced across two or more packages inside this module; everything else is package-private on purpose.

## Core abstraction — `ContainerRuntime`

```java
public interface ContainerRuntime {
    ContainerHandle start(ContainerSpec spec);
    void stop(String containerId);
    ContainerStatus status(String containerId);
    String logs(String containerId);
    List<ContainerHandle> list();
}
```

`ContainerSpec` — plain record: image reference, resource limits (cpu/mem), env vars, target node id. No behavior, no catalogue lookups — that resolution happens in control-api before the spec reaches the agent.

Implementations:

| Impl | Purpose | Notes |
|---|---|---|
| `SimulatedRuntime` | Default for tests, CI, load tests | In-memory state machine per container; configurable start latency, failure rate, crash-after-start. Built first — it's what makes load testing possible at all, not a placeholder for the real thing. |
| `DockerRuntime` | Real containers | Via `docker-java`. Built second, once `SimulatedRuntime` has proven the interface shape. |
| `SwarmRuntime` | Stretch | Stub honestly (`UnsupportedOperationException` + comment) or omit — do not fake it. |

Selection: `@ConditionalOnProperty(prefix = "appfleet", name = "runtime", havingValue = "simulated"|"docker")`. One `ApplicationContextRunner` test asserts exactly one `ContainerRuntime` bean exists per profile value — this is the test that proves the conditional wiring, not just the happy path.

## REST endpoints

Base path `/api/v1`, `ProblemDetail` errors, `X-Correlation-Id` in/out, per repo convention.

### Sessions — on-demand provisioning (Apptbuilder shape)

| Method | Path | Request | Response | Notes |
|---|---|---|---|---|
| `POST` | `/api/v1/sessions` | `{appImageId}` | `201 {sessionId, endpoint}` | Provisions a container from a catalogue image, tied to the calling user. Starts the idle timer. |
| `GET` | `/api/v1/sessions/{id}` | — | `200 {status, startedAt, lastActivityAt}` | |
| `DELETE` | `/api/v1/sessions/{id}` | — | `204` | Explicit teardown; same code path the idle-reaper uses. |

Session state (`PROVISIONING → RUNNING → IDLE → REAPED`) is a small state machine — not exposed as its own endpoint, only surfaced via `status` on the GET.

### Not endpoints — deliberately

- **Heartbeat** — internal, Redis sorted set only (`ZRANGEBYSCORE`). No `POST /heartbeat`; there's nothing external that needs to call it.
- **Node lease** — internal Redis operation triggered on agent startup/shutdown, not client-facing.
- **Service registry** — agents self-register `{logicalName → endpoint}` in Redis on boot; control-api reads the registry directly, no lookup endpoint on the agent side.

### Actuator

- `/actuator/health` — includes a custom `HealthIndicator`: fleet health = fraction of leased nodes heartbeating within threshold.
- `/actuator/info`, `/actuator/metrics` — standard, per the shared `management.endpoints.web.exposure.include` convention already in `application.yml`.

Container inspection (`list`/`logs`/`status` on `ContainerRuntime`) is **not** exposed over HTTP in S5 — it's invoked internally by the session and task-consumption code paths. An admin/debug endpoint over it is a plausible later add, not required by the spec; skip it unless a real need shows up.

## Node lease and fencing

- Redis: `SET node:lease:{nodeId} {instanceId} NX PX {ttl}`, renewed on heartbeat.
- Lease carries an incrementing fencing token; every `task.events` message the agent emits carries it.
- Consumers (task-service, query-service) reject events with a stale token.
- Build order: **broken first.** Pause an agent past lease TTL (simulate GC pause / partition), let a second agent acquire the lease, resume the first, watch the stale writer corrupt state with no fencing. Add fencing, repeat, watch it get rejected instead.
- Write the trade-off note (Redis lease vs Postgres advisory lock vs etcd) into `/docs` once the drill is done.

## Heartbeat and registry

- Heartbeat: Redis sorted set, scored by timestamp. "Which nodes are alive" = `ZRANGEBYSCORE(now - threshold, now)`.
- Registry: agents write `{logicalName → endpoint}` on boot, refreshed with the heartbeat. control-api resolves logical names against it (Automatter's `EndpointResolver`, in Redis).

## Kafka — events in and out

- **In:** `task.work` (6 partitions, keyed by aggregate id — see root `docker-compose.yml`). Idempotent consumption.
- **Out:** `task.events` — `TaskStarted` / `TaskSucceeded` / `TaskFailed`, fencing token, correlation id header.
- **MDC across the broker:** correlation id read from the inbound message header → MDC → written to outbound headers. This is the hard version of the tracing story (the easy version is a servlet filter; this is the same discipline across an async boundary).
- **Deliberate bug:** skip the per-message MDC clear, run two tasks on one pooled consumer thread, watch one log the other's correlation id. Same bug class as `ActivityIdFilter` in 2018, different decade. Fix with a per-message clear, keep the broken version as a `@Disabled` test.

## Deliberate bugs, build order

| Bug | Fix | Depends on |
|---|---|---|
| Stale writer without fencing token | Fencing token + rejection | Lease implemented |
| MDC bleed across pooled threads | Per-message clear | Kafka consumer wired |
| Double-reap of idle sessions when scaled | Claim discipline (same pattern as task-service's `SKIP LOCKED`) | Sessions + reaper, 2 agent instances |
| Agent crash mid-task | Lease expiry → reclaim → retry | Lease + task-service round trip |

## Testing

- Unit: `SimulatedRuntime` state machine (start→running, start→failed, running→crashed) — no containers involved.
- `ApplicationContextRunner`: conditional wiring of `ContainerRuntime`.
- Integration: Testcontainers Redis + Kafka for lease, heartbeat, consumer/producer round trip.
- Demo path: `docker compose` running **two agents against real Docker**, one simulated node each — sessions provision and reap, fencing drill reproducible on demand.

## Definition of done (S5)

- `mvn verify` green, Testcontainers included.
- Two-agent demo works from a clean `docker compose up`.
- Fencing-token drill and session-density numbers (cold start, sessions/node before degradation, warm-pool vs cold-start) written up in `/docs`.

## Open questions / deferred

- Does session state need to survive an agent restart (i.e., a Postgres table), or is Redis-only acceptable for the portfolio scope? Default: Redis-only, revisit if the reaper drill needs replay-after-crash.
- `SwarmRuntime` — stub or omit; decide when S5 starts, not before.
- Admin/debug HTTP surface over `ContainerRuntime.list()/logs()` — not in scope now, note as a named omission if asked "how would you debug a stuck container" in an interview.
