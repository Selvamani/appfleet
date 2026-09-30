package io.appfleet.control.application;

import io.appfleet.control.common.Uuidv7;
import jakarta.persistence.*;

import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.UUID;

@Entity
@Table(name = "release")
public class Release {
    @Id
    private UUID id;

    @ManyToOne(fetch = FetchType.LAZY)
    @JoinColumn(name = "application_id", nullable = false)
    private Application application;

    @Column(nullable = false)
    private String version;

    @Column(name = "artifact_ref", nullable = false)
    private String artifactRef;

    @Column(nullable = false)
    private String checksum;

    @Column(name = "created_at", nullable = false)
    private Instant createdAt;

    protected Release() {}

    public Release(Application application, String version, String artifactRef, String checksum) {
        this.id = Uuidv7.generate();
        this.application = application;
        this.version = version;
        this.artifactRef = artifactRef;
        this.checksum = checksum;
        this.createdAt = Instant.now().truncatedTo(ChronoUnit.MICROS);
    }

    public UUID getId() {
        return id;
    }

    public Application getApplication() {
        return application;
    }

    public String getVersion() {
        return version;
    }

    public String getArtifactRef() {
        return artifactRef;
    }

    public String getChecksum() {
        return checksum;
    }

    public Instant getCreatedAt() {
        return createdAt;
    }
}
