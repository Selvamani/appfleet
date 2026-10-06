package io.appfleet.control.web;

import io.appfleet.control.application.*;
import io.appfleet.control.deployment.*;
import io.appfleet.control.deployment.web.CreateDeploymentRequest;
import io.appfleet.control.environment.Environment;
import io.appfleet.control.environment.EnvironmentRepository;
import io.appfleet.control.task.Task;
import io.appfleet.control.task.TaskRepository;
import org.springframework.boot.test.context.TestComponent;

import java.util.ArrayList;
import java.util.List;
import java.util.UUID;

import static io.appfleet.control.deployment.DeploymentState.*;

/** Repository-level fixtures shared by the web tests. Each call creates fresh, uniquely named rows. */
@TestComponent
public class TestFixtures {

    public record Fixture(Application app, Release release, Environment env) {
        public CreateDeploymentRequest request() {
            return new CreateDeploymentRequest(app.getId(), release.getId(), env.getName());
        }
    }

    private final ApplicationRepository applications;
    private final ReleaseRepository releases;
    private final EnvironmentRepository environments;
    private final DeploymentRepository deployments;
    private final TaskRepository tasks;

    public TestFixtures(ApplicationRepository applications, ReleaseRepository releases, EnvironmentRepository environments,
                        DeploymentRepository deployments, TaskRepository tasks) {
        this.applications = applications;
        this.releases = releases;
        this.environments = environments;
        this.deployments = deployments;
        this.tasks = tasks;
    }

    /** A new application, release and environment: a valid target for POST /deployments. Random owner team. */
    public Fixture fixture() {
        return fixtureFor(TestAuth.TEAM);
    }

    /** Same, with the application owned by the given team. */
    public Fixture fixtureFor(UUID ownerTeamId) {
        String suffix = UUID.randomUUID().toString().substring(0, 8);
        Application app = applications.save(new Application("app-" + suffix, "x", ownerTeamId));
        Release release = releases.save(new Release(app, "v1.0.0", "registry/app:v1.0.0", "sha256:" + "a".repeat(64)));
        Environment env = environments.save(new Environment("env-" + suffix));
        return new Fixture(app, release, env);
    }

    /** A PENDING deployment of an application owned by the given team. */
    public Deployment deploymentFor(UUID ownerTeamId) {
        Fixture f = fixtureFor(ownerTeamId);
        return deployments.save(new Deployment(f.app(), f.release(), f.env()));
    }

    /** A deployment of the given team's application, moved to the target state through legal transitions. */
    public Deployment deploymentFor(UUID ownerTeamId, DeploymentState target) {
        Deployment d = deploymentFor(ownerTeamId);
        driveTo(d.getId(), target);
        return d;
    }


    /** A PENDING deployment saved directly, without the API (no task, no audit row). */
    public Deployment deployment() {
        Fixture f = fixture();
        return deployments.save(new Deployment(f.app(), f.release(), f.env()));
    }

    /** A deployment saved directly and moved to the given state through legal transitions. */
    public UUID deploymentIn(DeploymentState target) {
        UUID id = deployment().getId();
        driveTo(id, target);
        return id;
    }

    /** Moves an existing deployment to the given state, one legal transition at a time. */
    public void driveTo(UUID deploymentId, DeploymentState target) {
        Deployment d = deployments.findById(deploymentId).orElseThrow();
        for (DeploymentState s : pathTo(target)) {
            d.transitionTo(s);
            d = deployments.save(d);   // merge returns a copy with the new version: keep it, or the next save is stale
        }
    }

    /** Saves {@code count} DEPLOY tasks and returns their ids in history order (sorted, not insertion order). */
    public List<String> tasks(Deployment deployment, int count) {
        List<String> ids = new ArrayList<>();
        for (int i = 0; i < count; i++) {
            ids.add(tasks.save(new Task(deployment, Task.DEPLOY)).getId().toString());
        }
        return ids.stream().sorted().toList();
    }

    private static DeploymentState[] pathTo(DeploymentState target) {
        return switch (target) {
            case PENDING -> new DeploymentState[]{};
            case FAILED -> new DeploymentState[]{VALIDATING, FAILED};
            case HEALTHY -> new DeploymentState[]{VALIDATING, DEPLOYING, HEALTHY};
            case DEGRADED -> new DeploymentState[]{VALIDATING, DEPLOYING, HEALTHY, DEGRADED};
            case ROLLED_BACK -> new DeploymentState[]{VALIDATING, DEPLOYING, HEALTHY, ROLLED_BACK};
            default -> throw new IllegalArgumentException("No fixture path to " + target);
        };
    }
}

