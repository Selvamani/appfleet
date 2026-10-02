package io.appfleet.control.common;

public class NotFoundException extends RuntimeException {
    public NotFoundException(String resource, Object id) {
        super(resource + " " + id + " not found");
    }
}

