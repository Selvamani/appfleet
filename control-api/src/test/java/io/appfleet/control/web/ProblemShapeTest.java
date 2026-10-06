package io.appfleet.control.web;

import io.appfleet.control.common.NotFoundException;
import io.appfleet.control.common.UnprocessableRequestException;
import io.appfleet.control.deployment.Deployment;
import io.appfleet.control.deployment.DeploymentValidationException;
import io.appfleet.control.deployment.IllegalTransitionException;
import io.appfleet.control.deployment.RollbackAlreadyRequestedException;
import io.appfleet.control.idempotency.IdempotencyKeyReusedException;
import io.appfleet.control.idempotency.InvalidIdempotencyKeyException;
import io.appfleet.control.idempotency.RequestInProgressException;
import io.appfleet.control.ratelimit.RateLimitInterceptor;
import io.appfleet.control.ratelimit.RateLimitedException;
import jakarta.validation.Valid;
import jakarta.validation.constraints.NotBlank;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.params.ParameterizedTest;
import org.junit.jupiter.params.provider.Arguments;
import org.junit.jupiter.params.provider.MethodSource;
import org.junit.jupiter.params.provider.ValueSource;
import org.slf4j.MDC;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.webmvc.test.autoconfigure.WebMvcTest;
import org.springframework.context.annotation.ComponentScan;
import org.springframework.context.annotation.FilterType;
import org.springframework.context.annotation.Import;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.data.redis.RedisConnectionFailureException;
import org.springframework.orm.ObjectOptimisticLockingFailureException;
import org.springframework.test.context.ActiveProfiles;
import org.springframework.test.web.servlet.MockMvc;
import org.springframework.test.web.servlet.ResultActions;
import org.springframework.web.bind.annotation.*;

import java.sql.SQLException;
import java.time.Duration;
import java.util.UUID;
import java.util.stream.Stream;

import static org.hamcrest.Matchers.*;
import static org.springframework.http.MediaType.APPLICATION_JSON;
import static org.springframework.http.MediaType.TEXT_PLAIN;
import static org.springframework.test.web.servlet.request.MockMvcRequestBuilders.*;
import static org.springframework.test.web.servlet.result.MockMvcResultMatchers.*;
import static org.assertj.core.api.Assertions.assertThat;

@WebMvcTest(value = ProblemShapeTest.ProbeController.class,
        excludeFilters = @ComponentScan.Filter(type = FilterType.ASSIGNABLE_TYPE,
        classes = { RateLimitInterceptor.class, WebConfig.class }))
@Import({ApiExceptionHandler.class, CorrelationIdFilter.class, ProblemShapeTest.ProbeController.class})
@ActiveProfiles("test")
public class ProblemShapeTest {

    @Autowired
    MockMvc mockMvc;

    @RestController
    static class ProbeController {
        record Body(@NotBlank String name) {}

        @PostMapping("/probe/validate")
        void validate(@Valid @RequestBody Body body) {}

        @GetMapping("/probe/illegal-transition")
        void illegalTransition() { throw new IllegalTransitionException("Illegal transition from PENDING to HEALTHY"); }

        @GetMapping("/probe/not-found")
        void notFound() { throw new NotFoundException("Deployment", "abc"); }

        @GetMapping("/probe/optimistic-lock")
        void optimisticLock() { throw new ObjectOptimisticLockingFailureException(Deployment.class, "abc"); }

        @GetMapping("/probe/unprocessable")
        void unprocessable() throws DeploymentValidationException { throw new DeploymentValidationException("nope"); }

        @GetMapping("/probe/boom")
        void boom() { throw new RuntimeException("secret internal detail"); }

        @GetMapping("/probe/unique/{name}")
        void unique(@PathVariable String name) {
            throw new DataIntegrityViolationException("duplicate",
                    new org.hibernate.exception.ConstraintViolationException("dup", new SQLException(), name));
        }

        @GetMapping("/probe/unprocessable-request")
        void unprocessableRequest() {
            throw new UnprocessableRequestException("Application x does not exist.");
        }

        @GetMapping("/probe/rollback-already-requested")
        void rollbackAlreadyRequested() {
            throw new RollbackAlreadyRequestedException(UUID.randomUUID());
        }

        @GetMapping("/probe/idempotency-key-reused")
        void idempotencyKeyReused() {
            throw new IdempotencyKeyReusedException();
        }

        @GetMapping("/probe/request-in-progress")
        void requestInProgress() {
            throw new RequestInProgressException();
        }

        @GetMapping("/probe/redis-down")
        void redisDown() {
            throw new RedisConnectionFailureException("Unable to connect to Redis");
        }

        @GetMapping("/probe/invalid-idempotency-key")
        void invalidIdempotencyKey() {
            throw new InvalidIdempotencyKeyException();
        }

        @GetMapping("/probe/invalid-cursor")
        void invalidCursor() { throw new InvalidCursorException(); }

        @GetMapping("/probe/rate-limited")
        void rateLimited() { throw new RateLimitedException(Duration.ofMillis(1500)); }

        @GetMapping("/probe/rate-limited-zero")
        void rateLimitedZero() { throw new RateLimitedException(Duration.ZERO); }

    }

    private static void assertProblem(ResultActions result, int status, String slug, String path) throws Exception {
        result.andExpect(status().is(status))
                .andExpect(content().contentTypeCompatibleWith("application/problem+json"))
                .andExpect(jsonPath("$.type").value("urn:appfleet:problem:" + slug))
                .andExpect(jsonPath("$.title").exists())
                .andExpect(jsonPath("$.instance").value(path))
                .andExpect(jsonPath("$.correlationId").isNotEmpty());
    }

    @Test
    void malformedJson_is400() throws Exception {
        assertProblem(mockMvc.perform(post("/probe/validate")
                        .contentType(APPLICATION_JSON).content("{not json")),
                400, "malformed-request", "/probe/validate");
    }

    @Test
    void validationFailure_is400_withErrorsList() throws Exception {
        ResultActions result = mockMvc.perform(post("/probe/validate")
                .contentType(APPLICATION_JSON).content("{\"name\":\"\"}"));

        assertProblem(result, 400, "validation-failed", "/probe/validate");
        result.andExpect(jsonPath("$.errors[0].field").value("name"))
                .andExpect(jsonPath("$.errors[0].message").isNotEmpty());

    }

    @Test
    void unknownRoute_is404() throws Exception {
        assertProblem(mockMvc.perform(get("/probe/nope")), 404, "not-found", "/probe/nope");
    }

    @Test
    void wrongMethod_is405() throws Exception {
        assertProblem(mockMvc.perform(get("/probe/validate" )), 405, "method-not-allowed", "/probe/validate" );
    }

    @Test
    void wrongContentType_is415() throws Exception {
        assertProblem(mockMvc.perform(post("/probe/validate")
                        .contentType(TEXT_PLAIN).content("x")),
                415, "unsupported-media-type", "/probe/validate");
    }

    static Stream<Arguments> domainRows() {
        return Stream.of(
                Arguments.of("/probe/illegal-transition", 409, "illegal-transition"),
                Arguments.of("/probe/not-found", 404, "not-found"),
                Arguments.of("/probe/optimistic-lock", 409, "concurrent-modification"),
                Arguments.of("/probe/unprocessable", 422, "unprocessable"),
                Arguments.of("/probe/unique/uq_application_name", 409, "conflict"),
                Arguments.of("/probe/unique/uq_something_unknown", 500, "internal-error"),
                Arguments.of("/probe/boom", 500, "internal-error"),
                Arguments.of("/probe/unprocessable-request", 422, "unprocessable"),
                Arguments.of("/probe/rollback-already-requested", 409, "conflict"),
                Arguments.of("/probe/idempotency-key-reused", 422, "idempotency-key-reused"),
                Arguments.of("/probe/request-in-progress", 409, "request-in-progress"),
                Arguments.of("/probe/redis-down", 503, "service-unavailable"),
                Arguments.of("/probe/rate-limited", 429, "rate-limited"));
    }

    @ParameterizedTest(name = "{0} -> {1} {2}")
    @MethodSource("domainRows")
    void domainErrors_haveTheOneShape(String path, int status, String slug) throws Exception {
        ResultActions result = mockMvc.perform(get(path));
        assertProblem(result, status, slug, path);
        result.andExpect(jsonPath("$.errors").doesNotExist());
    }

    @Test
    void boom_doesNotLeakInternalMessage() throws Exception {
        mockMvc.perform(get("/probe/boom"))
                .andExpect(jsonPath("$.detail").value("An unexpected error occurred."))
                .andExpect(content().string(not(containsString("secret internal detail"))));
    }

    @Test
    void validCorrelationId_isEchoed() throws Exception {
        mockMvc.perform(get("/probe/not-found").header("X-Correlation-Id", "abc-123"))
                .andExpect(header().string("X-Correlation-Id", "abc-123"))
                .andExpect(jsonPath("$.correlationId").value("abc-123"));
    }

    @Test
    void missingCorrelationId_isGenerated() throws Exception {
        mockMvc.perform(get("/probe/not-found"))
                .andExpect(header().string("X-Correlation-Id", matchesPattern("[0-9a-f-]{36}")));
    }

    @ParameterizedTest
    @ValueSource(strings = {"bad id with spaces", "has\nnewline",
            "x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x-x"})
    void invalidCorrelationId_isReplaced(String bad) throws Exception {
        mockMvc.perform(get("/probe/not-found").header("X-Correlation-Id", bad))
                .andExpect(header().string("X-Correlation-Id", not(bad)))
                .andExpect(header().string("X-Correlation-Id", matchesPattern("[0-9a-f-]{36}")));
    }

    @Test
    void mdcIsClearedAfterRequest() throws Exception {
        mockMvc.perform(get("/probe/not-found").header("X-Correlation-Id", "abc-123"));
        assertThat(MDC.get("correlationId")).isNull();
    }

    static Stream<Arguments> retryAfterRows() {
        return Stream.of(
                Arguments.of("/probe/request-in-progress", "1"),
                Arguments.of("/probe/redis-down", "5"),
                Arguments.of("/probe/rate-limited", "2"),
                Arguments.of("/probe/rate-limited-zero", "1"));
    }

    @ParameterizedTest(name = "{0} -> Retry-After {1}")
    @MethodSource("retryAfterRows")
    void retryableErrors_carryRetryAfter(String path, String seconds) throws Exception {
        mockMvc.perform(get(path)).andExpect(header().string("Retry-After", seconds));
    }

    @Test
    void invalidIdempotencyKey_is400_withHeaderAsField() throws Exception {
        ResultActions result = mockMvc.perform(get("/probe/invalid-idempotency-key"));
        assertProblem(result, 400, "validation-failed", "/probe/invalid-idempotency-key");
        result.andExpect(jsonPath("$.errors[0].field").value("Idempotency-Key"));
    }

    @Test
    void invalidCursor_is400_withCursorAsField() throws Exception {
        ResultActions result = mockMvc.perform(get("/probe/invalid-cursor"));
        assertProblem(result, 400, "validation-failed", "/probe/invalid-cursor");
        result.andExpect(jsonPath("$.errors[0].field").value("cursor"))
                .andExpect(jsonPath("$.errors[0].message").isNotEmpty());
    }

}
