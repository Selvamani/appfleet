package io.appfleet.control.deployment;

import io.appfleet.control.application.Application;
import io.appfleet.control.application.Release;
import io.appfleet.control.audit.AuditEvent;
import io.appfleet.control.audit.AuditEventRecorder;
import io.appfleet.control.audit.AuditEventRepository;
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
}
