package io.appfleet.identity.team;

import java.util.UUID;

/** The team whose administrators administer the platform. Seeded by V6; the id is the same everywhere, so a token can be checked against it. */
public final class PlatformTeam {

    public static final UUID ID = UUID.fromString("00000000-0000-7000-8000-000000000001");
    public static final String NAME = "platform";

    private PlatformTeam() {}
}