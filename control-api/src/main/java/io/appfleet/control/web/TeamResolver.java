package io.appfleet.control.web;

import jakarta.servlet.http.HttpServletRequest;

public interface TeamResolver {
    String resolve(HttpServletRequest request);
}

