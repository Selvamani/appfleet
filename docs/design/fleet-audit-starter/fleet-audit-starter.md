# fleet-audit-starter — design

**Spec:** [00-BUILD-GUIDE.md](../../specs/project/00-BUILD-GUIDE.md) (repository layout, "★ your own starter + auto-configuration") · [01-CONTROL-API.md §S0](../../specs/project/01-CONTROL-API.md) · Slice **S0** · No port — library module, not a service · Package root `io.appfleet.audit`

This is the working design for the module, written before the code, so the interface shape gets decided once. Currently the module is empty — only `pom.xml` exists, with the starter's two auto-configuration dependencies (`spring-boot-autoconfigure`, `spring-boot-configuration-processor`) already declared and nothing built against them yet.

## Scope

**Owns:** one auto-configured `AuditLogger` bean, gated behind a property, replaceable by any consumer.

**Does not own:** the persisted `AuditEvent` JPA entity described in control-api's domain model ([01-CONTROL-API.md](../../specs/project/01-CONTROL-API.md), "append-only; written via `AFTER_COMMIT`"). That entity is control-api's own write-model concern — a database row, tied to its Flyway schema and its `@TransactionalEventListener(AFTER_COMMIT)` wiring (S6). This module's `AuditEvent` is a different, smaller thing: an in-memory record describing one loggable action, with no persistence opinion at all. A consumer is free to write a Postgres-backed `AuditLogger` that turns this record into that entity — that's exactly the override this design exists to prove.

**Why this module exists at all:** it's the project's own Spring Boot starter — a library that configures itself into a consuming app via auto-configuration, not a service with a `main` class. The point isn't the audit logging itself (that's almost incidental); it's proving out "how does Boot decide to configure a bean automatically, and how does a consumer take that decision back" — the S0 unlock called out in the control-api spec.

## Package layout

```
io.appfleet.audit
├── AuditLogger              interface — the extension point
├── AuditEvent                record — what gets logged
├── Slf4jAuditLogger           default impl, package-private
├── AuditProperties            @ConfigurationProperties(prefix = "appfleet.audit")
└── AuditAutoConfiguration     @AutoConfiguration
```

Only `AuditLogger`, `AuditEvent`, and `AuditAutoConfiguration` are public. `Slf4jAuditLogger` stays package-private — nothing outside this module should ever `new` it directly; the only sanctioned way to get an `AuditLogger` is through the bean Spring hands you (component convention already established in node-agent's `runtime/` package: callers depend on the interface, never the concrete default).

## Class structure

| Class | Kind | Visibility | Responsibility |
|---|---|---|---|
| `AuditLogger` | interface | public | `void record(AuditEvent event)`. The one method every consumer calls and the one method a replacement bean has to implement. |
| `AuditEvent` | record | public | `(String actor, String action, String targetType, String targetId, String detail, Instant occurredAt)`. Plain data — no behavior, no persistence annotations. `occurredAt` is set by the caller, not defaulted inside the record, so logging and "when it happened" stay decoupled from any clock mocking concerns in tests. |
| `Slf4jAuditLogger` | class | package-private | `record(AuditEvent event)` writes one structured `INFO` log line via SLF4J. The default every consumer gets for free until they override it. |
| `AuditProperties` | record | public (Boot needs to bind it, so package-private isn't viable) | `@ConfigurationProperties(prefix = "appfleet.audit")` — `(boolean enabled)`. `enabled` defaults to `false` when the property key is absent entirely, so a consumer that never mentions `appfleet.audit` gets no audit bean and no surprise log noise. |
| `AuditAutoConfiguration` | `@AutoConfiguration` | public | `@ConditionalOnProperty(prefix = "appfleet.audit", name = "enabled", havingValue = "true")` at the class level — the whole configuration class is skipped if audit logging isn't turned on. One `@Bean @ConditionalOnMissingBean AuditLogger auditLogger()` method returning `new Slf4jAuditLogger()`. |

```java
public interface AuditLogger {
    void record(AuditEvent event);
}

public record AuditEvent(
    String actor,
    String action,
    String targetType,
    String targetId,
    String detail,
    Instant occurredAt
) {}
```

## The two conditions, and what each one proves

This is the part the spec explicitly asks to prove with tests — not just wire it and move on:

1. **`@ConditionalOnProperty(appfleet.audit.enabled)`** — proves Boot can turn an entire slice of configuration on/off from `application.yml` alone, with zero code branching in the consuming app. A consumer that sets `appfleet.audit.enabled: false` (or omits the key) gets **no** `AuditLogger` bean in its context at all — not a no-op implementation, an absent one. Anything that constructor-injects `AuditLogger` unconditionally would fail that consumer's context startup, which is itself a useful signal: it means "you turned audit off but something still requires it," caught at boot, not at first call.

2. **`@ConditionalOnMissingBean`** — proves the starter's default backs off the moment the consuming app defines its own `AuditLogger` bean, with no flag, no priority annotation, no `@Primary` needed on the user's side. This is the actual "your own starter" lesson: a starter's job is to supply a sensible default, not to insist on it.

## Registration

`AuditAutoConfiguration` has to be listed in

```
src/main/resources/META-INF/spring/org.springframework.boot.autoconfigure.AutoConfiguration.imports
```

— one fully-qualified class name per line (`org.springframework.boot.autoconfigure.AutoConfiguration.imports`, the Boot 3+/4.x mechanism; the old `spring.factories` key is what you'd find in a pre-Boot-3 tutorial and does **not** work here). Nothing auto-configures without this file — it's the one step that turns "a class with the right annotations" into "a class Boot actually looks at during startup."

## Testing

Spec requirement: "Prove both conditions with `ApplicationContextRunner` tests." Three tests, not two — the third is what actually proves condition 2 rather than just asserting it compiled:

1. **Enabled, no user bean** → `hasSingleBean(AuditLogger.class)`, and the resolved bean's type is `Slf4jAuditLogger`. Proves the default wires when nothing else claims the slot.
2. **Disabled (or property absent)** → `doesNotHaveBean(AuditLogger.class)`. Proves the class-level `@ConditionalOnProperty` gate actually skips the whole configuration, not just the one bean method.
3. **Enabled, with a user-supplied `AuditLogger` bean registered via `withUserConfiguration(...)`** → `hasSingleBean(AuditLogger.class)`, and the resolved bean is the **user's** instance, not `Slf4jAuditLogger`. Proves `@ConditionalOnMissingBean` actually backs off instead of colliding (`NoUniqueBeanDefinitionException`) or silently winning.

Shape of test 3, the one worth writing out:

```java
new ApplicationContextRunner()
    .withConfiguration(AutoConfigurations.of(AuditAutoConfiguration.class))
    .withUserConfiguration(CustomAuditLoggerConfig.class)
    .withPropertyValues("appfleet.audit.enabled=true")
    .run(context -> {
        assertThat(context).hasSingleBean(AuditLogger.class);
        assertThat(context.getBean(AuditLogger.class)).isNotInstanceOf(Slf4jAuditLogger.class);
    });
```

No embedded server, no real app context — `ApplicationContextRunner` boots a throwaway minimal context in-process purely to assert on bean wiring, same tool node-agent's design already commits to for its own conditional-bean test ([node-agent-spring-flow.md §3](../node-agent/node-agent-spring-flow.md)).

## How control-api actually consumes this

Once built, control-api's `pom.xml` gains a dependency on `fleet-audit-starter`, and its `application.yml` sets `appfleet.audit.enabled: true`. That's the entire integration on control-api's side for S0 — no code, no explicit `@Import`, no manual bean registration. The point of a starter is that adding the dependency and one property key is the whole story.

`AuditLogger` becomes something control-api's controllers/services can constructor-inject and call — e.g. `auditLogger.record(new AuditEvent(userId, "DEPLOYMENT_CREATED", "Deployment", deploymentId, detail, Instant.now()))` — with the default `Slf4jAuditLogger` in place from day one, and room later (S6, when `AuditEvent` the JPA entity and the outbox exist) for control-api to supply its own `AuditLogger` bean that writes to Postgres instead of just logging, at which point `Slf4jAuditLogger` backs off automatically. No change needed in this module when that day comes — that's the entire point of building the seam now.

## Definition of done (S0)

- [ ] `AuditLogger`, `AuditEvent`, `Slf4jAuditLogger`, `AuditProperties`, `AuditAutoConfiguration` built as above
- [ ] `AutoConfiguration.imports` file present and correct
- [ ] All three `ApplicationContextRunner` tests pass
- [ ] `mvn verify` green for this module in isolation
- [ ] Run a consumer (control-api, once it depends on this) with `--debug`, find `AuditAutoConfiguration` in the conditions evaluation report under "Positive matches" — confirms the conditional did something real, not just compiled

## Open questions / deferred

- Should `AuditEvent` carry a correlation id field? The repo-wide convention ([00-BUILD-GUIDE.md](../../specs/project/00-BUILD-GUIDE.md), "Shared conventions") is `X-Correlation-Id` on everything. Deferred until a real consumer needs it — adding a field later is cheap, and this module has no HTTP/Kafka context of its own to pull it from.
- Should `AuditLogger.record` be fire-and-forget (`void`) or return something awaitable if a future implementation is async (e.g. writes to Kafka)? Default: `void`, synchronous contract — `Slf4jAuditLogger` is inherently synchronous, and nothing in S0 needs otherwise. Revisit if a later `AuditLogger` implementation needs to signal failure.
