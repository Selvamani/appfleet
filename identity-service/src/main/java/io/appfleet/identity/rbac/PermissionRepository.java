package io.appfleet.identity.rbac;

import org.springframework.data.repository.Repository;

import java.util.Collection;
import java.util.List;
import java.util.UUID;

public interface PermissionRepository extends Repository<Permission, UUID> {
    List<Permission> findAllByOrderByNameAsc();
    List<Permission> findByNameIn(Collection<String> names);
}
