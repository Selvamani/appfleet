package io.appfleet.control.application;

import org.springframework.data.jpa.repository.JpaRepository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface ReleaseRepository extends JpaRepository<Release, UUID> {
    List<Release> findByApplication(Application application);
    Optional<Release> findByIdAndApplication_Id(UUID id, UUID applicationId);
    Optional<Release> findByApplicationAndVersion(Application application, String version);
}
