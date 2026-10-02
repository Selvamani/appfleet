package io.appfleet.control.task;

import io.appfleet.control.deployment.Deployment;
import org.springframework.data.domain.Limit;
import org.springframework.data.domain.Pageable;
import org.springframework.data.domain.Slice;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Collection;
import java.util.List;
import java.util.UUID;

public interface TaskRepository extends JpaRepository<Task, UUID> {
    List<Task> findByDeployment(Deployment deployment);
    boolean existsByDeployment_IdAndTaskTypeAndStatusIn(UUID deploymentId, String taskType, Collection<TaskStatus> statuses);
    List<Task> findByDeployment_IdOrderByIdAsc(UUID deploymentId, Limit limit);
    List<Task> findByDeployment_IdAndIdGreaterThanOrderByIdAsc(UUID deploymentId, UUID after, Limit limit);
    Slice<Task> findSliceByDeployment_IdOrderByIdAsc(UUID deploymentId, Pageable pageable);
}