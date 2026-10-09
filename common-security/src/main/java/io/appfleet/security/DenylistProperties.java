package io.appfleet.security;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

/** Off by default: a service pays the Redis read on every request only when it asks for it. */
@ConfigurationProperties("appfleet.security.jwt.denylist")
public record DenylistProperties(
        @DefaultValue("false") boolean enabled,
        @DefaultValue("false") boolean failOpen
) {}