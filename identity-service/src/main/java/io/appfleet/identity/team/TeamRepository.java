package io.appfleet.identity.team;

import org.springframework.data.repository.Repository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface TeamRepository extends Repository<Team, UUID> {
    Team save(Team team);
    Optional<Team> findById(UUID id);
    boolean existsByName(String name);
    List<Team> findAllByOrderByNameAsc();
}
