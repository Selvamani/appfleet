package io.appfleet.identity.serviceaccount;

import org.springframework.data.repository.Repository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

/** No delete method: a service account is disabled, never deleted (its keys and its audit rows keep pointing at it). */
public interface ServiceAccountRepository extends Repository<ServiceAccount, UUID> {

    ServiceAccount save(ServiceAccount account);

    /** The id AND the team in one query: an account of another team is simply not found (the object-level check). */
    Optional<ServiceAccount> findByIdAndTeam_Id(UUID id, UUID teamId);

    List<ServiceAccount> findByTeam_IdOrderByNameAsc(UUID teamId);

    boolean existsByTeam_IdAndName(UUID teamId, String name);
}