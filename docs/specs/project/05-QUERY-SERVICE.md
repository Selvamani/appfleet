# query-service — implementation spec

**[← Build Guide](00-BUILD-GUIDE.md)** · Slice **S6** · Port **8085** · Schema **`query`**

The CQRS read side. Projects `deployment.events` and `task.events` into read-optimised tables, caches hot views in Redis, and answers every dashboard/history question — so the write model never grows read-shaped indexes.

> **The one-line defence:** *"CQRS here means separate models, not event sourcing — the write side stays authoritative, this side is a disposable projection I can rebuild from the topic."* Know both halves of that sentence.

---

## Read models — shaped by query, not by entity

```
deployment_summary      one row per deployment: denormalised app/env/release names,
                        current status, task counts, durations   ✱ the dashboard row
application_history     per app: releases, deployments, success rate over time
fleet_view              per node: leased-by, sessions, last heartbeat, health
task_timeline           flattened task+attempt rows for the history screen
projection_offset       consumer group offsets / high-water marks per projection
```

- [ ] **Denormalisation is the design here, not a compromise** — write down the contrast with control-api's 3NF schema; the pair is the normalisation interview answer from both directions
- [ ] Projections are **idempotent** (event id checked) and **replayable**: `POST /admin/projections/{name}/rebuild` truncates and re-consumes from earliest. **Rebuild-from-topic is the property that makes this CQRS and not just a cache**

## Projection discipline

- [ ] One consumer group per projection — they advance independently; one slow projection never blocks another
- [ ] **Out-of-order tolerance:** events for one aggregate arrive ordered *(partition key)*, but across aggregates nothing is promised — the projection must not assume global order. Test it with interleaved streams
- [ ] **Staleness is visible, not hidden:** every read response carries `asOf` *(the projection's high-water timestamp)*. **Eventual consistency you can see is a feature; hidden it is a bug** — that phrasing is an interview answer
- [ ] Measure and expose **projection lag** as a Micrometer gauge — it is the read side's honest SLO

## Caching — the deep treatment *(your `DALCacheApi`, grown up)*

- [ ] **Cache-aside** in Redis for `deployment_summary` and `fleet_view`; TTL as backstop only
- [ ] **Event-driven invalidation:** the projection evicts affected keys as it applies events — invalidation keyed by aggregate id, not `flushAll`
- [ ] **A dedicated eviction test** — update flows through, stale value provably gone *(you had one in 2018; most codebases never do)*
- [ ] **Build the stampede:** hot key expires under concurrent load, everyone recomputes. Fix with single-flight *(a short Redis lock around recompute)* and jittered TTLs. Capture the thundering-herd graph before/after
- [ ] **Measure hit ratio** under load and expose it as a metric — the number that justifies the cache's existence

## Endpoints

```
GET /api/v1/dashboard/deployments?cursor=&status=&teamId=     ✱ the hot path
GET /api/v1/applications/{id}/history
GET /api/v1/fleet
GET /api/v1/deployments/{id}/timeline
POST /admin/projections/{name}/rebuild                        (OPERATOR)
```

- [ ] Read-only Spring Data JDBC or plain `JdbcClient` — **no JPA here**, and say why: no dirty checking, no lazy loading, no persistence context — a projection needs none of it *(that contrast is itself an interview answer)*
- [ ] Team-scoped filtering enforced at the query level — a VIEWER's dashboard physically cannot select another team's rows

## Deliberate bugs owned here

| Build it broken | Then |
|---|---|
| **Stale cache after update** — no invalidation, TTL only | event-driven eviction + the eviction test |
| **Cache stampede** on hot key expiry | single-flight + TTL jitter |
| **Non-idempotent projection** — replay doubles the counts | event-id dedup, then a clean rebuild |
| **Global-order assumption** — interleaved events corrupt a view | per-aggregate ordering only |

## Definition of done

- [ ] `mvn verify` green — Testcontainers Postgres + Redis + Kafka
- [ ] **The rebuild drill:** truncate, replay from earliest, diff against the write side — zero divergence
- [ ] Hit ratio, projection lag and the stampede before/after in `/docs`

> **Unlocks:** *"CQRS — does it need event sourcing?"* · *"What's hard about caching?"* *(invalidation — demonstrated, not recited)* · *"How do you handle eventual consistency?"* *(`asOf`, visible staleness)* · *"When would you not use JPA?"*
