package io.appfleet.security;

import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.security.converter.RsaKeyConverters;
import org.springframework.security.oauth2.core.DelegatingOAuth2TokenValidator;
import org.springframework.security.oauth2.core.OAuth2TokenValidator;
import org.springframework.security.oauth2.jose.jws.SignatureAlgorithm;
import org.springframework.security.oauth2.jwt.*;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.io.InputStream;
import java.security.interfaces.RSAPublicKey;
import java.util.List;

@AutoConfiguration
@ConditionalOnProperty("appfleet.security.jwt.public-key-location")
@EnableConfigurationProperties(JwtProperties.class)
public class JwtSecurityAutoConfiguration {

    @Bean
    JwtDecoder jwtDecoder(JwtProperties p) throws IOException {
        RSAPublicKey key;
        try (InputStream in = p.publicKeyLocation().getInputStream()) {
            key = RsaKeyConverters.x509().convert(in);
        }
        NimbusJwtDecoder decoder = NimbusJwtDecoder.withPublicKey(key)
                .signatureAlgorithm(SignatureAlgorithm.RS256)
                .build();
        OAuth2TokenValidator<Jwt> validators = new DelegatingOAuth2TokenValidator<>(
                new JwtTimestampValidator(p.clockSkew()),
                new JwtIssuerValidator(p.issuer()),
                new JwtClaimValidator<List<String>>(JwtClaimNames.AUD,
                        aud -> aud != null && aud.contains(p.audience())),
                new JwtClaimValidator<String>(JwtClaimNames.SUB, s -> s != null && !s.isBlank()));
        decoder.setJwtValidator(validators);
        return decoder;
    }

    @Bean
    @ConditionalOnMissingBean
    AppfleetJwtAuthenticationConverter appfleetJwtAuthenticationConverter() {
        return new AppfleetJwtAuthenticationConverter();
    }

    @Bean
    @ConditionalOnMissingBean
    ProblemAuthenticationEntryPoint problemAuthenticationEntryPoint(ObjectProvider<JsonMapper> mapper) {
        return new ProblemAuthenticationEntryPoint(mapper.getIfAvailable(JsonMapper::new));
    }

    @Bean
    @ConditionalOnMissingBean
    ProblemAccessDeniedHandler problemAccessDeniedHandler(ObjectProvider<JsonMapper> mapper) {
        return new ProblemAccessDeniedHandler(mapper.getIfAvailable(JsonMapper::new));
    }
}
