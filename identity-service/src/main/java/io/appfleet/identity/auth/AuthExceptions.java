package io.appfleet.identity.auth;

/** The failures of the auth endpoints; web/ApiExceptionHandler turns each into one problem body. */
public final class AuthExceptions {

    private AuthExceptions() {}

    public static class EmailAlreadyRegisteredException extends RuntimeException {
        public EmailAlreadyRegisteredException() { super("email already registered"); }
    }

    /** Unknown email, wrong password and a deactivated user all raise this one exception: one message for all three. */
    public static class InvalidCredentialsException extends RuntimeException {
        public InvalidCredentialsException() { super("invalid credentials"); }
    }

    /** Unknown, expired, revoked and already-used refresh tokens all raise this one exception: one answer for all of them. */
    public static class InvalidRefreshTokenException extends RuntimeException {
        public InvalidRefreshTokenException() { super("invalid refresh token"); }
    }

    /** Too many failed sign-ins for this email: the answer is 423 with Retry-After, whether or not the email has an account. */
    public static class AccountLockedException extends RuntimeException {
        private final java.time.Duration retryAfter;

        public AccountLockedException(java.time.Duration retryAfter) {
            super("too many failed sign-in attempts");
            this.retryAfter = retryAfter;
        }

        public java.time.Duration retryAfter() { return retryAfter; }
    }

    /** BCrypt reads only the first 72 bytes, so a longer password is refused instead of silently truncated. */
    public static class PasswordTooLongException extends RuntimeException {
        private final String field;

        public PasswordTooLongException() { this("password"); }

        public PasswordTooLongException(String field) {
            super("password must be at most 72 bytes in UTF-8");
            this.field = field;
        }

        public String field() { return field; }
    }

    /** The current password given to a password change is wrong. It counts as a failed sign-in (same lockout counter). */
    public static class WrongCurrentPasswordException extends RuntimeException {
        public WrongCurrentPasswordException() { super("current password is not correct"); }
    }

    /** A password the policy refuses (common, or built from the email, or unchanged). The message names the rule, never the password. */
    public static class WeakPasswordException extends RuntimeException {
        private final String field;

        public WeakPasswordException(String field, String message) {
            super(message);
            this.field = field;
        }

        public String field() { return field; }
    }
}