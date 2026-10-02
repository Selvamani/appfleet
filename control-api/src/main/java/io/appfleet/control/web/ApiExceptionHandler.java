package io.appfleet.control.web;

import io.appfleet.control.common.NotFoundException;
import io.appfleet.control.common.UnprocessableRequestException;
import io.appfleet.control.deployment.DeploymentValidationException;
import io.appfleet.control.deployment.IllegalTransitionException;
import io.appfleet.control.deployment.RollbackAlreadyRequestedException;
import io.appfleet.control.idempotency.IdempotencyKeyReusedException;
import io.appfleet.control.idempotency.InvalidIdempotencyKeyException;
import io.appfleet.control.idempotency.RequestInProgressException;
import io.appfleet.control.ratelimit.RateLimitedException;
import io.appfleet.control.web.openapi.ProblemKind;
import jakarta.annotation.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.TypeMismatchException;
import org.springframework.context.MessageSourceResolvable;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.data.redis.RedisConnectionFailureException;
import org.springframework.http.*;
import org.springframework.orm.ObjectOptimisticLockingFailureException;
import org.springframework.validation.method.ParameterValidationResult;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.context.request.RequestAttributes;
import org.springframework.web.context.request.WebRequest;
import org.springframework.web.method.annotation.HandlerMethodValidationException;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.servlet.mvc.method.annotation.ResponseEntityExceptionHandler;

import java.net.URI;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;

@RestControllerAdvice
public class ApiExceptionHandler extends ResponseEntityExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(ApiExceptionHandler.class);
    private static final String TYPE_PREFIX = "urn:appfleet:problem:";

    private static final Map<String, String> KNOWN_CONFLICTS = Map.of(
            "uq_application_name", "An application with this name already exists.",
            "uq_release_app_version", "This application already has a release with that version.",
            "uq_deployment_active_per_app_env", "An active deployment already exists for this application and environment.");

    @Override
    protected ResponseEntity<Object> handleExceptionInternal(Exception ex, @Nullable Object body,
            HttpHeaders headers, HttpStatusCode status, WebRequest request) {
        ResponseEntity<Object> response = super.handleExceptionInternal(ex, body, headers, status, request);
        if (response != null && response.getBody() instanceof ProblemDetail pd) {
            stamp(pd, request, slugFor(ex, status));
        }
        return response;
    }

    @Override
    protected @Nullable ResponseEntity<Object> handleMethodArgumentNotValid(MethodArgumentNotValidException ex,
            HttpHeaders headers, HttpStatusCode status, WebRequest request) {
        ResponseEntity<Object> response = super.handleMethodArgumentNotValid(ex, headers, status, request);
        if (response != null && response.getBody() instanceof ProblemDetail pd) {
            pd.setProperty("errors", ex.getBindingResult().getFieldErrors().stream()
                    .map(e -> Map.of("field", e.getField(), "message", String.valueOf(e.getDefaultMessage())))
                    .toList());
        }
        return response;
    }

    @Override
    protected @Nullable ResponseEntity<Object> handleHandlerMethodValidationException(
            HandlerMethodValidationException ex, HttpHeaders headers, HttpStatusCode status, WebRequest request) {
        ResponseEntity<Object> response = super.handleHandlerMethodValidationException(ex, headers, status, request);
        if (response != null && response.getBody() instanceof ProblemDetail pd) {
            List<Map<String, String>> errors = new ArrayList<>();
            for (ParameterValidationResult result : ex.getParameterValidationResults()) {
                String field = result.getMethodParameter().getParameterName();
                for (MessageSourceResolvable error : result.getResolvableErrors()) {
                    errors.add(Map.of("field", String.valueOf(field), "message", String.valueOf(error.getDefaultMessage())));
                }
            }
            pd.setProperty("errors", errors);
        }
        return response;
    }

    @Override
    protected @Nullable ResponseEntity<Object> handleTypeMismatch(TypeMismatchException ex,
                                                                  HttpHeaders headers, HttpStatusCode status, WebRequest request) {
        ResponseEntity<Object> response = super.handleTypeMismatch(ex, headers, status, request);
        if (response != null && response.getBody() instanceof ProblemDetail pd) {
            String field = ex instanceof MethodArgumentTypeMismatchException m ? m.getName() : ex.getPropertyName();
            pd.setProperty("errors", List.of(Map.of("field", String.valueOf(field), "message", "Invalid value.")));
        }
        return response;
    }

    @ExceptionHandler(IllegalTransitionException.class)
    ResponseEntity<ProblemDetail> illegalTransition(IllegalTransitionException ex, WebRequest req) {
        return problem(ProblemKind.ILLEGAL_TRANSITION, ex.getMessage(), req);
    }

    @ExceptionHandler(ObjectOptimisticLockingFailureException.class)
    ResponseEntity<ProblemDetail> optimisticLock(ObjectOptimisticLockingFailureException ex, WebRequest req) {
        return problem(ProblemKind.CONCURRENT_MODIFICATION, "The resource was changed by another request. Re-read it and retry if still appropriate.", req);
    }

    @ExceptionHandler(NotFoundException.class)
    ResponseEntity<ProblemDetail> notFound(NotFoundException ex, WebRequest req) {
        return problem(ProblemKind.NOT_FOUND, ex.getMessage(), req);
    }

    @ExceptionHandler(DeploymentValidationException.class)
    ResponseEntity<ProblemDetail> unprocessable(DeploymentValidationException ex, WebRequest req) {
        return problem(ProblemKind.UNPROCESSABLE, ex.getMessage(), req);
    }

    @ExceptionHandler(DataIntegrityViolationException.class)
    ResponseEntity<ProblemDetail> dataIntegrity(DataIntegrityViolationException ex, WebRequest req) {
        String detail = KNOWN_CONFLICTS.get(constraintName(ex));
        if (detail == null) {
            return unexpected(ex, req);              // NOT NULL, FK, unknown unique: a bug, not a client conflict
        }
        return problem(ProblemKind.CONFLICT, detail, req);
    }

    @ExceptionHandler(jakarta.validation.ConstraintViolationException.class)
    ResponseEntity<ProblemDetail> constraintViolation(jakarta.validation.ConstraintViolationException ex, WebRequest req) {
        ResponseEntity<ProblemDetail> response = problem(ProblemKind.VALIDATION_FAILED, "One or more parameters are invalid.", req);
        response.getBody().setProperty("errors", ex.getConstraintViolations().stream()
                .map(v -> Map.of("field", lastNode(v.getPropertyPath()), "message", v.getMessage()))
                .toList());
        return response;
    }

    @ExceptionHandler(Exception.class)
    ResponseEntity<ProblemDetail> unexpected(Exception ex, WebRequest req) {
        log.error("Unhandled exception", ex);
        return problem(ProblemKind.INTERNAL_ERROR, "An unexpected error occurred.", req);
    }

    @ExceptionHandler(InvalidCursorException.class)
    ResponseEntity<ProblemDetail> invalidCursor(InvalidCursorException ex, WebRequest req) {
        ResponseEntity<ProblemDetail> response = problem(ProblemKind.VALIDATION_FAILED, "One or more parameters are invalid.", req);
        response.getBody().setProperty("errors", List.of(Map.of("field", "cursor", "message", "Cursor is not valid.")));
        return response;
    }

    @ExceptionHandler(UnprocessableRequestException.class)
    ResponseEntity<ProblemDetail> unprocessableRequest(UnprocessableRequestException ex, WebRequest req) {
        return problem(ProblemKind.UNPROCESSABLE, ex.getMessage(), req);
    }

    @ExceptionHandler(RollbackAlreadyRequestedException.class)
    ResponseEntity<ProblemDetail> rollbackAlreadyRequested(RollbackAlreadyRequestedException ex, WebRequest req) {
        return problem(ProblemKind.CONFLICT, "A rollback is already pending for this deployment.", req);
    }

    @ExceptionHandler(IdempotencyKeyReusedException.class)
    ResponseEntity<ProblemDetail> idempotencyKeyReused(IdempotencyKeyReusedException ex, WebRequest req) {
        return problem(ProblemKind.IDEMPOTENCY_KEY_REUSED, "This Idempotency-Key was already used with a different request body. Use a new key for a different request.", req);
    }

    @ExceptionHandler(RequestInProgressException.class)
    ResponseEntity<ProblemDetail> requestInProgress(RequestInProgressException ex, WebRequest req) {
        ResponseEntity<ProblemDetail> response = problem(ProblemKind.REQUEST_IN_PROGRESS, "A request with this Idempotency-Key is still being processed. Retry shortly to get its result.", req);
        return ResponseEntity.status(response.getStatusCode())
                .header(HttpHeaders.RETRY_AFTER, "1")
                .body(response.getBody());
    }

    @ExceptionHandler(InvalidIdempotencyKeyException.class)
    ResponseEntity<ProblemDetail> invalidIdempotencyKey(InvalidIdempotencyKeyException ex, WebRequest req) {
        ResponseEntity<ProblemDetail> response = problem(ProblemKind.VALIDATION_FAILED, "One or more parameters are invalid.", req);
        response.getBody().setProperty("errors", List.of(Map.of("field", "Idempotency-Key",
                "message", "Must be 1 to 255 printable ASCII characters, without spaces.")));
        return response;
    }

    @ExceptionHandler(RedisConnectionFailureException.class)
    ResponseEntity<ProblemDetail> backingServiceUnavailable(RedisConnectionFailureException ex, WebRequest req) {
        log.warn("Redis unavailable: {}", ex.getMessage());
        ResponseEntity<ProblemDetail> response = problem(ProblemKind.SERVICE_UNAVAILABLE, "A required backing service is unavailable. Retry later.", req);
        return ResponseEntity.status(response.getStatusCode())
                .header(HttpHeaders.RETRY_AFTER, "5")
                .body(response.getBody());
    }

    @ExceptionHandler(InvalidHeaderException.class)
    ResponseEntity<ProblemDetail> invalidHeader(InvalidHeaderException ex, WebRequest req) {
        ResponseEntity<ProblemDetail> response = problem(ProblemKind.VALIDATION_FAILED, "One or more parameters are invalid.", req);
        response.getBody().setProperty("errors", List.of(Map.of("field", ex.header(), "message", "Must be a UUID.")));
        return response;
    }

    @ExceptionHandler(RateLimitedException.class)
    ResponseEntity<ProblemDetail> rateLimited(RateLimitedException ex, WebRequest req) {
        long seconds = Math.max(1, (ex.retryAfter().toMillis() + 999) / 1000);   // round up, never 0
        ResponseEntity<ProblemDetail> response = problem(ProblemKind.RATE_LIMITED, "The rate limit for this team is exhausted. Retry after the time given in Retry-After.", req);
        return ResponseEntity.status(response.getStatusCode())
                .header(HttpHeaders.RETRY_AFTER, String.valueOf(seconds))
                .body(response.getBody());
    }

    private static String constraintName(Throwable t) {
        for (Throwable c = t; c != null; c = c.getCause()) {
            if (c instanceof org.hibernate.exception.ConstraintViolationException cve) {
                return cve.getConstraintName();
            }
        }
        return null;
    }

    private ResponseEntity<ProblemDetail> problem(HttpStatus status, String slug, String title,
                                                  String detail, WebRequest request) {
        ProblemDetail pd = ProblemDetail.forStatusAndDetail(status, detail);
        pd.setTitle(title);
        stamp(pd, request, slug);
        return ResponseEntity.status(status).body(pd);
    }

    private ResponseEntity<ProblemDetail> problem(ProblemKind kind, String detail, WebRequest request) {
        return problem(HttpStatus.valueOf(kind.status()), kind.slug(), kind.title(), detail, request);
    }

    private static String lastNode(jakarta.validation.Path path) {
        String last = "";
        for (jakarta.validation.Path.Node node : path) {
            if (node.getName() != null) {
                last = node.getName();
            }
        }
        return last;
    }

    private void stamp(ProblemDetail pd, WebRequest request, String slug) {
        pd.setType(URI.create(TYPE_PREFIX + slug));
        Object id = request.getAttribute(CorrelationIdFilter.ATTRIBUTE, RequestAttributes.SCOPE_REQUEST);
        pd.setProperty("correlationId", id);
    }

    private String slugFor(Exception ex, HttpStatusCode status) {
        if (ex instanceof MethodArgumentNotValidException
                || ex instanceof HandlerMethodValidationException
                || ex instanceof TypeMismatchException) {
            return ProblemKind.VALIDATION_FAILED.slug();
        }
        return switch (status.value()) {
            case 400 -> ProblemKind.MALFORMED_REQUEST.slug();
            case 404 -> ProblemKind.NOT_FOUND.slug();
            case 405 -> "method-not-allowed";
            case 415 -> "unsupported-media-type";
            default -> "error-" + status.value();
        };
    }

}
