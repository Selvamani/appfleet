package io.appfleet.control.deployment;

import io.appfleet.control.application.Application;
import io.appfleet.control.environment.Environment;
import org.springframework.data.jpa.repository.EntityGraph;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Query;

import java.util.List;
import java.util.UUID;

public interface DeploymentRepository extends JpaRepository<Deployment, UUID> {
    List<Deployment> findByApplication(Application application);
    List<Deployment> findByApplicationAndEnvironment(Application application, Environment environment);
    @Query("select d from Deployment d join fetch d.tasks")
    List<Deployment> findAllWithTasksJoinFetch();
    @EntityGraph(attributePaths = "tasks")
    List<Deployment> findAllBy();
    List<DeploymentListView> findByApplication_Id(UUID applicationId);
}
