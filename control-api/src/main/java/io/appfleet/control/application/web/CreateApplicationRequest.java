package io.appfleet.control.application.web;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

import java.util.UUID;

public record CreateApplicationRequest(
        @NotBlank @Pattern(regexp = "[a-z0-9][a-z0-9-]{0,62}") String name,
        @Size(max = 1000) String description,
        @NotNull UUID ownerTeamId
) {}

