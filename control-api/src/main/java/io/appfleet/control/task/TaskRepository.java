package io.appfleet.control.task;

import io.appfleet.control.deployment.Deployment;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.UUID;

public interface TaskRepository extends JpaRepository<Task, UUID> {
    List<Task> findByDeployment(Deployment deployment);
}
