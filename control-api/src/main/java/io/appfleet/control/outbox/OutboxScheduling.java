package io.appfleet.control.outbox;


import io.appfleet.control.config.AppfleetProperties;
import org.springframework.context.annotation.Configuration;
import org.springframework.scheduling.annotation.EnableScheduling;
import org.springframework.scheduling.annotation.SchedulingConfigurer;
import org.springframework.scheduling.config.ScheduledTaskRegistrar;

import java.time.Duration;

/** Registers the poll and the purge with the configured interval; the poll is a no-op while appfleet.outbox.enabled is false. */
@Configuration
@EnableScheduling
public class OutboxScheduling implements SchedulingConfigurer {

    private final OutboxPoller poller;
    private final OutboxProperties properties;

    public OutboxScheduling(OutboxPoller poller, AppfleetProperties appfleetProperties) {
        this.poller = poller;
        this.properties = appfleetProperties.outbox();
    }

    @Override
    public void configureTasks(ScheduledTaskRegistrar registrar) {
        registrar.addFixedDelayTask(() -> {
            if(properties.enabled()) {
                poller.pollOnce();
            }
        }, properties.pollInterval());
        registrar.addFixedDelayTask(poller::purgeOldSent, Duration.ofHours(1));
    }
}
