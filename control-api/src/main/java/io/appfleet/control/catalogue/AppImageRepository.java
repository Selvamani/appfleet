package io.appfleet.control.catalogue;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.UUID;

public interface AppImageRepository extends JpaRepository<AppImage, UUID> {
    List<AppImage> findByBaseImage(BaseImage baseImage);
}
