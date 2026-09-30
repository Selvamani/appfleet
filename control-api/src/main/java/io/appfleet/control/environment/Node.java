package io.appfleet.control.environment;

import io.appfleet.control.common.Uuidv7;
import jakarta.persistence.*;

import java.util.UUID;

@Entity
@Table(name = "node")
public class Node {
    @Id
    private UUID id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "environment_id", nullable = false)
    private Environment environment;

    @Column(nullable = false)
    private String hostname;

    protected Node() {}

    public Node(Environment environment, String hostname) {
        this.id = Uuidv7.generate();
        this.environment = environment;
        this.hostname = hostname;
    }

    public UUID getId() {
        return id;
    }

    public Environment getEnvironment() {
        return environment;
    }

    public String getHostname() {
        return hostname;
    }
}
