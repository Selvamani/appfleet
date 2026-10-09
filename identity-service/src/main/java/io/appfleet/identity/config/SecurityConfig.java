package io.appfleet.identity.config;

import io.appfleet.security.AppfleetJwtAuthenticationConverter;
import io.appfleet.security.ProblemAccessDeniedHandler;
import io.appfleet.security.ProblemAuthenticationEntryPoint;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;

@Configuration
@EnableWebSecurity
@EnableMethodSecurity
public class SecurityConfig {

    /**
     * identity-service is now its own resource server: it validates the tokens it issued with the same decoder, converter
     * and 401/403 writers as control-api (all from common-security). The auth endpoints stay open; everything else under
     * /api must carry a valid token; anything not named is refused.
     */
    @Bean
    SecurityFilterChain chain(HttpSecurity http, AppfleetJwtAuthenticationConverter converter,
                              ProblemAuthenticationEntryPoint entryPoint, ProblemAccessDeniedHandler denied) throws Exception {
        http.authorizeHttpRequests(a -> a
                .requestMatchers("/actuator/health", "/actuator/info").permitAll()
                .requestMatchers(HttpMethod.GET, "/.well-known/jwks.json").permitAll()
                .requestMatchers(HttpMethod.POST, "/api/v1/auth/register", "/api/v1/auth/login", "/api/v1/auth/refresh", "/api/v1/auth/logout", "/api/v1/auth/service-token").permitAll()
                .requestMatchers("/api/v1/auth/**").denyAll()      // any other method on an auth path: refused, never a 405 or a 500
                .requestMatchers("/api/**").authenticated()
                .anyRequest().denyAll())
                .oauth2ResourceServer(o -> o
                        .jwt(j -> j.jwtAuthenticationConverter(converter))
                        .authenticationEntryPoint(entryPoint)
                        .accessDeniedHandler(denied)
                )
                .exceptionHandling(e -> e.authenticationEntryPoint(entryPoint).accessDeniedHandler(denied))
                .csrf(c -> c.disable())
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS));
        return http.build();
    }
}