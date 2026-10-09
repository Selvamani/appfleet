package io.appfleet.security;

import org.springframework.boot.autoconfigure.condition.AnyNestedCondition;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.context.annotation.ConfigurationCondition;

/** The JWT beans switch on when either source of the public key is named. */
class JwtConfiguredCondition extends AnyNestedCondition {

    JwtConfiguredCondition() {
        super(ConfigurationCondition.ConfigurationPhase.PARSE_CONFIGURATION);
    }

    @ConditionalOnProperty("appfleet.security.jwt.public-key-location")
    static class StaticKey {}

    @ConditionalOnProperty("appfleet.security.jwt.jwks-uri")
    static class Jwks {}
}