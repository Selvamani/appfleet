package io.appfleet.agent.runtime;

import java.util.List;

public class SwarmRuntime implements ContainerRuntime {

    @Override
    public ContainerHandle start(ContainerSpec spec) {
        return null;
    }

    @Override
    public void stop(String containerId) {

    }

    @Override
    public ContainerStatus status(String containerId) {
        return null;
    }

    @Override
    public String logs(String containerId) {
        return "";
    }

    @Override
    public List<ContainerHandle> list() {
        return List.of();
    }
}
