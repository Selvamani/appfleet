package io.appfleet.identity.team;

import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.Repository;
import org.springframework.data.repository.query.Param;

import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface TeamMembershipRepository extends Repository<TeamMembership, UUID> {

    TeamMembership save(TeamMembership membership);

    /** Removing a grant is allowed (it is not a user); the unique key (user, team) keeps it at one role per team. */
    void delete(TeamMembership membership);

    /** All grants of one user in ONE select (membership joined to role); the team id is the foreign key, no team join. */
    @Query("select new io.appfleet.identity.team.TeamRole(m.team.id, m.role.name) "
        + "from TeamMembership m where m.user.id = :userId order by m.team.id")
    List<TeamRole> findGrantsByUserId(@Param("userId") UUID userId);

    Optional<TeamMembership> findByTeam_IdAndUser_Id(UUID teamId, UUID userId);

    long countByUser_Id(UUID userId);

    long countByTeam_IdAndRole_Name(UUID teamId, String roleName);

    /** The members of a team with their user and role in one select. */
    @Query("select m from TeamMembership m join fetch m.user join fetch m.role where m.team.id = :teamId order by m.user.email")
    List<TeamMembership> findMembers(@Param("teamId") UUID teamId);
}
