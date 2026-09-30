package io.appfleet.control.deployment;

public class IllegalTransitionException extends IllegalStateException {
    public IllegalTransitionException(String message) {
        super(message);
    }
}
