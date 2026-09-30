# control-api — S2 service layer

**Spec:** [01-CONTROL-API.md §S2](../../specs/project/01-CONTROL-API.md), remaining bullets: the self-invocation bug, rollback rules, `REQUIRES_NEW`, plus the transactional boundary the N+1 and `LazyInitializationException` drills run inside.

Companion: [control-api-s2-repositories.md](control-api-s2-repositories.md) (what this layer calls), [control-api-s2-entities.md](control-api-s2-entities.md)/[control-api-s2-verification.md](control-api-s2-verification.md) (what it operates on). **Status: designed, not yet implemented.**

## Why a service layer at all, and what goes in it

Per the repo-wide convention already stated in [control-api-spring-flow.md §3](control-api-spring-flow.md): controllers stay thin, **the service layer owns transactions**, repositories know nothing about business rules. Four of the six remaining S2 checklist items need a `@Transactional` method to exist before they can be demonstrated at all — none of them are properties of an entity or a repository, they're properties of *how a transaction boundary behaves*. This doc designs exactly enough service-layer code to make each one demonstrable, not a general-purpose service layer for its own sake.

Three new classes, two packages:

```
io.appfleet.control.deployment
├── DeploymentService              orchestrates deployment creation, owns the transaction boundary
└── DeploymentValidationException  checked exception — the rollback-rules demo needs one that exists

io.appfleet.control.audit
└── AuditEventRecorder              the self-invocation fix AND the REQUIRES_NEW demo, at once
```

## `AuditEventRecorder` — a separate bean, and why it has to be

```java
package io.appfleet.control.audit;

import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

@Service
public class AuditEventRecorder {

    private final AuditEventRepository auditEventRepository;

    public AuditEventRecorder(AuditEventRepository auditEventRepository) {
        this.auditEventRepository = auditEventRepository;
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void record(AuditEvent event) {
        auditEventRepository.save(event);
    }
}
```

This single class is simultaneously the **fix** for the self-invocation bug and the thing that makes `REQUIRES_NEW` (S2 checklist item 7) real. Spring's `@Transactional` works by wrapping the bean in a proxy — a call has to go *through* that proxy for the annotation to take effect. A call from one method to another **on the same object** (`this.record(...)`) never goes through the proxy at all; it's a plain Java method call. If `record(...)` lived as a sibling method inside `DeploymentService` and got called as `this.record(...)`, `@Transactional(propagation = REQUIRES_NEW)` on it would be silently ignored — no new transaction would ever open, it would just run inside whatever transaction the caller was already in. `AuditEventRecorder` being a genuinely separate Spring bean isn't refactoring polish here — it's the only way `REQUIRES_NEW` can function at all. This is why the spec's self-invocation bullet and its `REQUIRES_NEW` bullet are really one demonstration, not two unrelated ones.

## `DeploymentValidationException` — a checked exception, on purpose

```java
package io.appfleet.control.deployment;

public class DeploymentValidationException extends Exception {
    public DeploymentValidationException(String message) {
        super(message);
    }
}
```

**Checked, not a `RuntimeException`**, because the rollback-rules bullet is specifically about Spring's default behavior for checked exceptions: `@Transactional` only rolls back automatically on unchecked exceptions (`RuntimeException`/`Error`) by default — a checked exception thrown mid-transaction commits anyway unless `rollbackFor` says otherwise. A `RuntimeException` here wouldn't demonstrate anything; the surprise only exists because this one is checked.

## `DeploymentService` — three demonstrations, one class

```java
package io.appfleet.control.deployment;

import io.appfleet.control.application.Application;
import io.appfleet.control.application.Release;
import io.appfleet.control.audit.AuditEvent;
import io.appfleet.control.audit.AuditEventRecorder;
import io.appfleet.control.environment.Environment;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;

@Service
public class DeploymentService {

    private final DeploymentRepository deploymentRepository;
    private final AuditEventRecorder auditEventRecorder;

    public DeploymentService(DeploymentRepository deploymentRepository, AuditEventRecorder auditEventRecorder) {
        this.deploymentRepository = deploymentRepository;
        this.auditEventRecorder = auditEventRecorder;
    }

    // --- Self-invocation bug, kept as the broken version, per repo convention
    //     ("keep the broken version as a @Disabled test"). This method itself
    //     stays in the tree; the test proving it's broken is @Disabled, not this code.
    @Transactional
    public Deployment createBroken(Application application, Release release, Environment environment, String actor) {
        Deployment deployment = new Deployment(application, release, environment);
        deploymentRepository.save(deployment);
        this.recordAuditSelfInvoked(actor, deployment); // proxy bypass — never actually REQUIRES_NEW
        throw new IllegalStateException("simulated failure to prove the audit row does NOT survive this rollback");
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void recordAuditSelfInvoked(String actor, Deployment deployment) {
        auditEventRecorder.record(new AuditEvent(actor, "DEPLOYMENT_CREATED", "Deployment", deployment.getId(), null));
    }

    // --- The fix: audit recording delegated to a genuinely separate bean.
    //     Same simulated failure after the audit write — this time the audit
    //     row survives, because AuditEventRecorder.record(...) is a real
    //     cross-bean call, so REQUIRES_NEW actually takes effect.
    @Transactional
    public Deployment create(Application application, Release release, Environment environment, String actor) {
        Deployment deployment = new Deployment(application, release, environment);
        deploymentRepository.save(deployment);
        auditEventRecorder.record(new AuditEvent(actor, "DEPLOYMENT_CREATED", "Deployment", deployment.getId(), null));
        throw new IllegalStateException("simulated failure to prove the audit row DOES survive this rollback");
    }

    // --- Rollback rules: checked exception, default behavior first,
    //     then the rollbackFor-equipped fix.
    @Transactional
    public Deployment createRiskyDefault(Application application, Release release, Environment environment)
            throws DeploymentValidationException {
        Deployment deployment = new Deployment(application, release, environment);
        deploymentRepository.save(deployment);
        throw new DeploymentValidationException("simulated validation failure — expect this to commit anyway");
    }

    @Transactional(rollbackFor = DeploymentValidationException.class)
    public Deployment createRiskySafe(Application application, Release release, Environment environment)
            throws DeploymentValidationException {
        Deployment deployment = new Deployment(application, release, environment);
        deploymentRepository.save(deployment);
        throw new DeploymentValidationException("simulated validation failure — expect this to roll back");
    }

    // --- N+1 / LazyInitializationException: the same naive method demonstrates
    //     both, depending on when the caller touches the lazy `tasks` collection.
    //     Touched while this transaction is still open, no fetch strategy →
    //     one query per deployment (N+1). Touched after this method returns
    //     and the transaction has closed → LazyInitializationException.
    @Transactional(readOnly = true)
    public List<Deployment> listAllNaive() {
        return deploymentRepository.findAll();
    }
}
```

**Why `createBroken`/`create` and `createRiskyDefault`/`createRiskySafe` both stay as pairs in the real code, not "broken version deleted after the test is written":** the spec's own convention elsewhere in this project (`node-agent`'s deliberate MDC-bleed bug, the deadlock drill) is to keep the broken version reachable — usually via a `@Disabled` test — specifically so the failure is reproducible on demand later, not just something that happened once and left no trace. Here the broken *methods* stay in `DeploymentService` permanently (clearly named `*Broken`/`*Default` vs the fixed `create`/`*Safe`), and the tests proving each pair's different behavior are what actually get written — one `@Test` per fixed method, one `@Disabled` test per broken method, per the convention.

**Why one service class instead of splitting each concern out:** every method here is a facet of the *same* underlying object (`Deployment` creation) and the *same* underlying question ("what actually happens at this transaction boundary") — splitting into `DeploymentCreationService`/`DeploymentRollbackDemoService`/etc. would scatter one coherent teaching example across files for no reader benefit. This is a demonstration class, not a growing production surface; if `S3`'s real `POST /deployments` endpoint needs different shape later, it calls whichever of these methods turns out to be the right one (almost certainly `create`, not the broken variants).

## `LazyInitializationException` — the fix, once observed broken

Not designed in code yet (per the "find it broken first" discipline already used for the N+1 fix variants in [control-api-s2-repositories.md](control-api-s2-repositories.md)) — but the *shape* of the fix is worth stating now so `listAllNaive` isn't mistaken for the final answer: once the exception is actually observed (a test calling `listAllNaive()` then touching `.getTasks()` on a returned `Deployment` outside any transaction), the fix is either (a) map to a DTO *inside* the still-open transaction, never handing the entity itself past the transaction boundary, or (b) use a fetch strategy (`@EntityGraph`, same one the N+1 fix needs) so `tasks` is already loaded before the transaction closes. The spec explicitly asks this be solved **without** turning `open-in-view` on — `listAllNaive` staying naive is what makes that fix demonstrable at all.

## Definition of done

- [ ] `AuditEventRecorder`, `DeploymentValidationException`, `DeploymentService` created as above
- [ ] Self-invocation: `@Disabled` test proving `createBroken` does *not* leave an audit row after rollback; active test proving `create` *does*
- [ ] Rollback rules: `@Disabled` (or plainly-named, matching whichever convention gets picked when written) test proving `createRiskyDefault` commits the deployment row despite throwing; active test proving `createRiskySafe` rolls it back
- [ ] `mvn verify` green

## What's next

With this in place: the N+1 drill (call `listAllNaive()` against seeded data, count queries, design the 3 fixes) and the `LazyInitializationException` drill (call it, touch `tasks` outside the transaction, observe the exception, apply the fix from the section above) are both finally runnable. Optimistic-lock test (`Deployment.transitionTo` under two concurrent transactions) still needs its own design — `create`/`transitionTo` existing now is what that test will actually call.
