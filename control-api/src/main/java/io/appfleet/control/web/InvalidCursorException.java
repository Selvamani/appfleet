package io.appfleet.control.web;

public class InvalidCursorException extends RuntimeException {
    public InvalidCursorException() {
        super("invalid cursor");
    }
}