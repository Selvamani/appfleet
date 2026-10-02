package io.appfleet.control.task;

import io.appfleet.control.common.NotFoundException;
import io.appfleet.control.deployment.DeploymentRepository;
import io.appfleet.control.task.web.TaskResponse;
import io.appfleet.control.web.CursorCodec;
import io.appfleet.control.web.CursorPage;
import io.appfleet.control.web.OffsetPage;
import org.springframework.data.domain.Limit;
import org.springframework.data.domain.PageRequest;
import org.springframework.data.domain.Slice;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.List;
import java.util.UUID;

@Service
public class TaskService {

    private final TaskRepository taskRepository;
    private final DeploymentRepository deploymentRepository;

    public TaskService(TaskRepository taskRepository, DeploymentRepository deploymentRepository) {
        this.taskRepository = taskRepository;
        this.deploymentRepository = deploymentRepository;
    }

    @Transactional(readOnly = true)
    public TaskResponse get(UUID id) {
        Task task = taskRepository.findById(id).orElseThrow(() -> new NotFoundException("Task", id));
        return TaskResponse.from(task);
    }

    @Transactional(readOnly = true)
    public CursorPage<TaskResponse> history(UUID deploymentId, UUID afterId, int limit) {
        requireDeployment(deploymentId);
        Limit fetch = Limit.of(limit+1);
        List<Task> rows = afterId == null ?
                taskRepository.findByDeployment_IdOrderByIdAsc(deploymentId, fetch)
                : taskRepository.findByDeployment_IdAndIdGreaterThanOrderByIdAsc(deploymentId, afterId, fetch);
        boolean hasNext = rows.size() > limit;
        List<Task> page = hasNext ? rows.subList(0, limit) : rows;
        List<TaskResponse> items = page.stream().map(TaskResponse::from).toList();
        String nextCursor = hasNext ? CursorCodec.encode(page.get(page.size() -  1).getId()) : null;
        return new CursorPage<>(items, nextCursor);
    }

    @Transactional(readOnly = true)
    public OffsetPage<TaskResponse> historyByOffset(UUID deploymentId, int page, int size) {
        requireDeployment(deploymentId);
        Slice<Task> slice = taskRepository.findSliceByDeployment_IdOrderByIdAsc(deploymentId, PageRequest.of(page, size));
        return new OffsetPage<>(slice.map(TaskResponse::from).getContent(), page, size, slice.hasNext());
    }

    private void requireDeployment(UUID deploymentId) {
        if (!deploymentRepository.existsById(deploymentId)) {
            throw new NotFoundException("Deployment", deploymentId);
        }
    }
}
