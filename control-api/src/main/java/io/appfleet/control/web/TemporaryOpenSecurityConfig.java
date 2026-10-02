package io.appfleet.control.web;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configurers.AbstractHttpConfigurer;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;

@Configuration
public class TemporaryOpenSecurityConfig {

    @Bean
    SecurityFilterChain temporaryOpenChain(HttpSecurity http) throws Exception {
        http.authorizeHttpRequests(auth -> auth
                .requestMatchers("/api/**", "/actuator/health", "/actuator/info",
                        "/v3/api-docs/**", "/swagger-ui/**", "/swagger-ui.html").permitAll()
                .anyRequest().denyAll())
            .csrf(AbstractHttpConfigurer::disable).sessionManagement(s-> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS));
        return http.build();
    }
}
