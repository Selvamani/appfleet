# node-agent — implementation spec

**[← Build Guide](00-BUILD-GUIDE.md)** · Slice **S5** · Port **8084+** · **One instance per (simulated) node**

The container orchestration piece — your home ground. Consumes work, drives containers through a **pluggable runtime**, reports status, and hosts **on-demand sessions** *(Apptbuilder's shape)*. This is the service where a decade of your experience shows in the design decisions.

---

## Core abstraction — `ContainerRuntime`

*(Your three `ContainerManager`s from Automatter, redone in Spring.)*

```
ContainerRuntime            start(spec) · stop(id) · status(id) · logs(id) · list()
 ├── DockerRuntime          real containers via docker-java — the default for demos
 ├── SimulatedRuntime       state machine + configurable latency/failure — CI and load tests
 └── SwarmRuntime           stretch; stub it honestly or omit
```

- [ ] One interface, implementations selected by **`@ConditionalOnProperty(appfleet.runtime)`** — write the `ApplicationContextRunner` test proving exactly one is wired per profile
- [ ] **`SimulatedRuntime` is not a cop-out — it is what makes load testing possible.** Configurable start latency, failure rate, and crash-after-start. Say that in the code doc
- [ ] Container specs come from the **catalogue** (image version, resources, env) — the agent never invents configuration

## Node lease — the distributed lock done honestly

**Two agents must never drive the same node.**

- [ ] Redis lease: `SET node:lease:{nodeId} {instanceId} NX PX {ttl}` — heartbeat-renewed, expires on crash
- [ ] **Fencing token:** the lease carries an incrementing token; every status event includes it; consumers reject stale tokens
- [ ] **Build the failure first:** pause an agent (simulate GC/partition) past lease expiry, let a second agent acquire, resume the first — **without fencing, watch the stale writer corrupt state; with fencing, watch it get rejected.** This is the Redlock debate made concrete, in your own code
- [ ] Write the trade-off note: Redis lease vs Postgres advisory lock vs etcd — you have run all three ecosystems
- [ ] **One sentence in the code doc:** the fencing token is the **anti-CRDT** — Garuda merged concurrent writers (`ORMultiMap`); this design makes them impossible, because control-plane state cannot be merged. Same author, opposite regime, both correct

## Sessions — on-demand provisioning *(Apptbuilder)*

```
POST /api/v1/sessions {appImageId}  → 201 {sessionId, endpoint}
GET  /api/v1/sessions/{id}          → status, startedAt, lastActivityAt
DELETE /api/v1/sessions/{id}
```

- [ ] Session = a container from a catalogue image, tied to a user, **idle-reaped** after N minutes without activity
- [ ] Reaper honours the same claim discipline as task-service *(no double-reap when agents are scaled)*
- [ ] **Measure:** cold-start time per image; sessions per node before latency degrades *(with `SimulatedRuntime` under load)*; warm-pool vs cold-start comparison. **These are the Apptbuilder numbers you never captured in production — capture them now**

## Heartbeat and registry

- [ ] Heartbeat → Redis **sorted set** scored by timestamp — *"which nodes are alive?"* is `ZRANGEBYSCORE`, O(log n)
- [ ] **Service registry:** agents register `{logicalName → endpoint}` in Redis *(Automatter's `EndpointResolver`)*; control-api resolves logical names
- [ ] Custom **`HealthIndicator`**: fleet health = fraction of leased nodes heartbeating within threshold — surfaces in `/actuator/health`

## Events out

- [ ] `task.events`: `TaskStarted/Succeeded/Failed` + **fencing token** + correlation id header
- [ ] **MDC across Kafka:** read correlation id from the incoming message header → MDC → outgoing headers. **The hard version of tracing, and the impressive one**
- [ ] **Build the MDC leak:** skip the per-message clear, run two tasks on one pooled thread, watch one log the other's correlation id. *(The bug you already knew about in 2018 — `ActivityIdFilter` cleared per request. Same bug, new decade.)*

## Deliberate bugs owned here

| Build it broken | Then |
|---|---|
| **Stale writer without fencing token** | fencing rejection |
| **MDC bleed across pooled threads** | per-message clear |
| **Double-reap of idle sessions when scaled** | claim discipline |
| **Agent crash mid-task** | lease expiry → reclaim → retry (with task-service) |

## Definition of done

- [ ] `mvn verify` green — Testcontainers Redis + Kafka; `SimulatedRuntime` in tests
- [ ] Demo path: `docker compose` runs **two agents + real Docker runtime** for one node each, sessions provision and reap
- [ ] The fencing-token drill and the session-density numbers in `/docs`

> **Unlocks:** *"Distributed lock — is it safe?"* *(with the fencing demo)* · *"How do you trace across a broker?"* · *"Tell me about container orchestration"* — now with running code next to the production story
