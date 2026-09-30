# control-api — `Deployment.transitionTo` unit tests

**Spec:** [01-CONTROL-API.md §S2](../../specs/project/01-CONTROL-API.md) · Slice **S2**

Companion to [control-api-s2-entities.md](control-api-s2-entities.md) and [control-api-s2-verification.md](control-api-s2-verification.md). Those docs' Definition of Done both list the same open item: *"`Deployment.transitionTo(...)` unit-tested — legal transitions succeed, illegal ones throw, every state pair from the mermaid diagram covered."* This doc is that design, written before typing the test classes in, same discipline as everything else in this repo. **Status: designed, not yet implemented** — `control-api/src/test` doesn't exist in the tree yet.

## Two test classes, two different things proven

Splitting into two files rather than one, because they prove genuinely different things:

1. **`DeploymentStateTest`** — exhaustive, pure enum logic, no Spring context, no entity construction. Proves `DeploymentState.canTransitionTo(...)` matches the spec's mermaid diagram for **every** one of the 7×7 = 49 state pairs, not just the legal ones someone remembered to write a case for.
2. **`DeploymentTest`** — proves `Deployment.transitionTo(...)` itself behaves correctly as a method on the entity: it actually delegates to `canTransitionTo`, it mutates `status` (and only on success), it updates `updatedAt`, and — critically — it does **not** silently change state before throwing. That last point exists specifically because the earlier implementation had `transitionTo` write to `currentStatus` instead of `status` ([control-api-s2-verification.md](control-api-s2-verification.md)'s Pass 1 findings) — a test asserting "status unchanged after a thrown exception" is exactly the kind of test that would have caught that bug immediately instead of it surviving two review passes.

Neither test needs a database, a Spring context, or Testcontainers — `Deployment`/`Application`/`Release`/`Environment` are plain constructible classes (see [control-api-s2-entities.md](control-api-s2-entities.md)'s "entities are not records" section for why they're plain classes at all), so these are pure unit tests per the repo's own testing convention table (`00-BUILD-GUIDE.md`: "Unit — JUnit 5 + AssertJ — domain logic, state machines, policies" — this is exactly that row).

## `DeploymentStateTest` — exhaustive, 49 pairs

```java
package io.appfleet.control.deployment;

import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.MethodSource;

import java.util.ArrayList;
import java.util.List;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

class DeploymentStateTest {

    private static final Set<String> LEGAL_PAIRS = Set.of(
            "PENDING->VALIDATING",
            "VALIDATING->DEPLOYING", "VALIDATING->FAILED",
            "DEPLOYING->HEALTHY", "DEPLOYING->FAILED",
            "HEALTHY->DEGRADED", "HEALTHY->ROLLED_BACK",
            "DEGRADED->HEALTHY", "DEGRADED->ROLLED_BACK"
    );

    static List<org.junit.jupiter.params.provider.Arguments> allStatePairs() {
        List<org.junit.jupiter.params.provider.Arguments> pairs = new ArrayList<>();
        for (DeploymentState from : DeploymentState.values()) {
            for (DeploymentState to : DeploymentState.values()) {
                pairs.add(org.junit.jupiter.params.provider.Arguments.of(from, to));
            }
        }
        return pairs;
    }

    @ParameterizedTest(name = "{0} -> {1}")
    @MethodSource("allStatePairs")
    void matchesMermaidDiagram(DeploymentState from, DeploymentState to) {
        boolean expectedLegal = LEGAL_PAIRS.contains(from + "->" + to);
        assertThat(from.canTransitionTo(to)).isEqualTo(expectedLegal);
    }
}
```

**Why `LEGAL_PAIRS` as a literal `Set<String>` instead of re-deriving it from `canTransitionTo` itself:** the whole point is an independent source of truth. If the test computed its expectations by calling `canTransitionTo`, it would just be asserting the method agrees with itself — a bug in the `switch` would never surface. Typing the legal pairs out by hand, transcribed directly from the spec's mermaid diagram, is what makes this a real check against the spec rather than a check against the implementation.

**Why one `@ParameterizedTest` over 49 cases instead of 49 separate `@Test` methods:** JUnit reports each parameterized invocation as its own named result (`{0} -> {1}` renders as e.g. `PENDING -> VALIDATING`), so a failure still names the exact pair that broke — same diagnostic value as 49 methods, without 49 near-identical method bodies.

## `DeploymentTest` — behavior of the method itself

```java
package io.appfleet.control.deployment;

import io.appfleet.control.application.Application;
import io.appfleet.control.application.Release;
import io.appfleet.control.environment.Environment;
import org.junit.jupiter.api.Test;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class DeploymentTest {

    private Deployment newDeployment() {
        Application application = new Application("checkout-service", "desc", UUID.randomUUID());
        Release release = new Release(application, "v1.0.0", "s3://artifact.jar", "checksum");
        Environment environment = new Environment("prod");
        return new Deployment(application, release, environment);
    }

    @Test
    void startsInPending() {
        Deployment deployment = newDeployment();
        assertThat(deployment.getStatus()).isEqualTo(DeploymentState.PENDING);
    }

    @Test
    void legalTransitionUpdatesStatusAndUpdatedAt() {
        Deployment deployment = newDeployment();
        var before = deployment.getUpdatedAt();

        deployment.transitionTo(DeploymentState.VALIDATING);

        assertThat(deployment.getStatus()).isEqualTo(DeploymentState.VALIDATING);
        assertThat(deployment.getUpdatedAt()).isAfterOrEqualTo(before);
    }

    @Test
    void illegalTransitionThrowsAndLeavesStatusUnchanged() {
        Deployment deployment = newDeployment(); // starts PENDING

        assertThatThrownBy(() -> deployment.transitionTo(DeploymentState.HEALTHY))
                .isInstanceOf(IllegalStateException.class)
                .hasMessageContaining("PENDING")
                .hasMessageContaining("HEALTHY");

        assertThat(deployment.getStatus()).isEqualTo(DeploymentState.PENDING);
    }

    @Test
    void terminalStatesRejectEveryTransition() {
        Deployment deployment = newDeployment();
        deployment.transitionTo(DeploymentState.VALIDATING);
        deployment.transitionTo(DeploymentState.FAILED);

        for (DeploymentState target : DeploymentState.values()) {
            assertThatThrownBy(() -> deployment.transitionTo(target))
                    .isInstanceOf(IllegalStateException.class);
        }
    }
}
```

Four cases, each proving something the other three don't:
- **`startsInPending`** — the constructor's initial state is right, before any transition logic runs at all.
- **`legalTransitionUpdatesStatusAndUpdatedAt`** — the success path actually mutates both fields it's supposed to.
- **`illegalTransitionThrowsAndLeavesStatusUnchanged`** — the failure path throws the right exception type, with a message naming both states (useful for debugging a real illegal-transition error in logs later), **and** doesn't leave the entity in a half-changed state.
- **`terminalStatesRejectEveryTransition`** — `FAILED`/`ROLLED_BACK` reject every possible target, not just one hand-picked illegal example — this is the entity-level echo of `DeploymentStateTest`'s exhaustiveness, scoped to the two states where the answer is always "no."

## Location and dependencies

`control-api/src/test/java/io/appfleet/control/deployment/DeploymentStateTest.java` and `DeploymentTest.java` — mirrors the main package, same convention every other test in this repo follows (e.g. `fleet-audit-starter`'s `AuditAutoConfigurationTest`). No new dependency needed — `spring-boot-starter-test` (already in `control-api/pom.xml`) brings JUnit 5, AssertJ, and `@ParameterizedTest` transitively.

## Definition of done

- [ ] `DeploymentStateTest.java` created, all 49 cases pass
- [ ] `DeploymentTest.java` created, all 4 cases pass
- [ ] `mvn test -pl control-api` green
