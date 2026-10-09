package io.appfleet.identity.team;

import java.util.UUID;

/** One scoped grant as the token issuer needs it: a team id and a role name, nothing else. */
public record TeamRole(UUID teamId, String roleName) {}
