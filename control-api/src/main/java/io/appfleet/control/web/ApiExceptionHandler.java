package io.appfleet.control.web;

import io.appfleet.control.common.NotFoundException;
import io.appfleet.control.deployment.DeploymentValidationException;
import io.appfleet.control.deployment.IllegalTransitionException;
import jakarta.annotation.Nullable;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.http.*;
import org.springframework.orm.ObjectOptimisticLockingFailureException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;
import org.springframework.web.context.request.RequestAttributes;
import org.springframework.web.context.request.WebRequest;
import org.springframework.web.servlet.mvc.method.annotation.ResponseEntityExceptionHandler;

import java.net.URI;
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


    @ExceptionHandler(IllegalTransitionException.class)
    ResponseEntity<ProblemDetail> illegalTransition(IllegalTransitionException ex, WebRequest req) {
        return problem(HttpStatus.CONFLICT, "illegal-transition", "Illegal state transition", ex.getMessage(), req);
    }

    @ExceptionHandler(ObjectOptimisticLockingFailureException.class)
    ResponseEntity<ProblemDetail> optimisticLock(ObjectOptimisticLockingFailureException ex, WebRequest req) {
        return problem(HttpStatus.CONFLICT, "concurrent-modification", "Concurrent modification",
                "The resource was changed by another request. Re-read it and retry if still appropriate.", req);
    }

    @ExceptionHandler(NotFoundException.class)
    ResponseEntity<ProblemDetail> notFound(NotFoundException ex, WebRequest req) {
        return problem(HttpStatus.NOT_FOUND, "not-found", "Not found", ex.getMessage(), req);
    }

    @ExceptionHandler(DeploymentValidationException.class)
    ResponseEntity<ProblemDetail> unprocessable(DeploymentValidationException ex, WebRequest req) {
        return problem(HttpStatus.UNPROCESSABLE_ENTITY, "unprocessable", "Unprocessable request", ex.getMessage(), req);
    }

    @ExceptionHandler(DataIntegrityViolationException.class)
    ResponseEntity<ProblemDetail> dataIntegrity(DataIntegrityViolationException ex, WebRequest req) {
        String detail = KNOWN_CONFLICTS.get(constraintName(ex));
        if (detail == null) {
            return unexpected(ex, req);              // NOT NULL, FK, unknown unique: a bug, not a client conflict
        }
        return problem(HttpStatus.CONFLICT, "conflict", "Conflict", detail, req);
    }

    @ExceptionHandler(jakarta.validation.ConstraintViolationException.class)
    ResponseEntity<ProblemDetail> constraintViolation(jakarta.validation.ConstraintViolationException ex, WebRequest req) {
        ResponseEntity<ProblemDetail> response = problem(HttpStatus.BAD_REQUEST, "validation-failed",
                "Validation failed", "One or more parameters are invalid.", req);
        response.getBody().setProperty("errors", ex.getConstraintViolations().stream()
                .map(v -> Map.of("field", lastNode(v.getPropertyPath()), "message", v.getMessage()))
                .toList());
        return response;
    }

    @ExceptionHandler(Exception.class)
    ResponseEntity<ProblemDetail> unexpected(Exception ex, WebRequest req) {
        log.error("Unhandled exception", ex);
        return problem(HttpStatus.INTERNAL_SERVER_ERROR, "internal-error", "Internal server error",
                "An unexpected error occurred.", req);
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
        if (ex instanceof MethodArgumentNotValidException) {
            return "validation-failed";
        }
        return switch (status.value()) {
            case 400 -> "malformed-request";
            case 404 -> "not-found";
            case 405 -> "method-not-allowed";
            case 415 -> "unsupported-media-type";
            default -> "error-" + status.value();
        };
    }

}
