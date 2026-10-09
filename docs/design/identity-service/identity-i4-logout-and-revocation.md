# identity-service — I4: logout and revocation

**Spec:** [02-IDENTITY-SERVICE.md](../../specs/project/02-IDENTITY-SERVICE.md), *Token design* (revocation: a Redis denylist by `jti`, "then argue the other side") and the deliberate bug *Stale permissions in a live JWT* · Step **I4** of [identity-service-plan.md](identity-service-plan.md) · Predecessor: [identity-i3-refresh-rotation.md](identity-i3-refresh-rotation.md) (the refresh families this step ends) · Companion: [control-api-s4-1-jwt-validation.md](../control-api/control-api-s4-1-jwt-validation.md) (the decoder this step extends). **Status: built and closed 2026-10-07. The code in sections 5 and 6 was run on a scratch copy first (section 8), then typed into the real tree by hand: `common-security` 56 tests and identity-service 114, all green, and a real logout checked against the real control-api from the real build (section 12).**

An access token is valid until it expires, and nothing in it can be taken back: a verifier checks a signature and a date, and asks nobody. This step adds the two ways of taking a token back that the spec asks for, and measures what each costs. **Logout** ends a session: its refresh family is revoked and the access tokens it still has in the air go on a Redis denylist by `jti`, which any service can opt in to check. **Revoking a user's sessions** is the same operation for every session of one user, and it is the answer to the spec's bug: *a role is taken away and the old token still works until it expires.*

## 1. What already exists

- I3 is in your tree: login returns a refresh token, `POST /refresh` rotates it, a reused token revokes the family. 88 tests. `AuthService.login` is read-write.
- `common-security` has the decoder with its validators (`exp`, `iss`, `aud`, `sub`) and **no** way to refuse a token that is otherwise valid. `Redis` is not a dependency of `common-security`.
- `refresh_token` knows nothing about access tokens, so a logout has no way to find the access tokens a session issued. That is the one schema change of this step.
- **Your `common-security/pom.xml` does not build.** Its uncommitted version has two extra `test` dependencies at the end: `spring-boot-starter-validation` (already a compile dependency above it) and **`io.appfleet:common-security` itself with `<type>test-jar`**. Maven refuses a module that depends on itself: `'dependencies.dependency.[io.appfleet:common-security:0.1.0-SNAPSHOT]' for io.appfleet:common-security:0.1.0-SNAPSHOT is referencing itself`. Nothing in the module needs it (the test helpers are in its own `src/test`, and the `maven-jar-plugin` block already publishes them as the test-jar). Probably an IDE quick fix. **Remove both** (section 4). Until you do, `mvn -f common-security\pom.xml install` fails, and so does anything that needs a fresh `common-security` in `~/.m2`.
- The by-hand checks of S4.6 and I2 used the jar that was installed before that edit, which is why they ran.

## 2. Behaviour

| Request | Answer |
|---|---|
| `POST /api/v1/auth/logout` `{refreshToken}` with any refresh token of a session (new or already used) | **204**, no body. The session's refresh family is revoked and every access token it issued that could still be accepted goes on the denylist |
| same, with an unknown token | **204**, nothing changes (no oracle for which tokens exist) |
| same, blank, missing or over-long | **400** |
| same, when Redis cannot be written | **500**, and the refresh side is **not** changed (one transaction); the logout can be retried |
| a service that set `appfleet.security.jwt.denylist.enabled=true`, with a denylisted token | **401**, `WWW-Authenticate: Bearer error="invalid_token"`, the normal problem body |
| the same service, a token without a `jti` | **401** (with the denylist on, every accepted token must be revocable) |
| the same service, Redis unreachable | **401** by default (`fail-open: false`); with `fail-open: true` the token is accepted and a WARN is logged |
| a service without the property (control-api today) | unchanged: a logged-out access token works until it expires |

## 3. Decisions

1. **The denylist is optional and off by default** (plan question 2, decided). `common-security` gets a `JwtDenylistValidator`; it is added to the decoder only when `appfleet.security.jwt.denylist.enabled=true`. A service that does not switch it on pays nothing and does not need Redis (the Redis starter is an `optional` dependency of `common-security`, and the Redis classes are loaded only when the property is set). control-api stays off by default.
2. **The key format exists once.** `RedisJwtDenylist` (in `common-security`) both writes (`revoke`) and reads (`isRevoked`) the key `appfleet:jwt:denylist:<jti>`. identity-service writes through the same class that the validators read through, so the writer and the readers cannot disagree about the format.
3. **A key lives until the token could no longer be accepted: `exp` plus the clock skew.** The decoder accepts a token up to 60 seconds after its `exp` (`JwtTimestampValidator`'s skew), so a key that ended at `exp` would let a revoked token through for that last minute. The skew in the writer is read from the very property the validators use, `appfleet.security.jwt.clock-skew` (60 seconds), so there is one number. A token already past `exp` plus skew gets no key. Mutation M6 removes the skew and is red in both modules.
4. **Logout takes the refresh token, not the access token.** The caller does not need a valid access token to log out (it may have expired), and identity-service does not yet authenticate its own endpoints (that is I6). To find the access tokens of a session, **each refresh link now remembers the access token issued with it**: `access_jti` and `access_expires_at` (migration `V4`). Logout then denylists every link of the family whose access token could still be accepted: one per rotation within the last 15 minutes, usually one.
5. **Any refresh token of a session ends the whole family.** A token that was already used is not treated as theft here: someone who can present it holds a token of the session and asks to end it. It still ends the family.
6. **Unknown token: 204.** The same rule as every refusal in identity: an answer that says which tokens exist is a gift to a thief.
7. **Database first, Redis last, one transaction.** `SessionRevocationService` revokes the links, collects the access tokens, and writes Redis, all inside one `@Transactional` method. If Redis fails, the exception rolls the revocation back, the client gets a 500 and can retry, and nothing is left half done (`LogoutRedisFailureTest`; mutation M4 swallows the exception and is red). If the commit fails after Redis was written, a token is refused that did not need to be: the safe direction.
8. **Fail closed by default.** If the denylist cannot be read, the validator refuses the token (`fail-open: false`). Accepting a token that may have been revoked is the failure the denylist exists to prevent. A service that prefers availability sets `fail-open: true`; the choice is visible in its configuration. The consequence is stated in section 10: a service with the denylist on cannot authorize while Redis is down.
9. **`revokeAllSessions(userId)` is built now and called later.** It revokes every active refresh link of the user and denylists every access token of the user that could still be accepted. I4 proves it with a test that takes a role away and shows the stale token refused afterwards; the admin API that calls it on a role change and on deactivation is I6.
10. **The bug stays on record.** `staleToken_keepsItsPermissions_afterTheRoleIsTakenAway` passes: the role is gone from the database and the token still carries `deployment:create`. It documents the behaviour that exists without revocation, and `theWindowWithoutRevocation_isTheAccessTokenLifetime` measures the window (15 minutes).

## 4. Changes to your existing files

1. **`common-security/pom.xml`**: remove the two `test` dependencies described in section 1 (the second `spring-boot-starter-validation` and the `common-security` test-jar), and add the optional Redis starter next to `common-events`:

```xml
    <!-- optional: only a service that switches the denylist on needs Redis; the others never load these classes -->
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-data-redis</artifactId>
      <optional>true</optional>
    </dependency>
```
   Then run `mvn -f common-security\pom.xml install -DskipTests`. identity-service and control-api read `common-security` from `~/.m2`.
2. **identity-service**: new migration `V4`; replace the files listed in section 5.2 (they are whole files, because your formatting differs from mine in places); in tests, replace `IdentityIntegrationTest` (it now starts a Redis container, drops the `management.health.redis.enabled=false` line, and switches the denylist on).
3. **control-api needs no change.** To make it refuse revoked tokens, start it with `appfleet.security.jwt.denylist.enabled=true` (for example `APPFLEET_SECURITY_JWT_DENYLIST_ENABLED=true`); it already has Redis.

## 5. Main code

### 5.1 `common-security`: the denylist

**`common-security/src/main/java/io/appfleet/security/JwtDenylist.java`**

```java
package io.appfleet.security;

/** A list of access tokens that must be refused although their signature and expiry are fine, identified by jti. */
public interface JwtDenylist {

    boolean isRevoked(String jti);
}
```

**`common-security/src/main/java/io/appfleet/security/RedisJwtDenylist.java`**

```java
package io.appfleet.security;

import org.springframework.data.redis.core.StringRedisTemplate;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;

/**
 * The denylist in Redis: one key per revoked token, living exactly as long as the token could still be accepted.
 * The writer (identity-service) and the reader (the validators) share this class, so the key format exists once.
 */
public class RedisJwtDenylist implements JwtDenylist {

    public static final String KEY_PREFIX = "appfleet:jwt:denylist:";

    private final StringRedisTemplate redis;
    private final Duration clockSkew;
    private final Clock clock;

    public RedisJwtDenylist(StringRedisTemplate redis, Duration clockSkew) {
        this(redis, clockSkew, Clock.systemUTC());
    }

    RedisJwtDenylist(StringRedisTemplate redis, Duration clockSkew, Clock clock) {
        this.redis = redis;
        this.clockSkew = clockSkew;
        this.clock = clock;
    }

    /** The writer needs the skew too: it decides which issued tokens still count as live. Keep it equal to the validators' clock skew. */
    public Duration clockSkew() {
        return clockSkew;
    }

    /**
     * Refuses the token until it could no longer be accepted anyway. The decoder accepts a token up to clockSkew
     * after its exp, so the key lives until exp + clockSkew; one that is past that needs no key at all.
     */
    public void revoke(String jti, Instant expiresAt) {
        Duration ttl = Duration.between(clock.instant(), expiresAt.plus(clockSkew));
        if (ttl.isZero() || ttl.isNegative()) return;
        redis.opsForValue().set(KEY_PREFIX + jti, "1", ttl);
    }

    @Override
    public boolean isRevoked(String jti) {
        return Boolean.TRUE.equals(redis.hasKey(KEY_PREFIX + jti));
    }
}
```

**`common-security/src/main/java/io/appfleet/security/JwtDenylistValidator.java`**

```java
package io.appfleet.security;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.security.oauth2.core.OAuth2Error;
import org.springframework.security.oauth2.core.OAuth2TokenValidator;
import org.springframework.security.oauth2.core.OAuth2TokenValidatorResult;
import org.springframework.security.oauth2.jwt.Jwt;

/**
 * Refuses a token whose jti is on the denylist. A token with no jti cannot be checked, so it is refused too: with the
 * denylist switched on, every accepted token must be revocable.
 *
 * When the denylist cannot be read the choice is explicit: failOpen false (the default) refuses the token, because
 * accepting a token that may be revoked is the failure the denylist exists to prevent; true accepts it and logs.
 */
public class JwtDenylistValidator implements OAuth2TokenValidator<Jwt> {

    private static final Logger log = LoggerFactory.getLogger(JwtDenylistValidator.class);

    private final JwtDenylist denylist;
    private final boolean failOpen;

    public JwtDenylistValidator(JwtDenylist denylist, boolean failOpen) {
        this.denylist = denylist;
        this.failOpen = failOpen;
    }

    @Override
    public OAuth2TokenValidatorResult validate(Jwt jwt) {
        String jti = jwt.getId();
        if (jti == null || jti.isBlank())
            return OAuth2TokenValidatorResult.failure(new OAuth2Error("invalid_token", "The token has no jti", null));
        try {
            return denylist.isRevoked(jti)
                    ? OAuth2TokenValidatorResult.failure(new OAuth2Error("invalid_token", "The token has been revoked", null))
                    : OAuth2TokenValidatorResult.success();
        } catch (RuntimeException e) {
            if (failOpen) {
                log.warn("denylist unavailable, token accepted (fail-open): {}", e.toString());
                return OAuth2TokenValidatorResult.success();
            }
            log.warn("denylist unavailable, token refused (fail-closed): {}", e.toString());
            return OAuth2TokenValidatorResult.failure(new OAuth2Error("invalid_token", "The denylist could not be read", null));
        }
    }
}
```

**`common-security/src/main/java/io/appfleet/security/DenylistProperties.java`**

```java
package io.appfleet.security;

import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;

/** Off by default: a service pays the Redis read on every request only when it asks for it. */
@ConfigurationProperties("appfleet.security.jwt.denylist")
public record DenylistProperties(
        @DefaultValue("false") boolean enabled,
        @DefaultValue("false") boolean failOpen
) {}
```

**`common-security/src/main/java/io/appfleet/security/JwtSecurityAutoConfiguration.java`**

```java
package io.appfleet.security;

import org.springframework.beans.factory.ObjectProvider;
import org.springframework.boot.autoconfigure.AutoConfiguration;
import org.springframework.boot.autoconfigure.condition.ConditionalOnClass;
import org.springframework.boot.autoconfigure.condition.ConditionalOnMissingBean;
import org.springframework.boot.autoconfigure.condition.ConditionalOnProperty;
import org.springframework.boot.context.properties.EnableConfigurationProperties;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.security.converter.RsaKeyConverters;
import org.springframework.security.oauth2.core.DelegatingOAuth2TokenValidator;
import org.springframework.security.oauth2.core.OAuth2TokenValidator;
import org.springframework.security.oauth2.jose.jws.SignatureAlgorithm;
import org.springframework.security.oauth2.jwt.*;
import tools.jackson.databind.json.JsonMapper;

import java.io.IOException;
import java.io.InputStream;
import java.security.interfaces.RSAPublicKey;
import java.util.ArrayList;
import java.util.List;

@AutoConfiguration
@ConditionalOnProperty("appfleet.security.jwt.public-key-location")
@EnableConfigurationProperties({JwtProperties.class, DenylistProperties.class})
public class JwtSecurityAutoConfiguration {

    @Bean
    JwtDecoder jwtDecoder(JwtProperties p, ObjectProvider<JwtDenylistValidator> denylist) throws IOException {
        RSAPublicKey key;
        try (InputStream in = p.publicKeyLocation().getInputStream()) {
            key = RsaKeyConverters.x509().convert(in);
        }
        NimbusJwtDecoder decoder = NimbusJwtDecoder.withPublicKey(key)
                .signatureAlgorithm(SignatureAlgorithm.RS256)
                .build();
        List<OAuth2TokenValidator<Jwt>> validators = new ArrayList<>(List.of(
                new JwtTimestampValidator(p.clockSkew()),
                new JwtIssuerValidator(p.issuer()),
                new JwtClaimValidator<List<String>>(JwtClaimNames.AUD,
                        aud -> aud != null && aud.contains(p.audience())),
                new JwtClaimValidator<String>(JwtClaimNames.SUB, s -> s != null && !s.isBlank())));
        denylist.ifAvailable(validators::add);   // present only when appfleet.security.jwt.denylist.enabled=true
        decoder.setJwtValidator(new DelegatingOAuth2TokenValidator<>(validators));
        return decoder;
    }

    @Bean
    @ConditionalOnMissingBean
    AppfleetJwtAuthenticationConverter appfleetJwtAuthenticationConverter() {
        return new AppfleetJwtAuthenticationConverter();
    }

    @Bean
    @ConditionalOnMissingBean
    ProblemAuthenticationEntryPoint problemAuthenticationEntryPoint(ObjectProvider<JsonMapper> mapper) {
        return new ProblemAuthenticationEntryPoint(mapper.getIfAvailable(JsonMapper::new));
    }

    @Bean
    @ConditionalOnMissingBean
    ProblemAccessDeniedHandler problemAccessDeniedHandler(ObjectProvider<JsonMapper> mapper) {
        return new ProblemAccessDeniedHandler(mapper.getIfAvailable(JsonMapper::new));
    }

    /** The denylist: off unless asked for, and only when Redis is on the classpath. */
    @Configuration(proxyBeanMethods = false)
    @ConditionalOnClass(StringRedisTemplate.class)
    @ConditionalOnProperty(prefix = "appfleet.security.jwt.denylist", name = "enabled", havingValue = "true")
    static class DenylistConfiguration {

        @Bean
        @ConditionalOnMissingBean(JwtDenylist.class)
        RedisJwtDenylist redisJwtDenylist(StringRedisTemplate redis, JwtProperties p) {
            return new RedisJwtDenylist(redis, p.clockSkew());
        }

        @Bean
        JwtDenylistValidator jwtDenylistValidator(JwtDenylist denylist, DenylistProperties properties) {
            return new JwtDenylistValidator(denylist, properties.failOpen());
        }
    }
}
```

### 5.2 identity-service: remembering the access token, ending sessions

**`identity-service/src/main/resources/db/migration/V4__add_refresh_token_access_jti.sql`**

```sql
-- I4: remember which access token each refresh link issued, so that logging out can denylist it.
-- Nullable: rows written before this migration have none (and their access tokens have long expired).
ALTER TABLE refresh_token
    ADD COLUMN access_jti        uuid,
    ADD COLUMN access_expires_at timestamptz;
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

    @Column(name = "family_started_at")
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

    /** The access token issued together with this link; logging out denylists it. */
    @Column(name = "access_jti")
    private UUID accessJti;

    @Column(name = "access_expires_at")
    private Instant accessExpiresAt;

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

    public boolean isExpiredAt(Instant now) {
        return !expiresAt.isAfter(now);
    }

    public void recordAccessToken(UUID jti, Instant expiresAt) {
        this.accessJti = jti;
        this.accessExpiresAt = expiresAt.truncatedTo(ChronoUnit.MICROS);
    }

    public UUID getId() {
        return id;
    }

    public AppUser getUser() {
        return user;
    }

    public UUID getFamilyId() {
        return familyId;
    }

    public UUID getParentId() {
        return parentId;
    }

    public RefreshStatus getStatus() {
        return status;
    }

    public Instant getExpiresAt() {
        return expiresAt;
    }

    public UUID getAccessJti() {
        return accessJti;
    }

    public Instant getAccessExpiresAt() {
        return accessExpiresAt;
    }
}
```

**`identity-service/src/main/java/io/appfleet/identity/token/AccessRef.java`**

```java
package io.appfleet.identity.token;

import java.time.Instant;
import java.util.UUID;

/** One issued access token as the revocation needs it: its jti and when it expires. */
public record AccessRef(UUID jti, Instant expiresAt) {}
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
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public interface RefreshTokenRepository extends Repository<RefreshToken, UUID> {

    RefreshToken save(RefreshToken token);

    /** Needed in RefreshTokenService.rotate: Hibernate writes inserts before updates, so the used link must be flushed first. */
    void flush();

    /** Locks the row until the transaction ends, so two requests with the same token are decided one after the other. */
    @Lock(LockModeType.PESSIMISTIC_WRITE)
    Optional<RefreshToken> findByTokenHash(String tokenHash);

    /** The access tokens issued by one family that the decoder could still accept (expiry within the cutoff or later). */
    @Query("select new io.appfleet.identity.token.AccessRef(t.accessJti, t.accessExpiresAt) from RefreshToken t "
            + "where t.familyId = :familyId and t.accessJti is not null and t.accessExpiresAt > :cutoff")
    List<AccessRef> findLiveAccessTokensOfFamily(@Param("familyId") UUID familyId, @Param("cutoff") Instant cutoff);

    @Query("select new io.appfleet.identity.token.AccessRef(t.accessJti, t.accessExpiresAt) from RefreshToken t "
            + "where t.user.id = :userId and t.accessJti is not null and t.accessExpiresAt > :cutoff")
    List<AccessRef> findLiveAccessTokensOfUser(@Param("userId") UUID userId, @Param("cutoff") Instant cutoff);

    /** Cuts off every ACTIVE link of every family of one user. */
    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Query("update RefreshToken t set t.status = io.appfleet.identity.token.RefreshStatus.REVOKED, t.revokedAt = :now "
            + "where t.user.id = :userId and t.status = io.appfleet.identity.token.RefreshStatus.ACTIVE")
    int revokeActiveForUser(@Param("userId") UUID userId, @Param("now") Instant now);

    /** Cuts off every link of the family that could still be used. USED links stay USED: they keep their history. */
    @Modifying(flushAutomatically = true, clearAutomatically = true)
    @Query("update RefreshToken t set t.status = io.appfleet.identity.token.RefreshStatus.REVOKED, t.revokedAt = :now "
            + "where t.familyId = :familyId and t.status = io.appfleet.identity.token.RefreshStatus.ACTIVE")
    int revokeActiveInFamily(@Param("familyId") UUID familyId, @Param("now") Instant now);
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

    public record Rotated(AppUser user, String refreshToken, RefreshToken link) implements Outcome {}

    /** A new family's first link: the token (which exists nowhere else) and the managed row. */
    public record Started(String token, RefreshToken link) {}

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
    public Started startFamily(AppUser user) {
        String token = TokenHasher.newToken();
        RefreshToken link = tokens.save(RefreshToken.startFamily(user, TokenHasher.hash(token), clock.instant(),
                properties.tokenTtl(), properties.familyMaxLifetime()));
        return new Started(token, link);
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
        RefreshToken saved = tokens.save(child);
        return new Rotated(user, next, saved);
    }
}
```

**`identity-service/src/main/java/io/appfleet/identity/token/SessionRevocationService.java`**

```java
package io.appfleet.identity.token;

import io.appfleet.security.RedisJwtDenylist;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * Ends sessions: the refresh side is revoked in the database, and every access token those sessions still have in the
 * air goes on the Redis denylist until it could no longer be accepted.
 *
 * Order matters and is deliberate: the database first, Redis last, all in one transaction. If Redis fails, the
 * transaction rolls back, the caller sees an error and can retry, and nothing is half done on the refresh side. If the
 * commit fails after Redis was written, a token is refused that did not need to be, which is the safe direction.
 */
@Service
public class SessionRevocationService {

    private final RefreshTokenRepository tokens;
    private final RedisJwtDenylist denylist;
    private final Clock clock;

    public SessionRevocationService(RefreshTokenRepository tokens, RedisJwtDenylist denylist, Clock clock) {
        this.tokens = tokens;
        this.denylist = denylist;
        this.clock = clock;
    }

    /** Logout: whatever refresh token of the session is presented, used or not, the whole family ends. Unknown tokens do nothing. */
    @Transactional
    public void logout(String presentedRefreshToken) {
        tokens.findByTokenHash(TokenHasher.hash(presentedRefreshToken)).ifPresent(link -> revokeFamily(link.getFamilyId()));
    }

    @Transactional
    public void revokeFamily(UUID familyId) {
        Instant now = clock.instant();
        tokens.revokeActiveInFamily(familyId, now);
        deny(tokens.findLiveAccessTokensOfFamily(familyId, now.minus(denylist.clockSkew())));
    }

    /** Every session of one user: used when something about the user changes that tokens already issued would not show (a role). */
    @Transactional
    public int revokeAllSessions(UUID userId) {
        Instant now = clock.instant();
        int cut = tokens.revokeActiveForUser(userId, now);
        deny(tokens.findLiveAccessTokensOfUser(userId, now.minus(denylist.clockSkew())));
        return cut;
    }

    private void deny(List<AccessRef> refs) {
        refs.forEach(r -> denylist.revoke(r.jti().toString(), r.expiresAt()));
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

import io.appfleet.security.RedisJwtDenylist;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.redis.core.StringRedisTemplate;

import java.time.Clock;
import java.time.Duration;

@Configuration
@EnableConfigurationProperties({IdentityJwtProperties.class, PasswordProperties.class, RefreshProperties.class})
public class IdentityConfig {

    @Bean
    PasswordEncoder passwordEncoder(PasswordProperties properties) {
        return new BCryptPasswordEncoder(properties.bcryptCost());
    }

    /**
     * The writing side of the denylist. The skew must equal the validators' clock skew (appfleet.security.jwt.clock-skew,
     * 60 seconds by default), so it is read from that very property.
     */
    @Bean
    RedisJwtDenylist redisJwtDenylist(StringRedisTemplate redis, @Value("${appfleet.security.jwt.clock-skew:60s}") Duration clockSkew) {
        return new RedisJwtDenylist(redis, clockSkew);
    }

    @Bean
    Clock clock() {
        return Clock.systemUTC();
    }
}
```

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
                .requestMatchers(HttpMethod.POST, "/api/v1/auth/register", "/api/v1/auth/login", "/api/v1/auth/refresh", "/api/v1/auth/logout").permitAll()
                .anyRequest().denyAll())
                .csrf(c -> c.disable())
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS));
        return http.build();
    }
}
```

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

    public record LogoutRequest(
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

@Service
public class AuthService {

    private final UserRepository users;
    private final PasswordEncoder encoder;
    private final AccessTokenIssuer issuer;
    private final RefreshTokenService refreshTokens;
    private final SessionRevocationService sessions;

    public AuthService(UserRepository users, PasswordEncoder encoder, AccessTokenIssuer issuer, RefreshTokenService refreshTokens,
                       SessionRevocationService sessions) {
        this.users = users;
        this.encoder = encoder;
        this.issuer = issuer;
        this.refreshTokens = refreshTokens;
        this.sessions = sessions;
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

    @Transactional
    public TokenResponse login(LoginRequest request) {
        AppUser user = users.findByEmail(AppUser.normalize(request.email())).orElse(null);
        if (user == null || user.getStatus() != UserStatus.ACTIVE || !encoder.matches(request.password(), user.getPasswordHash()))
            throw new InvalidCredentialsException();
        RefreshTokenService.Started started = refreshTokens.startFamily(user);
        return respond(user, started.token(), started.link());
    }

    /**
     * Empty means "refused". It is NOT an exception on purpose: a reuse revokes the family, and an exception would roll
     * that revocation back. The controller turns the empty result into a 401 after this transaction has committed.
     * An exception from the access-token issuer, by contrast, rolls the rotation back, so the client can retry.
     */
    @Transactional
    public Optional<TokenResponse> refresh(AuthDTOs.RefreshRequest request) {
        return switch (refreshTokens.rotate(request.refreshToken())) {
            case RefreshTokenService.Rotated rotated -> Optional.of(respond(rotated.user(), rotated.refreshToken(), rotated.link()));
            case RefreshTokenService.Rejected rejected -> Optional.empty();
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
```

**`identity-service/src/main/java/io/appfleet/identity/auth/AuthController.java`**

```java
package io.appfleet.identity.auth;

import io.appfleet.identity.auth.AuthDTOs.LoginRequest;
import io.appfleet.identity.auth.AuthDTOs.LogoutRequest;
import io.appfleet.identity.auth.AuthDTOs.RegisterRequest;
import io.appfleet.identity.auth.AuthDTOs.RegisteredUser;
import io.appfleet.identity.auth.AuthDTOs.TokenResponse;
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

    /** 204 whether or not the token was known: the answer must not tell a thief which tokens exist. */
    @PostMapping("/logout")
    ResponseEntity<Void> logout(@Valid @RequestBody LogoutRequest request) {
        auth.logout(request.refreshToken());
        return ResponseEntity.noContent().build();
    }

    /** The refusal is thrown HERE, after AuthService.refresh has committed, so a family revocation survives it. */
    @PostMapping("/refresh")
    ResponseEntity<TokenResponse> refresh(@Valid @RequestBody AuthDTOs.RefreshRequest request) {
        return ResponseEntity.ok(auth.refresh(request).orElseThrow(AuthExceptions.InvalidRefreshTokenException::new));
    }
}
```

## 6. Tests

`common-security`: 15 new tests (56 in all). identity-service: 26 new (114 in all).

### 6.1 `common-security`

**`common-security/src/test/java/io/appfleet/security/JwtDenylistValidatorTest.java`**

```java
package io.appfleet.security;

import org.junit.jupiter.api.Test;
import org.springframework.security.oauth2.core.OAuth2TokenValidatorResult;
import org.springframework.security.oauth2.jwt.Jwt;

import java.time.Instant;
import java.util.HashSet;
import java.util.Set;

import static org.assertj.core.api.Assertions.assertThat;

class JwtDenylistValidatorTest {

    private static Jwt jwtWith(String jti) {
        Jwt.Builder b = Jwt.withTokenValue("t").header("alg", "RS256").subject("u")
                .issuedAt(Instant.now()).expiresAt(Instant.now().plusSeconds(900));
        if (jti != null) b.claim("jti", jti);
        return b.build();
    }

    private static JwtDenylist listing(String... revoked) {
        Set<String> set = new HashSet<>(Set.of(revoked));
        return set::contains;
    }

    private static JwtDenylist broken() {
        return jti -> { throw new IllegalStateException("redis down"); };
    }

    @Test
    void aToken_notOnTheList_isAccepted() {
        assertThat(new JwtDenylistValidator(listing("other"), false).validate(jwtWith("a")).hasErrors()).isFalse();
    }

    @Test
    void aToken_onTheList_isRefused_asRevoked() {
        OAuth2TokenValidatorResult r = new JwtDenylistValidator(listing("a"), false).validate(jwtWith("a"));
        assertThat(r.hasErrors()).isTrue();
        assertThat(r.getErrors().iterator().next().getDescription()).contains("revoked");
    }

    @Test
    void aToken_withoutAJti_isRefused_becauseItCouldNeverBeRevoked() {
        assertThat(new JwtDenylistValidator(listing(), false).validate(jwtWith(null)).hasErrors()).isTrue();
        assertThat(new JwtDenylistValidator(listing(), false).validate(jwtWith(" ")).hasErrors()).isTrue();
    }

    @Test
    void whenTheDenylistCannotBeRead_failClosed_refusesTheToken() {
        OAuth2TokenValidatorResult r = new JwtDenylistValidator(broken(), false).validate(jwtWith("a"));
        assertThat(r.hasErrors()).isTrue();
        assertThat(r.getErrors().iterator().next().getDescription()).contains("could not be read");
    }

    @Test
    void whenTheDenylistCannotBeRead_failOpen_acceptsTheToken() {
        assertThat(new JwtDenylistValidator(broken(), true).validate(jwtWith("a")).hasErrors()).isFalse();
    }
}
```

**`common-security/src/test/java/io/appfleet/security/RedisJwtDenylistTest.java`**

```java
package io.appfleet.security;

import org.junit.jupiter.api.Test;
import org.mockito.ArgumentCaptor;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.data.redis.core.ValueOperations;

import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.time.ZoneOffset;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.eq;
import static org.mockito.Mockito.mock;
import static org.mockito.Mockito.never;
import static org.mockito.Mockito.verify;
import static org.mockito.Mockito.when;

/** The key format and the lifetime of a key, against a mocked template (no Redis needed). */
class RedisJwtDenylistTest {

    private static final Instant NOW = Instant.parse("2026-10-07T10:00:00Z");
    private static final Duration SKEW = Duration.ofSeconds(60);

    private final StringRedisTemplate redis = mock(StringRedisTemplate.class);
    @SuppressWarnings("unchecked")
    private final ValueOperations<String, String> ops = mock(ValueOperations.class);
    private final RedisJwtDenylist denylist = new RedisJwtDenylist(redis, SKEW, Clock.fixed(NOW, ZoneOffset.UTC));

    RedisJwtDenylistTest() {
        when(redis.opsForValue()).thenReturn(ops);
    }

    @Test
    void revoke_storesOneKeyPerJti_livingUntilExpPlusTheClockSkew() {
        denylist.revoke("abc", NOW.plusSeconds(600));
        ArgumentCaptor<Duration> ttl = ArgumentCaptor.forClass(Duration.class);
        verify(ops).set(eq("appfleet:jwt:denylist:abc"), eq("1"), ttl.capture());
        assertThat(ttl.getValue()).isEqualTo(Duration.ofSeconds(660));   // 600 s left + 60 s the decoder still accepts
    }

    @Test
    void revoke_ofATokenPastItsExpiryAndSkew_writesNothing() {
        denylist.revoke("old", NOW.minusSeconds(61));
        verify(ops, never()).set(any(), any(), any(Duration.class));
    }

    @Test
    void revoke_ofATokenExpiredInsideTheSkew_stillWritesAKey_becauseTheDecoderWouldAcceptIt() {
        denylist.revoke("recent", NOW.minusSeconds(30));
        ArgumentCaptor<Duration> ttl = ArgumentCaptor.forClass(Duration.class);
        verify(ops).set(eq("appfleet:jwt:denylist:recent"), eq("1"), ttl.capture());
        assertThat(ttl.getValue()).isEqualTo(Duration.ofSeconds(30));
    }

    @Test
    void isRevoked_asksForTheSameKey() {
        when(redis.hasKey("appfleet:jwt:denylist:abc")).thenReturn(true);
        when(redis.hasKey("appfleet:jwt:denylist:other")).thenReturn(false);
        assertThat(denylist.isRevoked("abc")).isTrue();
        assertThat(denylist.isRevoked("other")).isFalse();
    }

    @Test
    void isRevoked_treatsANullAnswerAsNotRevoked() {
        when(redis.hasKey(any(String.class))).thenReturn(null);
        assertThat(denylist.isRevoked("x")).isFalse();
    }
}
```

**`common-security/src/test/java/io/appfleet/security/JwtDenylistAutoConfigurationTest.java`**

```java
package io.appfleet.security;

import io.appfleet.security.testing.TestJwt;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtException;

import java.util.HashSet;
import java.util.Set;
import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** The denylist is off unless asked for, and then it sits inside the decoder next to the other validators. */
class JwtDenylistAutoConfigurationTest {

    /** A list that tests can write to; stands in for Redis. */
    static class InMemoryDenylist implements JwtDenylist {
        final Set<String> revoked = new HashSet<>();
        @Override public boolean isRevoked(String jti) { return revoked.contains(jti); }
    }

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(JwtSecurityAutoConfiguration.class))
            .withPropertyValues(
                    "appfleet.security.jwt.public-key-location=classpath:keys/dev-public.pem",
                    "appfleet.security.jwt.issuer=appfleet-identity");

    private static String token() {
        return TestJwt.forUser(UUID.randomUUID()).sign();
    }

    @Test
    void byDefault_thereIsNoDenylistValidator_andARevokedJtiIsStillAccepted() {
        InMemoryDenylist list = new InMemoryDenylist();
        runner.withBean(JwtDenylist.class, () -> list).run(ctx -> {
            assertThat(ctx).doesNotHaveBean(JwtDenylistValidator.class);
            JwtDecoder decoder = ctx.getBean(JwtDecoder.class);
            Jwt jwt = decoder.decode(token());
            list.revoked.add(jwt.getId());
            assertThat(decoder.decode(token())).isNotNull();   // nobody consults the list
        });
    }

    @Test
    void whenEnabled_aRevokedToken_isRefusedByTheDecoder() {
        InMemoryDenylist list = new InMemoryDenylist();
        runner.withPropertyValues("appfleet.security.jwt.denylist.enabled=true")
                .withBean(JwtDenylist.class, () -> list)
                .run(ctx -> {
                    JwtDecoder decoder = ctx.getBean(JwtDecoder.class);
                    String token = token();
                    Jwt jwt = decoder.decode(token);                 // fine while the list is empty
                    list.revoked.add(jwt.getId());
                    assertThatThrownBy(() -> decoder.decode(token))
                            .isInstanceOf(JwtException.class).hasMessageContaining("revoked");
                    assertThat(decoder.decode(token())).as("another token is unaffected").isNotNull();
                });
    }

    @Test
    void whenEnabled_theRedisListIsTheDefault() {
        // spring-data-redis is on the test classpath (optional dependency), so the Redis list is the default.
        runner.withPropertyValues("appfleet.security.jwt.denylist.enabled=true")
                .withBean(org.springframework.data.redis.core.StringRedisTemplate.class,
                        () -> org.mockito.Mockito.mock(org.springframework.data.redis.core.StringRedisTemplate.class))
                .run(ctx -> {
                    assertThat(ctx).hasSingleBean(RedisJwtDenylist.class);
                    assertThat(ctx).hasSingleBean(JwtDenylistValidator.class);
                });
    }

    @Test
    void failOpen_isReadFromItsProperty() {
        runner.withPropertyValues("appfleet.security.jwt.denylist.enabled=true", "appfleet.security.jwt.denylist.fail-open=true")
                .withBean(JwtDenylist.class, () -> jti -> { throw new IllegalStateException("redis down"); })
                .run(ctx -> assertThat(ctx.getBean(JwtDecoder.class).decode(token())).isNotNull());
    }

    @Test
    void failClosed_isTheDefault() {
        runner.withPropertyValues("appfleet.security.jwt.denylist.enabled=true")
                .withBean(JwtDenylist.class, () -> jti -> { throw new IllegalStateException("redis down"); })
                .run(ctx -> assertThatThrownBy(() -> ctx.getBean(JwtDecoder.class).decode(token()))
                        .isInstanceOf(JwtException.class));
    }
}
```

### 6.2 identity-service

**`identity-service/src/test/java/io/appfleet/identity/IdentityIntegrationTest.java`**

```java
package io.appfleet.identity;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;
import org.springframework.boot.testcontainers.service.connection.ServiceConnection;
import org.springframework.jdbc.core.JdbcTemplate;
import org.testcontainers.containers.GenericContainer;
import org.testcontainers.containers.PostgreSQLContainer;
import org.testcontainers.lifecycle.Startables;

/**
 * One Postgres per JVM. Real HTTP port, because MockMvc skips the security filter chain
 */
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "spring.jpa.properties.hibernate.generate_statistics=true",
        "appfleet.identity.jwt.private-key-location=classpath:keys/dev-private.pem",
        "appfleet.identity.password.bcrypt-cost=4",
        // the validating side, from common-security, so a test can decode what the issuer signed
        "appfleet.security.jwt.public-key-location=classpath:keys/dev-public.pem",
        "appfleet.security.jwt.issuer=appfleet-identity",
        "appfleet.security.jwt.denylist.enabled=true"
})
public abstract class IdentityIntegrationTest {

    @ServiceConnection
    static final PostgreSQLContainer<?> postgres =
            new PostgreSQLContainer<>("postgres:16").withUrlParam("currentSchema", "identity");

    @ServiceConnection(name = "redis")
    static final GenericContainer<?> redis = new GenericContainer<>("redis:7").withExposedPorts(6379);

    static {
        Startables.deepStart(postgres, redis).join();
    }

    @Autowired
    protected JdbcTemplate jdbc;
}
```

**`identity-service/src/test/java/io/appfleet/identity/LogoutTest.java`**

```java
package io.appfleet.identity;

import io.appfleet.identity.token.TokenHasher;
import io.appfleet.security.RedisJwtDenylist;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtException;
import tools.jackson.databind.JsonNode;

import java.net.http.HttpResponse;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

class LogoutTest extends AuthHttpTest {

    @Autowired JwtDecoder decoder;
    @Autowired StringRedisTemplate redis;

    private JsonNode registerAndLogin(String email) throws Exception {
        register(email, PASSWORD);
        return body(login(email, PASSWORD));
    }

    private HttpResponse<String> logout(String refreshToken) throws Exception {
        return post("/api/v1/auth/logout", Map.of("refreshToken", refreshToken));
    }

    private HttpResponse<String> refresh(String refreshToken) throws Exception {
        return post("/api/v1/auth/refresh", Map.of("refreshToken", refreshToken));
    }

    private Map<String, Object> row(String token) {
        return jdbc.queryForMap("select * from refresh_token where token_hash = ?", TokenHasher.hash(token));
    }

    private int activeInFamily(String token) {
        return jdbc.queryForObject("select count(*) from refresh_token where family_id = ? and status = 'ACTIVE'",
                Integer.class, row(token).get("family_id"));
    }

    private void assertRevoked(String accessToken) {
        assertThatThrownBy(() -> decoder.decode(accessToken)).isInstanceOf(JwtException.class).hasMessageContaining("revoked");
    }

    // ---- the link remembers its access token --------------------------------------------------------------------

    @Test
    void login_recordsTheAccessTokenOnTheFirstLink() throws Exception {
        JsonNode login = registerAndLogin(uniqueEmail());
        Jwt jwt = decoder.decode(login.get("accessToken").asString());
        Map<String, Object> row = row(login.get("refreshToken").asString());
        assertThat(row.get("access_jti").toString()).isEqualTo(jwt.getId());
        Double secondsApart = jdbc.queryForObject("select abs(extract(epoch from (access_expires_at - to_timestamp(?)))) from refresh_token where token_hash = ?",
                Double.class, jwt.getExpiresAt().getEpochSecond(), TokenHasher.hash(login.get("refreshToken").asString()));
        assertThat(secondsApart).isLessThan(1.0);
    }

    @Test
    void refresh_recordsTheNewAccessTokenOnTheNewLink() throws Exception {
        JsonNode login = registerAndLogin(uniqueEmail());
        JsonNode refreshed = body(refresh(login.get("refreshToken").asString()));
        Jwt jwt = decoder.decode(refreshed.get("accessToken").asString());
        assertThat(row(refreshed.get("refreshToken").asString()).get("access_jti").toString()).isEqualTo(jwt.getId());
    }

    // ---- logout -------------------------------------------------------------------------------------------------

    @Test
    void logout_is204_andTheRefreshTokenStopsWorking() throws Exception {
        String refreshToken = registerAndLogin(uniqueEmail()).get("refreshToken").asString();
        HttpResponse<String> r = logout(refreshToken);
        assertThat(r.statusCode()).isEqualTo(204);
        assertThat(r.body()).isEmpty();
        assertThat(activeInFamily(refreshToken)).isZero();
        assertThat(refresh(refreshToken).statusCode()).isEqualTo(401);
    }

    @Test
    void logout_withAnUnknownToken_is204_andChangesNothing() throws Exception {
        String live = registerAndLogin(uniqueEmail()).get("refreshToken").asString();
        long before = jdbc.queryForObject("select count(*) from refresh_token where status = 'ACTIVE'", Long.class);
        assertThat(logout(TokenHasher.newToken()).statusCode()).isEqualTo(204);
        assertThat(jdbc.queryForObject("select count(*) from refresh_token where status = 'ACTIVE'", Long.class)).isEqualTo(before);
        assertThat(refresh(live).statusCode()).isEqualTo(200);
    }

    @Test
    void logout_withAnAlreadyUsedToken_stillEndsTheWholeFamily() throws Exception {
        String first = registerAndLogin(uniqueEmail()).get("refreshToken").asString();
        String second = body(refresh(first)).get("refreshToken").asString();
        assertThat(logout(first).statusCode()).isEqualTo(204);
        assertThat(refresh(second).statusCode()).as("the newest link died with the family").isEqualTo(401);
    }

    @Test
    void logout_leavesAnotherSessionOfTheSameUserAlone() throws Exception {
        String email = uniqueEmail();
        register(email, PASSWORD);
        JsonNode a = body(login(email, PASSWORD));
        JsonNode b = body(login(email, PASSWORD));
        logout(a.get("refreshToken").asString());
        assertThat(decoder.decode(b.get("accessToken").asString())).isNotNull();
        assertThat(refresh(b.get("refreshToken").asString()).statusCode()).isEqualTo(200);
    }

    // ---- the denylist -------------------------------------------------------------------------------------------

    @Test
    void logout_denylistsTheSessionsAccessToken() throws Exception {
        JsonNode login = registerAndLogin(uniqueEmail());
        String access = login.get("accessToken").asString();
        Jwt jwt = decoder.decode(access);                       // valid until the logout
        logout(login.get("refreshToken").asString());
        assertRevoked(access);

        long ttl = redis.getExpire(RedisJwtDenylist.KEY_PREFIX + jwt.getId(), TimeUnit.SECONDS);
        long remaining = jwt.getExpiresAt().getEpochSecond() - java.time.Instant.now().getEpochSecond();
        assertThat(ttl).as("lives as long as the token could still be accepted: exp + 60 s clock skew")
                .isBetween(remaining, remaining + 61);
    }

    @Test
    void logout_denylistsEveryUnexpiredAccessTokenOfTheFamily() throws Exception {
        JsonNode first = registerAndLogin(uniqueEmail());
        JsonNode second = body(refresh(first.get("refreshToken").asString()));
        JsonNode third = body(refresh(second.get("refreshToken").asString()));
        logout(third.get("refreshToken").asString());
        assertRevoked(first.get("accessToken").asString());
        assertRevoked(second.get("accessToken").asString());
        assertRevoked(third.get("accessToken").asString());
    }

    @Test
    void aNewLoginAfterLogout_isAFreshWorkingSession() throws Exception {
        String email = uniqueEmail();
        JsonNode old = registerAndLogin(email);
        logout(old.get("refreshToken").asString());
        JsonNode fresh = body(login(email, PASSWORD));
        assertThat(decoder.decode(fresh.get("accessToken").asString())).isNotNull();
        assertThat(refresh(fresh.get("refreshToken").asString()).statusCode()).isEqualTo(200);
    }

    @Test
    void aTokenOfAnotherUser_isNotAffected() throws Exception {
        JsonNode a = registerAndLogin(uniqueEmail());
        JsonNode b = registerAndLogin(uniqueEmail());
        logout(a.get("refreshToken").asString());
        assertThat(decoder.decode(b.get("accessToken").asString())).isNotNull();
    }

    // ---- validation ---------------------------------------------------------------------------------------------

    @Test
    void aBlankMissingOrHugeToken_is400() throws Exception {
        assertThat(logout("").statusCode()).isEqualTo(400);
        assertThat(post("/api/v1/auth/logout", Map.of()).statusCode()).isEqualTo(400);
        assertThat(logout("x".repeat(201)).statusCode()).isEqualTo(400);
    }

    @Test
    void get_onLogout_isRefused() throws Exception {
        assertThat(get("/api/v1/auth/logout").statusCode()).isEqualTo(403);
    }

    @Test
    void theTokensJtiIsAUuid() throws Exception {
        Jwt jwt = decoder.decode(registerAndLogin(uniqueEmail()).get("accessToken").asString());
        assertThat(UUID.fromString(jwt.getId())).isNotNull();
    }
}
```

**`identity-service/src/test/java/io/appfleet/identity/StaleTokenTest.java`**

```java
package io.appfleet.identity;

import io.appfleet.identity.rbac.RoleRepository;
import io.appfleet.identity.team.Team;
import io.appfleet.identity.team.TeamMembership;
import io.appfleet.identity.team.TeamMembershipRepository;
import io.appfleet.identity.team.TeamRepository;
import io.appfleet.identity.token.SessionRevocationService;
import io.appfleet.identity.user.AppUser;
import io.appfleet.identity.user.UserRepository;
import io.appfleet.security.AppfleetJwtAuthenticationConverter;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtException;
import org.springframework.security.oauth2.server.resource.authentication.JwtAuthenticationToken;
import tools.jackson.databind.JsonNode;

import java.time.Duration;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The deliberate bug of the spec, "stale permissions in a live JWT": a role is taken away, and the access token
 * issued before keeps carrying it until it expires. The first test keeps that behaviour on record; the others show
 * the denylist closing the window.
 */
class StaleTokenTest extends AuthHttpTest {

    @Autowired JwtDecoder decoder;
    @Autowired AppfleetJwtAuthenticationConverter converter;
    @Autowired UserRepository users;
    @Autowired TeamRepository teams;
    @Autowired TeamMembershipRepository memberships;
    @Autowired RoleRepository roles;
    @Autowired SessionRevocationService sessions;

    private record Setup(UUID userId, UUID teamId, JsonNode login, String email) {}

    private Setup deployerOnATeam() throws Exception {
        String email = uniqueEmail();
        register(email, PASSWORD);
        Team team = teams.save(new Team("stale-" + UUID.randomUUID()));
        AppUser user = users.findByEmail(email).orElseThrow();
        memberships.save(new TeamMembership(user, team, roles.findByName("DEPLOYER").orElseThrow()));
        return new Setup(user.getId(), team.getId(), body(login(email, PASSWORD)), email);
    }

    private void takeTheRoleAway(UUID userId) {
        jdbc.update("delete from team_membership where user_id = ?", userId);
    }

    private Set<String> authoritiesOf(Jwt jwt) {
        JwtAuthenticationToken auth = (JwtAuthenticationToken) converter.convert(jwt);
        return auth.getAuthorities().stream().map(GrantedAuthority::getAuthority).collect(Collectors.toSet());
    }

    /** The bug, on record: the role is gone from the database and the token still says deployment:create. */
    @Test
    void staleToken_keepsItsPermissions_afterTheRoleIsTakenAway() throws Exception {
        Setup s = deployerOnATeam();
        String access = s.login().get("accessToken").asString();
        takeTheRoleAway(s.userId());

        assertThat(jdbc.queryForObject("select count(*) from team_membership where user_id = ?", Integer.class, s.userId())).isZero();
        assertThat(authoritiesOf(decoder.decode(access))).as("the stale token still carries the permission").contains("deployment:create");
    }

    /** How long that window is when nothing revokes the token: the whole access-token lifetime. */
    @Test
    void theWindowWithoutRevocation_isTheAccessTokenLifetime() throws Exception {
        Jwt jwt = decoder.decode(deployerOnATeam().login().get("accessToken").asString());
        assertThat(Duration.between(jwt.getIssuedAt(), jwt.getExpiresAt())).isEqualTo(Duration.ofMinutes(15));
    }

    @Test
    void revokeAllSessions_closesTheWindow_forTheStaleAccessToken() throws Exception {
        Setup s = deployerOnATeam();
        String access = s.login().get("accessToken").asString();
        takeTheRoleAway(s.userId());

        sessions.revokeAllSessions(s.userId());

        assertThatThrownBy(() -> decoder.decode(access)).isInstanceOf(JwtException.class).hasMessageContaining("revoked");
    }

    @Test
    void revokeAllSessions_alsoEndsTheRefreshTokens_soTheOldGrantsCannotComeBackThroughARefresh() throws Exception {
        Setup s = deployerOnATeam();
        takeTheRoleAway(s.userId());
        int cut = sessions.revokeAllSessions(s.userId());
        assertThat(cut).isEqualTo(1);
        assertThat(post("/api/v1/auth/refresh", Map.of("refreshToken", s.login().get("refreshToken").asString())).statusCode()).isEqualTo(401);
    }

    @Test
    void afterRevokeAllSessions_aNewLoginSeesTheCurrentGrants() throws Exception {
        Setup s = deployerOnATeam();
        takeTheRoleAway(s.userId());
        sessions.revokeAllSessions(s.userId());
        Jwt fresh = decoder.decode(body(login(s.email(), PASSWORD)).get("accessToken").asString());
        assertThat(fresh.getClaims()).doesNotContainKey("teams");
        assertThat(authoritiesOf(fresh)).isEmpty();
    }

    @Test
    void revokeAllSessions_coversEverySessionOfTheUser() throws Exception {
        Setup s = deployerOnATeam();
        String second = body(login(s.email(), PASSWORD)).get("accessToken").asString();
        String first = s.login().get("accessToken").asString();
        sessions.revokeAllSessions(s.userId());
        assertThatThrownBy(() -> decoder.decode(first)).isInstanceOf(JwtException.class);
        assertThatThrownBy(() -> decoder.decode(second)).isInstanceOf(JwtException.class);
    }

    @Test
    void revokeAllSessions_doesNotTouchAnotherUser() throws Exception {
        Setup s = deployerOnATeam();
        String other = body(login(registerOther(), PASSWORD)).get("accessToken").asString();
        sessions.revokeAllSessions(s.userId());
        assertThat(decoder.decode(other)).isNotNull();
    }

    private String registerOther() throws Exception {
        String email = uniqueEmail();
        register(email, PASSWORD);
        return email;
    }
}
```

**`identity-service/src/test/java/io/appfleet/identity/RedisDenylistTest.java`**

```java
package io.appfleet.identity;

import io.appfleet.security.RedisJwtDenylist;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.redis.core.StringRedisTemplate;

import java.time.Instant;
import java.util.UUID;
import java.util.concurrent.TimeUnit;

import static org.assertj.core.api.Assertions.assertThat;

/** The shared denylist class against a real Redis. */
class RedisDenylistTest extends IdentityIntegrationTest {

    @Autowired RedisJwtDenylist denylist;
    @Autowired StringRedisTemplate redis;

    @Test
    void aRevokedJti_isRevoked_andAnotherIsNot() {
        String jti = UUID.randomUUID().toString();
        denylist.revoke(jti, Instant.now().plusSeconds(600));
        assertThat(denylist.isRevoked(jti)).isTrue();
        assertThat(denylist.isRevoked(UUID.randomUUID().toString())).isFalse();
    }

    @Test
    void theKey_livesUntilExpPlusTheClockSkew_andThenGoesAway() {
        String jti = UUID.randomUUID().toString();
        denylist.revoke(jti, Instant.now().plusSeconds(600));
        long ttl = redis.getExpire(RedisJwtDenylist.KEY_PREFIX + jti, TimeUnit.SECONDS);
        assertThat(ttl).isBetween(655L, 660L);   // 600 s left + 60 s skew
    }

    @Test
    void aTokenPastItsExpiryAndTheSkew_getsNoKey() {
        String jti = UUID.randomUUID().toString();
        denylist.revoke(jti, Instant.now().minusSeconds(61));
        assertThat(redis.hasKey(RedisJwtDenylist.KEY_PREFIX + jti)).isFalse();
    }

    @Test
    void theKeyFormat_isThePrefixAndTheJti() {
        String jti = UUID.randomUUID().toString();
        denylist.revoke(jti, Instant.now().plusSeconds(60));
        assertThat(redis.hasKey("appfleet:jwt:denylist:" + jti)).isTrue();
    }
}
```

**`identity-service/src/test/java/io/appfleet/identity/DenylistCostTest.java`**

```java
package io.appfleet.identity;

import io.appfleet.security.RedisJwtDenylist;
import io.appfleet.security.testing.TestJwt;
import io.appfleet.security.testing.TestKeys;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;

/** The cost of asking Redis on every request, as numbers for the denylist-versus-short-expiry argument. */
class DenylistCostTest extends IdentityIntegrationTest {

    private static final int N = 2000;

    @Autowired RedisJwtDenylist denylist;
    @Autowired JwtDecoder decoderWithDenylist;

    private static double microsPerCall(Runnable call) {
        for (int i = 0; i < 200; i++) call.run();   // warm up
        long start = System.nanoTime();
        for (int i = 0; i < N; i++) call.run();
        return (System.nanoTime() - start) / 1000.0 / N;
    }

    @Test
    void measured_theDenylistLookupAndTheDecodeWithAndWithout() {
        String token = TestJwt.forUser(UUID.randomUUID()).sign();
        JwtDecoder withoutDenylist = NimbusJwtDecoder.withPublicKey(TestKeys.PUBLIC).build();   // signature only: a floor, not the real decoder

        double lookup = microsPerCall(() -> denylist.isRevoked(UUID.randomUUID().toString()));
        double decodeWith = microsPerCall(() -> decoderWithDenylist.decode(token));
        double decodeSignatureOnly = microsPerCall(() -> withoutDenylist.decode(token));

        System.out.printf("DENYLIST-COST lookup=%.0f us  decode_with_denylist=%.0f us  decode_signature_only=%.0f us  (n=%d, Redis in a local container)%n",
                lookup, decodeWith, decodeSignatureOnly, N);
        assertThat(lookup).as("one Redis lookup stays far below a millisecond-scale budget").isLessThan(5000.0);
        assertThat(decodeWith).isGreaterThan(0.0);
    }
}
```

**`identity-service/src/test/java/io/appfleet/identity/LogoutRedisFailureTest.java`**

```java
package io.appfleet.identity;

import io.appfleet.identity.token.TokenHasher;
import io.appfleet.security.RedisJwtDenylist;
import org.junit.jupiter.api.Test;
import org.springframework.test.context.bean.override.mockito.MockitoBean;
import tools.jackson.databind.JsonNode;

import java.time.Duration;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;
import static org.mockito.ArgumentMatchers.any;
import static org.mockito.ArgumentMatchers.anyString;
import static org.mockito.Mockito.doNothing;
import static org.mockito.Mockito.doThrow;
import static org.mockito.Mockito.when;

/** When Redis cannot be written, the logout fails as a whole: nothing is left half done on the refresh side. */
class LogoutRedisFailureTest extends AuthHttpTest {

    @MockitoBean RedisJwtDenylist denylist;

    @Test
    void ifTheDenylistWriteFails_theRevocationRollsBack_andTheLogoutCanBeRetried() throws Exception {
        when(denylist.clockSkew()).thenReturn(Duration.ofSeconds(60));
        String email = uniqueEmail();
        register(email, PASSWORD);
        JsonNode login = body(login(email, PASSWORD));
        String refreshToken = login.get("refreshToken").asString();

        doThrow(new IllegalStateException("redis down")).when(denylist).revoke(anyString(), any());
        assertThat(post("/api/v1/auth/logout", Map.of("refreshToken", refreshToken)).statusCode()).isEqualTo(500);
        assertThat(jdbc.queryForObject("select status from refresh_token where token_hash = ?", String.class, TokenHasher.hash(refreshToken)))
                .as("the database change was rolled back with the failed Redis write").isEqualTo("ACTIVE");

        doNothing().when(denylist).revoke(anyString(), any());
        assertThat(post("/api/v1/auth/logout", Map.of("refreshToken", refreshToken)).statusCode()).isEqualTo(204);
        assertThat(jdbc.queryForObject("select status from refresh_token where token_hash = ?", String.class, TokenHasher.hash(refreshToken)))
                .isEqualTo("REVOKED");
    }
}
```

## 7. Order of work

1. Fix `common-security/pom.xml` (section 4, item 1) and check that `mvn -f common-security\pom.xml test` builds again (41 tests).
2. **The bug first.** In identity-service, write `StaleTokenTest.staleToken_keepsItsPermissions_afterTheRoleIsTakenAway` alone and run it: it is **green**, which is the bug (a revoked role still works). Then write `revokeAllSessions_closesTheWindow_forTheStaleAccessToken`: it does not compile (no `SessionRevocationService`) and, once it compiles against a stub, it is red.
3. `common-security`: the classes of 5.1, then the three test classes of 6.1. `mvn -f common-security\pom.xml test`: **56 tests.** Then `install -DskipTests`.
4. identity-service: `V4`, the changed files of 5.2 (the repository and service first), the test base, then the other test classes. `mvn -f identity-service\pom.xml test -DargLine="-Duser.timezone=UTC"`: **114 tests.** Docker must be running (Postgres and Redis containers). `DenylistCostTest` prints a `DENYLIST-COST` line: record yours.
5. Mutation checks (section 8.3) on a scratch copy. **Back up every file you will mutate once, before the first edit, and compare each restore with its backup.** After mutating `common-security`, run `install` before testing identity-service, and again after restoring.
6. By hand (section 8.4): both apps, logout, and the same token on control-api with the denylist off and then on. **Use a separate database for identity** while you do it (`createdb appfleet_i4`, then `SPRING_DATASOURCE_URL=jdbc:postgresql://localhost:55432/appfleet_i4?currentSchema=identity`) only if you want to keep `V4` out of your dev database until you have typed it; Flyway refuses a migration whose text differs from the one it already applied.
7. Results; the plan's I4 row; a concepts-guide lesson; the Outline pages.

## 8. Verification, 2026-10-07 (scratch copy of your I3 tree)

### 8.1 Results

`common-security`: 56 tests, 0 failures (the 41 of before, 15 new). identity-service: 114 tests, 0 failures (the 88 of I3, 26 new).

### 8.2 Measured cost of one denylist lookup

From `DenylistCostTest` (2000 calls after 200 warm-up calls; Redis in a local Docker Desktop container on Windows, port-forwarded, so the round trip is probably longer than on a real network of the same machine; the numbers are this machine's, not a general figure):

| What | Microseconds per call |
|---|---|
| one `RedisJwtDenylist.isRevoked` | 638 to 643 (two runs) |
| `decoder.decode` with the denylist | 638 to 658 |
| `decoder.decode` signature only (`NimbusJwtDecoder` with the public key and no other validator) | 32 to 35 |

The signature check is about 35 Âµs; the denylist lookup, on this setup, is about **18 times** that. The numbers feed section 9.

### 8.3 Mutation checks (each seen red, then restored)

| Mutation | Result |
|---|---|
| M1: logout does not denylist the access tokens | 4 red: `logout_denylistsTheSessionsAccessToken`, `logout_denylistsEveryUnexpiredAccessTokenOfTheFamily`, and two `StaleTokenTest` |
| M2: the family is not revoked on the refresh side | 2 red: `logout_is204_andTheRefreshTokenStopsWorking`, `logout_withAnAlreadyUsedToken_stillEndsTheWholeFamily` |
| M3: `revokeAllSessions` denylists nothing | 2 red in `StaleTokenTest` |
| M4: a Redis failure is swallowed | `LogoutRedisFailureTest` red (the logout answers 204 and revokes nothing in Redis) |
| M5: the access token is never recorded on the link | 4 red: both recording tests and both denylisting tests |
| M6: a key lives until `exp` only, no clock skew | 2 red in `common-security` (`RedisJwtDenylistTest`) and 2 red in identity-service (`RedisDenylistTest`, `LogoutTest`) |
| M7: the validator is not added to the decoder (across the module boundary) | 2 red in `common-security` (`JwtDenylistAutoConfigurationTest`) and 4 red in identity-service |

After restoring every file, checking each against its backup, and reinstalling `common-security`: 56 and 114, 0 failures.

### 8.4 A real logout against the real control-api (2026-10-07)

Postgres and Redis from compose; identity-service from the scratch jar on 8082 (against a **separate database**, so your dev database never saw `V4`); control-api from its own jar, rebuilt so that it contains the new `common-security`; a token for a user who is `DEPLOYER` on a team (the membership inserted by SQL, the admin API being I6). Then:

| Step | Answer |
|---|---|
| control-api `GET /api/v1/applications` with the access token, denylist **off** | 200 |
| identity `POST /logout` with the refresh token | 204 |
| the **same** access token on control-api straight afterwards, denylist **off** | **200** (the window the spec describes) |
| refresh with the logged-out refresh token | 401 |
| the Redis key of that `jti` | exists, **959 seconds** left (900 plus 60 of skew, a few seconds used) |
| control-api restarted with `APPFLEET_SECURITY_JWT_DENYLIST_ENABLED=true`, the same access token | **401**, `WWW-Authenticate: Bearer error="invalid_token"` |
| a **new** login's access token on that control-api | 200 |

The scratch database was dropped afterwards; both apps and the containers were stopped.

## 9. The argument: denylist, or short expiry and rotation

The spec asks for both mechanisms and for the argument. The numbers are the ones this step measured.

- **What each protects.** Short expiry bounds the damage of a leaked or stale access token to its lifetime: here **15 minutes** (`exp - iat`, measured by `theWindowWithoutRevocation_isTheAccessTokenLifetime`). Refresh rotation (I3) means a stolen refresh token is caught on first reuse. The denylist closes the remaining window for a session you know is over, such as a logout or a revoked role: from up to 15 minutes to **the time of one Redis write**. Section 8.4 shows both ends: 200 without the check, 401 with it.
- **What the denylist costs.** A Redis lookup on **every request** of every service that opts in: about 640 Âµs on this setup, against about 35 Âµs for the signature check (section 8.2). That is not a lot in absolute terms, and it is the difference between a request that needs nothing but a public key and one that needs a reachable Redis.
- **The coupling it adds.** With `fail-open: false`, a Redis outage means no request of that service is authorized. With `fail-open: true`, an outage means revoked tokens work again, quietly. Neither is free; the setting makes the choice visible. Without the denylist, the "zero extra calls on the request path" of the spec's definition of done holds.
- **How much it stores.** Only revoked tokens: one key per access token that was alive when its session ended, each for at most 16 minutes. The set is bounded by the logout rate times a quarter of an hour, not by the number of users.
- **What it does not fix.** It does not undo a role change by itself: something has to call `revokeAllSessions` when the role changes (I6). And it does not reach a service that has not opted in.
- **Recommendation.** Keep the 15-minute lifetime and rotation as the base, which is what makes the system correct without Redis. Turn the denylist on **per service and per environment** where "this person must be locked out now" matters more than the extra dependency: an admin service, or all of production after an incident. control-api stays off by default, as decided in the plan (question 2).

## 10. What this step deliberately does not do

- No admin API and no call to `revokeAllSessions` on a role change or a deactivation (I6).
- No `jti` check inside identity-service itself: it does not yet authenticate its own endpoints.
- No metric on the number of denylist keys.
- No logout-everywhere endpoint for a signed-in user (`revokeAllSessions` exists; the endpoint is I6).
- No change in control-api's code, and no default-on denylist.
- The cost numbers are from one machine and one Docker setup; a deployment needs its own measurement.

## 11. Open questions (yours to decide)

1. **`fail-open` default.** Built: fail-closed. Alternative: fail-open for availability. Recommendation: fail-closed, since the property is off unless someone chose the denylist for its security.
2. **Turn the denylist on in control-api's `local` profile?** Recommendation: no. Leave it off and switch it on by environment variable when you want to see it (section 8.4).
3. **Keep `access_jti` on every link or only on the newest?** Built: on every link, so a logout can cover tokens of earlier links that are still alive. The cost is two columns per row and nothing else.

## Definition of done

- [x] `common-security/pom.xml` fixed (two bad dependencies removed, Redis starter added); `mvn -f common-security\pom.xml test` green
- [x] The bug first: the stale-token test green (the bug), the revoke test red, then green
- [x] `common-security`: 56 tests green; installed
- [x] identity-service: 114 tests green, `V4` in place, the Redis container in the test base
- [x] A logout denylists every unexpired access token of the family, and its key lives `exp` plus the skew (tests)
- [x] A Redis failure rolls the whole logout back (test)
- [x] The cost numbers of your machine recorded (`DENYLIST-COST`)
- [x] The seven mutation checks seen red on a scratch copy and restored
- [x] By hand: a logged-out access token is 200 on control-api with the denylist off and 401 with it on
- [x] The argument of section 9 read and agreed, or changed
- [x] Results written; the plan's I4 row, the concepts guide (`sec-denylist`) and Outline updated

## 12. Results (built by hand, 2026-10-07)

- Real tree: `mvn -f common-security\pom.xml install`: **56 tests, 0 failures**. `mvn -f identity-service\pom.xml test`: **114 tests, 0 failures**. `DenylistCostTest` on your machine: **lookup 606 µs, decode with the denylist 641 µs, signature only 35 µs** (the earlier runs gave 600 to 643 and 32 to 37, so the section 8.2 numbers hold).
- **The seven mutation checks (section 8.3) were repeated on a copy of your real trees on 2026-10-07: all seven red.** M1 (no denylisting): 4 red; M2 (family not revoked): 2 red; M3 (`revokeAllSessions` denylists nothing): 2 red; M4 (Redis failure swallowed): `LogoutRedisFailureTest` red; M5 (access token never recorded): 2 failures and 2 errors; M6 (no clock skew in the key): 2 red in `common-security` and 2 in identity-service; M7 (validator not wired): 2 red in `common-security` and 4 in identity-service. After restoring every file, reinstalling your real `common-security`, and running both modules in full: 56 and 114 tests, 0 failures. The bug-first order of section 7 was not recorded separately on the real tree.
- **Six errors on the way, all from the code not matching the doc, each found by the build or the tests at once:**
  1. `common-security/pom.xml` still had the self-referencing `test-jar` dependency (Maven: "is referencing itself"). Section 1 had warned about it.
  2. After removing the two extra dependencies, the **compile-scope** `spring-boot-starter-validation` was gone and only the `test`-scope duplicate remained, so `JwtProperties` did not compile (`package jakarta.validation.constraints does not exist`). The scope had to come off the remaining one.
  3. Three `common-security` tests (`JwtDenylistAutoConfigurationTest`, `JwtDenylistValidatorTest`, `RedisJwtDenylistTest`) had been put in identity-service's test tree, so identity ran 129 tests and `common-security` 41. A first sign: they only compiled there by the accident of a shared package name. They moved to `common-security`, and the `package` line changed.
  4. `@EnableConfigurationProperties(JwtProperties.class)` did not list `DenylistProperties`: every identity test that starts Spring failed with `No qualifying bean of type DenylistProperties`.
  5. `jwtDecoder` was still the I2 version with a fixed validator list, so the denylist validator existed but was never used (2 `common-security` tests red: a revoked token accepted).
  6. After replacing it, one closing parenthesis was missing in `new ArrayList<>(List.of(...))` (`')' or ',' expected`, line 44).
  A pattern worth keeping: **an "install" of `common-security` that fails leaves the old jar in `~/.m2`, so identity-service keeps testing the old code and fails for a reason that looks unrelated.** Always read the first failure of `common-security` first.
- **By hand, from the real build** (Postgres and Redis from compose; identity-service and control-api from their own jars, profile `local`; a separate scratch database, dropped afterwards; all stopped):
  1. control-api with the denylist **off**: `GET /api/v1/applications` with the access token: 200. `POST /logout`: 204. The same access token straight afterwards: **200** (the window). Refresh with the logged-out refresh token: 401. Redis key of that `jti`: **959 seconds** left.
  2. control-api restarted with `APPFLEET_SECURITY_JWT_DENYLIST_ENABLED=true`, the same access token: **401**, `WWW-Authenticate: Bearer error="invalid_token"`.
- The concepts-guide lesson `sec-denylist` was added the same day and tested by clicking its controls in headless Chrome (denylist off: 200; on: 401; on with Redis down: 401 when fail-closed, 200 when fail-open).
- The web-console sign-in screen (`docs/design/ux/web-console-sign-in.md`) exercises exactly this flow in a browser.