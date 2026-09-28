package io.appfleet.agent.config;

import org.springframework.boot.context.properties.ConfigurationProperties;

import java.time.Duration;

@ConfigurationProperties(prefix = "appfleet")
public record AgentProperties(
    RuntimeProperties runtime,
    LeaseProperties lease,
    SessionProperties session,
    HeartbeatProperties heartbeat
) {

    public record RuntimeProperties(String mode, DockerProperties docker, SimulatedProperties simulated) {
    }

    public record DockerProperties(String host) {
    }

    public record SimulatedProperties(Duration startLatency, double failureRate, double crashAfterStartProbability) {
    }

    public record LeaseProperties(Duration ttl, Duration renewInterval) {
    }

    public record SessionProperties(Duration idleTimeout) {
    }

    public record HeartbeatProperties(Duration interval, Duration threshold) {
    }
}