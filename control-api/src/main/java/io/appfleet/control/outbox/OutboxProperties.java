package io.appfleet.control.outbox;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Positive;
import org.springframework.boot.context.properties.bind.DefaultValue;

import java.time.Duration;

public record OutboxProperties(@DefaultValue("true") boolean enabled,
                               @DefaultValue("task.work") @NotBlank String topic,
                               @DefaultValue("100") @Positive int batchSize,
                               @DefaultValue("1s") Duration pollInterval,
                               @DefaultValue("5s") Duration sendTimeout,
                               @DefaultValue("24h") Duration retention) {
}
