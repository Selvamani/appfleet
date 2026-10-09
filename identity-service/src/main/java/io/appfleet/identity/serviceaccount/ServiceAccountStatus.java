package io.appfleet.identity.serviceaccount;

/** A disabled service account can never get a token again. There is no way back and no delete (same rule as users). */
public enum ServiceAccountStatus {
    ACTIVE,
    DISABLED
}