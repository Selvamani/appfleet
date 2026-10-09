package io.appfleet.security;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.security.oauth2.core.OAuth2Error;
import org.springframework.security.oauth2.core.OAuth2TokenValidator;
import org.springframework.security.oauth2.core.OAuth2TokenValidatorResult;
import org.springframework.security.oauth2.jwt.Jwt;

/**
 * Refuses a token whose jti is on the denylist. A token with no jti cannot be checked, so it is refused too: with the
 * denylist switched on, every accepted token must be revocable.
 *
 * When the denylist cannot be read the choice is explicit: failOpen false (the default) refuses the token, because
 * accepting a token that may be revoked is the failure the denylist exists to prevent; true accepts it and logs.
 */
public class JwtDenylistValidator implements OAuth2TokenValidator<Jwt> {

    private static final Logger log = LoggerFactory.getLogger(JwtDenylistValidator.class);

    private final JwtDenylist denylist;
    private final boolean failOpen;

    public JwtDenylistValidator(JwtDenylist denylist, boolean failOpen) {
        this.denylist = denylist;
        this.failOpen = failOpen;
    }

    @Override
    public OAuth2TokenValidatorResult validate(Jwt jwt) {
        String jti = jwt.getId();
        if (jti == null || jti.isBlank())
            return OAuth2TokenValidatorResult.failure(new OAuth2Error("invalid_token", "The token has no jti", null));
        try {
            return denylist.isRevoked(jti)
                    ? OAuth2TokenValidatorResult.failure(new OAuth2Error("invalid_token", "The token has been revoked", null))
                    : OAuth2TokenValidatorResult.success();
        } catch (RuntimeException e) {
            if (failOpen) {
                log.warn("denylist unavailable, token accepted (fail-open): {}", e.toString());
                return OAuth2TokenValidatorResult.success();
            }
            log.warn("denylist unavailable, token refused (fail-closed): {}", e.toString());
            return OAuth2TokenValidatorResult.failure(new OAuth2Error("invalid_token", "The denylist could not be read", null));
        }
    }
}