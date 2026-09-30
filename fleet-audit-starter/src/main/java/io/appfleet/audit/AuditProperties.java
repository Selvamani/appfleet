package io.appfleet.audit;


import org.springframework.boot.context.properties.ConfigurationProperties;

@ConfigurationProperties(prefix = "appfleet.audit")
public record AuditProperties(boolean enabled) {

}
