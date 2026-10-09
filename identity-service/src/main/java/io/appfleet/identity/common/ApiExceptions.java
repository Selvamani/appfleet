package io.appfleet.identity.common;

/** The failures of the admin endpoints; web/ApiExceptionHandler turns each into one problem body. */
public final class ApiExceptions {

    private ApiExceptions() {}

    /** The thing named in the path does not exist (or the caller may not know it does). 404. */
    public static class NotFoundException extends RuntimeException {
        public NotFoundException(String what) { super(what + " not found"); }
    }

    /** The request is fine but the state refuses it (duplicate, last administrator, deactivated user). 409. */
    public static class ConflictException extends RuntimeException {
        public ConflictException(String message) { super(message); }
    }

    /** A rule of the model refuses it (teams per token). 422, with its own problem slug. */
    public static class UnprocessableException extends RuntimeException {
        private final String slug;

        public UnprocessableException(String slug, String message) {
            super(message);
            this.slug = slug;
        }

        public String slug() { return slug; }
    }

    /** One field of the body names something that does not exist or is not allowed. 400 validation-failed on that field. */
    public static class InvalidFieldException extends RuntimeException {
        private final String field;

        public InvalidFieldException(String field, String message) {
            super(message);
            this.field = field;
        }

        public String field() { return field; }
    }
}