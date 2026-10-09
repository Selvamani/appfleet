package io.appfleet.identity.serviceaccount;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

import java.time.Duration;

/**
 * tokenTtl: how long the token a key is exchanged for lives. Short on purpose (a service asks again, it costs one request),
 * and never above the 15 minutes of every access token.
 * maxActiveKeys: 2, so a key can be rotated without downtime (add the new one, deploy it, revoke the old one).
 */
@ConfigurationProperties("appfleet.identity.service-accounts")
public record ServiceAccountProperties(
        @DefaultValue("5m") Duration tokenTtl,
        @DefaultValue("2") int maxActiveKeys
) {
    public ServiceAccountProperties {
        if (tokenTtl == null || tokenTtl.isZero() || tokenTtl.isNegative() || tokenTtl.compareTo(Duration.ofMinutes(15)) > 0)
            throw new IllegalArgumentException("appfleet.identity.service-accounts.token-ttl must be above 0 and at most 15 minutes, was " + tokenTtl);
        if (maxActiveKeys < 1)
            throw new IllegalArgumentException("appfleet.identity.service-accounts.max-active-keys must be at least 1, was " + maxActiveKeys);
    }
}