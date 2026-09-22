# Two-developer split — build plan

**[← The Spring Boot Project](../SPRING-PROJECT.md)** · **[← Interview Preparation](../00-INDEX.md)**

> **Diverges from [00-BUILD-GUIDE.md](00-BUILD-GUIDE.md)'s solo order.** Solo plan builds one service, splits late (S4-S6) — a single dev needs always-green. Two devs need a boundary from day one, else they block each other. This is service-first, contract-first via `common-events`, not monolith-first.

## The split

**Track A** (sync half): control-api, identity-service, catalogue module.
**Track B** (async half): task-service, node-agent, query-service.

Boundary: Kafka topics (`deployment.commands`, `task.work`, `task.events`, `deployment.events`). Both code against `common-events` schemas from Week 1. No shared code beyond that.

## Week by week

| Week | Dev A (control-api, identity) | Dev B (task-service, node-agent, query-service) | Friday demo |
|---|---|---|---|
| 1 | Repo skeleton, `common-events`, `common-security`, `fleet-audit-starter`, docker-compose (Postgres/Redis/Kafka KRaft), topics with partition counts, healthchecks (joint). control-api schema (App/Release/Environment/Deployment), Flyway, basic CRUD REST, no auth (permit-all temp) | Same infra (joint). task-service schema (Task/Attempt), Kafka consumer stub on `deployment.commands`, SKIP LOCKED claim | `docker compose up -d` all healthy. Register app+release via REST. Manual Kafka publish to `deployment.commands`, task-service logs consume |
| 2 | Deployment FSM, transactional outbox (real publish on deploy), idempotency key on POST | node-agent skeleton, Simulated `ContainerRuntime`, consume `task.work`, emit `task.events` | POST /deployments runs full pipeline end to end: outbox, Kafka, task-service, node-agent (simulated), status update. No auth, no read side yet |
| 3 | Extract identity-service: JWT issue (RSA), basic Role, no full RBAC. control-api validates JWT via `common-security` | query-service skeleton, CQRS projection from `task.events`/`deployment.events`, GET /dashboard, Redis cache-aside | Full life-of-a-deployment sequence walkable: authenticated POST, pipeline runs, GET /dashboard shows result (`asOf` staleness visible) |
| 4 | Full RBAC: Team/Permission/scoped grants, `PermissionEvaluator`, build IDOR then fix, refresh rotation, Redis denylist | node-agent real Docker `ContainerRuntime`, Redis lease + fencing token, basic on-demand sessions | Deployer on Team A blocked 403 on Team B app. `POST /sessions` starts real Docker container |
| 5 | Rate limiting (token bucket), cursor pagination, `ProblemDetail` everywhere, catalogue module (BaseImage/AppImage/ImageVersion) | task-service retry+jitter, DLQ + replay endpoint, consumer-group scaling test (partitions vs consumers) | Kill task on purpose, dead-letter, operator replays it. Catalogue publish then session launch from published image |
| 6 | SQL bugs on control-api schema: N+1 fixed 3 ways, `@Version` optimistic lock demo, deadlock repro+fix, EXPLAIN ANALYZE+index | MDC correlation-id across Kafka (leak bug then fix), 3 business metrics, structured logging | Trace one correlation ID through logs across all 5 services, single request |
| 7 | Saga: deployment rollback compensation, State pattern step executors (Shell/Http/Wait) | query-service cache stampede repro+fix, `@Scheduled` reaper (fix fires-on-every-instance) | Trigger failed deploy, rollback runs, dashboard shows ROLLED_BACK. Reaper cleans idle session live |
| 8 | Resilience (timeout/retry+jitter/circuit breaker/bulkhead) on control-api+identity calls. Client SDK module | Same resilience on task-service/node-agent/query-service. Load test (k6): scale task-service 1→3→6, chart throughput | Load test charts, capacity note (what breaks first), README+diagrams, CI green |

Never two weeks without joint green build (`docker compose up -d && mvn verify`, both tracks). Cut query-service CQRS depth first if behind — not the write-ups.

Detailed Week 1-2 task lists: [Dev A spec](08-WEEK-1-2-DEV-A.md) · [Dev B spec](09-WEEK-1-2-DEV-B.md).

---

## Repo and git management

**One repo, trunk-based, short branches.** Two devs, tight weekly cadence — long-lived branches cause merge pain exactly where it hurts (`common-events`).

### Skeleton — Day 1, both devs together

```
mkdir appfleet && cd appfleet && git init
mkdir -p common-events/src/main/java/io/appfleet/events
mkdir -p common-security/src/main/java/io/appfleet/security
mkdir -p fleet-audit-starter/src/main/java/io/appfleet/audit
mkdir -p control-api/src/main/java/io/appfleet/control
mkdir -p identity-service/src/main/java/io/appfleet/identity
mkdir -p task-service/src/main/java/io/appfleet/task
mkdir -p node-agent/src/main/java/io/appfleet/agent
mkdir -p query-service/src/main/java/io/appfleet/query
mkdir -p client-sdk/src/main/java/io/appfleet/client
mkdir docs
```

- [ ] Parent `pom.xml`: `<packaging>pom</packaging>`, `<modules>` listing all 9 above, `dependencyManagement` pinning Boot 4.1.x BOM, Java 21 `<release>`
- [ ] `docker-compose.yml` — Postgres 16, Redis 7, Kafka KRaft, healthchecks, `depends_on: condition: service_healthy` (Build Guide §Slice 0)
- [ ] `.gitignore` — `target/`, `.env`, IDE dirs
- [ ] `.env.example` committed; `.env` never committed
- [ ] `README.md` stub — filled properly in Week 8

### Branching

- [ ] `main` protected: no direct push, PR + green CI required to merge
- [ ] Branch per checklist item, not per service: `feat/<module>-<short-name>` — e.g. `feat/control-api-schema`, `feat/task-service-skip-locked`
- [ ] Rebase on `main` before opening PR, not merge commits from `main` into feature branches
- [ ] `common-events` / `common-security` changes: **PR same day, fast review, other dev pulls `main` before continuing on anything touching that event**. These two modules are the seam — treat every change to them as blocking the other dev until merged
- [ ] Own-service PR (control-api-only, task-service-only, etc.): self-merge once CI green — don't wait on review, velocity matters more than a second pair of eyes on your own service's internals
- [ ] Cross-boundary PR (touches the other dev's module, or `common-*`): the other dev reviews before merge

### Commits

- [ ] Conventional Commits: `feat(control-api): deployment FSM enum + legal transitions`
- [ ] One checklist item per commit where practical — commit history is graded evidence per Build Guide
- [ ] Commit incomplete work too, end of every session

### CI

- [ ] GitHub Actions: `mvn verify` on every push to `main` and every PR, Testcontainers enabled (`docker` available on the runner)
- [ ] Matrix or single job is fine at this scale — green badge is the point, not the topology

### Weekly checkpoint

- [ ] Friday: both branches merged to `main`, `docker compose up -d && mvn verify` green from a clean clone, annotated tag `week-N-demo`
- [ ] The tag **is** the deliverable — it's what you show, and what you can roll back to if next week goes badly
