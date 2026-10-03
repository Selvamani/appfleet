package io.appfleet.security;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.context.annotation.Bean;
import org.springframework.core.convert.converter.Converter;
import org.springframework.security.authentication.AbstractAuthenticationToken;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import tools.jackson.databind.json.JsonMapper;

import java.util.Collection;
import java.util.LinkedHashSet;
import java.util.Map;
import java.util.Set;

public class AppfleetJwtAuthenticationConverter implements Converter<Jwt, AbstractAuthenticationToken> {

    private static final Logger log = LoggerFactory.getLogger(AppfleetJwtAuthenticationConverter.class);

    @Override
    public AbstractAuthenticationToken convert(Jwt jwt) {
        Set<GrantedAuthority> authorities = new LinkedHashSet<>();
        addAll(authorities, jwt.getClaim("perms"), "perms");
        Object teams = jwt.getClaim("teams");
        if (teams instanceof Map<?, ?> map) {
            map.values().forEach(v -> addAll(authorities, v, "teams"));
        } else if (teams != null) {
            log.warn("claim 'teams' has type {}, ignored", teams.getClass().getSimpleName());
        }
        return new JwtAuthenticationToken(jwt, authorities, jwt.getSubject());
    }

    private void addAll(Set<GrantedAuthority> out, Object claim, String name) {
        if(claim == null) return;
        if(!(claim instanceof Collection<?> c)) {
            log.warn("claim '{}' not a list, ignored", name);
            return;
        }
        for (Object o : c) {
            if(o instanceof String s && !s.isBlank()) {
                out.add(new SimpleGrantedAuthority(s));
            }
        }
    }
}