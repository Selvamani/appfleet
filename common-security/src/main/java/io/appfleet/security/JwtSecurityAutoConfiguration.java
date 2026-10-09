package io.appfleet.security;

import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Conditional;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.security.converter.RsaKeyConverters;
import org.springframework.security.oauth2.core.DelegatingOAuth2TokenValidator;
import org.springframework.security.oauth2.core.OAuth2TokenValidator;
import org.springframework.security.oauth2.jose.jws.SignatureAlgorithm;
import org.springframework.security.oauth2.jwt.*;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.io.InputStream;
import java.security.interfaces.RSAPublicKey;
import java.util.ArrayList;
import java.util.List;

@AutoConfiguration
@Conditional(JwtConfiguredCondition.class)
@EnableConfigurationProperties({JwtProperties.class, DenylistProperties.class})
public class JwtSecurityAutoConfiguration {

    @Bean
    JwtDecoder jwtDecoder(JwtProperties p, ObjectProvider<JwtDenylistValidator> denylist) throws IOException {
        NimbusJwtDecoder decoder = p.jwksUri() != null ? JwksJwtDecoders.create(p) : staticKeyDecoder(p);
        List<OAuth2TokenValidator<Jwt>> validators =  new ArrayList<>(List.of(
                new JwtTimestampValidator(p.clockSkew()),
                new JwtIssuerValidator(p.issuer()),
                new JwtClaimValidator<List<String>>(JwtClaimNames.AUD,
                        aud -> aud != null && aud.contains(p.audience())),
                new JwtClaimValidator<String>(JwtClaimNames.SUB, s -> s != null && !s.isBlank())));
        denylist.ifAvailable(validators::add);   // present only when appfleet.security.jwt.denylist.enabled=true
        decoder.setJwtValidator(new DelegatingOAuth2TokenValidator<>(validators));
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

    /** The denylist: off unless asked for, and only when Redis is on the classpath. */
    @Configuration(proxyBeanMethods = false)
    @ConditionalOnClass(StringRedisTemplate.class)
    @ConditionalOnProperty(prefix = "appfleet.security.jwt.denylist", name = "enabled", havingValue = "true")
    static class DenylistConfiguration {

        @Bean
        @ConditionalOnMissingBean(JwtDenylist.class)
        RedisJwtDenylist redisJwtDenylist(StringRedisTemplate redis, JwtProperties p) {
            return new RedisJwtDenylist(redis, p.clockSkew());
        }

        @Bean
        JwtDenylistValidator jwtDenylistValidator(JwtDenylist denylist, DenylistProperties properties) {
            return new JwtDenylistValidator(denylist, properties.failOpen());
        }
    }

    /** One static RSA public key from a PEM, RS256 only. A missing or unreadable key fails startup. */
    private static NimbusJwtDecoder staticKeyDecoder(JwtProperties p) throws IOException {
        RSAPublicKey key;
        try (InputStream in = p.publicKeyLocation().getInputStream()) {
            key = RsaKeyConverters.x509().convert(in);
        }
        return NimbusJwtDecoder.withPublicKey(key)
                .signatureAlgorithm(SignatureAlgorithm.RS256)
                .build();
    }

}
