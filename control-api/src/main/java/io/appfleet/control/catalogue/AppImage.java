package io.appfleet.control.catalogue;

import io.appfleet.control.common.Uuidv7;
import jakarta.persistence.*;

import java.util.UUID;

@Entity
@Table(name = "app_image")
public class AppImage {
    @Id
    private UUID id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "base_image_id", nullable = false)
    private BaseImage baseImage;

    @Column(nullable = false)
    private String name;

    private String maintainer;

    protected AppImage() {}

    public AppImage(BaseImage baseImage, String name, String maintainer) {
        this.id = Uuidv7.generate();
        this.baseImage = baseImage;
        this.name = name;
        this.maintainer = maintainer;
    }

    public UUID getId() {
        return id;
    }

    public BaseImage getBaseImage() {
        return baseImage;
    }

    public String getName() {
        return name;
    }

    public String getMaintainer() {
        return maintainer;
    }
}
