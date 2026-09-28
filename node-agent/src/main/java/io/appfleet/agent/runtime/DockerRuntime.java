package io.appfleet.agent.runtime;

import com.github.dockerjava.api.DockerClient;
import com.github.dockerjava.api.async.ResultCallback;
import com.github.dockerjava.api.command.CreateContainerResponse;
import com.github.dockerjava.api.command.InspectContainerResponse;
import com.github.dockerjava.api.model.Container;
import com.github.dockerjava.api.model.Frame;
import com.github.dockerjava.api.model.HostConfig;

import java.nio.charset.StandardCharsets;
import java.time.Instant;
import java.util.List;
import java.util.Map;

public class DockerRuntime implements ContainerRuntime {

    private final DockerClient dockerClient;
    private static final String NODE_ID_LABEL = "io.appfleet.nodeId";

    public DockerRuntime(DockerClient dockerClient) {
        this.dockerClient = dockerClient;
    }

    @Override
    public ContainerHandle start(ContainerSpec spec) {
        HostConfig hostConfig = HostConfig.newHostConfig()
                .withNanoCPUs((long) (spec.cpuLimit() * 1_000_000_000))
                .withMemory(spec.memoryLimitMb() * 1024 * 1024);
        List<String> env = spec.env().entrySet().stream().map(e -> e.getKey() + "=" + e.getValue()).toList();
        CreateContainerResponse created = dockerClient.createContainerCmd(
                spec.image()).withHostConfig(hostConfig).withEnv(env).withLabels(Map.of(NODE_ID_LABEL, spec.nodeId())).exec();
        dockerClient.startContainerCmd(created.getId()).exec();
        return new ContainerHandle(created.getId(), spec.nodeId(), spec.image(), Instant.now());
    }

    @Override
    public void stop(String containerId) {
        dockerClient.stopContainerCmd(containerId).exec();
    }

    @Override
    public ContainerStatus status(String containerId) {
        InspectContainerResponse response = dockerClient.inspectContainerCmd(containerId).exec();
        ContainerState state;
        if(Boolean.TRUE.equals(response.getState().getOOMKilled()) || Boolean.TRUE.equals(response.getState().getDead())) {
            state = ContainerState.CRASHED;
        } else if (Boolean.TRUE.equals(response.getState().getPaused()) || Boolean.TRUE.equals(response.getState().getRunning())) {
            state = ContainerState.RUNNING;
        } else if ("exited".equals(response.getState().getStatus())) {
            state = response.getState().getExitCodeLong() !=null  && response.getState().getExitCodeLong() == 0 ? ContainerState.STOPPED :  ContainerState.FAILED;
        } else if (Boolean.TRUE.equals(response.getState().getRestarting())) {
            state = ContainerState.PENDING;
        } else if ("created".equals(response.getState().getStatus())) {
            state = ContainerState.PENDING;
        } else {
            state = ContainerState.FAILED;
        }
        String detail = (response.getState().getError() != null && !response.getState().getError().isBlank()) ? response.getState().getError() : response.getState().getStatus();
        return new ContainerStatus(containerId, state, detail,Instant.now());
    }

    @Override
    public String logs(String containerId) {
        final StringBuilder sb = new StringBuilder();
        ResultCallback.Adapter<Frame> callback = new ResultCallback.Adapter<>() {
            @Override
            public void onNext(Frame frame) {
                sb.append(new String(frame.getPayload(), StandardCharsets.UTF_8));
            }
        };
        try {
            dockerClient.logContainerCmd(containerId).withStdErr(true).withStdOut(true).exec(callback).awaitCompletion();
        } catch (InterruptedException e) {
            Thread.currentThread().interrupt();
        }
        return sb.toString();
    }


    @Override
    public List<ContainerHandle> list() {
        List<Container> containerList = dockerClient.listContainersCmd().withLabelFilter(List.of(NODE_ID_LABEL)).withShowAll(true).exec();
        return containerList.stream().map(container -> new ContainerHandle(container.getId(), container.getLabels().getOrDefault(NODE_ID_LABEL,""), container.getImageId(), Instant.ofEpochSecond(container.getCreated()))).toList();
    }
}
