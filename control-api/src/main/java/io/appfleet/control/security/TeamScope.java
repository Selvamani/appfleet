package io.appfleet.control.security;

import java.util.Set;
import java.util.UUID;

/** The teams for which the caller holds one permission; {@code all} when it is held globally. */
public record TeamScope(boolean all, Set<UUID> teams) {

    public static TeamScope everyTeam() {
        return new TeamScope(true, Set.of());
    }

    public static TeamScope of(Set<UUID> teams) {
        return new TeamScope(false, Set.copyOf(teams));
    }

    public boolean contains(UUID teamId) {
        return all || teams.contains(teamId);
    }
}
