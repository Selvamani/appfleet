package io.appfleet.security;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.web.access.AccessDeniedHandler;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.Map;

public class ProblemAccessDeniedHandler implements AccessDeniedHandler {

    public static final String TYPE = "urn:appfleet:problem:forbidden";
    static final String CORRELATION_ID_KEY = "correlationId";
    private static final Logger log = LoggerFactory.getLogger(ProblemAccessDeniedHandler.class);

    private final JsonMapper mapper;

    public ProblemAccessDeniedHandler(JsonMapper mapper) {
        this.mapper = mapper;
    }

    @Override
    public void handle(HttpServletRequest req, HttpServletResponse res, AccessDeniedException ex)
            throws IOException {
        String cid = MDC.get(CORRELATION_ID_KEY);
        log.warn("403 {} {} cid={}", req.getMethod(), req.getRequestURI(), cid);

        res.setStatus(HttpStatus.FORBIDDEN.value());
        res.setContentType(MediaType.APPLICATION_PROBLEM_JSON_VALUE);

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("type", TYPE);
        body.put("title", "Forbidden");
        body.put("status", 403);
        body.put("detail", "You do not have permission to perform this action");
        body.put("instance", req.getRequestURI());
        body.put("correlationId", cid);
        mapper.writeValue(res.getOutputStream(), body);
    }
}

