# Build Guide — conventions and infrastructure

**[← The Spring Boot Project](../SPRING-PROJECT.md)** · **[← Interview Preparation](../00-INDEX.md)**

> **Why any of it exists: [Business Requirements](06-BUSINESS-REQUIREMENTS.md)** — read it first; every spec below traces to an FR there.
>
> **These specs describe *what* to build, never *how*.** No code. You implement every line — that is the entire point, because Spring Boot is the one gap on your résumé that reading cannot close.
>
> **When a spec says something is deliberately broken first, do it broken first.** Watching a failure is what makes the interview answer real.

## The module specs

| # | Module | Slice | Spec |
|---|---|---|---|
| 1 | **control-api** | S0–S3, S6 | [01-CONTROL-API.md](01-CONTROL-API.md) |
| 2 | **identity-service** | S4 | [02-IDENTITY-SERVICE.md](02-IDENTITY-SERVICE.md) |
| 3 | **task-service** | S4, S6 | [03-TASK-SERVICE.md](03-TASK-SERVICE.md) |
| 4 | **node-agent** | S5 | [04-NODE-AGENT.md](04-NODE-AGENT.md) |
| 5 | **query-service** | S6 | [05-QUERY-SERVICE.md](05-QUERY-SERVICE.md) |

---

## Repository layout

**One repo, multi-module Maven.** Not five repos — you would spend the project managing versions instead of learning Spring.

```
appfleet/
├── pom.xml                     parent: dependencyManagement, Java 21, Boot 4.1.x
├── docker-compose.yml          postgres · redis · kafka · (nginx)
├── common-events/              event schemas — the ONLY thing services share
├── common-security/            JWT validation filter + SecurityContext plumbing
├── fleet-audit-starter/        ★ your own starter + auto-configuration (S0)
├── control-api/
├── identity-service/
├── task-service/
├── node-agent/
├── query-service/
├── client-sdk/                 ★ typed client, published (S7)
└── docs/                       write-ups, diagrams, measurements
```

- [ ] **`common-events` carries schemas only** — records/DTOs and topic names. **No business logic, no shared entities.** A shared domain model is how you get a distributed monolith
- [ ] **`common-security` is a library, not a service** — every service validates JWTs locally with the public key. No network call to authenticate

## Ports and infrastructure

| | Port | |
|---|---|---|
| control-api | 8081 | |
| identity-service | 8082 | |
| task-service | 8083 | scaled: no fixed port, LB only |
| node-agent | 8084 | one per simulated node |
| query-service | 8085 | |
| Postgres | 5432 | **schema per service**, one instance |
| Redis | 6379 | one instance, key prefix per service |
| Kafka | 9092 | KRaft mode, no Zookeeper |

- [ ] **Schema per service, not database per service.** Then be able to say *"in production I'd split them; here the isolation boundary is what matters and one instance keeps the compose file honest"*
- [ ] **No service reads another service's schema.** Ever. That rule is the whole point of the boundary

## Shared conventions

Decide these once, in Slice 0, and never revisit them.

| | Convention |
|---|---|
| **Base path** | `/api/v1/...` |
| **Errors** | RFC 7807 `ProblemDetail` — one shape, every service, every failure |
| **Correlation** | `X-Correlation-Id` header in, generated if absent, into MDC, out on the response, **and onto every Kafka message header** |
| **Idempotency** | `Idempotency-Key` header on unsafe POSTs; stored in Redis with TTL |
| **Pagination** | Cursor by default: `?cursor=<opaque>&limit=`. Response carries `nextCursor` |
| **Time** | `Instant`, UTC, `timestamptz` in Postgres. **Never `LocalDateTime` in a column** |
| **IDs** | UUIDv7 — sortable, index-friendly. Know why v4 is worse for a primary key |
| **Kafka topics** | `<domain>.<type>` — `deployment.commands`, `task.events`. DLT: `<topic>.DLT` |
| **Kafka keys** | The aggregate id, so ordering holds per aggregate |
| **Package root** | `io.appfleet.<service>` |
| **Migrations** | Flyway, `V<n>__<snake_case>.sql`, per service, **never edited after commit** |

## Definition of done — every slice

- [ ] `docker compose up -d && mvn verify` passes **from a clean clone**
- [ ] New endpoints documented in OpenAPI
- [ ] The slice's **deliberate bug reproduced**, then fixed, with the broken version kept as a `@Disabled` test
- [ ] A short note in `/docs` if the slice produced a measurement or a trade-off
- [ ] Committed — even if incomplete. **The history is evidence**

## The infrastructure to stand up first (Slice 0)

- [ ] `docker-compose.yml` with Postgres 16, Redis 7, Kafka in **KRaft mode** *(no Zookeeper — it's been removed; know that)*
- [ ] Healthchecks on every container, and `depends_on: condition: service_healthy`
- [ ] One `init.sql` creating a schema per service
- [ ] Kafka topics created on startup — **explicitly, with chosen partition counts**, not auto-created
- [ ] **Set `task.work` to 6 partitions.** You will later prove that a 7th consumer sits idle
- [ ] `.env` for ports and credentials; **nothing secret committed**

## Testing conventions

| Layer | Tool | Use for |
|---|---|---|
| Unit | JUnit 5 + AssertJ | domain logic, state machines, policies |
| Slice | `@WebMvcTest`, `@DataJpaTest` | controllers and repositories in isolation |
| Integration | `@SpringBootTest` + **Testcontainers** | anything crossing a boundary |
| Contract | Testcontainers Kafka | producer/consumer agreement on `common-events` |

- [ ] **Testcontainers with `@ServiceConnection`** — no manual datasource config in tests
- [ ] **One shared container per module** — reusing containers is what keeps the suite fast enough to actually run
- [ ] **`@Disabled` tests preserving each deliberate bug**, with a comment explaining what it demonstrates

## Order of work

**Follow the slices in [SPRING-PROJECT.md](../SPRING-PROJECT.md), not the module numbering.** control-api is built across four slices; identity is extracted in one. Building a service "completely" before starting the next is how the project stalls.

- [ ] **Never two weeks without a green build.** That is the point where side projects die
- [ ] **If you fall behind, cut a service — not the write-ups.** Three services with measurements beat five without
