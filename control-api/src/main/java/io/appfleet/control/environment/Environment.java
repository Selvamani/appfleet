package io.appfleet.control.environment;

import io.appfleet.control.common.Uuidv7;
import jakarta.persistence.*;

import java.util.UUID;

@Entity
@Table(name = "environment")
public class Environment {
    @Id
    private UUID id;

    @Column(nullable = false, unique = true)
    private String name;

    protected Environment() {}

    public Environment(String name) {
        this.id = Uuidv7.generate();
        this.name = name;
    }

    public UUID getId() {
        return id;
    }

    public String getName() {
        return name;
    }
}
