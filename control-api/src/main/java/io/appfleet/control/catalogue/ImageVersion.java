package io.appfleet.control.catalogue;

import io.appfleet.control.common.Uuidv7;
import jakarta.persistence.*;

import java.util.UUID;

@Entity
@Table(name = "image_version")
public class ImageVersion {
    @Id
    private UUID id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "app_image_id", nullable = false)
    private AppImage appImage;

    @Column(nullable = false)
    private String version;

    @Column(name = "pipeline_state", nullable = false)
    private String pipelineState;

    protected ImageVersion() {}

    public ImageVersion(AppImage appImage, String version, String pipelineState) {
        this.id = Uuidv7.generate();
        this.appImage = appImage;
        this.version = version;
        this.pipelineState = pipelineState;
    }

    public UUID getId() {
        return id;
    }

    public AppImage getAppImage() {
        return appImage;
    }

    public String getVersion() {
        return version;
    }

    public String getPipelineState() {
        return pipelineState;
    }
}
