package io.appfleet.agent.session;

import io.appfleet.agent.runtime.ContainerRuntime;
import io.appfleet.agent.runtime.ContainerSpec;
import io.appfleet.agent.runtime.RuntimeAutoConfig;

public class SessionService {

    final ContainerRuntime containerRuntime;

    public SessionService(ContainerRuntime containerRuntime) {
        this.containerRuntime = containerRuntime;
    }


    public Session provision(String imageId, String userId) {
        //TODO Use control-api to look up the catalogue image
        return null;
    }
}
