package io.appfleet.control.deployment.web;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Size;

import java.util.UUID;

public record CreateDeploymentRequest(@NotNull UUID applicationId,
                                      @NotNull UUID releaseId,
                                      @NotBlank @Size(max = 63) String environment) {
}
