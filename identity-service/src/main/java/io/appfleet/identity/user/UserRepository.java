package io.appfleet.identity.user;

import org.springframework.data.domain.Pageable;
import org.springframework.data.repository.Repository;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

/**
 * Deliberately NOT a CrudRepository: it has no delete method, so a user cannot be hard-deleted through it.
 * UserRepositoryTest.userRepository_hasNoDeleteMethod pins that.
 */
public interface UserRepository extends Repository<AppUser, UUID> {
    AppUser save(AppUser user);
    Optional<AppUser> findById(UUID id);
    Optional<AppUser> findByEmail(String email);
    boolean existsByEmail(String email);
    /** Keyset pages in id order (UUIDv7: creation order). Two methods, because a null cursor parameter has no type in PostgreSQL. */
    List<AppUser> findAllByOrderByIdAsc(Pageable page);
    List<AppUser> findByIdGreaterThanOrderByIdAsc(UUID cursor, Pageable page);
}
