package io.appfleet.identity.audit;

/** What happened, for the audit. The caller only ever sees a 401, a 423 or a 200; the audit may say which of the 401s it was. */
public enum LoginOutcome {
    SUCCESS,
    BAD_CREDENTIALS,
    UNKNOWN_USER,
    DEACTIVATED,
    LOCKED,
    REUSED,
    INVALID_KEY
}
