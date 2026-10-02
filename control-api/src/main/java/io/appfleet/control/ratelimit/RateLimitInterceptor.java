package io.appfleet.control.ratelimit;

import io.appfleet.control.config.AppfleetProperties;
import io.appfleet.control.web.TeamResolver;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.springframework.stereotype.Component;
import org.springframework.web.servlet.HandlerInterceptor;

@Component
public class RateLimitInterceptor implements HandlerInterceptor {

    private final AppfleetProperties properties;
    private final TeamResolver teamResolver;      // temporary HeaderTeamResolver until S4
    private final RateLimiter rateLimiter;

    public RateLimitInterceptor(AppfleetProperties properties, TeamResolver teamResolver, RateLimiter rateLimiter) {
        this.properties = properties;
        this.teamResolver = teamResolver;
        this.rateLimiter = rateLimiter;
    }

    @Override
    public boolean preHandle(HttpServletRequest request, HttpServletResponse response, Object handler) {
        if (!properties.rateLimit().enabled()) {
            return true;
        }
        String team = teamResolver.resolve(request);
        RateLimitDecision decision = rateLimiter.tryConsume(team);
        if (!decision.allowed()) {
            throw new RateLimitedException(decision.retryAfter());
        }
        return true;
    }
}

