package io.appfleet.identity.config;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;
import org.springframework.core.io.Resource;

import java.time.Duration;
import java.time.Instant;
import java.util.List;

/**
 * Key rotation, as configuration. The key that signs is appfleet.identity.jwt.private-key-location. To rotate: put the NEW
 * private key there, and list the OLD key's public half here with the moment it was retired. The old key stays in the JWKS for
 * retireGrace after that (so the tokens it signed can still be verified until they expire), and then it is gone.
 *
 * retireGrace must cover the longest token (15 minutes) plus the verifiers' clock skew (1 minute): shorter, and a valid token
 * could be refused; the default is 20 minutes. cacheMaxAge is what verifiers may cache the JWKS for.
 */
@ConfigurationProperties("appfleet.identity.jwks")
public record JwksProperties(
        @DefaultValue List<RetiredKey> retiredKeys,
        @DefaultValue("20m") Duration retireGrace,
        @DefaultValue("5m") Duration cacheMaxAge
) {
    /** The shortest grace that cannot refuse a valid token: the longest access token plus the validators' clock skew. */
    public static final Duration MIN_GRACE = Duration.ofMinutes(16);

    public record RetiredKey(Resource publicKeyLocation, Instant retiredAt) {
        public RetiredKey {
            if (publicKeyLocation == null || retiredAt == null)
                throw new IllegalArgumentException("a retired key needs both public-key-location and retired-at");
        }
    }

    public JwksProperties {
        if (retireGrace == null || retireGrace.compareTo(MIN_GRACE) < 0)
            throw new IllegalArgumentException("appfleet.identity.jwks.retire-grace must be at least 16 minutes (a 15 minute token plus 1 minute of clock skew), was " + retireGrace);
        if (cacheMaxAge == null || cacheMaxAge.isNegative())
            throw new IllegalArgumentException("appfleet.identity.jwks.cache-max-age must not be negative, was " + cacheMaxAge);
    }
}