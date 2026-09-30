# control-api — design (S0)

**Spec:** [01-CONTROL-API.md](../../specs/project/01-CONTROL-API.md) · Slice **S0** of **S0–S3, S6** · Port **8081** · Schema **`control`** · Package root `io.appfleet.control`

This doc covers **S0 only** — the skeleton slice. control-api is the largest module in the project (four slices: S0 skeleton, S1 schema, S2 JPA, S3 REST+Redis, then S6 CQRS later) and per [00-BUILD-GUIDE.md](../../specs/project/00-BUILD-GUIDE.md), "building a service completely before starting the next is how the project stalls" — so this doc deliberately stops at S0's boundary rather than speculating about S1's schema or S3's endpoints. Companion: [fleet-audit-starter.md](../fleet-audit-starter/fleet-audit-starter.md), which S0 depends on directly. S1's schema design (0NF → 3NF, BCNF-validated) is now underway — see [control-api-schema-3nf.md](control-api-schema-3nf.md). The remaining S1 exercises (seed generator, window function, recursive CTE, index tuning, deadlock drill) are planned in [control-api-s1-exercises.md](control-api-s1-exercises.md). For how the pieces actually wire together and boot, see [control-api-spring-flow.md](control-api-spring-flow.md). S2 entity design (data/query exercises parked until this lands) is in [control-api-s2-entities.md](control-api-s2-entities.md); the implementation checkout and live verification against the running schema is in [control-api-s2-verification.md](control-api-s2-verification.md). `Deployment.transitionTo` unit tests are designed in [control-api-s2-deployment-tests.md](control-api-s2-deployment-tests.md); repositories are designed in [control-api-s2-repositories.md](control-api-s2-repositories.md); the service layer (self-invocation bug, `REQUIRES_NEW`, rollback rules, the N+1/`LazyInitializationException` demo hook) is designed in [control-api-s2-service-layer.md](control-api-s2-service-layer.md), and its transaction-boundary tests are designed in [control-api-s2-service-layer-tests.md](control-api-s2-service-layer-tests.md). The `@Version` optimistic-lock test and its retry-vs-fail policy are designed in [control-api-s2-optimistic-lock.md](control-api-s2-optimistic-lock.md); the N+1 drill (baseline, `JOIN FETCH`, `@EntityGraph`, `@BatchSize`) is designed in [control-api-s2-n-plus-one.md](control-api-s2-n-plus-one.md); the `LazyInitializationException` drill and turning `open-in-view` off are designed in [control-api-s2-lazy-initialization.md](control-api-s2-lazy-initialization.md). The last two repository items (`findLineage` test and the interface projection) are designed in [control-api-s2-lineage-and-projection.md](control-api-s2-lineage-and-projection.md). S3 (REST and Redis) is planned in [control-api-s3-rest.md](control-api-s3-rest.md); its first step (correlation id, one error shape, web-layer test setup) is designed in [control-api-s3-1-foundations.md](control-api-s3-1-foundations.md). S3.2 (applications and releases endpoints) is designed in [control-api-s3-2-applications-releases.md](control-api-s3-2-applications-releases.md).

**Current state of the tree:** `ControlApiApplication` (bare `@SpringBootApplication`), `application.yml` (datasource/flyway/kafka/redis/actuator config, no profiles), one Flyway migration file that's a comment only — no tables yet. No `config/` package, no dependency on `fleet-audit-starter`, no `spring-boot-starter-validation`. Everything below is what closes that gap.

## Scope (S0)

**Owns:** the module boots, its own typed config, its own audit wiring, its actuator surface, its profile split.

**Does not own (later slices):** the domain model (`Application`/`Release`/`Deployment`/`Environment`/`Node`/catalogue — S1), JPA entities (S2), REST endpoints and Redis-backed idempotency/rate-limiting (S3), the outbox and CQRS emission (S6). None of that is touched here.

## What S0 requires, per spec, and where each item lands

| Spec bullet ([01-CONTROL-API.md §S0](../../specs/project/01-CONTROL-API.md)) | Landing point |
|---|---|
| Boot 4.1.x, Java 25, module builds inside the parent | Already true — `pom.xml` inherits `appfleet-parent`. No action. |
| `@ConfigurationProperties(prefix = "appfleet")`, typed, validated, fail-fast. **No `@Value` anywhere** | New `config/` package, `AppfleetProperties` — see below. |
| Profiles: `local`, `test`, `prod`, know the precedence order | New `application-local.yml`, `application-test.yml`, `application-prod.yml`. |
| `fleet-audit-starter` wired, `ApplicationContextRunner` proof | Add the Maven dependency + `appfleet.audit.enabled: true`; the *proof* tests live in `fleet-audit-starter` itself (see [fleet-audit-starter.md §Testing](../fleet-audit-starter/fleet-audit-starter.md#testing)) — control-api's own job is just to depend on it correctly and show up in the conditions report. |
| Actuator: health/info/metrics exposed, everything else locked | Mostly already true in `application.yml`; confirmed, not rebuilt. |
| Run with `--debug`, read the conditions evaluation report | A one-time verification step, done last, after the dependency exists. |

## Package layout (S0 slice of it)

```
io.appfleet.control
├── ControlApiApplication
└── config/
    └── AppfleetProperties     @ConfigurationProperties(prefix = "appfleet"), @Validated
```

Everything else in the eventual package layout (`application/`, `deployment/`, `catalogue/`, `audit/`, `outbox/`, ...) belongs to S1–S6 and isn't named yet — inventing package names for code that doesn't exist yet is exactly the kind of premature structure the spec's slice-by-slice approach is designed to avoid.

## Class structure

| Class | Kind | Visibility | Responsibility |
|---|---|---|---|
| `AppfleetProperties` | record | public | `@ConfigurationProperties(prefix = "appfleet")`, class annotated `@Validated`. One field for S0: `@NotBlank String environment`. Bound from `appfleet.environment`, set per-profile (`local`/`test`/`prod`) — see below. |

```java
@ConfigurationProperties(prefix = "appfleet")
@Validated
public record AppfleetProperties(
    @NotBlank String environment
) {}
```

**Why `environment` and nothing else, at S0:** the spec's S0 bullet is a convention decision ("typed, validated, no `@Value`"), not a request for a specific feature — but a `@ConfigurationProperties` class with zero fields doesn't exercise `@Validated`/`@NotBlank` at all, and there's nothing to fail fast on. `environment` is the one value S0 actually needs: it's what ties the profile split (next section) to something typed and checkable at startup, instead of scattering `spring.profiles.active` string checks through the code later. Boot fails context startup immediately if `appfleet.environment` is missing or blank in whichever profile is active — that's the "fail-fast on bad config" bullet, demonstrated with the smallest honest example rather than an invented one. More fields get added here as later slices actually need typed config (e.g. idempotency-key TTL in S3) — this record is meant to grow, not to be re-architected.

**Why not fold `appfleet.audit.enabled` in here too:** that key is bound by `fleet-audit-starter`'s own `AuditProperties`, under the same `appfleet` root but a different leaf path (`appfleet.audit.*` vs `appfleet.environment`). Two separate `@ConfigurationProperties` classes can each bind their own subtree of the same YAML document — control-api doesn't need to own or re-declare a property that belongs to the starter.

## Maven changes

`control-api/pom.xml` gains:

```xml
<dependency>
  <groupId>io.appfleet</groupId>
  <artifactId>fleet-audit-starter</artifactId>
  <version>${project.version}</version>
</dependency>
<dependency>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-starter-validation</artifactId>
</dependency>
```

`spring-boot-starter-validation` isn't currently a dependency anywhere in this module — `@Validated`/`@NotBlank` on `AppfleetProperties` won't compile/wire without it (it's what pulls in Hibernate Validator, the Jakarta Bean Validation implementation Boot delegates to).

## Profiles

Three new files alongside the existing `application.yml`:

| File | `appfleet.environment` | What else differs |
|---|---|---|
| `application-local.yml` | `local` | `appfleet.audit.enabled: true` (see it log); relaxed logging level for local iteration. |
| `application-test.yml` | `test` | Used by `@ActiveProfiles("test")` in integration tests — Testcontainers supplies datasource/redis/kafka connection details at runtime via `@ServiceConnection`, so this file mainly needs to *not* hardcode a real `localhost` datasource URL that would shadow the container one. |
| `application-prod.yml` | `prod` | Placeholder for now — no real prod target exists for a portfolio project, but the file existing is what proves the three-profile convention, and it's where secrets would come from env vars if this ever deployed anywhere. |

`application.yml` (no suffix) keeps everything genuinely shared across all three — datasource driver, Flyway schema name, actuator exposure, Kafka/Redis connection *shape* (host/port as env-var-overridable placeholders, already the case today).

**Precedence order** (Spring Boot 4.1, no custom `PropertySource` added by this module): command-line arguments > `SPRING_APPLICATION_JSON` env var > `application-{profile}.yml` for the active profile > `application.yml`. Profile-specific files override the base file key-by-key, not wholesale — a key only present in `application.yml` still applies even when a profile is active and that profile's file doesn't mention it.

## Actuator lockdown

Already in `application.yml`:

```yaml
management:
  endpoints:
    web:
      exposure:
        include: health,info,metrics
```

This is an **allow-list**, not a deny-list — only the three named endpoints are exposed over HTTP, regardless of how many actuator endpoints exist on the classpath. S0's job here is verification, not new config: confirm no later dependency addition (e.g. if something pulls in `spring-boot-starter-actuator`'s optional extras) introduces an `include: "*"` or a `management.endpoint.shutdown.enabled: true` anywhere in the three new profile files. None of the profile files above should touch `management.*` at all — leaving it inherited from the shared `application.yml` is the correct outcome, not an oversight.

## Verification step — conditions evaluation report

Last step, after the dependency and properties exist:

```
mvn spring-boot:run -Dspring-boot.run.arguments=--debug
```

(or the equivalent `java -jar ... --debug` once packaged). Read the printed conditions evaluation report and confirm:

- `AuditAutoConfiguration` (from `fleet-audit-starter`) appears under **Positive matches** — proves the `@ConditionalOnProperty` in that module actually fired because `appfleet.audit.enabled: true` is set in the active profile.
- Switching the active profile to one where `appfleet.audit.enabled` is unset or `false` moves `AuditAutoConfiguration` to **Negative matches** — the same class, opposite outcome, driven purely by YAML. Worth doing once as a second run to see both sides, not just the positive case.

## Testing (S0)

- No integration tests needed yet — S0 has no domain logic, no repository, nothing crossing a real boundary (Postgres/Kafka/Redis) worth a Testcontainers test on control-api's own side. `fleet-audit-starter`'s `ApplicationContextRunner` tests (in that module) are what actually exercises the conditional wiring; control-api just needs to boot with it present.
- One thing worth a test here regardless: a context-load smoke test (`@SpringBootTest` with `@ActiveProfiles("test")`) asserting `AppfleetProperties` binds and `environment()` resolves to `"test"` — cheap, and it's the test that would fail loudly if `application-test.yml` ever drifted from setting the key.

## Definition of done (S0)

- [ ] `AppfleetProperties` built, `@Validated`, `@NotBlank` on `environment`; zero `@Value` usages anywhere in the module (`grep -rn "@Value" control-api/src` returns nothing)
- [ ] `fleet-audit-starter` dependency added, `appfleet.audit.enabled: true` set in `application-local.yml` (and deliberately not in every profile, so the negative-match run above has something to show)
- [ ] `application-local.yml`, `application-test.yml`, `application-prod.yml` created, each setting `appfleet.environment`
- [ ] Actuator exposure confirmed unchanged (`health,info,metrics` only) across all profiles
- [ ] `mvn verify` green for control-api in isolation
- [ ] Conditions evaluation report read once with `--debug`, both a positive and a negative match for `AuditAutoConfiguration` observed
- [ ] Committed — per [00-BUILD-GUIDE.md](../../specs/project/00-BUILD-GUIDE.md) "Definition of done — every slice," even though S1–S3/S6 remain untouched

## Open questions / deferred

- Exact shape of `AppfleetProperties` beyond `environment` — deferred until S1–S3 name a concrete need (e.g. idempotency-key TTL, rate-limit bucket size). Adding a field to an existing record is cheap; this doc isn't trying to pre-guess S3's Redis config.
- Whether `application-prod.yml` ever becomes real (actual secrets management, actual deploy target) — out of scope for a portfolio project; the file exists to prove the convention, not to run anywhere.
