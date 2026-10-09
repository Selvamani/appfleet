package io.appfleet.identity.config;

import io.appfleet.identity.team.PlatformTeam;
import org.springframework.security.core.Authentication;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import org.springframework.stereotype.Component;

import java.util.Collection;
import java.util.Map;
import java.util.UUID;

/**
 * The scoped questions behind @PreAuthorize. The token carries permissions PER TEAM (the "teams" claim), and the converter
 * flattens them into one authority list, so "hasAuthority('user:manage')" would mean "administrator of any team". These two
 * methods ask the question with the team in it. They are a separate bean on purpose: a @PreAuthorize that calls a method of
 * its own class would be skipped (the proxy trap of I6a).
 */
@Component("guard")
public class AccessGuard {

    static final String MANAGE = "user:manage";

    /** Administrator of the platform team: may list and deactivate users, create teams and roles, read the login audit. */
    public boolean platformAdmin(Authentication authentication) {
        return holds(authentication, PlatformTeam.ID);
    }

    /** Administrator of this team, or of the platform: may manage the members of the team. */
    public boolean teamAdmin(Authentication authentication, UUID teamId) {
        return platformAdmin(authentication) || holds(authentication, teamId);
    }

    private static boolean holds(Authentication authentication, UUID teamId) {
        if (!(authentication instanceof JwtAuthenticationToken token) || teamId == null) return false;
        Object teams = token.getToken().getClaim("teams");
        if (!(teams instanceof Map<?, ?> map)) return false;
        Object permissions = map.get(teamId.toString());
        return permissions instanceof Collection<?> c && c.contains(MANAGE);
    }
}