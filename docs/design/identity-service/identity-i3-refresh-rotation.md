# identity-service — I3: refresh rotation and theft detection

**Spec:** [02-IDENTITY-SERVICE.md](../../specs/project/02-IDENTITY-SERVICE.md), *Token design* (refresh rotation) and the deliberate bug *Refresh replay* · Step **I3** of [identity-service-plan.md](identity-service-plan.md) · Predecessor: [identity-i2-register-login-token.md](identity-i2-register-login-token.md) (login and the access token this step extends). **Status: built and closed 2026-10-06. The code in sections 5 and 6 was run on a scratch copy first (88 tests green, nine mutation checks seen red, section 8), then typed into the real tree by hand: 88 tests green, and the replay checked by hand against the running app (section 11).**

An access token lives 15 minutes, so a session needs a way to get a new one without the password. That is the refresh token: long-lived, used once, and replaced by a new one every time it is used. This step adds it to login, adds `POST /api/v1/auth/refresh`, and adds the part the spec calls the point of the step: **a refresh token that is used twice is a theft signal, and the whole family it belongs to is revoked.**

## 1. What already exists

- I2 is in your tree: register, login, the RS256 access token, the problem shape, 58 tests. `AuthService.login` is `@Transactional(readOnly = true)` and returns `{accessToken, tokenType, expiresIn}`.
- `AuthDTOs` (your spelling; the I2 doc said `AuthDtos`), `AuthService`, `AuthController`, `AuthExceptions`, `ApiExceptionHandler`, `SecurityConfig` and `IdentityConfig` are the files this step changes.
- The I2 `LoginTest` has one assertion that must change: it says the login response has **no** `refreshToken` ("refresh tokens arrive with I3"). It is the reason that assertion existed.
- No refresh-token table, no logout, no revocation. The login audit is I5, so a reuse is logged, not audited, for now.

## 2. Behaviour

| Request | Answer |
|---|---|
| `POST /api/v1/auth/login` | as in I2, **plus** `refreshToken` (43 characters); it starts a new family |
| `POST /api/v1/auth/refresh` `{refreshToken}` with the newest token of a live family | **200** `{accessToken, tokenType, expiresIn, refreshToken}`: a new access token (grants read again) and a new refresh token; the old one is now used |
| same, with a token that was **already used** | **401**, and **every unused link of that family is revoked** (the owner's newest token dies too) |
| same, with an unknown, expired or revoked token | **401** |
| same, for a deactivated user | **401**, and the family is revoked |
| same, blank, missing or over-long `refreshToken` | **400** |
| two requests with the same token at the same moment | exactly one **200**; the others **401**; the family is then revoked |
| `GET /api/v1/auth/refresh` | **403**, as for every other unlisted path |

All the 401 bodies are identical (apart from the correlation id): `urn:appfleet:problem:unauthorized`, detail `Invalid refresh token`. The response says nothing about why a token was refused.

## 3. Decisions

1. **A refresh token is opaque, not a JWT.** 32 random bytes, 43 characters of unpadded base64url. Nobody but identity-service needs to read it, and a random string cannot be forged, so it carries no claims and needs no signature. Rejected: a signed JWT refresh token, which would be readable and would still need a database row to be revocable.
2. **Only its SHA-256 is stored.** `token_hash` holds 64 hex characters; the token is returned once and exists nowhere else. SHA-256 is enough because the token is 256 bits of randomness: there is nothing to guess, so the slow hash that protects human passwords (BCrypt) would only cost time. A leaked table gives no usable token.
3. **One row per link, a family per login.** `refresh_token(id, user_id, family_id, family_started_at, parent_id, token_hash, status, issued_at, expires_at, used_at, revoked_at)`. A login starts a family; each rotation adds a child with `parent_id` set and the same `family_id`. Two logins by one user are two families (two devices do not disturb each other; tested).
4. **Three states, one direction.** `ACTIVE` becomes `USED` when it is rotated, or `REVOKED` when its family is cut. A `USED` link stays `USED` when the family is revoked, so the table keeps the history of which links were consumed. Checks in the database: `USED` if and only if `used_at` is set; `REVOKED` if and only if `revoked_at` is set.
5. **The database refuses a forked family.** A partial unique index, `uq_refresh_token_one_active_per_family` on `(family_id) WHERE status = 'ACTIVE'`, allows at most one live link per family. The code is also written not to fork; the index is the second guard (decision 8, and section 8.3 measures what each guard does alone).
6. **Reuse revokes the family. No grace window.** A refresh token that is presented after it was used means that two parties hold it. Identity cannot tell which one is the owner, so it cuts both off and the user logs in again. The cost is real: a client that retries a refresh after a lost response, or two tabs that refresh at once, will log the user out. A grace period (accept the previous token again for a few seconds and return the same successor) is the usual softening; it is **not** built here, and the choice is open question 1.
7. **A refusal is a return value, not an exception, inside the transaction.** `RefreshTokenService.rotate` returns `Rotated` or `Rejected`. If the reuse path threw, the transaction would roll back and the revocation it had just done would be lost: the thief's replay would answer 401 and change nothing. Mutation (section 8.2) shows exactly that. `AuthService.refresh` returns an empty `Optional`, the transaction commits, and `AuthController` throws the 401 afterwards.
8. **Two requests with one token are serialised by a row lock,** `@Lock(PESSIMISTIC_WRITE)` on the lookup. The second request waits, then sees `USED` and treats it as a reuse. With six parallel requests the result is one 200 and five 401, and the family is revoked (so the winner's new token dies too: strict, as in decision 6). Without the lock, the unique index still prevents two winners, but the losers get a **500** (section 8.2): the lock is what gives clean 401s.
9. **A failure while building the new access token rolls the rotation back.** The access token is issued inside the same transaction, after the rotation. If it fails (for example a user above the team cap, I2 decision 8), the old refresh token is still `ACTIVE` and the client can retry. A refusal commits; a failure rolls back.
10. **Lifetimes: 7 days per token, 30 days for the family.** `appfleet.identity.refresh.token-ttl` and `family-max-lifetime`, checked at startup (the family lifetime cannot be shorter than one token). Each new token expires at `min(now + 7 days, family_started_at + 30 days)`: rotation can keep a session alive, but not for ever; after 30 days the user logs in again.
11. **One answer for every refusal,** as for login failures (I2 decision 6): unknown, reused, expired, revoked and deactivated all give the same body.
12. **Refresh reads the grants again.** The new access token is built from the user's memberships at that moment, so a role granted since the last login appears at the next refresh (tested). The reverse is the stale-permissions problem of I4: a role taken away stays in an already issued access token until it expires.
13. **Login is read-write now.** `AuthService.login` was `readOnly = true`; it creates a family. The transaction (and its connection) is held during the BCrypt check, as before; worth a look in I8 when the hash time at cost 12 is measured.
14. **A reuse is logged at WARN** with the user id, the family id and the number of links revoked, never the token. The login-audit row comes with I5.
15. **No cleanup yet.** The table grows by one row per refresh. A purge of old `USED`, `REVOKED` and expired rows is deferred (I8), the same way control-api deferred the outbox purge; the row count is a number to watch.
16. **The token travels in the JSON body.** Where the web-console stores it (memory, a cookie) is a console decision with an XSS-versus-CSRF trade-off, and is not made here.

## 4. Changes to your existing files

1. **New migration `identity-service/src/main/resources/db/migration/V3__add_refresh_token.sql`** (section 5.1).
2. **`application.yml`**: add under `appfleet.identity`, next to `password`:

```yaml
    refresh:
      token-ttl: 7d
      family-max-lifetime: 30d
```
   (Both have the same defaults in code, so the file only makes them visible.)
3. **Replace these files with the versions in section 5:** `AuthDTOs.java`, `AuthService.java`, `AuthController.java`, `AuthExceptions.java`, `ApiExceptionHandler.java`, `SecurityConfig.java`, `IdentityConfig.java`.
4. **`LoginTest.java`**: replace the line

```java
assertThat(b.has("refreshToken")).as("refresh tokens arrive with I3").isFalse();
```
with

```java
assertThat(b.get("refreshToken").asString()).as("a refresh token since I3").hasSize(43);
```

## 5. Main code

New package `io.appfleet.identity.token`; the other files are changed versions of I2's.

### 5.1 The migration

**`identity-service/src/main/resources/db/migration/V3__add_refresh_token.sql`**

```sql
-- I3: refresh tokens, one row per link of a rotation chain. Only the SHA-256 of a token is stored.
CREATE TABLE refresh_token (
    id                 uuid PRIMARY KEY,
    user_id            uuid NOT NULL REFERENCES app_user(id),
    family_id          uuid NOT NULL,
    family_started_at  timestamptz NOT NULL,
    parent_id          uuid REFERENCES refresh_token(id),
    token_hash         text NOT NULL,
    status             text NOT NULL CHECK (status IN ('ACTIVE', 'USED', 'REVOKED')),
    issued_at          timestamptz NOT NULL,
    expires_at         timestamptz NOT NULL,
    used_at            timestamptz,
    revoked_at         timestamptz,
    CONSTRAINT uq_refresh_token_hash UNIQUE (token_hash),
    CONSTRAINT ck_refresh_token_used CHECK ((status = 'USED') = (used_at IS NOT NULL)),
    CONSTRAINT ck_refresh_token_revoked CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL))
);

-- A family can never fork: at most one link of it is ACTIVE at any time.
CREATE UNIQUE INDEX uq_refresh_token_one_active_per_family ON refresh_token (family_id) WHERE status = 'ACTIVE';
CREATE INDEX idx_refresh_token_user ON refresh_token (user_id);
CREATE INDEX idx_refresh_token_family ON refresh_token (family_id);
```

### 5.2 The tokens

**`identity-service/src/main/java/io/appfleet/identity/token/RefreshStatus.java`**

```java
package io.appfleet.identity.token;

/** ACTIVE can be used once; USED has been rotated into its child; REVOKED was cut off when its family was revoked. */
public enum RefreshStatus {
    ACTIVE,
    USED,
    REVOKED
}
```

**`identity-service/src/main/java/io/appfleet/identity/token/RefreshToken.java`**

```java
package io.appfleet.identity.token;

import io.appfleet.identity.common.Uuidv7;
import io.appfleet.identity.user.AppUser;
import jakarta.persistence.*;

import java.time.Duration;
import java.time.Instant;
import java.time.temporal.ChronoUnit;
import java.util.UUID;

/**
 * One link of a refresh-token family. Only the SHA-256 of the token is stored, never the token. A link is used once:
 * rotating it marks it USED and creates its ACTIVE child in the same family.
 */
@Entity
@Table(name = "refresh_token")
public class RefreshToken {

    @Id
    private UUID id;

    @ManyToOne(fetch = FetchType.LAZY, optional = false)
    @JoinColumn(name = "user_id")
    private AppUser user;

    @Column(name = "family_id", nullable = false)
    private UUID familyId;

    /** When the first link of the family was issued; the family has an absolute lifetime counted from here. */
    @Column(name = "family_started_at", nullable = false)
    private Instant familyStartedAt;

    @Column(name = "parent_id")
    private UUID parentId;

    @Column(name = "token_hash", nullable = false, unique = true)
    private String tokenHash;

    @Enumerated(EnumType.STRING)
    @Column(nullable = false)
    private RefreshStatus status;

    @Column(name = "issued_at", nullable = false)
    private Instant issuedAt;

    @Column(name = "expires_at", nullable = false)
    private Instant expiresAt;

    @Column(name = "used_at")
    private Instant usedAt;

    @Column(name = "revoked_at")
    private Instant revokedAt;

    protected RefreshToken() {}

    private RefreshToken(AppUser user, UUID familyId, Instant familyStartedAt, UUID parentId, String tokenHash,
                         Instant now, Duration ttl, Duration familyMaxLifetime) {
        this.id = Uuidv7.generate();
        this.user = user;
        this.familyId = familyId;
        this.familyStartedAt = familyStartedAt;
        this.parentId = parentId;
        this.tokenHash = tokenHash;
        this.status = RefreshStatus.ACTIVE;
        this.issuedAt = now.truncatedTo(ChronoUnit.MICROS);
        Instant slidingEnd = now.plus(ttl);
        Instant absoluteEnd = familyStartedAt.plus(familyMaxLifetime);
        this.expiresAt = (slidingEnd.isBefore(absoluteEnd) ? slidingEnd : absoluteEnd).truncatedTo(ChronoUnit.MICROS);
    }

    /** The first link of a new family, issued at login. */
    public static RefreshToken startFamily(AppUser user, String tokenHash, Instant now, Duration ttl, Duration familyMaxLifetime) {
        Instant started = now.truncatedTo(ChronoUnit.MICROS);
        return new RefreshToken(user, Uuidv7.generate(), started, null, tokenHash, started, ttl, familyMaxLifetime);
    }

    /** Uses this link up and returns its successor in the same family. */
    public RefreshToken rotate(String childHash, Instant now, Duration ttl, Duration familyMaxLifetime) {
        this.status = RefreshStatus.USED;
        this.usedAt = now.truncatedTo(ChronoUnit.MICROS);
        return new RefreshToken(user, familyId, familyStartedAt, id, childHash, now, ttl, familyMaxLifetime);
    }

    public boolean isExpiredAt(Instant now) { return !expiresAt.isAfter(now); }

    public UUID getId() { return id; }
    public AppUser getUser() { return user; }
    public UUID getFamilyId() { return familyId; }
    public UUID getParentId() { return parentId; }
    public RefreshStatus getStatus() { return status; }
    public Instant getExpiresAt() { return expiresAt; }
}
```

**`identity-service/src/main/java/io/appfleet/identity/token/RefreshTokenRepository.java`**

```java
package io.appfleet.identity.token;

import jakarta.persistence.LockModeType;
import org.springframework.data.jpa.repository.Lock;
import org.springframework.data.jpa.repository.Modifying;
import org.springframework.data.jpa.repository.Query;
import org.springframework.data.repository.Repository;
import org.springframework.data.repository.query.Param;

import java.time.Instant;
import java.util.Optional;
import java.util.UUID;

public interface RefreshTokenRepository extends Repository<RefreshToken, UUID> {

    RefreshToken save(RefreshToken token);

    /** Needed in RefreshTokenService.rotate: Hibernate writes inserts before updates, so the used link must be flushed first. */
    void flush();

    /** Locks the row until the transaction ends, so two requests with the same token are decided one after the other. */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    Optional<RefreshToken> findByTokenHash(String tokenHash);

    /** Cuts off every link of the family that could still be used. USED links stay USED: they keep their history. */
    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Query("update RefreshToken t set t.status = io.appfleet.identity.token.RefreshStatus.REVOKED, t.revokedAt = :now "
            + "where t.familyId = :familyId and t.status = io.appfleet.identity.token.RefreshStatus.ACTIVE")
    int revokeActiveInFamily(@Param("familyId") UUID familyId, @Param("now") Instant now);
}
```

**`identity-service/src/main/java/io/appfleet/identity/token/TokenHasher.java`**

```java
package io.appfleet.identity.token;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.util.Base64;
import java.util.HexFormat;

/**
 * A refresh token is 32 random bytes, so it needs no slow hash: SHA-256 is enough, because there is nothing to guess
 * (BCrypt is for passwords a human chose). The database keeps the hash; a leaked table gives no usable token.
 */
public final class TokenHasher {

    private static final SecureRandom RANDOM = new SecureRandom();

    private TokenHasher() {}

    /** 32 random bytes as 43 characters of unpadded base64url. */
    public static String newToken() {
        byte[] bytes = new byte[32];
        RANDOM.nextBytes(bytes);
        return Base64.getUrlEncoder().withoutPadding().encodeToString(bytes);
    }

    /** 64 lower-case hex characters. */
    public static String hash(String token) {
        try {
            return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(token.getBytes(StandardCharsets.UTF_8)));
        } catch (NoSuchAlgorithmException e) {
            throw new IllegalStateException(e);
        }
    }
}
```

**`identity-service/src/main/java/io/appfleet/identity/token/RefreshTokenService.java`**

```java
package io.appfleet.identity.token;

import io.appfleet.identity.config.RefreshProperties;
import io.appfleet.identity.user.AppUser;
import io.appfleet.identity.user.UserStatus;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Clock;
import java.time.Instant;

@Service
public class RefreshTokenService {

    private static final Logger log = LoggerFactory.getLogger(RefreshTokenService.class);

    /** The result of presenting a refresh token. A rejection is a RETURN VALUE, not an exception (see rotate). */
    public sealed interface Outcome permits Rotated, Rejected {}

    public record Rotated(AppUser user, String refreshToken) implements Outcome {}

    public record Rejected(Reason reason) implements Outcome {}

    public enum Reason { UNKNOWN, EXPIRED, REUSED, REVOKED, USER_INACTIVE }

    private final RefreshTokenRepository tokens;
    private final RefreshProperties properties;
    private final Clock clock;

    public RefreshTokenService(RefreshTokenRepository tokens, RefreshProperties properties, Clock clock) {
        this.tokens = tokens;
        this.properties = properties;
        this.clock = clock;
    }

    /** Login: the first link of a new family. Returns the token itself, which exists in no database. */
    @Transactional
    public String startFamily(AppUser user) {
        String token = TokenHasher.newToken();
        tokens.save(RefreshToken.startFamily(user, TokenHasher.hash(token), clock.instant(),
                properties.tokenTtl(), properties.familyMaxLifetime()));
        return token;
    }

    /**
     * Uses a presented token up and returns its successor. The row is locked first, so two requests with the same
     * token are decided one after the other.
     *
     * A refusal must COMMIT the family revocation it may have done. If this method threw on a reuse, the transaction
     * would roll back and the revocation would be lost, so refusals are returned, and the caller turns them into a 401
     * after the commit.
     */
    @Transactional
    public Outcome rotate(String presented) {
        Instant now = clock.instant();
        RefreshToken current = tokens.findByTokenHash(TokenHasher.hash(presented)).orElse(null);
        if (current == null) return new Rejected(Reason.UNKNOWN);

        switch (current.getStatus()) {
            case USED -> {
                // Someone presents a token that was already rotated: the owner or a thief has an older copy. Cut off the family.
                int cut = tokens.revokeActiveInFamily(current.getFamilyId(), now);
                log.warn("refresh token reuse: user {} family {}; {} active link(s) revoked", current.getUser().getId(), current.getFamilyId(), cut);
                return new Rejected(Reason.REUSED);
            }
            case REVOKED -> {
                return new Rejected(Reason.REVOKED);
            }
            default -> { /* ACTIVE: carry on */ }
        }

        if (current.isExpiredAt(now)) return new Rejected(Reason.EXPIRED);

        AppUser user = current.getUser();
        if (user.getStatus() != UserStatus.ACTIVE) {
            tokens.revokeActiveInFamily(current.getFamilyId(), now);
            return new Rejected(Reason.USER_INACTIVE);
        }

        String next = TokenHasher.newToken();
        RefreshToken child = current.rotate(TokenHasher.hash(next), now, properties.tokenTtl(), properties.familyMaxLifetime());
        tokens.save(current);
        // Hibernate would insert the child before it updates the used link, and the unique index "one ACTIVE link per
        // family" would refuse that moment. Writing the update first keeps the family a chain at every instant.
        tokens.flush();
        tokens.save(child);
        return new Rotated(user, next);
    }
}
```

**`identity-service/src/main/java/io/appfleet/identity/config/RefreshProperties.java`**

```java
package io.appfleet.identity.config;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

import java.time.Duration;

/** One refresh token lives tokenTtl; the whole family of rotated tokens lives at most familyMaxLifetime from the login. */
@ConfigurationProperties("appfleet.identity.refresh")
public record RefreshProperties(
        @DefaultValue("7d") Duration tokenTtl,
        @DefaultValue("30d") Duration familyMaxLifetime
) {
    public RefreshProperties {
        if (tokenTtl == null || tokenTtl.isZero() || tokenTtl.isNegative())
            throw new IllegalArgumentException("appfleet.identity.refresh.token-ttl must be above 0, was " + tokenTtl);
        if (familyMaxLifetime == null || familyMaxLifetime.compareTo(tokenTtl) < 0)
            throw new IllegalArgumentException("appfleet.identity.refresh.family-max-lifetime must be at least token-ttl, was " + familyMaxLifetime);
    }
}
```

### 5.3 The endpoints (changed files)

**`identity-service/src/main/java/io/appfleet/identity/auth/AuthDTOs.java`**

```java
package io.appfleet.identity.auth;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

import java.util.UUID;

/** The request and response bodies of the auth endpoints. Records, never entities. */
public final class AuthDTOs {

    private AuthDTOs() {}

    public record RegisterRequest(
       @NotBlank @Email @Size(max = 254) String email,
       @NotBlank @Size(max = 100) String displayName,
       @NotBlank @Size(min = 12, max = 72) String password) {}

    public record LoginRequest(
            @NotBlank String email,
            @NotBlank String password) {}

    /** A refresh token is 43 characters; the limit only stops absurd bodies. */
    public record RefreshRequest(
            @NotBlank @Size(max = 200) String refreshToken) {}

    public record RegisteredUser(
            UUID id,
            String email,
            String displayName) {}

    public record TokenResponse(String accessToken,
                                String tokenType,
                                long expiresIn,
                                String refreshToken) {}
}
```

**`identity-service/src/main/java/io/appfleet/identity/auth/AuthService.java`**

```java
package io.appfleet.identity.auth;

import io.appfleet.identity.auth.AuthDTOs.LoginRequest;
import io.appfleet.identity.auth.AuthDTOs.RefreshRequest;
import io.appfleet.identity.auth.AuthDTOs.RegisterRequest;
import io.appfleet.identity.auth.AuthDTOs.RegisteredUser;
import io.appfleet.identity.auth.AuthDTOs.TokenResponse;
import io.appfleet.identity.auth.AuthExceptions.EmailAlreadyRegisteredException;
import io.appfleet.identity.auth.AuthExceptions.InvalidCredentialsException;
import io.appfleet.identity.auth.AuthExceptions.PasswordTooLongException;
import io.appfleet.identity.token.RefreshTokenService;
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

@Service
public class AuthService {

    private final UserRepository users;
    private final PasswordEncoder encoder;
    private final AccessTokenIssuer issuer;
    private final RefreshTokenService refreshTokens;

    public AuthService(UserRepository users, PasswordEncoder encoder, AccessTokenIssuer issuer, RefreshTokenService refreshTokens) {
        this.users = users;
        this.encoder = encoder;
        this.issuer = issuer;
        this.refreshTokens = refreshTokens;
    }

    @Transactional
    public RegisteredUser register(RegisterRequest request) {
        if (request.password().getBytes(StandardCharsets.UTF_8).length > 72) throw new PasswordTooLongException();
        String email = AppUser.normalize(request.email());
        if (users.existsByEmail(email))
            throw new EmailAlreadyRegisteredException();
        try {
            AppUser saved = users.save(new AppUser(email, request.displayName().trim(), encoder.encode(request.password())));
            return new RegisteredUser(saved.getId(), saved.getEmail(), saved.getDisplayName());
        } catch (DataIntegrityViolationException e) {
            throw new EmailAlreadyRegisteredException();   // two registrations raced past existsByEmail; the unique index decided
        }
    }

    /** Read-write now: a login starts a refresh-token family. */
    @Transactional
    public TokenResponse login(LoginRequest request) {
        AppUser user = users.findByEmail(AppUser.normalize(request.email())).orElse(null);
        if (user == null || user.getStatus() != UserStatus.ACTIVE || !encoder.matches(request.password(), user.getPasswordHash()))
            throw new InvalidCredentialsException();
        return respond(user, refreshTokens.startFamily(user));
    }

    /**
     * Empty means "refused". It is NOT an exception on purpose: a reuse revokes the family, and an exception would roll
     * that revocation back. The controller turns the empty result into a 401 after this transaction has committed.
     * An exception from the access-token issuer, by contrast, rolls the rotation back, so the client can retry.
     */
    @Transactional
    public Optional<TokenResponse> refresh(RefreshRequest request) {
        return switch (refreshTokens.rotate(request.refreshToken())) {
            case RefreshTokenService.Rotated rotated -> Optional.of(respond(rotated.user(), rotated.refreshToken()));
            case RefreshTokenService.Rejected rejected -> Optional.empty();
        };
    }

    private TokenResponse respond(AppUser user, String refreshToken) {
        AccessTokenIssuer.IssuedToken token = issuer.issue(user);
        return new TokenResponse(token.value(), "Bearer", Duration.between(token.issuedAt(), token.expiresAt()).toSeconds(), refreshToken);
    }
}
```

**`identity-service/src/main/java/io/appfleet/identity/auth/AuthController.java`**

```java
package io.appfleet.identity.auth;

import io.appfleet.identity.auth.AuthDTOs.LoginRequest;
import io.appfleet.identity.auth.AuthDTOs.RefreshRequest;
import io.appfleet.identity.auth.AuthDTOs.RegisterRequest;
import io.appfleet.identity.auth.AuthDTOs.RegisteredUser;
import io.appfleet.identity.auth.AuthDTOs.TokenResponse;
import io.appfleet.identity.auth.AuthExceptions.InvalidRefreshTokenException;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

@RestController
@RequestMapping("/api/v1/auth")
public class AuthController {

    private final AuthService auth;

    public AuthController(AuthService auth) {
        this.auth = auth;
    }

    @PostMapping("/register")
    ResponseEntity<RegisteredUser> register(@Valid @RequestBody RegisterRequest request) {
        return ResponseEntity.status(HttpStatus.CREATED).body(auth.register(request));
    }

    /**
     * A token response must not be cached anywhere (RFC 6749). The Cache-Control and Pragma headers come
     * from Spring Security's default header writers, not from this method; LoginTest pins the result.
     */
    @PostMapping("/login")
    ResponseEntity<TokenResponse> login(@Valid @RequestBody LoginRequest request) {
        return ResponseEntity.ok(auth.login(request));
    }

    /** The refusal is thrown HERE, after AuthService.refresh has committed, so a family revocation survives it. */
    @PostMapping("/refresh")
    ResponseEntity<TokenResponse> refresh(@Valid @RequestBody RefreshRequest request) {
        return ResponseEntity.ok(auth.refresh(request).orElseThrow(InvalidRefreshTokenException::new));
    }
}
```

**`identity-service/src/main/java/io/appfleet/identity/auth/AuthExceptions.java`**

```java
package io.appfleet.identity.auth;

/** The failures of the auth endpoints; web/ApiExceptionHandler turns each into one problem body. */
public final class AuthExceptions {

    private AuthExceptions() {}

    public static class EmailAlreadyRegisteredException extends RuntimeException {
        public EmailAlreadyRegisteredException() { super("email already registered"); }
    }

    /** Unknown email, wrong password and a deactivated user all raise this one exception: one message for all three. */
    public static class InvalidCredentialsException extends RuntimeException {
        public InvalidCredentialsException() { super("invalid credentials"); }
    }

    /** Unknown, expired, revoked and already-used refresh tokens all raise this one exception: one answer for all of them. */
    public static class InvalidRefreshTokenException extends RuntimeException {
        public InvalidRefreshTokenException() { super("invalid refresh token"); }
    }

    /** BCrypt reads only the first 72 bytes, so a longer password is refused instead of silently truncated. */
    public static class PasswordTooLongException extends RuntimeException {
        public PasswordTooLongException() { super("password must be at most 72 bytes in UTF-8"); }
    }
}
```

**`identity-service/src/main/java/io/appfleet/identity/web/ApiExceptionHandler.java`**

```java
package io.appfleet.identity.web;

import io.appfleet.identity.auth.AuthExceptions.EmailAlreadyRegisteredException;
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
        p.setProperty("errors", List.of(Map.of("field", "password", "message", e.getMessage())));
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
```

### 5.4 Chain and configuration (changed files)

**`identity-service/src/main/java/io/appfleet/identity/config/SecurityConfig.java`**

```java
package io.appfleet.identity.config;

import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpMethod;
import org.springframework.security.config.annotation.web.builders.HttpSecurity;
import org.springframework.security.config.annotation.web.configuration.EnableWebSecurity;
import org.springframework.security.config.http.SessionCreationPolicy;
import org.springframework.security.web.SecurityFilterChain;

@Configuration
@EnableWebSecurity
public class SecurityConfig {

    @Bean
    SecurityFilterChain chain(HttpSecurity http) throws Exception {
        http.authorizeHttpRequests(a -> a
                .requestMatchers("/actuator/health", "/actuator/info").permitAll()
                .requestMatchers(HttpMethod.POST, "/api/v1/auth/register", "/api/v1/auth/login", "/api/v1/auth/refresh").permitAll()
                .anyRequest().denyAll())
                .csrf(c -> c.disable())
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS));
        return http.build();
    }
}
```

**`identity-service/src/main/java/io/appfleet/identity/config/IdentityConfig.java`**

```java
package io.appfleet.identity.config;

import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import org.springframework.security.crypto.password.PasswordEncoder;

import java.time.Clock;

@Configuration
@EnableConfigurationProperties({IdentityJwtProperties.class, PasswordProperties.class, RefreshProperties.class})
public class IdentityConfig {

    @Bean
    PasswordEncoder passwordEncoder(PasswordProperties properties) {
        return new BCryptPasswordEncoder(properties.bcryptCost());
    }

    @Bean
    Clock clock() {
        return Clock.systemUTC();
    }
}
```

## 6. Tests

Under `identity-service/src/test/java/io/appfleet/identity/`. 30 new tests: `RefreshTest` 18 (over real HTTP), `RefreshTokenConstraintTest` 7 (plain SQL), `RefreshUnitTest` 5 (no Spring). With the I2 change to `LoginTest`, the suite is **88**.

**`identity-service/src/test/java/io/appfleet/identity/RefreshTest.java`**

```java
package io.appfleet.identity;

import io.appfleet.identity.rbac.RoleRepository;
import io.appfleet.identity.team.Team;
import io.appfleet.identity.team.TeamMembership;
import io.appfleet.identity.team.TeamMembershipRepository;
import io.appfleet.identity.team.TeamRepository;
import io.appfleet.identity.token.TokenHasher;
import io.appfleet.identity.user.AppUser;
import io.appfleet.identity.user.UserRepository;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import tools.jackson.databind.JsonNode;

import java.net.http.HttpResponse;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.Future;

import static org.assertj.core.api.Assertions.assertThat;

class RefreshTest extends AuthHttpTest {

    @Autowired JwtDecoder decoder;
    @Autowired UserRepository users;
    @Autowired TeamRepository teams;
    @Autowired TeamMembershipRepository memberships;
    @Autowired RoleRepository roles;

    private JsonNode registerAndLogin(String email) throws Exception {
        register(email, PASSWORD);
        return body(login(email, PASSWORD));
    }

    private String refreshTokenOf(String email) throws Exception {
        return registerAndLogin(email).get("refreshToken").asString();
    }

    private HttpResponse<String> refresh(String token) throws Exception {
        return post("/api/v1/auth/refresh", Map.of("refreshToken", token));
    }

    private Map<String, Object> row(String token) {
        return jdbc.queryForMap("select * from refresh_token where token_hash = ?", TokenHasher.hash(token));
    }

    private UUID familyOf(String token) {
        return (UUID) row(token).get("family_id");
    }

    private int activeInFamily(UUID family) {
        return jdbc.queryForObject("select count(*) from refresh_token where family_id = ? and status = 'ACTIVE'", Integer.class, family);
    }

    private Map<String, Object> withoutPerRequestFields(HttpResponse<String> r) {
        Map<String, Object> m = new LinkedHashMap<>(json.convertValue(body(r), Map.class));
        m.remove("correlationId");
        return m;
    }

    // ---- login --------------------------------------------------------------------------------------------------

    @Test
    void login_returnsARefreshToken_storedOnlyAsItsSha256() throws Exception {
        String token = refreshTokenOf(uniqueEmail());
        assertThat(token).hasSize(43).matches("[A-Za-z0-9_-]+");
        Map<String, Object> row = row(token);
        assertThat(row.get("token_hash")).isEqualTo(TokenHasher.hash(token)).isNotEqualTo(token);
        assertThat((String) row.get("token_hash")).hasSize(64);
        assertThat(row.get("status")).isEqualTo("ACTIVE");
        assertThat(row.get("parent_id")).isNull();
        assertThat(jdbc.queryForObject("select count(*) from refresh_token where token_hash = ?", Integer.class, token))
                .as("the token itself is nowhere in the table").isZero();
    }

    @Test
    void twoLogins_startTwoFamilies() throws Exception {
        String email = uniqueEmail();
        register(email, PASSWORD);
        String a = body(login(email, PASSWORD)).get("refreshToken").asString();
        String b = body(login(email, PASSWORD)).get("refreshToken").asString();
        assertThat(familyOf(a)).isNotEqualTo(familyOf(b));
    }

    // ---- rotation -----------------------------------------------------------------------------------------------

    @Test
    void refresh_rotates_theOldLinkIsUsed_theNewOneIsItsActiveChild() throws Exception {
        String first = refreshTokenOf(uniqueEmail());
        HttpResponse<String> r = refresh(first);
        assertThat(r.statusCode()).isEqualTo(200);
        assertThat(r.headers().firstValue("Cache-Control").orElse("")).contains("no-store");
        JsonNode b = body(r);
        String second = b.get("refreshToken").asString();
        assertThat(second).hasSize(43).isNotEqualTo(first);
        assertThat(b.get("tokenType").asString()).isEqualTo("Bearer");
        assertThat(b.get("expiresIn").asLong()).isEqualTo(900);

        Map<String, Object> old = row(first);
        Map<String, Object> child = row(second);
        assertThat(old.get("status")).isEqualTo("USED");
        assertThat(old.get("used_at")).isNotNull();
        assertThat(child.get("status")).isEqualTo("ACTIVE");
        assertThat(child.get("family_id")).isEqualTo(old.get("family_id"));
        assertThat(child.get("parent_id")).isEqualTo(old.get("id"));
        assertThat(activeInFamily(familyOf(first))).isEqualTo(1);
    }

    @Test
    void refresh_givesANewAccessTokenWithItsOwnJti() throws Exception {
        String email = uniqueEmail();
        JsonNode first = registerAndLogin(email);
        JsonNode second = body(refresh(first.get("refreshToken").asString()));
        Jwt a = decoder.decode(first.get("accessToken").asString());
        Jwt b = decoder.decode(second.get("accessToken").asString());
        assertThat(b.getSubject()).isEqualTo(a.getSubject());
        assertThat(b.getId()).isNotEqualTo(a.getId());
    }

    @Test
    void refresh_readsTheGrantsAgain_soARoleGrantedSinceLoginShowsUp() throws Exception {
        String email = uniqueEmail();
        String refreshToken = refreshTokenOf(email);
        Team team = teams.save(new Team("r-" + UUID.randomUUID()));
        AppUser user = users.findByEmail(email).orElseThrow();
        memberships.save(new TeamMembership(user, team, roles.findByName("DEPLOYER").orElseThrow()));

        Jwt refreshed = decoder.decode(body(refresh(refreshToken)).get("accessToken").asString());
        Map<String, List<String>> claim = refreshed.getClaim("teams");
        assertThat(claim).containsOnlyKeys(team.getId().toString());
        assertThat(claim.get(team.getId().toString())).contains("deployment:create");
    }

    @Test
    void aChainOfRotations_staysOneFamilyWithOneActiveLink() throws Exception {
        String t1 = refreshTokenOf(uniqueEmail());
        String t2 = body(refresh(t1)).get("refreshToken").asString();
        String t3 = body(refresh(t2)).get("refreshToken").asString();
        assertThat(familyOf(t3)).isEqualTo(familyOf(t1));
        assertThat(activeInFamily(familyOf(t1))).isEqualTo(1);
        assertThat(row(t3).get("parent_id")).isEqualTo(row(t2).get("id"));
    }

    // ---- theft detection ----------------------------------------------------------------------------------------

    /** The theft-detection test. Against a refresh that does not consume the token, the second call returns 200. */
    @Test
    void replayOfAUsedToken_is401_andRevokesTheWholeFamily() throws Exception {
        String first = refreshTokenOf(uniqueEmail());
        String second = body(refresh(first)).get("refreshToken").asString();

        HttpResponse<String> replay = refresh(first);
        assertThat(replay.statusCode()).isEqualTo(401);

        assertThat(activeInFamily(familyOf(first))).as("no link of the family may stay usable").isZero();
        assertThat(row(second).get("status")).isEqualTo("REVOKED");
        assertThat(row(second).get("revoked_at")).isNotNull();
        assertThat(refresh(second).statusCode()).as("the thief's and the owner's newest token are both dead").isEqualTo(401);
    }

    @Test
    void replayOfAnOlderLink_revokesTheFamilyThroughTheLatestOne() throws Exception {
        String t1 = refreshTokenOf(uniqueEmail());
        String t2 = body(refresh(t1)).get("refreshToken").asString();
        String t3 = body(refresh(t2)).get("refreshToken").asString();

        assertThat(refresh(t1).statusCode()).isEqualTo(401);
        assertThat(row(t3).get("status")).isEqualTo("REVOKED");
        assertThat(row(t1).get("status")).as("consumed links keep their history").isEqualTo("USED");
        assertThat(row(t2).get("status")).isEqualTo("USED");
    }

    @Test
    void aReplayInOneFamily_doesNotTouchAnotherFamilyOfTheSameUser() throws Exception {
        String email = uniqueEmail();
        register(email, PASSWORD);
        String deviceA = body(login(email, PASSWORD)).get("refreshToken").asString();
        String deviceB = body(login(email, PASSWORD)).get("refreshToken").asString();
        refresh(deviceA);
        assertThat(refresh(deviceA).statusCode()).isEqualTo(401);
        assertThat(refresh(deviceB).statusCode()).as("device B is a different family").isEqualTo(200);
    }

    @Test
    void presentingAnAlreadyRevokedToken_isRefused() throws Exception {
        String first = refreshTokenOf(uniqueEmail());
        String second = body(refresh(first)).get("refreshToken").asString();
        refresh(first);                                           // reuse: the family is revoked
        assertThat(refresh(second).statusCode()).isEqualTo(401);  // REVOKED
        assertThat(row(second).get("status")).isEqualTo("REVOKED");
    }

    // ---- other refusals -----------------------------------------------------------------------------------------

    @Test
    void unknownReplayedExpiredAndRevokedTokens_areOneIndistinguishableAnswer() throws Exception {
        String used = refreshTokenOf(uniqueEmail());
        String live = body(refresh(used)).get("refreshToken").asString();
        String expired = refreshTokenOf(uniqueEmail());
        jdbc.update("update refresh_token set expires_at = now() - interval '1 minute' where token_hash = ?", TokenHasher.hash(expired));

        Map<String, Object> unknown = withoutPerRequestFields(refresh(TokenHasher.newToken()));
        Map<String, Object> replayed = withoutPerRequestFields(refresh(used));      // also revokes the family
        Map<String, Object> revoked = withoutPerRequestFields(refresh(live));
        Map<String, Object> expiredBody = withoutPerRequestFields(refresh(expired));

        assertThat(unknown).containsEntry("status", 401).containsEntry("type", "urn:appfleet:problem:unauthorized");
        assertThat(replayed).isEqualTo(unknown);
        assertThat(revoked).isEqualTo(unknown);
        assertThat(expiredBody).isEqualTo(unknown);
    }

    @Test
    void anExpiredToken_isRefused_andIsNotConsumed() throws Exception {
        String token = refreshTokenOf(uniqueEmail());
        jdbc.update("update refresh_token set expires_at = now() - interval '1 minute' where token_hash = ?", TokenHasher.hash(token));
        assertThat(refresh(token).statusCode()).isEqualTo(401);
        assertThat(row(token).get("status")).isEqualTo("ACTIVE");
    }

    @Test
    void aDeactivatedUser_cannotRefresh_andTheFamilyIsRevoked() throws Exception {
        String email = uniqueEmail();
        String token = refreshTokenOf(email);
        jdbc.update("update app_user set status = 'DEACTIVATED', deactivated_at = now() where email = ?", email);
        assertThat(refresh(token).statusCode()).isEqualTo(401);
        assertThat(activeInFamily(familyOf(token))).isZero();
        assertThat(row(token).get("status")).isEqualTo("REVOKED");
    }

    @Test
    void theFamilyHasAnAbsoluteLifetime_thatRotationCannotExtend() throws Exception {
        String token = refreshTokenOf(uniqueEmail());
        UUID family = familyOf(token);
        jdbc.update("update refresh_token set family_started_at = now() - interval '29 days' where family_id = ?", family);

        String child = body(refresh(token)).get("refreshToken").asString();
        // 30 days from the start of the family, so about 1 day from now, and not the 7 days a fresh token would get
        Double hoursLeft = jdbc.queryForObject("select extract(epoch from (expires_at - now())) / 3600 from refresh_token where token_hash = ?",
                Double.class, TokenHasher.hash(child));
        assertThat(hoursLeft).isBetween(22.0, 25.0);
    }

    @Test
    void aFreshFamily_getsTheNormalSevenDays() throws Exception {
        String token = refreshTokenOf(uniqueEmail());
        Double daysLeft = jdbc.queryForObject("select extract(epoch from (expires_at - now())) / 86400 from refresh_token where token_hash = ?",
                Double.class, TokenHasher.hash(token));
        assertThat(daysLeft).isBetween(6.9, 7.1);
    }

    // ---- concurrency --------------------------------------------------------------------------------------------

    /** Two requests with one token are decided one after the other (the row lock): exactly one wins, and the family dies. */
    @Test
    void theSameTokenUsedAtTheSameTime_hasExactlyOneWinner() throws Exception {
        String token = refreshTokenOf(uniqueEmail());
        int threads = 6;
        ExecutorService pool = Executors.newFixedThreadPool(threads);
        CountDownLatch go = new CountDownLatch(1);
        List<Future<Integer>> results = new ArrayList<>();
        for (int i = 0; i < threads; i++) {
            results.add(pool.submit(() -> {
                go.await();
                return refresh(token).statusCode();
            }));
        }
        go.countDown();
        List<Integer> statuses = new ArrayList<>();
        for (Future<Integer> f : results) statuses.add(f.get());
        pool.shutdown();

        assertThat(statuses.stream().filter(s -> s == 200).count()).as("winners: " + statuses).isEqualTo(1);
        assertThat(statuses.stream().filter(s -> s == 401).count()).as("losers: " + statuses).isEqualTo(threads - 1);
        assertThat(activeInFamily(familyOf(token))).as("the losers saw a used token and revoked the family").isZero();
    }

    // ---- validation ---------------------------------------------------------------------------------------------

    @Test
    void aBlankMissingOrHugeToken_is400() throws Exception {
        assertThat(refresh("").statusCode()).isEqualTo(400);
        assertThat(post("/api/v1/auth/refresh", Map.of()).statusCode()).isEqualTo(400);
        assertThat(refresh("x".repeat(201)).statusCode()).isEqualTo(400);
    }

    @Test
    void get_onRefresh_isRefused() throws Exception {
        assertThat(get("/api/v1/auth/refresh").statusCode()).isEqualTo(403);
    }
}
```

**`../../../identity-service/src/test/java/io/appfleet/identity/RefreshTokenConstraintTest`**

```java
package io.appfleet.identity;

import org.junit.jupiter.api.Test;
import org.springframework.dao.DataIntegrityViolationException;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** The refresh-token rules that live in the database: plain SQL, no entities. */
class RefreshTokenConstraintTest extends IdentityIntegrationTest {

    private UUID user() {
        UUID id = UUID.randomUUID();
        jdbc.update("insert into app_user (id, email, display_name, password_hash, status, created_at) values (?, ?, 'n', 'h', 'ACTIVE', now())",
                id, "rt-" + UUID.randomUUID() + "@x.io");
        return id;
    }

    private void insert(UUID user, UUID family, String hash, String status, boolean used, boolean revoked) {
        jdbc.update("""
                insert into refresh_token (id, user_id, family_id, family_started_at, token_hash, status, issued_at, expires_at, used_at, revoked_at)
                values (?, ?, ?, now(), ?, ?, now(), now() + interval '7 days',
                        case when ? then now() end, case when ? then now() end)
                """, UUID.randomUUID(), user, family, hash, status, used, revoked);
    }

    @Test
    void aFamily_cannotHaveTwoActiveLinks() {
        UUID user = user(), family = UUID.randomUUID();
        insert(user, family, "h-" + UUID.randomUUID(), "ACTIVE", false, false);
        assertThatThrownBy(() -> insert(user, family, "h-" + UUID.randomUUID(), "ACTIVE", false, false))
                .isInstanceOf(DataIntegrityViolationException.class).hasMessageContaining("uq_refresh_token_one_active_per_family");
    }

    @Test
    void aFamily_mayHaveManyUsedLinksAndOneActive() {
        UUID user = user(), family = UUID.randomUUID();
        insert(user, family, "h-" + UUID.randomUUID(), "USED", true, false);
        insert(user, family, "h-" + UUID.randomUUID(), "USED", true, false);
        insert(user, family, "h-" + UUID.randomUUID(), "ACTIVE", false, false);
        assertThat(jdbc.queryForObject("select count(*) from refresh_token where family_id = ?", Integer.class, family)).isEqualTo(3);
    }

    @Test
    void theSameTokenHash_isRefused() {
        UUID user = user();
        String hash = "h-" + UUID.randomUUID();
        insert(user, UUID.randomUUID(), hash, "ACTIVE", false, false);
        assertThatThrownBy(() -> insert(user, UUID.randomUUID(), hash, "ACTIVE", false, false))
                .isInstanceOf(DataIntegrityViolationException.class).hasMessageContaining("uq_refresh_token_hash");
    }

    @Test
    void usedWithoutATimestamp_isRefused() {
        assertThatThrownBy(() -> insert(user(), UUID.randomUUID(), "h-" + UUID.randomUUID(), "USED", false, false))
                .isInstanceOf(DataIntegrityViolationException.class).hasMessageContaining("ck_refresh_token_used");
    }

    @Test
    void revokedWithoutATimestamp_isRefused() {
        assertThatThrownBy(() -> insert(user(), UUID.randomUUID(), "h-" + UUID.randomUUID(), "REVOKED", false, false))
                .isInstanceOf(DataIntegrityViolationException.class).hasMessageContaining("ck_refresh_token_revoked");
    }

    @Test
    void anUnknownStatus_isRefused() {
        assertThatThrownBy(() -> insert(user(), UUID.randomUUID(), "h-" + UUID.randomUUID(), "SPENT", false, false))
                .isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void aTokenForAnUnknownUser_isRefused() {
        assertThatThrownBy(() -> insert(UUID.randomUUID(), UUID.randomUUID(), "h-" + UUID.randomUUID(), "ACTIVE", false, false))
                .isInstanceOf(DataIntegrityViolationException.class);
    }
}
```

**`identity-service/src/test/java/io/appfleet/identity/RefreshUnitTest.java`**

```java
package io.appfleet.identity;

import io.appfleet.identity.config.RefreshProperties;
import io.appfleet.identity.token.TokenHasher;
import org.junit.jupiter.api.Test;

import java.time.Duration;
import java.util.HashSet;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** No Spring context and no database. */
class RefreshUnitTest {

    @Test
    void newToken_is43UrlSafeCharacters_andDoesNotRepeat() {
        Set<String> seen = new HashSet<>();
        for (int i = 0; i < 1000; i++) {
            String t = TokenHasher.newToken();
            assertThat(t).hasSize(43).matches("[A-Za-z0-9_-]+");
            assertThat(seen.add(t)).as("repeat at " + i).isTrue();
        }
    }

    @Test
    void hash_is64LowerCaseHex_stable_andDiffersPerToken() {
        assertThat(TokenHasher.hash("abc")).isEqualTo("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");   // SHA-256 of "abc"
        assertThat(TokenHasher.hash("abc")).isEqualTo(TokenHasher.hash("abc"));
        assertThat(TokenHasher.hash("abc")).isNotEqualTo(TokenHasher.hash("abd"));
    }

    @Test
    void defaults_areSevenDaysAndThirty() {
        RefreshProperties p = new RefreshProperties(Duration.ofDays(7), Duration.ofDays(30));
        assertThat(p.tokenTtl()).isEqualTo(Duration.ofDays(7));
        assertThat(p.familyMaxLifetime()).isEqualTo(Duration.ofDays(30));
    }

    @Test
    void aTtlOfZeroOrLess_isRefused() {
        assertThatThrownBy(() -> new RefreshProperties(Duration.ZERO, Duration.ofDays(30))).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> new RefreshProperties(Duration.ofSeconds(-1), Duration.ofDays(30))).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void aFamilyLifetimeShorterThanOneToken_isRefused() {
        assertThatThrownBy(() -> new RefreshProperties(Duration.ofDays(7), Duration.ofDays(3)))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("at least token-ttl");
    }
}
```

## 7. Order of work

The spec asks for the bug first: **build refresh replay, see it work, then fix it.**

1. `application.yml`, the `LoginTest` line, and the migration (section 4).
2. Write the three test classes (section 6). They do not compile until the `token` package exists.
3. **Build the broken version first.** Write `TokenHasher`, `RefreshToken`, the repository and the service so that `rotate` creates the child **without marking the old link used** (leave out the two lines `this.status = USED` and `this.usedAt = ...` in `RefreshToken.rotate`) and with the unique index commented out of the migration. Run `RefreshTest`: `replayOfAUsedToken_is401_andRevokesTheWholeFamily` is **red**, because the second call with the same token answers 200. That is the bug the spec names. (With the index left in, the broken version fails more loudly: every refresh answers 500, because the child cannot be inserted next to a still-active parent. Section 8.2 shows both.)
4. **Fix it:** restore the two lines and the index, add the reuse handling and the family revocation as in section 5. Run the full suite. Expected: **88 tests, 0 failures.**
5. Mutation checks (section 8.2) on a scratch copy. Back up **all** files you will mutate once, before the first edit, and compare every restore with its backup. After a change to a migration, run `clean`.
6. By hand against the running app: login, refresh twice with the same token, and watch the second answer 401 and the WARN line.
7. Results; the plan's I3 row; a concepts-guide lesson; the Outline pages.

## 8. Verification, 2026-10-06 (scratch copy of your I2 tree)

### 8.1 Results

88 tests, 0 failures: 58 of I2 plus 30 new. The first run, with the service written the natural way, had **every refresh answering 500**, and the cause is worth keeping.

### 8.2 Findings and mutation checks

**The database caught my bug.** `rotate` saved the used parent and then the new child, but Hibernate writes inserts before updates, so the child was inserted while the parent was still `ACTIVE`. The unique index `uq_refresh_token_one_active_per_family` refused it (`duplicate key value violates unique constraint`), and every refresh answered 500. The fix is one `flush()` between the two saves (`RefreshTokenRepository.flush`). Without the index this ordering would have passed silently on a single request, and the family would have briefly had two live links. Mutation B8 removes the flush again and is red.

| Mutation | Result |
|---|---|
| B1a: rotation does not mark the old link `USED`, index still in the schema | rotation fails: `refresh_rotates_...` fails and `replayOfAUsedToken_...` errors (the 500 has no token in its body). The index turns "forgot to consume" into a loud failure |
| B1b: the same, and the index removed (the spec's broken version) | `replayOfAUsedToken_...` fails at the replay (200 instead of 401) and `aChainOfRotations_...` fails: the replay works twice, the family forks |
| B2: a refusal throws inside the transaction | `replayOfAUsedToken_...` fails with `no link of the family may stay usable`, and `replayOfAnOlderLink_...` fails: the revocation rolled back |
| B3: no row lock on the lookup | `theSameTokenUsedAtTheSameTime_...` fails: **one 200 and five 500s** (`[500, 500, 500, 200, 500, 500]`). The unique index still stops a double win, but the losers get a 500, not a 401 |
| B4: rotation ignores the family's absolute lifetime | `theFamilyHasAnAbsoluteLifetime_...` fails |
| B5: the token is stored, not its hash | `login_returnsARefreshToken_storedOnlyAsItsSha256` errors: no row for the hash |
| B6: a deactivated user is refused but the family is left alive | `aDeactivatedUser_...` fails |
| B7: reuse is refused but revokes nothing | 3 of 3 fail: `replayOfAUsedToken_...`, `replayOfAnOlderLink_...`, `presentingAnAlreadyRevokedToken_...` |
| B8: no flush between the update and the insert | `refresh_rotates_...` fails |

After restoring every file and checking each against its backup: 88 tests, 0 failures.

### 8.3 Two guards, measured separately

The lock and the unique index protect the same thing, and the mutations show what each does alone:

| | Replay of a consumed token | Concurrent use of one token |
|---|---|---|
| Both guards | 401, family revoked | one 200, the rest 401, family revoked |
| Index only (B3, no lock) | 401 (state check) | one 200, the rest **500** |

The lock gives clean refusals; the index gives safety when the code is wrong. Neither replaces the state check that treats a `USED` token as theft. A run with the lock and **without** the index, everything else correct, was not isolated: B1b removes the index **and** the consumption, so it shows the whole broken version, not the lock alone.

## 9. What this step deliberately does not do

- No logout and no revocation of access tokens (I4). A revoked family stops refreshing; the access token already issued lives until it expires.
- No grace window for a retried refresh (open question 1).
- No login audit row for a reuse (I5); only the WARN log.
- No cleanup of old rows (I8).
- No admin "revoke this user's sessions" and no revocation on role change (I6).
- No cookie handling and no storage advice for clients.

## 10. Open questions (yours to decide)

1. **Grace window for a retried refresh.** Built: strict, no window (decision 6). Alternative: for a few seconds after a rotation, accept the used token again and return the successor that was already issued. It prevents spurious logouts from retries and double submits, and it costs a small window in which a stolen copy also works, plus the successor has to be findable (it is: `parent_id`). Recommendation: keep strict until the web-console exists and a real double-submit shows up; the spec asks for the strict behaviour and a test of exactly that.
2. **Cleanup of used and revoked rows.** Recommendation: a scheduled purge in I8, with a retention of 30 days (the family lifetime), as control-api does for the outbox.
3. **Keep revoked families' `USED` links forever?** Recommendation: yes until the purge, because they are the evidence of a theft signal.

## Definition of done

- [x] `V3` migration, `application.yml` and the `LoginTest` line changed
- [x] The three test classes written first
- [x] The broken version built first and seen red on the replay test (step 3 of section 7), then fixed
- [x] The `token` package, the changed auth files, the chain and the configuration in place
- [x] 88 tests green with `mvn -f identity-service\pom.xml test`
- [x] The refresh token stored only as its SHA-256 (test)
- [x] A reused refresh token answers 401 and revokes the whole family, including the newest link (tests)
- [x] Two simultaneous requests with one token: exactly one winner (test)
- [x] The family has an absolute lifetime that rotation cannot extend (test)
- [x] The database refuses a family with two active links (test)
- [x] The nine mutation checks (B1a to B8, section 8.2) seen red on a scratch copy and restored
- [x] By hand: login, refresh, replay the old token, see 401 and the WARN line
- [x] Results written; the plan's I3 row and Outline updated
- [x] Concepts-guide lesson for I3: `sec-refresh-rotation` (an interactive family with an owner and a thief, and the reuse-detection switch), 2026-10-06; opened in headless Chrome and driven with real clicks (replay with detection on: 401 and 0 live links; off: 200 and 2 live links)

## 11. Results (built by hand, 2026-10-06)

- Real tree: `mvn -f identity-service\pom.xml test -DargLine="-Duser.timezone=UTC"`: **88 tests, 0 failures** (`RefreshTest` 18, `RefreshTokenConstraintTest` 7, `RefreshUnitTest` 5, plus the 58 of I2).
- **The nine mutation checks (section 8.2) were repeated on a copy of your real tree on 2026-10-07: all nine red, as on the scratch copy.** B1a: `refresh_rotates_...` fails and two tests error; B1b (index removed too): the replay answers 200, 3 of 3 red; B2: `no link of the family may stay usable`, 2 of 2 red; B3 (no lock): `[500, 200, 500, 500, 500, 500]`, one winner and five 500s; B4, B5, B6, B7 and B8 each red; after restoring every file (compared with its backup) the I3 classes passed again (30 tests). The order of events in section 7 (broken version first) was not recorded separately on the real tree.
- Two errors on the way, both from skipping a line of the doc, both caught by the tests at once:
  1. `No default constructor for entity 'io.appfleet.identity.token.RefreshToken'`: the `protected RefreshToken() {}` was missing, so every login failed (login creates a family) and every other test failed through it.
  2. After that, 13 of the 18 `RefreshTest` tests failed with `expected 1, actual 0` when reading the refresh-token row, and every refresh answered 401: `AuthService.login` was still `@Transactional(readOnly = true)` from I2 (decision 13). In a read-only transaction Hibernate does not flush, so the insert never happened; login still answered 200 with a token that had no row. This is the same symptom my mutation B5 produced (a token that cannot be found by its hash) from a different cause.
- **By hand, on the dev stack** (Postgres and Redis from compose; identity-service from its jar, profile `local`; all stopped afterwards):
  1. `POST /login`: 200, `refreshToken` of 43 characters, `expiresIn` 900.
  2. `POST /refresh` with that token: 200, and a **different** refresh token.
  3. `POST /refresh` with the **first** token again (the replay): **401**, body `{type: urn:appfleet:problem:unauthorized, detail: Invalid refresh token, ...}`.
  4. `POST /refresh` with the **second** token, the owner's newest: **401**. The replay killed it too.
  5. In the table, for that user: one link `USED` and one `REVOKED`.
  6. The log: `refresh token reuse: user <id> family <id>; 1 active link(s) revoked`, with no token in it.
  7. Rows left in the dev database: a few users named `i3-...` and their refresh tokens.
- The concepts-guide lesson `sec-refresh-rotation` was added the same day and tested by clicking its buttons in headless Chrome.
