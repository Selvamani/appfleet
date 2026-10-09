package io.appfleet.identity.web;

import io.appfleet.identity.auth.AuthExceptions;
import io.appfleet.identity.common.ApiExceptions;
import org.springframework.web.HttpRequestMethodNotSupportedException;
import org.springframework.web.bind.MissingServletRequestParameterException;
import org.springframework.web.method.annotation.MethodArgumentTypeMismatchException;
import org.springframework.web.servlet.resource.NoResourceFoundException;
import io.appfleet.identity.auth.AuthExceptions.AccountLockedException;
import io.appfleet.identity.auth.AuthExceptions.EmailAlreadyRegisteredException;
import io.appfleet.identity.auth.LockoutService.LockoutUnavailableException;
import org.springframework.http.HttpHeaders;
import io.appfleet.identity.auth.AuthExceptions.InvalidCredentialsException;
import io.appfleet.identity.auth.AuthExceptions.InvalidRefreshTokenException;
import io.appfleet.identity.auth.AuthExceptions.PasswordTooLongException;
import jakarta.servlet.http.HttpServletRequest;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.http.HttpStatus;
import org.springframework.http.ProblemDetail;
import org.springframework.http.ResponseEntity;
import org.springframework.http.converter.HttpMessageNotReadableException;
import org.springframework.security.access.AccessDeniedException;
import org.springframework.security.core.AuthenticationException;
import org.springframework.web.bind.MethodArgumentNotValidException;
import org.springframework.web.bind.annotation.ExceptionHandler;
import org.springframework.web.bind.annotation.RestControllerAdvice;

import java.net.URI;
import java.util.List;
import java.util.Map;

/**
 * One problem shape, the same as control-api: type urn:appfleet:problem:slug, title, status, detail, instance,
 * correlationId, and errors[] on a validation failure. Clients switch on type, never on detail.
 */
@RestControllerAdvice
public class ApiExceptionHandler {

    private static final Logger log = LoggerFactory.getLogger(ApiExceptionHandler.class);

    @ExceptionHandler(MethodArgumentNotValidException.class)
    ResponseEntity<ProblemDetail> validation(MethodArgumentNotValidException e, HttpServletRequest request) {
        List<Map<String, String>> errors = e.getBindingResult().getFieldErrors().stream()
                .map(f -> Map.of("field", f.getField(), "message", String.valueOf(f.getDefaultMessage())))
                .toList();
        ProblemDetail p = problem(HttpStatus.BAD_REQUEST, "validation-failed", "Validation failed", "The request body is not valid", request);
        p.setProperty("errors", errors);
        return ResponseEntity.badRequest().body(p);
    }

    @ExceptionHandler(PasswordTooLongException.class)
    ResponseEntity<ProblemDetail> passwordTooLong(PasswordTooLongException e, HttpServletRequest request) {
        ProblemDetail p = problem(HttpStatus.BAD_REQUEST, "validation-failed", "Validation failed", "The request body is not valid", request);
        p.setProperty("errors", List.of(Map.of("field", e.field(), "message", e.getMessage())));
        return ResponseEntity.badRequest().body(p);
    }

    @ExceptionHandler(HttpMessageNotReadableException.class)
    ResponseEntity<ProblemDetail> malformed(HttpMessageNotReadableException e, HttpServletRequest request) {
        return ResponseEntity.badRequest().body(
                problem(HttpStatus.BAD_REQUEST, "malformed-request", "Bad Request", "The request body could not be read", request));
    }

    @ExceptionHandler(EmailAlreadyRegisteredException.class)
    ResponseEntity<ProblemDetail> conflict(EmailAlreadyRegisteredException e, HttpServletRequest request) {
        return ResponseEntity.status(HttpStatus.CONFLICT).body(
                problem(HttpStatus.CONFLICT, "conflict", "Conflict", "That email is already registered", request));
    }

    @ExceptionHandler(InvalidCredentialsException.class)
    ResponseEntity<ProblemDetail> invalidCredentials(InvalidCredentialsException e, HttpServletRequest request) {
        return ResponseEntity.status(HttpStatus.UNAUTHORIZED).body(
                problem(HttpStatus.UNAUTHORIZED, "unauthorized", "Unauthorized", "Invalid credentials", request));
    }

    @ExceptionHandler(InvalidRefreshTokenException.class)
    ResponseEntity<ProblemDetail> invalidRefreshToken(InvalidRefreshTokenException e, HttpServletRequest request) {
        return ResponseEntity.status(HttpStatus.UNAUTHORIZED).body(
                problem(HttpStatus.UNAUTHORIZED, "unauthorized", "Unauthorized", "Invalid refresh token", request));
    }

    @ExceptionHandler(AccountLockedException.class)
    ResponseEntity<ProblemDetail> locked(AccountLockedException e, HttpServletRequest request) {
        long seconds = Math.max(1, e.retryAfter().toSeconds());
        return ResponseEntity.status(HttpStatus.LOCKED)
                .header(HttpHeaders.RETRY_AFTER, String.valueOf(seconds))
                .body(problem(HttpStatus.LOCKED, "locked", "Locked", "Too many failed sign-in attempts. Try again later.", request));
    }

    /** Redis (the failure counter) cannot be reached: sign-in is refused rather than left unprotected. */
    @ExceptionHandler(LockoutUnavailableException.class)
    ResponseEntity<ProblemDetail> lockoutUnavailable(LockoutUnavailableException e, HttpServletRequest request) {
        log.error("lockout counter unavailable", e);
        return ResponseEntity.status(HttpStatus.SERVICE_UNAVAILABLE)
                .header(HttpHeaders.RETRY_AFTER, "5")
                .body(problem(HttpStatus.SERVICE_UNAVAILABLE, "service-unavailable", "Service unavailable", "Sign-in is temporarily unavailable. Try again shortly.", request));
    }

    @ExceptionHandler(AuthExceptions.WeakPasswordException.class)
    ResponseEntity<ProblemDetail> weakPassword(AuthExceptions.WeakPasswordException e, HttpServletRequest request) {
        ProblemDetail p = problem(HttpStatus.BAD_REQUEST, "validation-failed", "Validation failed", "The request body is not valid", request);
        p.setProperty("errors", List.of(Map.of("field", e.field(), "message", e.getMessage())));
        return ResponseEntity.badRequest().body(p);
    }

    @ExceptionHandler(AuthExceptions.WrongCurrentPasswordException.class)
    ResponseEntity<ProblemDetail> wrongCurrentPassword(AuthExceptions.WrongCurrentPasswordException e, HttpServletRequest request) {
        ProblemDetail p = problem(HttpStatus.BAD_REQUEST, "validation-failed", "Validation failed", "The request body is not valid", request);
        p.setProperty("errors", List.of(Map.of("field", "currentPassword", "message", "is not correct")));
        return ResponseEntity.badRequest().body(p);
    }

    /**
     * Method security throws these from inside the handler method, so the catch-all below would turn every 403 into a 500.
     * Rethrown, they reach the filter chain, where ProblemAccessDeniedHandler and ProblemAuthenticationEntryPoint answer.
     */
    @ExceptionHandler({AccessDeniedException.class, AuthenticationException.class})
    void rethrowSecurity(RuntimeException e) {
        throw e;
    }

    @ExceptionHandler(ApiExceptions.NotFoundException.class)
    ResponseEntity<ProblemDetail> notFound(ApiExceptions.NotFoundException e, HttpServletRequest request) {
        return ResponseEntity.status(HttpStatus.NOT_FOUND).body(problem(HttpStatus.NOT_FOUND, "not-found", "Not found", e.getMessage(), request));
    }

    @ExceptionHandler(ApiExceptions.ConflictException.class)
    ResponseEntity<ProblemDetail> conflictState(ApiExceptions.ConflictException e, HttpServletRequest request) {
        return ResponseEntity.status(HttpStatus.CONFLICT).body(problem(HttpStatus.CONFLICT, "conflict", "Conflict", e.getMessage(), request));
    }

    @ExceptionHandler(ApiExceptions.UnprocessableException.class)
    ResponseEntity<ProblemDetail> unprocessable(ApiExceptions.UnprocessableException e, HttpServletRequest request) {
        return ResponseEntity.status(HttpStatus.UNPROCESSABLE_CONTENT).body(
                        problem(HttpStatus.UNPROCESSABLE_CONTENT, e.slug(), "Unprocessable", e.getMessage(), request));
    }

    @ExceptionHandler(ApiExceptions.InvalidFieldException.class)
    ResponseEntity<ProblemDetail> invalidField(ApiExceptions.InvalidFieldException e, HttpServletRequest request) {
        ProblemDetail p = problem(HttpStatus.BAD_REQUEST, "validation-failed", "Validation failed", "The request body is not valid", request);
        p.setProperty("errors", List.of(Map.of("field", e.field(), "message", e.getMessage())));
        return ResponseEntity.badRequest().body(p);
    }

    /** A path or query value that is not what its type needs (a cursor that is not a UUID): 400, not the 500 of the catch-all. */
    @ExceptionHandler(MethodArgumentTypeMismatchException.class)
    ResponseEntity<ProblemDetail> typeMismatch(MethodArgumentTypeMismatchException e, HttpServletRequest request) {
        ProblemDetail p = problem(HttpStatus.BAD_REQUEST, "validation-failed", "Validation failed", "The request is not valid", request);
        p.setProperty("errors", List.of(Map.of("field", e.getName(), "message", "has the wrong format")));
        return ResponseEntity.badRequest().body(p);
    }

    /**
      * Spring's own web errors (an unknown path or a wrong method, once the caller is signed in) are not server errors.
      * They carry their status; the problem shape is ours.
      */
    @ExceptionHandler({HttpRequestMethodNotSupportedException.class, NoResourceFoundException.class, MissingServletRequestParameterException.class})
    ResponseEntity<ProblemDetail> webError(Exception e, HttpServletRequest request) {
        HttpStatus status = e instanceof HttpRequestMethodNotSupportedException ? HttpStatus.METHOD_NOT_ALLOWED
                        : e instanceof NoResourceFoundException ? HttpStatus.NOT_FOUND : HttpStatus.BAD_REQUEST;
        String slug = status == HttpStatus.NOT_FOUND ? "not-found" : status == HttpStatus.METHOD_NOT_ALLOWED ? "method-not-allowed" : "malformed-request";
        return ResponseEntity.status(status).body(problem(status, slug, status.getReasonPhrase(), "The request cannot be served", request));
    }

    
    @ExceptionHandler(Exception.class)
    ResponseEntity<ProblemDetail> unexpected(Exception e, HttpServletRequest request) {
        log.error("unhandled exception", e);
        return ResponseEntity.status(HttpStatus.INTERNAL_SERVER_ERROR).body(
                problem(HttpStatus.INTERNAL_SERVER_ERROR, "internal-error", "Internal server error", "An unexpected error occurred", request));
    }

    private static ProblemDetail problem(HttpStatus status, String slug, String title, String detail, HttpServletRequest request) {
        ProblemDetail p = ProblemDetail.forStatusAndDetail(status, detail);
        p.setType(URI.create("urn:appfleet:problem:" + slug));
        p.setTitle(title);
        p.setInstance(URI.create(request.getRequestURI()));
        Object id = request.getAttribute(CorrelationIdFilter.ATTRIBUTE);
        if (id != null) p.setProperty("correlationId", id.toString());
        return p;
    }
}