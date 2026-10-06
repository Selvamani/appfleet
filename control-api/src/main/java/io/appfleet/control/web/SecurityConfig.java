package io.appfleet.control.web;

import io.appfleet.security.AppfleetJwtAuthenticationConverter;
import io.appfleet.security.ProblemAccessDeniedHandler;
import io.appfleet.security.ProblemAuthenticationEntryPoint;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.method.configuration.EnableMethodSecurity;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;

@Configuration
@EnableWebSecurity
@EnableMethodSecurity
public class SecurityConfig {

    @Bean
    SecurityFilterChain apiChain(HttpSecurity http, AppfleetJwtAuthenticationConverter converter,
                                 ProblemAuthenticationEntryPoint entryPoint,
                                 ProblemAccessDeniedHandler denied,
                                 @Value("${appfleet.docs.public:true}") boolean docsPublic) throws Exception {
        http.authorizeHttpRequests(a -> {
                    a.requestMatchers("/actuator/health", "/actuator/info").permitAll();
                    var docs = a.requestMatchers("/v3/api-docs/**", "/swagger-ui/**", "/swagger-ui.html");
                    if (docsPublic) docs.permitAll(); else docs.authenticated();
                    a.requestMatchers("/api/**").authenticated()
                            .anyRequest().denyAll();
                })
                .oauth2ResourceServer(o -> o
                        .jwt(j -> j.jwtAuthenticationConverter(converter))
                        .authenticationEntryPoint(entryPoint)
                        .accessDeniedHandler(denied))
                .exceptionHandling(e -> e.authenticationEntryPoint(entryPoint).accessDeniedHandler(denied))
                .csrf(c -> c.disable())
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS));
        return http.build();
    }
}
