package io.appfleet.control.security;

import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.security.authentication.AnonymousAuthenticationToken;
import org.springframework.security.authentication.TestingAuthenticationToken;
import org.springframework.security.core.authority.AuthorityUtils;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;

import java.time.Instant;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class TeamAccessTest {

    private static final UUID A = UUID.fromString("00000000-0000-0000-0000-00000000a0a0");
    private static final UUID B = UUID.fromString("00000000-0000-0000-0000-00000000b0b0");
    private static final String CREATE = "deployment:create";
    private static final String READ = "deployment:read";

    private final TeamAccess access = new TeamAccess();

    @AfterEach
    void clear() {
        SecurityContextHolder.clearContext();
    }

    /** Puts a validated-looking JWT with exactly these extra claims into the security context. */
    private void token(Map<String, Object> claims) {
        Map<String, Object> all = new HashMap<>(claims);
        all.put("sub", "caller");
        Jwt jwt = Jwt.withTokenValue("t").header("alg", "RS256")
                .claims(c -> c.putAll(all))
                .issuedAt(Instant.now()).expiresAt(Instant.now().plusSeconds(60))
                .build();
        SecurityContextHolder.getContext().setAuthentication(new JwtAuthenticationToken(jwt, List.of()));
    }

    private static Map<String, Object> teams(Object... pairs) {
        Map<String, Object> teams = new HashMap<>();
        for (int i = 0; i < pairs.length; i += 2) {
            teams.put(pairs[i].toString(), pairs[i + 1]);
        }
        return Map.of("teams", teams);
    }

    @Test
    void permissionHeldForTheObjectsTeam_isAllowed() {
        token(teams(A, List.of(CREATE)));
        assertThat(access.allows(CREATE, A)).isTrue();
    }

    @Test
    void permissionHeldOnlyForAnotherTeam_isDenied() {
        token(teams(A, List.of(CREATE)));
        assertThat(access.allows(CREATE, B)).isFalse();
    }

    @Test
    void aDifferentPermissionForTheObjectsTeam_isDenied() {
        token(teams(A, List.of(READ), B, List.of(CREATE)));
        assertThat(access.allows(CREATE, A)).isFalse();      // create is B's, read is A's
        assertThat(access.allows(READ, A)).isTrue();
    }

    @Test
    void globalPerm_appliesToEveryTeam() {
        token(Map.of("perms", List.of(CREATE)));
        assertThat(access.allows(CREATE, A)).isTrue();
        assertThat(access.allows(CREATE, B)).isTrue();
    }

    @Test
    void aGlobalPermIsNotAnyOtherPermission() {
        token(Map.of("perms", List.of(READ)));
        assertThat(access.allows(CREATE, A)).isFalse();
    }

    @Test
    void missingEmptyOrMalformedClaims_areDenied_withoutAnException() {
        token(Map.of());
        assertThat(access.allows(CREATE, A)).isFalse();

        token(Map.of("teams", Map.of()));
        assertThat(access.allows(CREATE, A)).isFalse();

        token(Map.of("teams", "not-a-map"));
        assertThat(access.allows(CREATE, A)).isFalse();

        token(teams(A, "not-a-list"));
        assertThat(access.allows(CREATE, A)).isFalse();

        token(teams(A, List.of(42, CREATE)));                     // a non-string entry is ignored, the string still counts
        assertThat(access.allows(CREATE, A)).isTrue();

        token(Map.of("perms", "not-a-list"));
        assertThat(access.allows(CREATE, A)).isFalse();
    }

    @Test
    void noOwner_isDenied() {
        token(Map.of("perms", List.of(CREATE)));
        assertThat(access.allows(CREATE, null)).isFalse();
    }

    @Test
    void noAuthentication_orANonJwtOne_isDenied() {
        assertThat(access.allows(CREATE, A)).isFalse();           // empty context

        SecurityContextHolder.getContext().setAuthentication(
                new TestingAuthenticationToken("caller", "n/a", CREATE));          // authorities say yes, it is not a JWT
        assertThat(access.allows(CREATE, A)).isFalse();

        SecurityContextHolder.getContext().setAuthentication(
                new AnonymousAuthenticationToken("k", "anon", AuthorityUtils.createAuthorityList("ROLE_ANONYMOUS")));
        assertThat(access.allows(CREATE, A)).isFalse();
    }

    @Test
    void scopeFor_listsTheTeamsThatGrantThePermission() {
        token(teams(A, List.of(READ), B, List.of(CREATE)));
        TeamScope scope = access.scopeFor(READ);
        assertThat(scope.all()).isFalse();
        assertThat(scope.teams()).containsExactly(A);
        assertThat(scope.contains(A)).isTrue();
        assertThat(scope.contains(B)).isFalse();
    }

    @Test
    void scopeFor_aGlobalGrantIsEveryTeam() {
        token(Map.of("perms", List.of(READ)));
        TeamScope scope = access.scopeFor(READ);
        assertThat(scope.all()).isTrue();
        assertThat(scope.contains(UUID.randomUUID())).isTrue();
    }

    @Test
    void scopeFor_noGrant_isEmpty() {
        token(teams(A, List.of(CREATE)));
        TeamScope scope = access.scopeFor(READ);
        assertThat(scope.all()).isFalse();
        assertThat(scope.teams()).isEmpty();

        SecurityContextHolder.clearContext();
        assertThat(access.scopeFor(READ).teams()).isEmpty();
        assertThat(access.scopeFor(READ).all()).isFalse();
    }

    @Test
    void teamKeysThatAreNotUuids_areIgnored() {
        token(teams("not-a-uuid", List.of(READ), A, List.of(READ)));
        assertThat(access.scopeFor(READ).teams()).isEqualTo(Set.of(A));
    }

    @Test
    void require_throwsTheSuppliedException_whenDenied_andDoesNothingWhenAllowed() {
        token(teams(A, List.of(CREATE)));
        access.require(CREATE, A, () -> new IllegalStateException("must not be thrown"));

        assertThatThrownBy(() -> access.require(CREATE, B, () -> new IllegalArgumentException("denied")))
                .isInstanceOf(IllegalArgumentException.class)
                .hasMessage("denied");
    }
}
