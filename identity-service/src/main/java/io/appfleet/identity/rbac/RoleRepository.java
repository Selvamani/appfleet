package io.appfleet.identity.rbac;

import org.springframework.data.jpa.repository.EntityGraph;
import org.springframework.data.repository.Repository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface RoleRepository extends Repository<Role, UUID> {

    Optional<Role> findByName(String name);

    boolean existsByName(String name);

    Role save(Role role);

    /** Every role with its permissions in ONE select, so the resolver never lazy-loads. */
    @EntityGraph(attributePaths = "permissions")
    List<Role> findAllBy();
}
