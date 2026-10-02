package io.appfleet.control.web;

public class InvalidHeaderException extends RuntimeException {
    private final String header;

    public InvalidHeaderException(String header) {
        super("invalid header " + header);
        this.header = header;
    }

    public String header() {
        return header;
    }
}

