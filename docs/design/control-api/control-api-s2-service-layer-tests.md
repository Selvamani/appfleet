# control-api — `DeploymentService` transaction-boundary tests

**Spec:** [01-CONTROL-API.md §S2](../../specs/project/01-CONTROL-API.md) — self-invocation bug, rollback rules, `REQUIRES_NEW`.

Companion: [control-api-s2-service-layer.md](control-api-s2-service-layer.md) (the `DeploymentService`/`AuditEventRecorder`/`DeploymentValidationException` these tests exercise, already implemented and checked). **Status: implemented and passing** — see "Three more gaps, found only by actually running this against a real container" below for what it took to get from designed to green.

## Why these can't be plain unit tests

[control-api-s2-deployment-tests.md](control-api-s2-deployment-tests.md)'s tests needed nothing but plain Java objects — `Deployment.transitionTo` is pure logic. These tests are checking something a plain unit test structurally cannot see: **whether a transaction actually committed or rolled back against a real database.** That needs a real Spring context (for the `@Transactional` proxies to exist at all) and a real database connection (rollback is a database-level guarantee, not a Java-level one). Per the repo's own testing table (`00-BUILD-GUIDE.md`): *"Integration — `@SpringBootTest` + Testcontainers — anything crossing a boundary"* — this is exactly that row.

**One pom addition needed first:** `@ServiceConnection` (the annotation that wires a Testcontainers container into Spring Boot's `DataSource` with zero manual config) lives in `org.springframework.boot:spring-boot-testcontainers`, which `control-api/pom.xml` doesn't have yet — only the raw `org.testcontainers:postgresql`/`junit-jupiter` artifacts. Add:

```xml
<dependency>
  <groupId>org.springframework.boot</groupId>
  <artifactId>spring-boot-testcontainers</artifactId>
  <scope>test</scope>
</dependency>
```

## Two test classes, matching the two behaviors, treated differently on purpose

The spec's own wording treats these two demonstrations differently, and the tests should reflect that difference exactly:

- **Self-invocation** — the spec calls this a bug and explicitly says *"keep the broken version as a `@Disabled` test."* `createBroken` is a real defect (the audit write silently never gets its own transaction), so the test proving it's broken is `@Disabled` — documented, reproducible on demand, not run on every build.
- **Rollback rules** — the spec says *"watch it commit anyway. Then `rollbackFor`. Keep **both** tests."* This isn't a bug, it's Spring's documented default behavior — both the "commits anyway" test and the `rollbackFor` test stay **active**, asserting two different, both-correct outcomes.

## `DeploymentServiceAuditRecordingTest` — self-invocation / `REQUIRES_NEW`

```java
package io.appfleet.control.deployment;

import io.appfleet.control.application.Application;
import io.appfleet.control.application.ApplicationRepository;
import io.appfleet.control.application.Release;
import io.appfleet.control.application.ReleaseRepository;
import io.appfleet.control.audit.AuditEventRepository;
import io.appfleet.control.environment.Environment;
import io.appfleet.control.environment.EnvironmentRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Disabled;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

@SpringBootTest
@Testcontainers
class DeploymentServiceAuditRecordingTest {

    @Container
    @ServiceConnection
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:16");

    @Autowired DeploymentService deploymentService;
    @Autowired ApplicationRepository applicationRepository;
    @Autowired ReleaseRepository releaseRepository;
    @Autowired EnvironmentRepository environmentRepository;
    @Autowired DeploymentRepository deploymentRepository;
    @Autowired AuditEventRepository auditEventRepository;

    private Application application;
    private Release release;
    private Environment environment;

    @BeforeEach
    void setUp() {
        application = applicationRepository.save(
                new Application("app-" + UUID.randomUUID(), "desc", UUID.randomUUID()));
        release = releaseRepository.save(
                new Release(application, "v1.0.0", "s3://artifact.jar", "checksum"));
        environment = environmentRepository.save(
                new Environment("env-" + UUID.randomUUID()));
    }

    @Disabled("deliberate bug — self-invocation bypasses the @Transactional proxy, REQUIRES_NEW never takes effect")
    @Test
    void createBroken_auditRowDoesNotSurviveRollback() {
        long deploymentsBefore = deploymentRepository.count();
        long auditBefore = auditEventRepository.count();

        assertThatThrownBy(() -> deploymentService.createBroken(application, release, environment, "tester"))
                .isInstanceOf(IllegalStateException.class);

        assertThat(deploymentRepository.count()).isEqualTo(deploymentsBefore);
        assertThat(auditEventRepository.count()).isEqualTo(auditBefore); // the assertion that fails today
    }

    @Test
    void create_auditRowSurvivesRollback() {
        long deploymentsBefore = deploymentRepository.count();
        long auditBefore = auditEventRepository.count();

        assertThatThrownBy(() -> deploymentService.create(application, release, environment, "tester"))
                .isInstanceOf(IllegalStateException.class);

        assertThat(deploymentRepository.count()).isEqualTo(deploymentsBefore); // deployment rolled back
        assertThat(auditEventRepository.count()).isEqualTo(auditBefore + 1);   // audit row survived
    }
}
```

The disabled test's last assertion (`auditEventRepository.count()` equal to `auditBefore`) is written as what the bug actually produces — if someone re-enables it without also fixing `createBroken`, it should **pass**, proving the bug is still present. That's the point of keeping it as evidence rather than deleting it once the fix (`create`) exists.

## `DeploymentServiceRollbackTest` — rollback rules

```java
package io.appfleet.control.deployment;

import io.appfleet.control.application.Application;
import io.appfleet.control.application.ApplicationRepository;
import io.appfleet.control.application.Release;
import io.appfleet.control.application.ReleaseRepository;
import io.appfleet.control.environment.Environment;
import io.appfleet.control.environment.EnvironmentRepository;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.junit.jupiter.Container;
import org.testcontainers.junit.jupiter.Testcontainers;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

@SpringBootTest
@Testcontainers
class DeploymentServiceRollbackTest {

    @Container
    @ServiceConnection
    static PostgreSQLContainer<?> postgres = new PostgreSQLContainer<>("postgres:16");

    @Autowired DeploymentService deploymentService;
    @Autowired ApplicationRepository applicationRepository;
    @Autowired ReleaseRepository releaseRepository;
    @Autowired EnvironmentRepository environmentRepository;
    @Autowired DeploymentRepository deploymentRepository;

    private Application application;
    private Release release;
    private Environment environment;

    @BeforeEach
    void setUp() {
        application = applicationRepository.save(
                new Application("app-" + UUID.randomUUID(), "desc", UUID.randomUUID()));
        release = releaseRepository.save(
                new Release(application, "v1.0.0", "s3://artifact.jar", "checksum"));
        environment = environmentRepository.save(
                new Environment("env-" + UUID.randomUUID()));
    }

    @Test
    void createRiskyDefault_commitsDespiteCheckedException() {
        long before = deploymentRepository.count();

        assertThatThrownBy(() -> deploymentService.createRiskyDefault(application, release, environment))
                .isInstanceOf(DeploymentValidationException.class);

        assertThat(deploymentRepository.count()).isEqualTo(before + 1); // commits anyway — Spring's default
    }

    @Test
    void createRiskySafe_rollsBackOnCheckedException() {
        long before = deploymentRepository.count();

        assertThatThrownBy(() -> deploymentService.createRiskySafe(application, release, environment))
                .isInstanceOf(DeploymentValidationException.class);

        assertThat(deploymentRepository.count()).isEqualTo(before); // rollbackFor did its job
    }
}
```

## One fixture detail that would silently break both test classes

`Application.name` has a real `UNIQUE` constraint (`uq_application_name`, `V1__init.sql`). If `@BeforeEach` reused a fixed literal name (`"checkout-service"`) across multiple `@Test` methods in the same class, the **second** test method's setup would fail with a unique-constraint violation, since the container/schema persists across test methods within one class (only one `@Container` instance, not recreated per test). Every fixture name above is suffixed with `UUID.randomUUID()` specifically to avoid this — worth calling out because it's the kind of thing that passes on the first test method and mysteriously fails on the second, in a way that looks like a Spring/transaction bug but is actually just a fixture-naming mistake.

## Three more gaps, found only by actually running this against a real container

Typing the two test classes in wasn't enough on its own — three separate, real problems surfaced only once they actually ran:

1. **`testcontainers.version` (`1.20.4`, root `pom.xml`) couldn't talk to this machine's Docker Desktop at all** — `NpipeSocketClientProviderStrategy: failed with exception BadRequestException (Status 400: ...)`. The bundled `docker-java` client was too old for this Docker Desktop version's API responses. Confirmed it wasn't a shell/environment quirk — the identical failure happened from IntelliJ too. Fixed by bumping to `1.21.4` (latest same-major release; a `2.0.x` exists but risks breaking API changes, not worth it for a version bump alone).

2. **Once the container could start, Hibernate couldn't find any tables** — `Schema validation: missing table [app_image]`. Flyway ran correctly and created every table inside the `control` schema (`spring.flyway.schemas: control` is its own config, independent of the JDBC connection). But `@ServiceConnection` hands Spring a fresh Testcontainers JDBC URL that has no `?currentSchema=control` — the query param baked into the *manual* datasource URL in `application.yml` that made the compose-based setup work by coincidence. Hibernate's schema validation fell back to the connection's default search path (`public`) and found nothing there. Fixed once, at the source, for every environment — added to `control-api/src/main/resources/application.yml`:
   ```yaml
   spring:
     jpa:
       properties:
         hibernate:
           default_schema: control
   ```
   This makes Hibernate schema-qualify every table reference explicitly, regardless of whatever the JDBC connection's own default search path happens to be — fixes the Testcontainers case and is a no-op for the already-working manual compose case.

3. **`appfleet.environment` was `null`** — `@NotBlank` (`AppfleetProperties`, [control-api.md](control-api.md)) rejected the binding, failing context startup outright. Neither test class activated a Spring profile, so `application-test.yml` (which sets `appfleet.environment: test`) never got merged in — this is *exactly* the scenario that file was built for, per its own original design note ("Used by `@ActiveProfiles("test")` in integration tests"), just never actually wired up until now. Fixed by adding `@ActiveProfiles("test")` to both test classes.

None of these three were mistakes in the test *logic* — the assertions, the fixtures, the transaction-boundary reasoning were all correct from the first pass. They were gaps in the surrounding infrastructure (dependency version, schema-qualification strategy, profile activation) that only a real run against a real container could expose — the same category of thing `ddl-auto: validate` caught for the `Deployment.version` column in [control-api-s2-verification.md](control-api-s2-verification.md).

## Definition of done

- [x] `spring-boot-testcontainers` added to `control-api/pom.xml` (test scope)
- [x] `testcontainers.version` bumped `1.20.4` → `1.21.4` (root `pom.xml`)
- [x] `spring.jpa.properties.hibernate.default_schema: control` added to `application.yml`
- [x] `@ActiveProfiles("test")` added to both test classes
- [x] `DeploymentServiceAuditRecordingTest` — `@Disabled` test on `createBroken` skipped as designed, active test on `create` passes
- [x] `DeploymentServiceRollbackTest` — both tests active and passing
- [x] `mvn test -pl control-api -Dtest=DeploymentServiceAuditRecordingTest,DeploymentServiceRollbackTest` — **BUILD SUCCESS**, `Tests run: 4, Failures: 0, Errors: 0, Skipped: 1`
