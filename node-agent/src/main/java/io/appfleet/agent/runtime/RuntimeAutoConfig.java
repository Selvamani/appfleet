package io.appfleet.agent.runtime;

import com.github.dockerjava.api.DockerClient;
import io.appfleet.agent.config.AgentProperties;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
public class RuntimeAutoConfig {

    @Bean
    @ConditionalOnProperty(prefix = "appfleet.runtime", name = "mode", havingValue = "docker")
    ContainerRuntime dockerContainerRuntime(DockerClient dockerClient) {
        return new DockerRuntime(dockerClient);
    }

    @Bean
    @ConditionalOnProperty(prefix = "appfleet.runtime", name = "mode", havingValue = "simulated")
    ContainerRuntime simulatedContainerRuntime(AgentProperties agentProperties) {
        return new SimulatedRuntime(agentProperties);
    }

    @Bean
    @ConditionalOnProperty(prefix = "appfleet.runtime", name = "mode", havingValue = "swarm")
    ContainerRuntime swarmContainerRuntime() {
        return new SwarmRuntime();
    }
}
