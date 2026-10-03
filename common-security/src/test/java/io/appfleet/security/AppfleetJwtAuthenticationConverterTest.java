package io.appfleet.security;


import org.junit.jupiter.api.Test;
import org.springframework.security.authentication.AbstractAuthenticationToken;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;

import java.util.List;
import java.util.Map;
import java.util.Set;

import static java.util.stream.Collectors.toSet;

import static org.assertj.core.api.Assertions.assertThat;

class AppfleetJwtAuthenticationConverterTest {

    private final AppfleetJwtAuthenticationConverter converter = new AppfleetJwtAuthenticationConverter();

    private static Jwt jwt(Map<String, Object> claims) {
        return Jwt.withTokenValue("t").header("alg", "RS256").subject("u1")
                .claims(c -> c.putAll(claims)).build();
    }

    private static Set<String> names(AbstractAuthenticationToken t) {
        return t.getAuthorities().stream().map(GrantedAuthority::getAuthority).collect(toSet());
    }

    @Test
    void flattensPermsAndTeams_withoutPrefix() {
        var t = converter.convert(jwt(Map.of(
                "perms", List.of("app:read"),
                "teams", Map.of("t1", List.of("deployment:create"), "t2", List.of("deployment:rollback")))));
        assertThat(names(t)).containsExactlyInAnyOrder("app:read", "deployment:create", "deployment:rollback");
    }

    @Test
    void missingClaims_giveNoAuthorities() {
        assertThat(converter.convert(jwt(Map.of("x", "y"))).getAuthorities()).isEmpty();
    }

    @Test
    void wrongTypeClaims_giveNoAuthorities_andDoNotThrow() {
        var t = converter.convert(jwt(Map.of("perms", "not-a-list", "teams", "nope")));
        assertThat(t.getAuthorities()).isEmpty();
    }

    @Test
    void duplicatesCollapse() {
        var t = converter.convert(jwt(Map.of(
                "perms", List.of("deployment:create"),
                "teams", Map.of("t1", List.of("deployment:create"), "t2", List.of("deployment:create")))));
        assertThat(t.getAuthorities()).hasSize(1);
    }

    @Test
    void nameIsSub_andPrincipalIsTheJwt() {
        var t = converter.convert(jwt(Map.of()));
        assertThat(t.getName()).isEqualTo("u1");
        assertThat(((JwtAuthenticationToken) t).getToken().getSubject()).isEqualTo("u1");
    }
}
