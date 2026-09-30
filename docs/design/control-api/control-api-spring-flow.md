# control-api — Spring Boot wiring and runtime flow

Companion to [control-api.md](control-api.md) (S0 design), [control-api-schema-3nf.md](control-api-schema-3nf.md) (schema), [control-api-s1-exercises.md](control-api-s1-exercises.md) (remaining S1 work), and the spec [01-CONTROL-API.md](../../specs/project/01-CONTROL-API.md). Same purpose as [node-agent-spring-flow.md](../node-agent/node-agent-spring-flow.md): that doc says what each class is; this one says how Spring actually assembles them at startup and how a request/message moves through the assembled graph. Written against the current tree, so it calls out what's implemented vs. still a stub from the spec.

Shared Spring mechanics (the `ApplicationContext`, beans, constructor injection, `@ConfigurationProperties` binding, `@ConditionalOnProperty`) are explained once in [node-agent-spring-flow.md §1](../node-agent/node-agent-spring-flow.md) and not repeated here — read that first if these are unfamiliar. This doc only covers what's different or new in control-api.

---

## 1. What's new here that node-agent doesn't have

node-agent has no database, no Flyway, no JPA, and consumes exactly one external auto-configuration indirectly (none, currently). control-api has all three, and they interact with each other in an order that matters — this section explains each mechanism once, §2 shows the actual sequence.

### Auto-configuration arriving from an *external* jar, not this module's own code

Every auto-configuration class node-agent has (`RuntimeAutoConfig`, `DockerRuntimeConfig`) lives inside node-agent's own source tree. control-api is the first module in this repo that consumes auto-configuration **shipped by a separate module** — `fleet-audit-starter`'s `AuditAutoConfiguration`.

Mechanically, this changes nothing about *how* Spring Boot decides whether to fire it — `@ConditionalOnProperty`/`@ConditionalOnMissingBean` work identically regardless of which jar the class came from. What's different is *discovery*: Spring Boot's `AutoConfigurationImportSelector` doesn't scan control-api's own package tree to find `AuditAutoConfiguration` — it reads `META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports` from **every jar on the classpath**, merges all of them into one list, and evaluates every class in that merged list, regardless of which jar declared it. control-api's own `pom.xml` dependency on `fleet-audit-starter` is what puts that jar (and its imports file) on the classpath in the first place — nothing else has to happen on control-api's side for the class to even be *considered*.

The `--debug` conditions evaluation report is where this is directly visible: it lists hundreds of auto-configuration classes under Positive/Negative matches, spanning `spring-boot-autoconfigure`, `spring-boot-flyway`, `spring-boot-jdbc`, and `fleet-audit-starter` all mixed together in one report — the report has no concept of "which module this came from," because by the time it's evaluating conditions, it's all just classes on one classpath.

### Flyway's auto-configuration, and *why it has to run before JPA*

`FlywayAutoConfiguration` (from the `spring-boot-flyway` module — see the note in §2, this was a real gap that had to get fixed) is gated by `@ConditionalOnClass(Flyway.class)` plus a nested condition requiring a `DataSource` bean to already exist. Once it fires, it registers a `FlywayMigrationInitializer` bean whose job is to call `Flyway.migrate()` — applying every pending `V__` script in `db/migration` against the configured schema, recording each one into `flyway_schema_history`.

The part that matters and is easy to get backwards: **Flyway has to finish migrating before Hibernate's `EntityManagerFactory` gets built**, because this module's `spring.jpa.hibernate.ddl-auto` is set to `validate` — Hibernate checks that every JPA entity's mapped table/column actually exists in the database, and throws at startup if it doesn't. If JPA initialized first, `validate` would run against a schema Flyway hadn't populated yet, and fail every time regardless of whether the entities were mapped correctly. Spring Boot handles this ordering automatically via `FlywayMigrationInitializer` implementing `InitializingBean` and depending on the `Flyway` bean, combined with `@AutoConfigureAfter`/`@AutoConfigureBefore` annotations on the respective auto-configuration classes — not something this module's code has to arrange by hand, but worth knowing it's not accidental either.

Right now this ordering is trivially satisfied — zero JPA entities exist (S2 hasn't started), so `validate` has nothing to check. It becomes load-bearing the moment the first `@Entity` class is added.

### HikariCP — the connection pool underneath `DataSource`

`spring-boot-starter-data-jpa` pulls in HikariCP as the default `DataSource` implementation. `HikariPool-1 - Starting...` in the boot log is this pool warming up a set of physical Postgres connections *before* anything else — Flyway's migration, Hibernate's metadata build, and every future JPA query all borrow a connection from this one pool rather than opening a fresh TCP connection per query. This is the layer that was actually failing during setup (wrong port, then wrong password expectation, then a rejected `TimeZone` session parameter) before the app could boot at all — Hikari's first borrowed connection is also the first place any of those three problems became visible.

### `@Validated` + `@NotBlank` — fail-fast, and exactly how early it fires

`AppfleetProperties` binds during context initialization, before component-scanned beans are created — if `appfleet.environment` is missing or blank in the active profile, the context refuses to start with a `ConfigurationPropertiesBindException`, not a `NullPointerException` deep in some service later. This is deliberately the *first* thing that can fail — everything else in this doc assumes it already passed.

---

## 2. Startup sequence — what actually happens, in order

This is the real sequence, confirmed against actual `--debug` boot output against the live Docker Postgres, not a projection:

```
ControlApiApplication.main()
 │
 ├─ SpringApplication.run() builds the ApplicationContext
 │
 ├─ appfleet-local.yml / appfleet-test.yml / appfleet-prod.yml + application.yml merged
 │    per active profile — property source precedence resolved
 │    (command-line > env vars > active profile file > base application.yml)
 │
 ├─ AppfleetProperties binds — @Validated, @NotBlank on `environment`
 │    fails fast here if appfleet.environment is missing/blank
 │
 ├─ Component scan under io.appfleet.control.**
 │
 ├─ Merged AutoConfiguration.imports evaluated (spring-boot-autoconfigure +
 │    spring-boot-flyway + spring-boot-jdbc + fleet-audit-starter, all merged —
 │    see §1). Two outcomes that matter today:
 │
 │    AuditAutoConfiguration (fleet-audit-starter) — @ConditionalOnProperty
 │      (appfleet.audit.enabled=true) MATCHES under the `local` profile (set in
 │      application-local.yml), does NOT match under `test`/`prod` (property
 │      absent there, defaults false) — confirmed via the conditions report
 │      showing this class under Positive matches on `local`.
 │      @ConditionalOnMissingBean then wires Slf4jAuditLogger as the AuditLogger
 │      bean, since control-api hasn't defined its own yet.
 │
 │    FlywayAutoConfiguration (spring-boot-flyway) — @ConditionalOnClass(Flyway)
 │      + DataSourceBeanCondition MATCH once a DataSource bean exists (see next
 │      step). PostgresqlConfiguration nested class also matches — Postgres-
 │      specific Flyway behavior (e.g. advisory locking during migration) is
 │      enabled automatically because flyway-database-postgresql is on the
 │      classpath.
 │
 ├─ HikariDataSource bean created — "HikariPool-1 - Starting..." — physical
 │    connections opened against jdbc:postgresql://.../appfleet?currentSchema=control
 │
 ├─ Flyway migrates — creates control.flyway_schema_history if absent, applies
 │    every unapplied V__ script in order, records each as a row. This runs
 │    and fully completes BEFORE the next step (see §1's ordering note).
 │
 ├─ LocalContainerEntityManagerFactoryBean builds the Hibernate SessionFactory,
 │    hibernate.hbm2ddl.auto=validate runs against whatever entities exist —
 │    currently zero @Entity classes, so this is a no-op that always passes.
 │
 ├─ Remaining singletons wire in via constructor injection (AuditLogger
 │    consumers, once any exist — none yet call it)
 │
 ├─ Embedded Tomcat opens port 8081
 │
 └─ Actuator exposes exactly health/info/metrics — everything else locked,
      per application.yml's exposure allow-list (confirmed unchanged across
      all three profile files)
```

**One real gap this sequence exposed, now fixed:** `flyway-database-postgresql` alone (the migration *engine*) does nothing without Boot's own integration glue calling `migrate()` on startup. In Spring Boot 4.x that glue moved out of the monolithic `spring-boot-autoconfigure` jar into its own module, `org.springframework.boot:spring-boot-flyway` — without it, `FlywayAutoConfiguration` never even appears in the conditions report (not a Negative match, not evaluated at all, because the class itself isn't on the classpath). control-api's `pom.xml` now depends on it explicitly.

---

## 3. Planned flows — not yet built (S2/S3)

Nothing below this line exists in the tree yet. This is the anticipated shape once JPA entities (S2) and REST controllers (S3) land, based on [01-CONTROL-API.md](../../specs/project/01-CONTROL-API.md)'s endpoint table and the class-level conventions already decided (records for DTOs, `ProblemDetail` for every error, service layer owns transactions).

### REST flow — creating a deployment (S3 shape)

```
Client              DeploymentController        DeploymentService         DeploymentRepository       Postgres
  │                        │                            │                          │                    │
  │ POST /api/v1/          │                            │                          │                    │
  │  deployments           │                            │                          │                    │
  │ Idempotency-Key: K     │                            │                          │                    │
  ├───────────────────────▶│                            │                          │                    │
  │                        │ check Redis SET NX for K   │                          │                    │
  │                        │ (idempotency, S3) ─────────┼──────────────────────────┼──────▶ Redis        │
  │                        │                            │                          │                    │
  │                        │ create(request) ───────────▶                          │                    │
  │                        │                            │ @Transactional           │                    │
  │                        │                            │  begin                  │                    │
  │                        │                            │ new Deployment(PENDING) │                    │
  │                        │                            │ save() ──────────────────▶ INSERT ────────────▶│
  │                        │                            │  commit                 │                    │
  │                        │◀───────────────────────────┤ Deployment               │                    │
  │  202 Accepted          │                            │                          │                    │
  │  Location: /tasks/{id} │                            │                          │                    │
  │◀───────────────────────┤                            │                          │                    │
```

Points this flow has to get right, per the S2/S3 checklist already written into the spec:

- **`DeploymentController` stays thin** — same discipline node-agent's `SessionController` follows: no transaction logic, no repository calls, just delegates and maps DTOs.
- **The self-invocation bug the spec deliberately plants (S2):** if `DeploymentService.create(...)` called another `@Transactional` method *on itself* (e.g. `this.validateAndCreate(...)`), Spring's proxy-based AOP would never see that second annotation — the call bypasses the proxy entirely, so no new transaction opens. The fix is extracting the collaborator into a different bean. Worth watching for the first time a service method looks like it should call a sibling method for "just this one extra step."
- **Idempotency check happens in front of the transaction, not inside it** — a duplicate `POST` with the same `Idempotency-Key` should short-circuit before ever touching Postgres, replaying the original response instead of attempting a second insert.
- **202 + `Location`, not 201** — because deployment is async (task-service, once it exists, does the actual work); the response points at a task resource to poll, not the finished deployment.

### The N+1 this module is meant to build deliberately (S2)

Listing 50 deployments with their tasks, naively (`deployment.getTasks()` per row, lazy-loaded, no fetch strategy) — 1 query for the deployments, then 50 more, one per row, for each deployment's tasks. The spec wants this actually observed (SQL logging on, count the queries) before fixing it three ways (`JOIN FETCH`, `@EntityGraph`, `@BatchSize`) and diffing the generated SQL into `/docs`. Not built yet — flagged here so it's not forgotten once `Deployment`/`TaskStatus` entities exist.

### Outbox flow (S6 — Kafka out)

```
DeploymentService          OutboxMessage table       OutboxPoller (@Scheduled)      Kafka (deployment.events)
       │                          │                          │                              │
       │ same transaction as      │                          │                              │
       │ the state change:       │                          │                              │
       │ INSERT deployment row   │                          │                              │
       │ INSERT outbox_message ──▶                          │                              │
       │  (both commit together) │                          │                              │
       │                          │                          │                              │
       │                          │◀── poll unsent rows ─────┤                              │
       │                          │                          │  publish ────────────────────▶│
       │                          │◀── mark sent, delete ────┤                              │
```

Why the two inserts share one transaction: if `deployment` committed but the outbox insert failed (or vice versa), the event and the state change would drift apart — exactly the failure mode a transactional outbox exists to prevent. The **kill-test** the spec wants: stop the app between the transaction committing and the poller publishing, restart, prove the message still goes out — because it's sitting in `outbox_message`, unsent, waiting for whichever instance polls next.

---

## 4. Cross-cutting pieces and who calls them

| Piece | Mechanism | Triggered by | Talks to | Status |
|---|---|---|---|---|
| `AppfleetProperties` | `@ConfigurationProperties` + `@Validated` | context startup, before most beans | — | Built, confirmed binding |
| `AuditLogger` (`Slf4jAuditLogger` default) | external auto-config (`fleet-audit-starter`) | anything that later injects `AuditLogger` | SLF4J/Logback | Wired, not yet called by anything (no callers exist until S2/S3 add domain code) |
| Flyway | `spring-boot-flyway` auto-config | context startup, before JPA | Postgres (`control` schema) | Built, confirmed applying `V1__init.sql` |
| HikariCP | `spring-boot-starter-data-jpa` | first DB access (Flyway is first) | Postgres | Built, confirmed pool startup |
| Actuator (`health`/`info`/`metrics`) | Boot's own actuator auto-config | external poll (`/actuator/*`) | — | Confirmed exposure allow-list holds across all profiles |
| `DeploymentController`/`Service`/`Repository` | `@RestController`/`@Service`/Spring Data | HTTP requests | Postgres, Redis (idempotency) | Not built (S2/S3) |
| `OutboxMessage` poller | `@Scheduled` | fixed interval | Postgres, Kafka | Not built (S6) |
| `GlobalExceptionHandler` | `@RestControllerAdvice` | any uncaught exception from a controller | — | Not built (S3) |

---

## 5. Build-order dependency map

```
AppfleetProperties ──▶ (nothing downstream depends on it yet — will gate future config)

fleet-audit-starter (external jar) ──▶ AuditAutoConfiguration ──▶ AuditLogger bean
                                                                        │
                                                     (no caller yet — S2/S3 domain code
                                                      will inject AuditLogger once it exists)

DataSource (Hikari) ──▶ Flyway migrate() ──▶ JPA EntityManagerFactory (validate)
       │                                            │
       │                                            ▼
       │                                   Deployment/Application/Release entities (S2, not built)
       │                                            │
       └────────────────────────────────────────────┼──▶ DeploymentRepository ──▶ DeploymentService ──▶ DeploymentController (S2/S3, not built)
                                                      │
                                                      ▼
                                            OutboxMessage writes (same tx) ──▶ OutboxPoller ──▶ Kafka (S6, not built)
```

Everything above the `DataSource`/Flyway line is unblocked and proven working today. Everything below it — entities, repositories, services, controllers, the outbox poller — is spec'd but not started, and per this module's own slice ordering (S0 done, S1 nearly done, S2 next), none of it is blocked on task-service, identity-service, or query-service existing — same "no blocking dependency on the rest of the build order" pattern node-agent's design already commits to.
