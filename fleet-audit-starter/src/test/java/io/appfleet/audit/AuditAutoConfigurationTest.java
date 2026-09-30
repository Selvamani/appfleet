package io.appfleet.audit;

import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;

import static org.assertj.core.api.Assertions.assertThat;

public class AuditAutoConfigurationTest {

    private final ApplicationContextRunner contextRunner = new ApplicationContextRunner().
            withConfiguration(AutoConfigurations.of(AuditAutoConfiguration.class));

    @Test
    void enabledWithNodeUserBean_wiresDefaultLogger() {
        contextRunner
                .withPropertyValues("appfleet.audit.enabled=true")
                .run(context -> {
                   assertThat(context).hasSingleBean(AuditLogger.class);
                   assertThat(context.getBean(AuditLogger.class)).isInstanceOf(Slf4jAuditLogger.class);
                });
    }

    @Test
    void disabled_noAuditLoggerBean() {
        contextRunner
                .withPropertyValues("appfleet.audit.enabled=false")
                .run(context -> {
                   assertThat(context).doesNotHaveBean(AuditLogger.class);
                });
    }

    @Test
    void enabledWithUserBean_backsOff() {
        contextRunner
                .withUserConfiguration(CustomAuditLoggerConfig.class)
                .withPropertyValues("appfleet.audit.enabled=true")
                .run(context -> {
                    assertThat(context).hasSingleBean(AuditLogger.class);
                    assertThat(context.getBean(AuditLogger.class)).isNotInstanceOf(Slf4jAuditLogger.class);
                });
    }

    @Configuration
    static class CustomAuditLoggerConfig {

        @Bean
        AuditLogger customAuditLogger() {
            return event -> {};
        }
    }
}
