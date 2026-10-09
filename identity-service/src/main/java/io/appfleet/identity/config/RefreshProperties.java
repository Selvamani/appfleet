package io.appfleet.identity.config;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

import java.time.Duration;

/** One refresh token lives tokenTtl; the whole family of rotated tokens lives at most familyMaxLifetime from the login. */
@ConfigurationProperties("appfleet.identity.refresh")
public record RefreshProperties(
        @DefaultValue("7d") Duration tokenTtl,
        @DefaultValue("30d") Duration familyMaxLifetime
) {
    public RefreshProperties {
        if (tokenTtl == null || tokenTtl.isZero() || tokenTtl.isNegative())
            throw new IllegalArgumentException("appfleet.identity.refresh.token-ttl must be above 0, was " + tokenTtl);
        if (familyMaxLifetime == null || familyMaxLifetime.compareTo(tokenTtl) < 0)
            throw new IllegalArgumentException("appfleet.identity.refresh.family-max-lifetime must be at least token-ttl, was " + familyMaxLifetime);
    }
}