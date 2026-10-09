package io.appfleet.identity.token;

/** ACTIVE can be used once; USED has been rotated into its child; REVOKED was cut off when its family was revoked. */
public enum RefreshStatus {
    ACTIVE,
    USED,
    REVOKED
}
