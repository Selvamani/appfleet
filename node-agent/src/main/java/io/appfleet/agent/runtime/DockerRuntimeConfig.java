package io.appfleet.agent.runtime;

import com.github.dockerjava.api.DockerClient;
import com.github.dockerjava.core.DefaultDockerClientConfig;
import com.github.dockerjava.core.DockerClientImpl;
import com.github.dockerjava.httpclient5.ApacheDockerHttpClient;
import com.github.dockerjava.transport.DockerHttpClient;
import io.appfleet.agent.config.AgentProperties;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

@Configuration
class DockerRuntimeConfig {

    @Bean
    @ConditionalOnProperty(prefix = "appfleet.runtime", name = "mode", havingValue = "docker")
    DockerClient dockerClient(AgentProperties agentProperties) {
        DefaultDockerClientConfig.Builder configBuilder = DefaultDockerClientConfig.createDefaultConfigBuilder();
        var docker = agentProperties.runtime().docker();
        if(docker != null && docker.host() != null && !docker.host().isBlank()) {
            configBuilder.withDockerHost(docker.host());
        }
        DefaultDockerClientConfig clientConfig = configBuilder.build();
        DockerHttpClient httpClient = new ApacheDockerHttpClient.Builder()
            .dockerHost(clientConfig.getDockerHost())
            .sslConfig(clientConfig.getSSLConfig())
            .build();
        return DockerClientImpl.getInstance(clientConfig, httpClient);
    }
}
