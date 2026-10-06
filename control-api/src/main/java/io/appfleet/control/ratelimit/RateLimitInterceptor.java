package io.appfleet.control.ratelimit;

import io.appfleet.control.config.AppfleetProperties;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.security.core.Authentication;
import org.springframework.security.core.context.SecurityContextHolder;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;

@Component
public class RateLimitInterceptor implements HandlerInterceptor {

    private static final Logger log = LoggerFactory.getLogger(RateLimitInterceptor.class);
    private static final String ANONYMOUS = "anonymous";

    private final AppfleetProperties properties;
    private final RateLimiter rateLimiter;

    public RateLimitInterceptor(AppfleetProperties properties, RateLimiter rateLimiter) {
        this.properties = properties;
        this.rateLimiter = rateLimiter;
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
        if (!properties.rateLimit().enabled()) {
            return true;
        }
        RateLimitDecision decision = rateLimiter.tryConsume(callerKey());
        if (!decision.allowed()) {
            throw new RateLimitedException(decision.retryAfter());
        }
        return true;
    }

    private String callerKey() {
        Authentication authentication = SecurityContextHolder.getContext().getAuthentication();
        if (authentication == null || !authentication.isAuthenticated()) {
            log.warn("Rate limit: no authenticated principal, using shared '{}' bucket", ANONYMOUS);
            return ANONYMOUS;
        }
        return authentication.getName();
    }
}
