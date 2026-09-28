# Appfleet

Application fleet management platform — control plane, deployments, task
lifecycle, container orchestration, read-model dashboards. Spec-driven build,
no reference implementation copied.

Specs: [`docs/specs/`](docs/specs/) — start at
[SPRING-PROJECT.md](docs/specs/SPRING-PROJECT.md), module specs in
[`docs/specs/project/`](docs/specs/project/). **Solo build order (S0-S7,
monolith-first, slices extracted late) — the primary spec.** A two-developer,
service-first variant was tried and dropped: wrong collection, dangling
links, confusing next to this spec. Copied in from the job-search repo
(`JobSearch/prep/`); edit there, re-copy here. Some links inside these files
point up to the wider interview-prep corpus (syllabus, checklists) that
isn't copied — those won't resolve from here, everything Appfleet-specific
does.

Modules: common-events, common-security, fleet-audit-starter, control-api,
identity-service, task-service, node-agent, query-service, client-sdk.

## Status: skeleton, no logic

What's here: parent + all 10 module `pom.xml`, a bare `@SpringBootApplication`
per service, `application.yml` per service (ports, Kafka/Redis/Postgres
connection wired to env vars), a Flyway `V1__init.sql` placeholder per service
with its own schema, `docker-compose.yml` (Postgres 16, Redis 7, Kafka KRaft,
healthchecks, explicit topic creation — `task.work` at 6 partitions).

`mvn validate` and `mvn compile` both pass clean from this state.

What's not here: every business rule, every entity, every endpoint. That's
Week 2+ per [SPRING-PROJECT.md](docs/specs/SPRING-PROJECT.md)'s slice order —
see the per-module specs in `docs/specs/project/`.

```
docker compose up -d   # postgres, redis, kafka + topic init
mvn verify              # currently: nothing to test yet
```

## What each module owns

| Module | Port | Owns | Bound by |
|---|---|---|---|
| **control-api** | 8081 | Application, Environment, Release, Deployment. The write model — decides *what should be true*. REST, validation, authorization, the transactional outbox. | Request rate, DB writes (connection pool) |
| **identity-service** | 8082 | User, Role, Permission, Team, tokens. Issues RSA-signed JWTs; every other service verifies locally, no network call back. | CPU — BCrypt is deliberately expensive |
| **task-service** | 8083 (scaled, no fixed port) | Task, Attempt, retry policy, DLQ. Consumes `deployment.commands`, dispatches work. | Kafka consumer lag / partition count |
| **node-agent** | 8084 (one per node) | Node, Session, container lifecycle. Pluggable `ContainerRuntime` (Docker / Simulated / Swarm). Leases a node via a Redis fencing token so two agents never drive the same node. | Number of nodes — leases are 1:1 with nodes |
| **query-service** | 8085 | Read models, history, dashboards. Projects `deployment.events` into a CQRS read model, Redis-cached. Never writes control state. | Read rate, cache hit ratio |
| **common-events** | — | Event schemas and topic-name constants only — no business logic, no shared entities. The only thing services share. | — |
| **common-security** | — | Library, not a service. JWT validation filter + `SecurityContext` wiring, imported by every service. | — |
| **fleet-audit-starter** | — | A hand-written Spring Boot starter + auto-configuration (`@ConditionalOnProperty` / `@ConditionalOnMissingBean`). Proof of understanding Boot's auto-config machinery. | — |
| **client-sdk** | — | Typed HTTP client for the API, versioned and published. Built in Slice 7. | — |

No service reads another service's Postgres schema. Cross-service communication is Kafka or REST only.
