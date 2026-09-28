package io.appfleet.agent.runtime;

import java.util.List;

public interface ContainerRuntime {
    ContainerHandle start(ContainerSpec spec);

    void stop(String containerId);

    ContainerStatus status(String containerId);

    String logs(String containerId);

    List<ContainerHandle> list();
}
