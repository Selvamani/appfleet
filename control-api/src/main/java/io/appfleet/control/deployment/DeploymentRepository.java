package io.appfleet.control.deployment;

import io.appfleet.control.application.Application;
import io.appfleet.control.environment.Environment;
import jakarta.persistence.LockModeType;
import org.springframework.data.domain.Limit;
import org.springframework.data.jpa.repository.EntityGraph;
import org.springframework.data.jpa.repository.JpaRepository;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface DeploymentRepository extends JpaRepository<Deployment, UUID> {
    @EntityGraph(attributePaths = {"environment", "application"})
    Optional<Deployment> findDetailById(UUID id);

    @Lock(LockModeType.OPTIMISTIC_FORCE_INCREMENT)
    Optional<Deployment> findLockedById(UUID id);

    List<Deployment> findByApplication(Application application);

    List<Deployment> findByApplicationAndEnvironment(Application application, Environment environment);

    @Query("select d from Deployment d join fetch d.tasks")
    List<Deployment> findAllWithTasksJoinFetch();

    @EntityGraph(attributePaths = "tasks")
    List<Deployment> findAllBy();

    List<DeploymentListView> findByApplication_Id(UUID applicationId);

    @Query("select d.application.ownerTeamId from Deployment d where d.id = :id")
    Optional<UUID> findOwnerTeamById(@Param("id") UUID id);
}
