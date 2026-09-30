package io.appfleet.control.application.web;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Pattern;
import jakarta.validation.constraints.Size;

public record CreateReleaseRequest(
        @NotBlank @Size(max = 64) @Pattern(regexp = "[A-Za-z0-9][A-Za-z0-9._+-]*")String version,
        @NotBlank @Size(max = 512) String artifactRef,
        @NotBlank @Pattern(regexp = "sha256:[0-9a-f]{64}") String checksum) {}
