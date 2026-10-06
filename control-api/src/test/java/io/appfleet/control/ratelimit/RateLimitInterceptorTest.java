package io.appfleet.control.ratelimit;

import io.appfleet.control.config.AppfleetProperties;
import io.appfleet.control.outbox.OutboxProperties;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.Test;
import org.springframework.mock.web.MockHttpServletRequest;
import org.springframework.mock.web.MockHttpServletResponse;
import org.springframework.security.authentication.TestingAuthenticationToken;
import org.springframework.security.core.context.SecurityContextHolder;

import java.time.Duration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

class RateLimitInterceptorTest {

    private static final RateLimitDecision ALLOWED = new RateLimitDecision(true, 2, Duration.ZERO);

    private final RateLimiter limiter = mock(RateLimiter.class);
    private final HttpServletRequest request = new MockHttpServletRequest();
    private final HttpServletResponse response = new MockHttpServletResponse();

    @AfterEach
    void clearContext() {
        SecurityContextHolder.clearContext();
    }

    private RateLimitInterceptor interceptor(boolean enabled) {
        return new RateLimitInterceptor(
                new AppfleetProperties("test", new RateLimitProperties(enabled, 3, 1.0),
                new OutboxProperties(false, "task.work", 100, Duration.ofSeconds(1), Duration.ofSeconds(5), Duration.ofHours(24))),
                limiter);
    }

    @Test
    void authenticatedCaller_isKeyedBySub() {
        SecurityContextHolder.getContext()
                .setAuthentication(new TestingAuthenticationToken("alice-sub", "n/a", "ROLE_USER"));
        when(limiter.tryConsume("alice-sub")).thenReturn(ALLOWED);

        assertThat(interceptor(true).preHandle(request, response, new Object())).isTrue();
        verify(limiter).tryConsume("alice-sub");
    }

    @Test
    void noAuthentication_sharesTheAnonymousBucket() {
        when(limiter.tryConsume("anonymous")).thenReturn(ALLOWED);

        assertThat(interceptor(true).preHandle(request, response, new Object())).isTrue();
        verify(limiter).tryConsume("anonymous");
    }

    @Test
    void unauthenticatedToken_sharesTheAnonymousBucket() {
        SecurityContextHolder.getContext()
                .setAuthentication(new TestingAuthenticationToken("mallory", "n/a"));   // 2-arg: authenticated=false
        when(limiter.tryConsume("anonymous")).thenReturn(ALLOWED);

        interceptor(true).preHandle(request, response, new Object());
        verify(limiter).tryConsume("anonymous");
    }

    @Test
    void denied_throwsRateLimited() {
        SecurityContextHolder.getContext()
                .setAuthentication(new TestingAuthenticationToken("alice-sub", "n/a", "ROLE_USER"));
        when(limiter.tryConsume("alice-sub")).thenReturn(new RateLimitDecision(false, 0, Duration.ofSeconds(2)));

        assertThatThrownBy(() -> interceptor(true).preHandle(request, response, new Object()))
                .isInstanceOf(RateLimitedException.class);
    }

    @Test
    void disabled_neverTouchesTheLimiter() {
        assertThat(interceptor(false).preHandle(request, response, new Object())).isTrue();
        verify(limiter, never()).tryConsume(anyString());
    }
}
