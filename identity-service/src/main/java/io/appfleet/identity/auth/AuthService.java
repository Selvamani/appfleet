package io.appfleet.identity.auth;

import io.appfleet.identity.audit.AuditEvent;
import io.appfleet.identity.audit.ClientInfo;
import io.appfleet.identity.audit.LoginAuditService;
import io.appfleet.identity.audit.LoginOutcome;
import io.appfleet.identity.auth.AuthDTOs.LoginRequest;
import io.appfleet.identity.auth.AuthDTOs.RegisterRequest;
import io.appfleet.identity.auth.AuthDTOs.RegisteredUser;
import io.appfleet.identity.auth.AuthDTOs.TokenResponse;
import io.appfleet.identity.auth.AuthExceptions.EmailAlreadyRegisteredException;
import io.appfleet.identity.auth.AuthExceptions.InvalidCredentialsException;
import io.appfleet.identity.auth.AuthExceptions.PasswordTooLongException;
import io.appfleet.identity.token.RefreshToken;
import io.appfleet.identity.token.RefreshTokenService;
import io.appfleet.identity.token.SessionRevocationService;
import io.appfleet.identity.user.AppUser;
import io.appfleet.identity.user.UserRepository;
import io.appfleet.identity.user.UserStatus;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.time.Duration;
import java.util.Optional;
import java.util.UUID;

@Service
public class AuthService {

    private final UserRepository users;
    private final PasswordEncoder encoder;
    private final AccessTokenIssuer issuer;
    private final RefreshTokenService refreshTokens;
    private final SessionRevocationService sessions;
    private final CredentialChecker credentials;
    private final LockoutService lockout;
    private final LoginAuditService audit;
    private final PasswordPolicy policy;

    public AuthService(UserRepository users, PasswordEncoder encoder, AccessTokenIssuer issuer, RefreshTokenService refreshTokens, SessionRevocationService sessions, CredentialChecker credentials, LockoutService lockout, LoginAuditService audit, PasswordPolicy policy) {
        this.users = users;
        this.encoder = encoder;
        this.issuer = issuer;
        this.refreshTokens = refreshTokens;
        this.sessions = sessions;
        this.credentials = credentials;
        this.lockout = lockout;
        this.audit = audit;
        this.policy = policy;
    }

    @Transactional
    public RegisteredUser register(RegisterRequest request) {
        String email = AppUser.normalize(request.email());
        policy.check("password", request.password(), email);
        if (users.existsByEmail(email))
            throw new EmailAlreadyRegisteredException();
        try {
            AppUser saved = users.save(new AppUser(email, request.displayName().trim(), encoder.encode(request.password())));
            return new RegisteredUser(saved.getId(), saved.getEmail(), saved.getDisplayName());
        } catch (DataIntegrityViolationException e) {
            throw new EmailAlreadyRegisteredException();   // two registrations raced past existsByEmail; the unique index decided
        }
    }

    /**
     * The order is the design.
     * (1) Look the user up: cheap, and it only feeds the audit.
     * (2) Ask the lockout BEFORE any hashing, so a locked email costs the server nothing.
     * (3) Always run exactly one BCrypt check, against a dummy hash when the email is unknown, so the time says nothing.
     * (4) Only then judge: unknown, wrong password and deactivated all end in the same 401, and all count as one failure.
     * Every attempt writes an audit row in its own transaction, so the rows of the refused attempts survive the rollback of this one.
     */
    @Transactional
    public TokenResponse login(LoginRequest request, ClientInfo client) {
        String email = AppUser.normalize(request.email());
        AppUser user = users.findByEmail(email).orElse(null);
        UUID userId = user == null ? null : user.getId();

        Optional<Duration> locked = lockout.lockedFor(email);
        if (locked.isPresent()) {
            audit.record(AuditEvent.LOGIN, LoginOutcome.LOCKED, email, userId, client);
            throw new AuthExceptions.AccountLockedException(locked.get());
        }

        boolean passwordOk = credentials.matches(request.password(), user);
        if (user == null || !passwordOk || user.getStatus() != UserStatus.ACTIVE) {
            lockout.recordFailure(email);
            LoginOutcome why = user == null ? LoginOutcome.UNKNOWN_USER : !passwordOk ? LoginOutcome.BAD_CREDENTIALS : LoginOutcome.DEACTIVATED;
            audit.record(AuditEvent.LOGIN, why, email, userId, client);
            throw new InvalidCredentialsException();
        }

        lockout.clear(email);
        audit.record(AuditEvent.LOGIN, LoginOutcome.SUCCESS, email, userId, client);
        RefreshTokenService.Started started = refreshTokens.startFamily(user);
        return respond(user, started.token(), started.link());
    }

    /**
     * Empty means "refused". It is NOT an exception on purpose: a reuse revokes the family, and an exception would roll
     * that revocation back. The controller turns the empty result into a 401 after this transaction has committed.
     * An exception from the access-token issuer, by contrast, rolls the rotation back, so the client can retry.
     */
    @Transactional
    public Optional<TokenResponse> refresh(AuthDTOs.RefreshRequest request, ClientInfo client) {
        return switch (refreshTokens.rotate(request.refreshToken())) {
            case RefreshTokenService.Rotated rotated -> Optional.of(respond(rotated.user(), rotated.refreshToken(), rotated.link()));
            case RefreshTokenService.Rejected rejected ->  {
                if (rejected.reason() == RefreshTokenService.Reason.REUSED)
                    audit.record(AuditEvent.REFRESH_REUSE, LoginOutcome.REUSED, null, rejected.userId(), client);
                yield Optional.empty();
            }
        };
    }

    /** Ends the session this refresh token belongs to. Always succeeds from the caller's side: an unknown token reveals nothing. */
    @Transactional
    public void logout(String refreshToken) {
        sessions.logout(refreshToken);
    }

    private TokenResponse respond(AppUser user, String refreshToken, RefreshToken link) {
        AccessTokenIssuer.IssuedToken token = issuer.issue(user);
        link.recordAccessToken(java.util.UUID.fromString(token.jti()), token.expiresAt());   // so logout can denylist it
        return new TokenResponse(token.value(), "Bearer", Duration.between(token.issuedAt(), token.expiresAt()).toSeconds(), refreshToken);
    }
}
