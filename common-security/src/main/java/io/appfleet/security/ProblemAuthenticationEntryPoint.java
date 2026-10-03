package io.appfleet.security;

import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.slf4j.MDC;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.security.core.AuthenticationException;
import org.springframework.security.oauth2.core.OAuth2AuthenticationException;
import org.springframework.security.web.AuthenticationEntryPoint;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.util.LinkedHashMap;
import java.util.Map;

public class ProblemAuthenticationEntryPoint implements AuthenticationEntryPoint {

    public static final String TYPE = "urn:appfleet:problem:unauthorized";
    static final String CORRELATION_ID_KEY = "correlationId";
    private static final Logger log = LoggerFactory.getLogger(ProblemAuthenticationEntryPoint.class);

    private final JsonMapper mapper;

    public ProblemAuthenticationEntryPoint(JsonMapper mapper) {
        this.mapper = mapper;
    }

    @Override
    public void commence(HttpServletRequest req, HttpServletResponse res, AuthenticationException ex)
            throws IOException {
        String cid = MDC.get(CORRELATION_ID_KEY);
        log.warn("401 {} {} cid={} reason={}", req.getMethod(), req.getRequestURI(), cid, ex.getMessage());

        res.setStatus(HttpStatus.UNAUTHORIZED.value());
        res.setHeader(HttpHeaders.WWW_AUTHENTICATE, challenge(ex));
        res.setContentType(MediaType.APPLICATION_PROBLEM_JSON_VALUE);

        Map<String, Object> body = new LinkedHashMap<>();
        body.put("type", TYPE);
        body.put("title", "Unauthorized");
        body.put("status", 401);
        body.put("detail", "Authentication required");
        body.put("instance", req.getRequestURI());
        body.put(CORRELATION_ID_KEY, cid);
        mapper.writeValue(res.getOutputStream(), body);
    }

    /** RFC 6750: a missing token gets a bare challenge; a rejected token gets the error code, never the reason. */
    private static String challenge(AuthenticationException ex) {
        if (ex instanceof OAuth2AuthenticationException oauth) {
            return "Bearer error=\"" + oauth.getError().getErrorCode() + "\"";
        }
        return "Bearer";
    }
}

