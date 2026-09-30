package io.appfleet.control.catalogue;

import io.appfleet.control.common.Uuidv7;
import jakarta.persistence.*;

import java.util.UUID;

@Entity
@Table(name = "base_image")
public class BaseImage {
    @Id
    private UUID id;

    @Column(nullable = false)
    private String name;

    @Column(nullable = false)
    private String registry;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "parent_base_image_id")
    private BaseImage parent;

    protected BaseImage() {}

    public BaseImage(String name, String registry, BaseImage parent) {
        this.id = Uuidv7.generate();
        this.name = name;
        this.registry = registry;
        this.parent = parent;
    }

    public UUID getId() {
        return id;
    }

    public String getName() {
        return name;
    }

    public String getRegistry() {
        return registry;
    }

    public BaseImage getParent() {
        return parent;
    }
}
