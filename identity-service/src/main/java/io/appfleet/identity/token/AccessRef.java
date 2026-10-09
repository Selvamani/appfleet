package io.appfleet.identity.token;

import java.time.Instant;
import java.util.UUID;

/** One issued access token as the revocation needs it: its jti and when it expires. */
public record AccessRef(UUID jti, Instant expiresAt) {}