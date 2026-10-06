package io.appfleet.control.application;

import org.springframework.data.domain.Limit;
import org.springframework.data.jpa.repository.JpaRepository;

import java.util.Collection;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface ApplicationRepository extends JpaRepository<Application, UUID> {
    Optional<Application> findByName(String name);
    List<Application> findAllByOrderByIdAsc(Limit limit);
    List<Application> findByIdGreaterThanOrderByIdAsc(UUID after, Limit limit);
    List<Application> findByOwnerTeamIdInOrderByIdAsc(Collection<UUID> ownerTeamIds, Limit limit);
    List<Application> findByOwnerTeamIdInAndIdGreaterThanOrderByIdAsc(Collection<UUID> ownerTeamIds, UUID after, Limit limit);
}