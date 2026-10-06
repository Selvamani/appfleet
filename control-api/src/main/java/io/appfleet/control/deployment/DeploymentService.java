package io.appfleet.control.deployment;

import io.appfleet.control.application.Application;
import io.appfleet.control.application.ApplicationRepository;
import io.appfleet.control.application.Release;
import io.appfleet.control.application.ReleaseRepository;
import io.appfleet.control.audit.AuditEvent;
import io.appfleet.control.audit.AuditEventRecorder;
import io.appfleet.control.common.NotFoundException;
import io.appfleet.control.common.UnprocessableRequestException;
import io.appfleet.control.deployment.web.CreateDeploymentRequest;
import io.appfleet.control.deployment.web.DeploymentAccepted;
import io.appfleet.control.deployment.web.DeploymentResponse;
import io.appfleet.control.deployment.web.RollbackAccepted;
import io.appfleet.control.environment.Environment;
import io.appfleet.control.environment.EnvironmentRepository;
import io.appfleet.control.outbox.OutboxWriter;
import io.appfleet.control.security.TeamAccess;
import io.appfleet.control.task.Task;
import io.appfleet.control.task.TaskRepository;
import io.appfleet.control.task.TaskStatus;
import io.appfleet.events.CommandType;
import io.appfleet.events.DeploymentCommand;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Propagation;
import org.springframework.transaction.annotation.Transactional;

import java.util.EnumSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;

@Service
public class DeploymentService {

    private static final Set<TaskStatus> OPEN_TASK_STATUSES = EnumSet.of(TaskStatus.PENDING, TaskStatus.RUNNING);

    private final DeploymentRepository deploymentRepository;
    private final AuditEventRecorder auditEventRecorder;
    private final ApplicationRepository applicationRepository;
    private final ReleaseRepository releaseRepository;
    private final EnvironmentRepository environmentRepository;
    private final TaskRepository taskRepository;
    private final TeamAccess teamAccess;
    private final OutboxWriter outboxWriter;

    public DeploymentService(DeploymentRepository deploymentRepository, AuditEventRecorder auditEventRecorder, ApplicationRepository applicationRepository, ReleaseRepository releaseRepository, EnvironmentRepository environmentRepository, TaskRepository taskRepository, TeamAccess teamAccess, OutboxWriter outboxWriter) {
        this.deploymentRepository = deploymentRepository;
        this.auditEventRecorder = auditEventRecorder;
        this.applicationRepository = applicationRepository;
        this.releaseRepository = releaseRepository;
        this.environmentRepository = environmentRepository;
        this.taskRepository = taskRepository;
        this.teamAccess = teamAccess;
        this.outboxWriter = outboxWriter;
    }

    @Transactional
    public Deployment createBroken(Application application, Release release, Environment environment, String actor) {
        Deployment deployment = new Deployment(application, release, environment);
        deploymentRepository.save(deployment);
        this.recordAuditSelfInvoked(actor, deployment);
        throw new IllegalStateException("simulated failure to prove the audit row does NOT survive this rollback");
    }

    @Transactional(propagation = Propagation.REQUIRES_NEW)
    public void recordAuditSelfInvoked(String actor, Deployment deployment) {
        auditEventRecorder.record(new AuditEvent(actor, "DEPLOYMENT_CREATED", "deployment", deployment.getId(), null));
    }

    @Transactional
    public Deployment create(Application application, Release release, Environment environment, String actor) {
        Deployment deployment = new Deployment(application, release, environment);
        deploymentRepository.save(deployment);
        auditEventRecorder.record(new AuditEvent(actor, "DEPLOYMENT_CREATED", "deployment", deployment.getId(), null));
        throw new IllegalStateException("simulated failure to prove the audit row DOES survive this rollback");
    }

    @Transactional
    public Deployment createRiskyDefault(Application application, Release release, Environment environment) throws DeploymentValidationException {
        Deployment deployment = new Deployment(application, release, environment);
        deploymentRepository.save(deployment);
        throw new DeploymentValidationException("simulated validation failure — expect this to commit anyway");
    }

    @Transactional(rollbackFor = DeploymentValidationException.class)
    public Deployment createRiskySafe(Application application, Release release, Environment environment) throws DeploymentValidationException {
        Deployment deployment = new Deployment(application, release, environment);
        deploymentRepository.save(deployment);
        throw new DeploymentValidationException("simulated validation failure — expect this to roll back");
    }

    @Transactional(readOnly = true)
    public List<Deployment> listAllNaive() {
        return deploymentRepository.findAll();
    }

    @Transactional(readOnly = true)
    public List<DeploymentSummary> listSummaries() {
        return deploymentRepository.findAllBy().stream()
                .map(deployment -> new DeploymentSummary(deployment.getId(), deployment.getStatus(), deployment.getTasks().size()))
                .toList();
    }

    @Transactional
    public DeploymentAccepted requestDeployment(CreateDeploymentRequest request, String actor) {
        Application application = applicationRepository.findById(request.applicationId())
                .orElseThrow(() ->  new UnprocessableRequestException("Application " + request.applicationId() + " does not exist."));
        teamAccess.require("deployment:create", application.getOwnerTeamId(),
                () -> new UnprocessableRequestException("Application " + request.applicationId() + " does not exist."));
        Release release = releaseRepository.findByIdAndApplication_Id(request.releaseId(), request.applicationId())
                .orElseThrow(() -> new UnprocessableRequestException("Release " + request.releaseId() + " does not exist for application " + request.applicationId() + "."));
        Environment environment = environmentRepository.findByName(request.environment())
                .orElseThrow(() -> new UnprocessableRequestException("Environment '" + request.environment() + "' does not exist."));
        Deployment deployment = new Deployment(application, release, environment);
        deploymentRepository.saveAndFlush(deployment);
        Task task = taskRepository.save(new Task(deployment, Task.DEPLOY));
        auditEventRecorder.record(new AuditEvent(actor, "DEPLOYMENT_REQUESTED", "deployment", deployment.getId(), null));
        outboxWriter.write(DeploymentCommand.of(CommandType.DEPLOY, task.getId(), deployment.getId(),
                application.getId(), release.getId(), environment.getName(), actor));
        return new DeploymentAccepted(deployment.getId(), task.getId(), deployment.getStatus());
    }

    @Transactional
    public RollbackAccepted requestRollback(UUID deploymentId, String actor) {
        Deployment deployment = deploymentRepository.findLockedById(deploymentId).orElseThrow(() -> new NotFoundException("Deployment", deploymentId));
        teamAccess.require("deployment:rollback", deployment.getApplication().getOwnerTeamId(),
                () -> new NotFoundException("Deployment", deploymentId));
        if(!deployment.getStatus().canTransitionTo(DeploymentState.ROLLED_BACK)) {
            throw new IllegalTransitionException("Illegal transition from " + deployment.getStatus() + " to " + DeploymentState.ROLLED_BACK);
        }

        if(taskRepository.existsByDeployment_IdAndTaskTypeAndStatusIn(deploymentId, Task.ROLLBACK, OPEN_TASK_STATUSES)) {
            throw new RollbackAlreadyRequestedException(deploymentId);
        }

        Task task = taskRepository.save(new Task(deployment, Task.ROLLBACK));
        auditEventRecorder.record(new AuditEvent(actor, "ROLLBACK_REQUESTED", "deployment", deployment.getId(), null));
        outboxWriter.write(DeploymentCommand.of(CommandType.ROLLBACK, task.getId(), deployment.getId(),
                deployment.getApplication().getId(), deployment.getRelease().getId(), deployment.getEnvironment().getName(), actor));
        return new RollbackAccepted(deployment.getId(), task.getId());
    }

    @Transactional(readOnly = true)
    public DeploymentResponse get(UUID id) {
        Deployment deployment = deploymentRepository.findDetailById(id).orElseThrow(() -> new NotFoundException("Deployment", id));
        teamAccess.require("deployment:read", deployment.getApplication().getOwnerTeamId(), () ->  new NotFoundException("Deployment", id));
        return DeploymentResponse.from(deployment);
    }
}
