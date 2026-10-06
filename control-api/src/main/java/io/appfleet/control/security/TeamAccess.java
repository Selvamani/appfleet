package io.appfleet.control.security;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.stereotype.Component;

import java.util.Collection;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.function.Supplier;

/**
 * The object-level rule of S4.4: a permission counts only if the token grants it for the object's own team,
 * or globally in {@code perms}.
 */
@Component
public class TeamAccess {

    private static final Logger log = LoggerFactory.getLogger(TeamAccess.class);

    public boolean allows(String permission, UUID ownerTeamId) {
        if (ownerTeamId == null) {
            return false;
        }
        return scopeFor(permission).contains(ownerTeamId);
    }

    /** The teams for which the caller holds {@code permission}; every team for a global grant; none without a JWT. */
    public TeamScope scopeFor(String permission) {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (!(authentication instanceof JwtAuthenticationToken jwtAuthentication) || !authentication.isAuthenticated()) {
            return TeamScope.of(Set.of());
        }
        Jwt jwt = jwtAuthentication.getToken();
        if (strings(jwt.getClaim("perms")).contains(permission)) {
            return TeamScope.everyTeam();
        }
        Set<UUID> teams = new HashSet<>();
        Object claim = jwt.getClaim("teams");
        if (claim instanceof Map<?, ?> map) {
            for (Map.Entry<?, ?> entry : map.entrySet()) {
                UUID teamId = parse(entry.getKey());
                if (teamId != null && strings(entry.getValue()).contains(permission)) {
                    teams.add(teamId);
                }
            }
        }
        return TeamScope.of(teams);
    }

    /** Does nothing when allowed; throws the supplied exception when denied, and logs the denial (never the response). */
    public void require(String permission, UUID ownerTeamId, Supplier<? extends RuntimeException> onDenied) {
        if (!allows(permission, ownerTeamId)) {
            Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
            log.info("Team access denied: sub={} permission={} ownerTeam={}",
                    authentication == null ? null : authentication.getName(), permission, ownerTeamId);
            throw onDenied.get();
        }
    }

    private static List<String> strings(Object claim) {
        if (!(claim instanceof Collection<?> values)) {
            return List.of();
        }
        return values.stream().filter(String.class::isInstance).map(String.class::cast).toList();
    }

    private static UUID parse(Object key) {
        if (key == null) {
            return null;
        }
        try {
            UUID parsed = UUID.fromString(key.toString());
            return parsed.toString().equalsIgnoreCase(key.toString()) ? parsed : null;   // reject lenient forms like 1-1-1-1-1
        } catch (IllegalArgumentException e) {
            return null;
        }
    }
}
