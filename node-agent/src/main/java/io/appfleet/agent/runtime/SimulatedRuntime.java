package io.appfleet.agent.runtime;

import io.appfleet.agent.config.AgentProperties;

import java.util.List;

public class SimulatedRuntime implements ContainerRuntime {

    public SimulatedRuntime(AgentProperties agentProperties) {

    }

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
