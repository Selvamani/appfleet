# identity-service — I2: register, login and the access token

**Spec:** [02-IDENTITY-SERVICE.md](../../specs/project/02-IDENTITY-SERVICE.md), *Token design* and *Endpoints* · Step **I2** of [identity-service-plan.md](identity-service-plan.md) · Predecessor: [identity-i1-domain-and-schema.md](identity-i1-domain-and-schema.md) (the data model and the `PermissionResolver` this step calls) · Companion: [control-api-s4-1-jwt-validation.md](../control-api/control-api-s4-1-jwt-validation.md) (section 3, decision 5: the claim contract this step issues). **Status: built and closed 2026-10-06. The code in sections 5 and 6 was run on a scratch copy first (section 8), then typed into the real tree by hand: 58 tests green, and a token from the running identity-service accepted by the running control-api (section 10).**

I2 is the first step that produces something the rest of the system uses: a signed access token. It adds `POST /api/v1/auth/register` and `POST /api/v1/auth/login`, an `AccessTokenIssuer` that builds exactly the claims control-api already validates, and a cross-module test in which `common-security`'s own decoder accepts the token. There is no refresh token yet (I3) and no lockout (I5).

## 1. What already exists

- I1 is in your tree: the `identity` schema, `AppUser` and its repository, roles and the seeded permissions, `TeamMembershipRepository.findGrantsByUserId`, `PermissionResolver`, a chain that refuses everything but the two actuator probes. 27 tests.
- `common-security` (installed in `~/.m2`, with a `tests` jar) holds the validating side: `JwtDecoder` with RS256 only, `iss`, `aud`, `exp` and `sub` validators, and `AppfleetJwtAuthenticationConverter`, which turns `teams` and `perms` into authorities. It starts only when `appfleet.security.jwt.public-key-location` is set, which identity-service does not set in production. Its test jar carries the dev key pair under `keys/` (`dev-private.pem`, `dev-public.pem`) and `TestJwt`, the reference for the claim shape.
- `nimbus-jose-jwt` is on the classpath through `common-security`; `BCryptPasswordEncoder` comes with `spring-boot-starter-security`; `RsaKeyConverters.pkcs8()` reads a PEM private key.
- Not in the pom yet: `spring-boot-starter-validation` (request validation) and `common-security` as a **test-jar** (the dev keys).
- Your `AppUser` has no `isActive()` (the I1 doc had one); I2 uses `getStatus() == UserStatus.ACTIVE`, so nothing needs to change there.
- There is no problem-shape handling in identity-service yet, and no correlation id: this step copies the pieces from control-api (plan question 5, decided).

## 2. Behaviour

| Request | Answer |
|---|---|
| `POST /api/v1/auth/register` `{email, displayName, password}` | **201** `{id, email, displayName}`; the email is stored lower case; the password is stored as a BCrypt hash and never returned |
| same, an email already registered (any letter case) | **409** `conflict` |
| same, invalid email, blank display name, password shorter than 12 or longer than 72 characters, or longer than 72 **bytes** in UTF-8 | **400** `validation-failed` with `errors[{field, message}]` |
| same, a body that is not JSON | **400** `malformed-request` |
| `POST /api/v1/auth/login` `{email, password}` | **200** `{accessToken, tokenType: "Bearer", expiresIn: 900}`; the response is not cacheable |
| same, unknown email, wrong password, or deactivated user | **401** `unauthorized`, **one identical body** for all three (apart from the correlation id) |
| same, blank password | **400** |
| `GET` on either path, or any other path | **403**, as in I1 |
| `/actuator/health`, `/actuator/info` | open, as in I1 |

Errors use control-api's shape: `type` `urn:appfleet:problem:<slug>`, `title`, `status`, `detail`, `instance`, `correlationId`, and `errors[]` on a validation failure, served as `application/problem+json`.

The access token, in the contract of S4.1:

| Part | Value |
|---|---|
| header | `alg` RS256, `typ` JWT (no `kid` until I8) |
| `iss` | `appfleet.identity.jwt.issuer`, `appfleet-identity` |
| `sub` | the user id (UUID string) |
| `aud` | `["appfleet"]` |
| `jti` | a new UUID on every login |
| `iat`, `exp` | `exp` = `iat` + 15 minutes (the configured TTL, never more than 15 minutes) |
| `teams` | `{ "<teamId>": ["application:create", ...] }`: for each of the user's grants, the permissions of the role **including everything the hierarchy implies**, sorted; **absent** (not empty) when the user has no grants, as `TestJwt` does |
| `perms` | not issued: there is no global role in the model yet |
| `roles` | never issued; control-api does not read it |

## 3. Decisions

1. **The claim contract is built to, not changed.** The cross-module test (section 6, `AccessTokenContractTest`) decodes the issued token with `common-security`'s own `JwtDecoder` and maps it with its own `AppfleetJwtAuthenticationConverter`. If identity and control-api ever disagree about a claim, an identity-service test fails.
2. **The private key comes from a file, with no default.** `appfleet.identity.jwt.private-key-location` is `${JWT_PRIVATE_KEY_LOCATION}`; a missing variable stops startup with an unresolved placeholder, and a missing or unreadable file stops the `AccessTokenIssuer` from being built (tested without Spring). `application-local.yml` points at the dev key under `common-security`'s test resources by file path; tests use the same key through the test jar. The dev key must never be used outside a dev machine.
3. **The TTL is checked at startup.** `IdentityJwtProperties` refuses a TTL that is zero, negative or longer than 15 minutes (the spec). A property cannot quietly turn a 15-minute token into a day-long one.
4. **BCrypt cost is a property, 12 by default.** Tests use 4 (the minimum), because a cost-12 hash takes a noticeable time and the suite hashes dozens of passwords. The test that checks the stored hash starts with `$2a$04$` shows the property is really used.
5. **Passwords longer than 72 bytes are refused, not truncated.** BCrypt reads only 72 bytes. `@Size(max = 72)` counts characters, and 40 accented characters are 80 bytes, so the service checks the byte length and answers 400 with the field `password`. A silent truncation would let two different long passwords match.
6. **Login failures are one answer.** Unknown email, wrong password and a deactivated user all raise `InvalidCredentialsException`, and a test compares the three response bodies. **Known gap, left for I5:** the unknown-user path skips the BCrypt check and is therefore faster than the wrong-password path. I2 does not measure it; I5 builds the timing comparison and fixes it with a dummy hash.
7. **Register and login treat the email differently on purpose.** Registration validates the address with `@Email`, so surrounding spaces are a 400, not silently trimmed. Login only normalises (trim, lower case) and then looks the user up, so `" ADA@X.IO "` still logs in. A duplicate registration answers 409, which does reveal that an address is registered; that is inherent in sign-up and is the one place the spec's no-enumeration rule is deliberately relaxed (the spec's rule is about login).
8. **At most 10 team grants per token, from measurement.** The plan said 20 and "measure". Measured on 2026-10-06 (characters of the compact token): no grants 604, one VIEWER team 722, one DEPLOYER team 776, one ADMIN team 866, 5 DEPLOYER teams 1411, 10 ADMIN teams 3098, **20 ADMIN teams 5578**. The spec's "about 1 KB" is already exceeded by the signature and header alone (604 characters with no grants). Ten teams of ADMIN, the worst case, stay under 4 KB, the smallest header limit commonly met in front of an application; twenty do not. So the cap is 10 and the plan's question 6 changes. A user above the cap gets no token (`IllegalStateException`, a 500 and a log line): the real refusal belongs where memberships are created, in I6. A test pins both the cap and the 4 KB bound.
9. **`teams` is absent when there are no grants.** An empty map and an absent claim read the same to the converter, but `TestJwt` omits it, and one rule for both is easier to remember.
10. **The cache headers are not set by the controller.** A token response must not be cached (RFC 6749, 5.1). Spring Security's default header writers already send `Cache-Control: no-cache, no-store, max-age=0, must-revalidate` and `Pragma: no-cache`. A first version set them in the controller, and the mutation that removed them left the test green, so they were redundant and are gone. `LoginTest` pins the result, and a mutation that disables the cache-control header writer turns it red.
11. **`Jwt.getIssuer()` throws for this issuer.** Spring converts `iss` to a URL, and `appfleet-identity` is not one (found in the cross-module test). The validators in `common-security` compare the string claim, so nothing breaks today; the rule for any code in any service is to read `getClaimAsString("iss")`.
12. **Copied, not shared.** `CorrelationIdFilter` and a small `ApiExceptionHandler` are copies of control-api's (plan question 5: decide again at I6, when a fourth handler is needed). The handler has five cases only; the full status matrix stays in control-api.
13. **No refresh token and no logout yet.** The login response has exactly three fields; a test asserts there is no `refreshToken`, so I3 adds it on purpose and not by accident.

## 4. Changes to your existing files

1. **`identity-service/pom.xml`**: add the validation starter next to the other starters, and the `common-security` test jar next to the other test dependencies:

```xml
    <dependency>
      <groupId>org.springframework.boot</groupId>
      <artifactId>spring-boot-starter-validation</artifactId>
    </dependency>

    <dependency>
      <groupId>io.appfleet</groupId>
      <artifactId>common-security</artifactId>
      <version>${project.version}</version>
      <type>test-jar</type>
      <scope>test</scope>
    </dependency>
```
   The test jar must be in `~/.m2`: run `mvn -f common-security\pom.xml install -DskipTests` once (and again after any change in `common-security`).

2. **`identity-service/src/main/resources/application.yml`**: add above `server:`:

```yaml
appfleet:
  identity:
    jwt:
      # no default: a missing key must stop startup, not the first login
      private-key-location: ${JWT_PRIVATE_KEY_LOCATION}
      issuer: appfleet-identity
      audience: appfleet
      access-token-ttl: 15m
    password:
      bcrypt-cost: 12
```
3. **New file `identity-service/src/main/resources/application-local.yml`**, for running the app by hand with `SPRING_PROFILES_ACTIVE=local`:

**`identity-service/src/main/resources/application-local.yml`**

```yaml
# Local runs only: the dev private key lives with the test fixtures of common-security. Never use it elsewhere.
appfleet:
  identity:
    jwt:
      private-key-location: file:../common-security/src/test/resources/keys/dev-private.pem
```

4. **`SecurityConfig.java`**: replace the whole file with the one in section 5.5 (it adds the two POST paths).
5. **`IdentityIntegrationTest.java`**: replace the `properties = { ... }` of `@SpringBootTest` with the list in section 6 (it adds the private key, a cheap BCrypt cost, and the validating side's settings).

## 5. Main code

### 5.1 Settings

**`identity-service/src/main/java/io/appfleet/identity/config/IdentityJwtProperties.java`**

```java
package io.appfleet.identity.config;

import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.NotNull;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;
import org.springframework.core.io.Resource;
import org.springframework.validation.annotation.Validated;

import java.time.Duration;

/**
 * What identity-service needs to sign an access token. The matching public key and the same issuer and audience are
 * what common-security's appfleet.security.jwt.* settings hold on the validating side.
 */
@ConfigurationProperties("appfleet.identity.jwt")
@Validated
public record IdentityJwtProperties(
        @NotNull Resource privateKeyLocation,
        @NotBlank String issuer,
        @DefaultValue("appfleet") @NotBlank String audience,
        @DefaultValue("15m") Duration accessTokenTtl
) {
    /** The spec: access tokens live at most 15 minutes. */
    public static final Duration MAX_TTL = Duration.ofMinutes(15);

    public IdentityJwtProperties {
        if (accessTokenTtl == null || accessTokenTtl.isZero() || accessTokenTtl.isNegative() || accessTokenTtl.compareTo(MAX_TTL) > 0)
            throw new IllegalArgumentException("appfleet.identity.jwt.access-token-ttl must be above 0 and at most 15 minutes, was " + accessTokenTtl);
    }
}
```

**`identity-service/src/main/java/io/appfleet/identity/config/PasswordProperties.java`**

```java
package io.appfleet.identity.config;

import jakarta.validation.constraints.Max;
import jakarta.validation.constraints.Min;
import org.springframework.boot.context.properties.ConfigurationProperties;
import org.springframework.boot.context.properties.bind.DefaultValue;
import org.springframework.validation.annotation.Validated;

/** BCrypt cost. 12 is the production value (the spec); tests lower it, because each hash at cost 12 takes a noticeable time. */
@ConfigurationProperties("appfleet.identity.password")
@Validated
public record PasswordProperties(
        @DefaultValue("12") @Min(4) @Max(31) int bcryptCost
) {}
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
@EnableConfigurationProperties({IdentityJwtProperties.class, PasswordProperties.class})
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

### 5.2 The token issuer

**`identity-service/src/main/java/io/appfleet/identity/auth/AccessTokenIssuer.java`**

```java
package io.appfleet.identity.auth;

import com.nimbusds.jose.JOSEException;
import com.nimbusds.jose.JOSEObjectType;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.RSASSASigner;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import io.appfleet.identity.config.IdentityJwtProperties;
import io.appfleet.identity.rbac.PermissionResolver;
import io.appfleet.identity.team.TeamMembershipRepository;
import io.appfleet.identity.team.TeamRole;
import io.appfleet.identity.user.AppUser;
import org.springframework.security.converter.RsaKeyConverters;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.io.IOException;
import java.io.InputStream;
import java.security.interfaces.RSAPrivateKey;
import java.time.Clock;
import java.time.Instant;
import java.util.Date;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;

/**
 * Signs an access token that carries exactly the claim contract of control-api S4.1: iss, sub, aud, jti, iat, exp,
 * and teams (team id to the permission list that team grants). It never writes a roles claim.
 */
@Component
public class AccessTokenIssuer {

    /** Most team grants one token may carry; the measured sizes behind it are in the I2 doc. */
    public static final int MAX_TEAMS = 10;

    private final IdentityJwtProperties properties;
    private final RSAPrivateKey key;
    private final TeamMembershipRepository memberships;
    private final PermissionResolver resolver;
    private final Clock clock;

    public AccessTokenIssuer(IdentityJwtProperties properties, TeamMembershipRepository memberships,
                             PermissionResolver resolver, Clock clock) throws IOException {
        this.properties = properties;
        this.memberships = memberships;
        this.resolver = resolver;
        this.clock = clock;
        try (InputStream in = properties.privateKeyLocation().getInputStream()) {
            this.key = RsaKeyConverters.pkcs8().convert(in);   // a missing or unreadable key fails startup
        }
    }

    @Transactional(readOnly = true)
    public IssuedToken issue(AppUser user) {
        List<TeamRole> grants = memberships.findGrantsByUserId(user.getId());
        if (grants.size() > MAX_TEAMS)
            throw new IllegalStateException("user " + user.getId() + " has " + grants.size()
                    + " team grants; one token carries at most " + MAX_TEAMS);

        Map<String, List<String>> byRole = new HashMap<>();
        Map<String, List<String>> teams = new LinkedHashMap<>();
        for (TeamRole grant : grants) {
            teams.put(grant.teamId().toString(), byRole.computeIfAbsent(grant.roleName(),
                    role -> resolver.permissionsFor(role).stream().sorted().toList()));
        }

        Instant issuedAt = clock.instant();
        Instant expiresAt = issuedAt.plus(properties.accessTokenTtl());
        String jti = UUID.randomUUID().toString();

        JWTClaimsSet.Builder claims = new JWTClaimsSet.Builder()
                .issuer(properties.issuer())
                .subject(user.getId().toString())
                .audience(properties.audience())
                .jwtID(jti)
                .issueTime(Date.from(issuedAt))
                .expirationTime(Date.from(expiresAt));
        if (!teams.isEmpty()) claims.claim("teams", teams);   // absent, not empty, when the user has no grants (as TestJwt does)

        try {
            SignedJWT jwt = new SignedJWT(
                    new JWSHeader.Builder(JWSAlgorithm.RS256).type(JOSEObjectType.JWT).build(), claims.build());
            jwt.sign(new RSASSASigner(key));
            return new IssuedToken(jwt.serialize(), issuedAt, expiresAt, jti);
        } catch (JOSEException e) {
            throw new IllegalStateException("could not sign the access token", e);
        }
    }

    public record IssuedToken(String value, Instant issuedAt, Instant expiresAt, String jti) {}
}
```

### 5.3 The endpoints

**`identity-service/src/main/java/io/appfleet/identity/auth/AuthDtos.java`**

```java
package io.appfleet.identity.auth;

import jakarta.validation.constraints.Email;
import jakarta.validation.constraints.NotBlank;
import jakarta.validation.constraints.Size;

import java.util.UUID;

/** The request and response bodies of the auth endpoints. Records, never entities. */
public final class AuthDtos {

    private AuthDtos() {}

    public record RegisterRequest(
            @NotBlank @Email @Size(max = 254) String email,
            @NotBlank @Size(max = 100) String displayName,
            @NotBlank @Size(min = 12, max = 72) String password) {}

    public record LoginRequest(
            @NotBlank String email,
            @NotBlank String password) {}

    public record RegisteredUser(UUID id, String email, String displayName) {}

    public record TokenResponse(String accessToken, String tokenType, long expiresIn) {}
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

    /** BCrypt reads only the first 72 bytes, so a longer password is refused instead of silently truncated. */
    public static class PasswordTooLongException extends RuntimeException {
        public PasswordTooLongException() { super("password must be at most 72 bytes in UTF-8"); }
    }
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
import io.appfleet.identity.user.AppUser;
import io.appfleet.identity.user.UserRepository;
import io.appfleet.identity.user.UserStatus;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.time.Duration;

@Service
public class AuthService {

    private final UserRepository users;
    private final PasswordEncoder encoder;
    private final AccessTokenIssuer issuer;

    public AuthService(UserRepository users, PasswordEncoder encoder, AccessTokenIssuer issuer) {
        this.users = users;
        this.encoder = encoder;
        this.issuer = issuer;
    }

    @Transactional
    public RegisteredUser register(RegisterRequest request) {
        if (request.password().getBytes(StandardCharsets.UTF_8).length > 72) throw new PasswordTooLongException();
        String email = AppUser.normalize(request.email());
        if (users.existsByEmail(email)) throw new EmailAlreadyRegisteredException();
        try {
            AppUser saved = users.save(new AppUser(email, request.displayName().trim(), encoder.encode(request.password())));
            return new RegisteredUser(saved.getId(), saved.getEmail(), saved.getDisplayName());
        } catch (DataIntegrityViolationException e) {
            throw new EmailAlreadyRegisteredException();   // two registrations raced past existsByEmail; the unique index decided
        }
    }

    @Transactional(readOnly = true)
    public TokenResponse login(LoginRequest request) {
        AppUser user = users.findByEmail(AppUser.normalize(request.email())).orElse(null);
        if (user == null || user.getStatus() != UserStatus.ACTIVE || !encoder.matches(request.password(), user.getPasswordHash()))
            throw new InvalidCredentialsException();
        AccessTokenIssuer.IssuedToken token = issuer.issue(user);
        return new TokenResponse(token.value(), "Bearer", Duration.between(token.issuedAt(), token.expiresAt()).toSeconds());
    }
}
```

**`identity-service/src/main/java/io/appfleet/identity/auth/AuthController.java`**

```java
package io.appfleet.identity.auth;

import io.appfleet.identity.auth.AuthDTOs.LoginRequest;
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
     * A token response must not be cached anywhere (RFC 6749, section 5.1). The Cache-Control and Pragma headers come
     * from Spring Security's default header writers, not from this method; LoginTest pins the result.
     */
    @PostMapping("/login")
    ResponseEntity<TokenResponse> login(@Valid @RequestBody LoginRequest request) {
        return ResponseEntity.ok(auth.login(request));
    }
}
```

### 5.4 The problem shape and the correlation id

**`identity-service/src/main/java/io/appfleet/identity/web/CorrelationIdFilter.java`**

```java
package io.appfleet.identity.web;

import jakarta.servlet.FilterChain;
import jakarta.servlet.ServletException;
import jakarta.servlet.http.HttpServletRequest;
import jakarta.servlet.http.HttpServletResponse;
import org.slf4j.MDC;
import org.springframework.core.annotation.Order;
import org.springframework.stereotype.Component;
import org.springframework.web.filter.OncePerRequestFilter;

import java.io.IOException;
import java.util.UUID;
import java.util.regex.Pattern;

import static org.springframework.core.Ordered.HIGHEST_PRECEDENCE;

/** Copied from control-api (plan question 5): the same header, the same rule for an incoming id. */
@Component
@Order(HIGHEST_PRECEDENCE)
public class CorrelationIdFilter extends OncePerRequestFilter {

    public static final String HEADER = "X-Correlation-Id";
    public static final String MDC_KEY = "correlationId";
    public static final String ATTRIBUTE = CorrelationIdFilter.class.getName() + ".id";

    private static final Pattern VALID = Pattern.compile("[A-Za-z0-9._-]{1,64}");

    @Override
    protected void doFilterInternal(HttpServletRequest request, HttpServletResponse response, FilterChain chain) throws ServletException, IOException {
        String incoming = request.getHeader(HEADER);
        String id = (incoming != null && VALID.matcher(incoming).matches()) ? incoming : UUID.randomUUID().toString();

        MDC.put(MDC_KEY, id);
        request.setAttribute(ATTRIBUTE, id);
        response.setHeader(HEADER, id);
        try {
            chain.doFilter(request, response);
        } finally {
            MDC.remove(MDC_KEY);
        }
    }
}
```

**`identity-service/src/main/java/io/appfleet/identity/web/ApiExceptionHandler.java`**

```java
package io.appfleet.identity.web;

import io.appfleet.identity.auth.AuthExceptions.EmailAlreadyRegisteredException;
import io.appfleet.identity.auth.AuthExceptions.InvalidCredentialsException;
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

### 5.5 The chain

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

    // I2: the two probes and POST register and login are open; everything else is refused.
    // Later steps open their own paths here; each service writes its own chain.
    @Bean
    SecurityFilterChain chain(HttpSecurity http) throws Exception {
        http.authorizeHttpRequests(a -> a
                .requestMatchers("/actuator/health", "/actuator/info").permitAll()
                .requestMatchers(HttpMethod.POST, "/api/v1/auth/register", "/api/v1/auth/login").permitAll()
                .anyRequest().denyAll())
                .csrf(c -> c.disable())
                .sessionManagement(s -> s.sessionCreationPolicy(SessionCreationPolicy.STATELESS));
        return http.build();
    }
}
```

## 6. Tests

Under `identity-service/src/test/java/io/appfleet/identity/`. 31 new tests in six classes (`RegisterTest` 12, `LoginTest` 6, `AccessTokenContractTest` 6, `IssuerSettingsTest` 4, `TokenSizeTest` 3, and the helper base `AuthHttpTest`). The 27 tests of I1 stay as they are: 58 in all.

In `IdentityIntegrationTest.java`, the `@SpringBootTest` properties become:

```java
@SpringBootTest(webEnvironment = SpringBootTest.WebEnvironment.RANDOM_PORT, properties = {
        "management.health.redis.enabled=false",
        "spring.jpa.properties.hibernate.generate_statistics=true",
        "appfleet.identity.jwt.private-key-location=classpath:keys/dev-private.pem",
        "appfleet.identity.password.bcrypt-cost=4",
        // the validating side, from common-security, so a test can decode what the issuer signed
        "appfleet.security.jwt.public-key-location=classpath:keys/dev-public.pem",
        "appfleet.security.jwt.issuer=appfleet-identity"
})
```
**`identity-service/src/test/java/io/appfleet/identity/AuthHttpTest.java`**

```java
package io.appfleet.identity;

import org.springframework.beans.factory.annotation.Value;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.util.Map;
import java.util.UUID;

/** Real HTTP helpers for the auth endpoints (MockMvc would skip the security chain). */
public abstract class AuthHttpTest extends IdentityIntegrationTest {

    protected static final String PASSWORD = "correct horse battery";

    @Value("${local.server.port}")
    protected int port;

    protected final HttpClient client = HttpClient.newHttpClient();
    protected final JsonMapper json = new JsonMapper();

    protected HttpResponse<String> postRaw(String path, String body) throws Exception {
        HttpRequest request = HttpRequest.newBuilder(URI.create("http://localhost:" + port + path))
                .header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(body)).build();
        return client.send(request, HttpResponse.BodyHandlers.ofString());
    }

    protected HttpResponse<String> post(String path, Map<String, ?> body) throws Exception {
        return postRaw(path, json.writeValueAsString(body));
    }

    protected HttpResponse<String> get(String path) throws Exception {
        return client.send(HttpRequest.newBuilder(URI.create("http://localhost:" + port + path)).GET().build(),
                HttpResponse.BodyHandlers.ofString());
    }

    protected JsonNode body(HttpResponse<String> response) {
        return json.readTree(response.body());
    }

    protected static String uniqueEmail() {
        return "u-" + UUID.randomUUID() + "@example.io";
    }

    protected HttpResponse<String> register(String email, String password) throws Exception {
        return post("/api/v1/auth/register", Map.of("email", email, "displayName", "Test User", "password", password));
    }

    protected HttpResponse<String> login(String email, String password) throws Exception {
        return post("/api/v1/auth/login", Map.of("email", email, "password", password));
    }

    /** Registers a user and logs in; returns the access token. */
    protected String tokenFor(String email) throws Exception {
        register(email, PASSWORD);
        return body(login(email, PASSWORD)).get("accessToken").asString();
    }
}
```

**`identity-service/src/test/java/io/appfleet/identity/RegisterTest.java`**

```java
package io.appfleet.identity;

import org.junit.jupiter.api.Test;
import org.springframework.security.crypto.bcrypt.BCryptPasswordEncoder;
import tools.jackson.databind.JsonNode;

import java.net.http.HttpResponse;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class RegisterTest extends AuthHttpTest {

    @Test
    void register_is201_andTheBodyHasNoPasswordField() throws Exception {
        String email = uniqueEmail();
        HttpResponse<String> r = register(email, PASSWORD);
        assertThat(r.statusCode()).isEqualTo(201);
        JsonNode b = body(r);
        assertThat(b.get("email").asString()).isEqualTo(email);
        assertThat(b.get("id").asString()).isNotBlank();
        assertThat(b.has("password")).isFalse();
        assertThat(b.has("passwordHash")).isFalse();
        assertThat(r.body()).doesNotContain(PASSWORD);
    }

    @Test
    void email_isStoredLowerCase() throws Exception {
        String lower = uniqueEmail();
        HttpResponse<String> r = register(lower.toUpperCase(), PASSWORD);
        assertThat(r.statusCode()).isEqualTo(201);
        assertThat(body(r).get("email").asString()).isEqualTo(lower);
        assertThat(jdbc.queryForObject("select count(*) from app_user where email = ?", Integer.class, lower)).isEqualTo(1);
    }

    @Test
    void password_isStoredAsABcryptHashAtTheConfiguredCost() throws Exception {
        String email = uniqueEmail();
        register(email, PASSWORD);
        String hash = jdbc.queryForObject("select password_hash from app_user where email = ?", String.class, email);
        assertThat(hash).startsWith("$2a$04$");   // cost 4 in the tests; 12 in production
        assertThat(hash).isNotEqualTo(PASSWORD);
        assertThat(new BCryptPasswordEncoder().matches(PASSWORD, hash)).isTrue();
    }

    @Test
    void sameEmail_is409_inTheProblemShape_withTheCorrelationId() throws Exception {
        String email = uniqueEmail();
        register(email, PASSWORD);
        HttpResponse<String> r = register(email, PASSWORD);
        assertThat(r.statusCode()).isEqualTo(409);
        assertThat(r.headers().firstValue("Content-Type").orElse("")).startsWith("application/problem+json");
        JsonNode b = body(r);
        assertThat(b.get("type").asString()).isEqualTo("urn:appfleet:problem:conflict");
        assertThat(b.get("status").asInt()).isEqualTo(409);
        assertThat(b.get("correlationId").asString()).isEqualTo(r.headers().firstValue("X-Correlation-Id").orElse("?"));
    }

    @Test
    void sameEmailInAnotherCase_is409() throws Exception {
        String email = uniqueEmail();
        register(email, PASSWORD);
        assertThat(register(email.toUpperCase(), PASSWORD).statusCode()).isEqualTo(409);
    }

    @Test
    void emailWithSurroundingSpaces_is400_itIsNotSilentlyTrimmed() throws Exception {
        assertThat(register("  " + uniqueEmail() + " ", PASSWORD).statusCode()).isEqualTo(400);
    }

    @Test
    void invalidEmail_is400_withTheFieldNamed() throws Exception {
        HttpResponse<String> r = register("not-an-email", PASSWORD);
        assertThat(r.statusCode()).isEqualTo(400);
        JsonNode b = body(r);
        assertThat(b.get("type").asString()).isEqualTo("urn:appfleet:problem:validation-failed");
        assertThat(b.get("errors").toString()).contains("\"field\":\"email\"");
    }

    @Test
    void shortPassword_is400() throws Exception {
        HttpResponse<String> r = register(uniqueEmail(), "short");
        assertThat(r.statusCode()).isEqualTo(400);
        assertThat(body(r).get("errors").toString()).contains("\"field\":\"password\"");
    }

    @Test
    void passwordOf72CharactersButMoreThan72Bytes_is400_notSilentlyTruncated() throws Exception {
        String longInBytes = "é".repeat(40);   // 40 characters, 80 bytes in UTF-8
        HttpResponse<String> r = register(uniqueEmail(), longInBytes);
        assertThat(r.statusCode()).isEqualTo(400);
        assertThat(body(r).get("errors").toString()).contains("\"field\":\"password\"").contains("72 bytes");
    }

    @Test
    void blankDisplayName_is400() throws Exception {
        HttpResponse<String> r = post("/api/v1/auth/register", Map.of("email", uniqueEmail(), "displayName", " ", "password", PASSWORD));
        assertThat(r.statusCode()).isEqualTo(400);
        assertThat(body(r).get("errors").toString()).contains("\"field\":\"displayName\"");
    }

    @Test
    void malformedJson_is400_asMalformedRequest() throws Exception {
        HttpResponse<String> r = postRaw("/api/v1/auth/register", "{not json");
        assertThat(r.statusCode()).isEqualTo(400);
        assertThat(body(r).get("type").asString()).isEqualTo("urn:appfleet:problem:malformed-request");
    }

    @Test
    void get_onRegister_isRefused() throws Exception {
        assertThat(get("/api/v1/auth/register").statusCode()).isEqualTo(403);
    }
}
```

**`identity-service/src/test/java/io/appfleet/identity/LoginTest.java`**

```java
package io.appfleet.identity;

import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

import java.net.http.HttpResponse;
import java.util.LinkedHashMap;
import java.util.Map;

import static org.assertj.core.api.Assertions.assertThat;

class LoginTest extends AuthHttpTest {

    @Test
    void login_returnsABearerTokenThatExpiresIn900Seconds_andIsNotCacheable() throws Exception {
        String email = uniqueEmail();
        register(email, PASSWORD);
        HttpResponse<String> r = login(email, PASSWORD);
        assertThat(r.statusCode()).isEqualTo(200);
        JsonNode b = body(r);
        assertThat(b.get("tokenType").asString()).isEqualTo("Bearer");
        assertThat(b.get("expiresIn").asLong()).isEqualTo(900);
        assertThat(b.get("accessToken").asString().split("\\.")).hasSize(3);
        assertThat(r.headers().firstValue("Cache-Control").orElse("")).contains("no-store");
        assertThat(r.headers().firstValue("Pragma").orElse("")).isEqualTo("no-cache");
        assertThat(b.has("refreshToken")).as("refresh tokens arrive with I3").isFalse();
    }

    @Test
    void emailIsMatchedWithoutRegardToCaseAndSpaces() throws Exception {
        String email = uniqueEmail();
        register(email, PASSWORD);
        assertThat(login("  " + email.toUpperCase() + " ", PASSWORD).statusCode()).isEqualTo(200);
    }

    /** One message for three different reasons, so the response does not say which of them it was. */
    @Test
    void unknownUser_wrongPassword_andDeactivatedUser_areOneIndistinguishableAnswer() throws Exception {
        String known = uniqueEmail();
        register(known, PASSWORD);
        String deactivated = uniqueEmail();
        register(deactivated, PASSWORD);
        jdbc.update("update app_user set status = 'DEACTIVATED', deactivated_at = now() where email = ?", deactivated);

        Map<String, Object> unknown = withoutPerRequestFields(login(uniqueEmail(), PASSWORD));
        Map<String, Object> wrong = withoutPerRequestFields(login(known, "another correct horse"));
        Map<String, Object> off = withoutPerRequestFields(login(deactivated, PASSWORD));

        assertThat(unknown).containsEntry("status", 401).containsEntry("type", "urn:appfleet:problem:unauthorized");
        assertThat(wrong).isEqualTo(unknown);
        assertThat(off).isEqualTo(unknown);
    }

    @Test
    void aDeactivatedUserWithTheRightPassword_getsNoToken() throws Exception {
        String email = uniqueEmail();
        register(email, PASSWORD);
        jdbc.update("update app_user set status = 'DEACTIVATED', deactivated_at = now() where email = ?", email);
        HttpResponse<String> r = login(email, PASSWORD);
        assertThat(r.statusCode()).isEqualTo(401);
        assertThat(r.body()).doesNotContain("accessToken");
    }

    @Test
    void blankPassword_is400() throws Exception {
        HttpResponse<String> r = post("/api/v1/auth/login", Map.of("email", uniqueEmail(), "password", ""));
        assertThat(r.statusCode()).isEqualTo(400);
    }

    @Test
    void get_onLogin_isRefused() throws Exception {
        assertThat(get("/api/v1/auth/login").statusCode()).isEqualTo(403);
    }

    private Map<String, Object> withoutPerRequestFields(HttpResponse<String> r) {
        Map<String, Object> m = new LinkedHashMap<>(json.convertValue(body(r), Map.class));
        m.remove("correlationId");
        return m;
    }
}
```

**`identity-service/src/test/java/io/appfleet/identity/AccessTokenContractTest.java`**

```java
package io.appfleet.identity;

import com.nimbusds.jwt.SignedJWT;
import io.appfleet.identity.rbac.RoleRepository;
import io.appfleet.identity.team.Team;
import io.appfleet.identity.team.TeamMembership;
import io.appfleet.identity.team.TeamMembershipRepository;
import io.appfleet.identity.team.TeamRepository;
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

import java.time.Duration;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.stream.Collectors;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * The cross-module test: a token signed by identity-service is decoded by common-security's own decoder (the one
 * control-api runs) and mapped by its own authority converter. If the two modules disagree about a claim, this fails.
 */
class AccessTokenContractTest extends AuthHttpTest {

    @Autowired JwtDecoder decoder;
    @Autowired AppfleetJwtAuthenticationConverter converter;
    @Autowired UserRepository users;
    @Autowired TeamRepository teams;
    @Autowired TeamMembershipRepository memberships;
    @Autowired RoleRepository roles;

    private void grant(String email, Team team, String roleName) {
        AppUser user = users.findByEmail(email).orElseThrow();
        memberships.save(new TeamMembership(user, team, roles.findByName(roleName).orElseThrow()));
    }

    private String loginToken(String email) throws Exception {
        return body(login(email, PASSWORD)).get("accessToken").asString();
    }

    @Test
    void theIssuedToken_isAcceptedByCommonSecuritysDecoder_withTheContractClaims() throws Exception {
        String email = uniqueEmail();
        register(email, PASSWORD);
        Team a = teams.save(new Team("a-" + UUID.randomUUID()));
        Team b = teams.save(new Team("b-" + UUID.randomUUID()));
        grant(email, a, "DEPLOYER");
        grant(email, b, "VIEWER");
        UUID userId = users.findByEmail(email).orElseThrow().getId();

        String token = loginToken(email);
        Jwt jwt = decoder.decode(token);

        // not jwt.getIssuer(): Spring converts iss to a URL, and "appfleet-identity" is not one
        assertThat(jwt.getClaimAsString("iss")).isEqualTo("appfleet-identity");
        assertThat(jwt.getAudience()).containsExactly("appfleet");
        assertThat(jwt.getSubject()).isEqualTo(userId.toString());
        assertThat(UUID.fromString(jwt.getId())).isNotNull();
        assertThat(Duration.between(jwt.getIssuedAt(), jwt.getExpiresAt())).isEqualTo(Duration.ofMinutes(15));

        Map<String, List<String>> claim = jwt.getClaim("teams");
        assertThat(claim).containsOnlyKeys(a.getId().toString(), b.getId().toString());
        assertThat(claim.get(a.getId().toString())).containsExactly(
                "application:create", "application:read", "deployment:create", "deployment:read");
        assertThat(claim.get(b.getId().toString())).containsExactly("application:read", "deployment:read");

        assertThat(jwt.getClaims()).doesNotContainKeys("roles", "perms");
    }

    @Test
    void theHeader_isRs256AndTypeJwt() throws Exception {
        String email = uniqueEmail();
        String token = tokenFor(email);
        var header = SignedJWT.parse(token).getHeader();
        assertThat(header.getAlgorithm().getName()).isEqualTo("RS256");
        assertThat(header.getType().getType()).isEqualTo("JWT");
    }

    @Test
    void commonSecuritysConverter_turnsTheTeamsClaimIntoTheUnionOfPermissions() throws Exception {
        String email = uniqueEmail();
        register(email, PASSWORD);
        grant(email, teams.save(new Team("c-" + UUID.randomUUID())), "OPERATOR");

        JwtAuthenticationToken auth = (JwtAuthenticationToken) converter.convert(decoder.decode(loginToken(email)));
        Set<String> authorities = auth.getAuthorities().stream().map(GrantedAuthority::getAuthority).collect(Collectors.toSet());
        assertThat(authorities).containsExactlyInAnyOrder(
                "application:create", "application:read", "deployment:create", "deployment:read",
                "deployment:rollback", "node:drain");
    }

    @Test
    void aUserWithNoGrants_getsAValidTokenWithoutATeamsClaim() throws Exception {
        String email = uniqueEmail();
        Jwt jwt = decoder.decode(tokenFor(email));
        assertThat(jwt.getClaims()).doesNotContainKey("teams");
        JwtAuthenticationToken auth = (JwtAuthenticationToken) converter.convert(jwt);
        assertThat(auth.getAuthorities()).isEmpty();
    }

    @Test
    void aTamperedToken_isRefusedByTheDecoder() throws Exception {
        String token = tokenFor(uniqueEmail());
        String[] parts = token.split("\\.");
        String payload = new String(java.util.Base64.getUrlDecoder().decode(parts[1]), java.nio.charset.StandardCharsets.UTF_8)
                .replace("appfleet-identity", "appfleet-idemtity");
        String forged = parts[0] + "." + java.util.Base64.getUrlEncoder().withoutPadding().encodeToString(payload.getBytes(java.nio.charset.StandardCharsets.UTF_8)) + "." + parts[2];
        assertThatThrownBy(() -> decoder.decode(forged)).isInstanceOf(JwtException.class);
    }

    @Test
    void everyLoginGetsItsOwnJti() throws Exception {
        String email = uniqueEmail();
        register(email, PASSWORD);
        String first = decoder.decode(loginToken(email)).getId();
        String second = decoder.decode(loginToken(email)).getId();
        assertThat(first).isNotEqualTo(second);
    }
}
```

**`identity-service/src/test/java/io/appfleet/identity/TokenSizeTest.java`**

```java
package io.appfleet.identity;

import io.appfleet.identity.auth.AccessTokenIssuer;
import io.appfleet.identity.rbac.RoleRepository;
import io.appfleet.identity.team.Team;
import io.appfleet.identity.team.TeamMembership;
import io.appfleet.identity.team.TeamMembershipRepository;
import io.appfleet.identity.team.TeamRepository;
import io.appfleet.identity.user.AppUser;
import io.appfleet.identity.user.UserRepository;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** The token travels in a header, so its size is a number to know, not a guess. */
class TokenSizeTest extends IdentityIntegrationTest {

    @Autowired AccessTokenIssuer issuer;
    @Autowired UserRepository users;
    @Autowired TeamRepository teams;
    @Autowired TeamMembershipRepository memberships;
    @Autowired RoleRepository roles;

    private AppUser userWithGrants(int teamCount, String roleName) {
        AppUser user = users.save(new AppUser("s-" + UUID.randomUUID() + "@x.io", "Sizer", "hash"));
        for (int i = 0; i < teamCount; i++) {
            Team team = teams.save(new Team("t-" + UUID.randomUUID()));
            memberships.save(new TeamMembership(user, team, roles.findByName(roleName).orElseThrow()));
        }
        return user;
    }

    private int size(int teamCount, String roleName) {
        int chars = issuer.issue(userWithGrants(teamCount, roleName)).value().length();
        System.out.println("TOKEN-SIZE teams=" + teamCount + " role=" + roleName + " characters=" + chars);
        return chars;
    }

    @Test
    void measured_typicalAndWorstCaseSizes() {
        int none = size(0, "VIEWER");
        int oneViewer = size(1, "VIEWER");
        int oneDeployer = size(1, "DEPLOYER");
        int oneAdmin = size(1, "ADMIN");
        int five = size(5, "DEPLOYER");
        int worst = size(AccessTokenIssuer.MAX_TEAMS, "ADMIN");   // the most one token can carry
        assertThat(none).isLessThan(oneViewer);
        assertThat(oneViewer).isLessThan(oneDeployer);
        assertThat(oneDeployer).isLessThan(oneAdmin);
        assertThat(five).isLessThan(worst);
        assertThat(worst).as("worst case stays under 4 KB, the smallest header limit commonly met").isLessThan(4096);
    }

    @Test
    void aUserWithMoreThanTheCap_getsNoToken() {
        AppUser user = userWithGrants(AccessTokenIssuer.MAX_TEAMS + 1, "VIEWER");
        assertThatThrownBy(() -> issuer.issue(user))
                .isInstanceOf(IllegalStateException.class).hasMessageContaining("at most " + AccessTokenIssuer.MAX_TEAMS);
    }

    @Test
    void aUserAtTheCap_getsAToken() {
        assertThat(issuer.issue(userWithGrants(AccessTokenIssuer.MAX_TEAMS, "VIEWER")).value()).isNotBlank();
    }
}
```

**`identity-service/src/test/java/io/appfleet/identity/IssuerSettingsTest.java`**

```java
package io.appfleet.identity;

import io.appfleet.identity.auth.AccessTokenIssuer;
import io.appfleet.identity.config.IdentityJwtProperties;
import org.junit.jupiter.api.Test;
import org.springframework.core.io.ClassPathResource;
import org.springframework.core.io.FileSystemResource;

import java.io.IOException;
import java.time.Clock;
import java.time.Duration;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** No Spring context, no database: the rules that must hold before the application can start at all. */
class IssuerSettingsTest {

    private static IdentityJwtProperties props(Duration ttl) {
        return new IdentityJwtProperties(new ClassPathResource("keys/dev-private.pem"), "appfleet-identity", "appfleet", ttl);
    }

    @Test
    void accessTokenTtl_ofFifteenMinutes_isAccepted() {
        assertThat(props(Duration.ofMinutes(15)).accessTokenTtl()).isEqualTo(Duration.ofMinutes(15));
    }

    @Test
    void accessTokenTtl_overFifteenMinutes_isRefused() {
        assertThatThrownBy(() -> props(Duration.ofMinutes(16)))
                .isInstanceOf(IllegalArgumentException.class).hasMessageContaining("at most 15 minutes");
    }

    @Test
    void accessTokenTtl_ofZeroOrLess_isRefused() {
        assertThatThrownBy(() -> props(Duration.ZERO)).isInstanceOf(IllegalArgumentException.class);
        assertThatThrownBy(() -> props(Duration.ofSeconds(-1))).isInstanceOf(IllegalArgumentException.class);
    }

    @Test
    void aMissingPrivateKey_stopsTheIssuerFromBeingBuilt() {
        IdentityJwtProperties missing = new IdentityJwtProperties(
                new FileSystemResource("no-such-key.pem"), "appfleet-identity", "appfleet", Duration.ofMinutes(15));
        assertThatThrownBy(() -> new AccessTokenIssuer(missing, null, null, Clock.systemUTC()))
                .isInstanceOf(IOException.class);
    }
}
```

## 7. Order of work

1. Pom, `application.yml`, `application-local.yml`, the test base properties (section 4 and 6), and `mvn -f common-security\pom.xml install -DskipTests`.
2. **The red run, before any main code:** write the six test classes. They do not compile yet (no `AccessTokenIssuer`, no endpoints). That compile failure is the red run; the scratch run did the code and the tests together, so you are the first to see it red.
3. Main code in the order of section 5: settings, issuer, endpoints, problem shape, chain.
4. `mvn -f identity-service\pom.xml test -DargLine="-Duser.timezone=UTC"`. Expected: **58 tests, 0 failures**. `TokenSizeTest` prints the `TOKEN-SIZE` lines; compare them with section 8.
5. Mutation checks (section 8.2) on a scratch copy. **Back up a file once, before its first edit, and compare the restore with the backup.**
6. Results; the plan's I2 row and question 6; a concepts-guide lesson; the Outline pages.
7. By hand, once: `SPRING_PROFILES_ACTIVE=local`, run the app, register, login, and paste the token into control-api's Swagger UI (control-api must trust the same public key, which it does with its dev configuration).

## 8. Verification, 2026-10-06 (scratch copy of your I1 tree)

### 8.1 Results

58 tests, 0 failures: the 27 of I1 plus 31 new. Two corrections made on the way, both in the tests and both kept as findings: `@Email` refuses an address with surrounding spaces (a 400, not a trim), and `Jwt.getIssuer()` throws for a non-URL issuer (decision 11). The cap changed from 20 to 10 after measurement (decision 8).

### 8.2 Mutation checks (each seen red, then restored)

| Mutation | Result |
|---|---|
| Token issued without the `aud` claim | 4 of 6 `AccessTokenContractTest` tests error: `The aud claim is not valid` (the decoder refuses it) |
| Login ignores a deactivated user | 2 of 6 `LoginTest` fail (`aDeactivatedUserWithTheRightPassword_getsNoToken` and the one-answer test) |
| Unknown user answers with its own detail | 1 of 6 `LoginTest` fails: the one-answer test |
| No 72-byte check | 1 of 12 `RegisterTest` fails: the 40-accent password |
| Default cache headers switched off in the chain | 1 of 6 `LoginTest` fails (`login_returnsABearerTokenThatExpiresIn900Seconds_andIsNotCacheable`) |
| TTL limit raised from 15 to 25 minutes | 1 of 4 `IssuerSettingsTest` fails |

A seventh mutation, removing the cache headers **from the controller**, left `LoginTest` green: the headers were redundant. The controller code was removed (decision 10) and the check redone against the chain, as in the table.

**Two mistakes of mine, kept as lessons.** First, my mutation helper was named `Cp`, which is a PowerShell alias for `Copy-Item`, so it never ran: no backup was taken and a mutated file stayed mutated (the same trap as an earlier helper named `R`, an alias for `Invoke-History`). Check a helper name with `Get-Command` before using it. Second, a mutation that edits three files needs a backup of all three, taken before the first edit; I restored two and left `AuthExceptions` mutated until the next run caught it.

### 8.3 Measured token sizes

Characters of the compact token, from `TokenSizeTest` on 2026-10-06 (RS256, 2048-bit key; the signature alone is 342 characters):

| Grants | Characters |
|---|---|
| none | 604 |
| 1 team, VIEWER (2 permissions) | 722 |
| 1 team, DEPLOYER (4) | 776 |
| 1 team, ADMIN (8) | 866 |
| 5 teams, DEPLOYER | 1411 |
| 10 teams, ADMIN (the cap) | 3098 |
| 20 teams, ADMIN (measured before the cap became 10) | 5578 |

## 9. What this step deliberately does not do

- No refresh token, no logout, no revocation (I3, I4).
- No lockout, no breach-list check, no login audit, no timing equalisation (I5). The password policy in I2 is length only: 12 to 72 characters and 72 bytes.
- No admin API; the tests create teams and memberships through the repositories (I6).
- No JWKS and no `kid` (I8); control-api uses its static public key.
- No `perms` claim, because the model has no global role.
- No BCrypt timing numbers (I8).
- No rate limit on `register` or `login` other than the lockout of I5.

## Definition of done

- [x] pom, `application.yml`, `application-local.yml` and the test base properties changed (section 4, 6)
- [x] The red run: the six test classes written first and seen not to compile
- [x] Settings, issuer, endpoints, problem shape and chain in place
- [x] 58 tests green with `mvn -f identity-service\pom.xml test`
- [x] A token from identity-service decoded and converted by `common-security`'s decoder and converter (`AccessTokenContractTest`)
- [x] Passwords stored as BCrypt hashes at the configured cost; none in any response
- [x] The three login failures return one identical body
- [x] Token sizes recorded; the cap of 10 enforced and tested
- [x] The six mutation checks seen red on a scratch copy and restored
- [x] A login by hand against the running app, and the token accepted by control-api
- [x] Results written; the plan's I2 row and question 6 and Outline updated
- [x] Concepts-guide lesson for I2: `sec-access-token` (the claim contract, measured sizes and the cap), 2026-10-06

## 10. Results (built by hand, 2026-10-06)

- Real tree: `mvn -f identity-service\pom.xml test -DargLine="-Duser.timezone=UTC"`: **58 tests, 0 failures** (`AccessTokenContractTest` 6, `ConstraintTest` 9, `IssuerSettingsTest` 4, `LoginTest` 6, `RbacTest` 8, `RegisterTest` 12, `SchemaAndSeedTest` 3, `SecurityChainTest` 2, `TokenSizeTest` 3, `UserRepositoryTest` 5). The token sizes printed on the real tree equal the scratch run to the character (604, 722, 776, 866, 1411, 3098).
- The first run on the real tree had every Spring test failing: `class path resource [keys/dev-private.pem] cannot be opened because it does not exist`. The pom lacked the `common-security` test-jar, which carries the dev keys. After adding it, 58 of 58. `IssuerSettingsTest` had passed even then, because it starts no context.
- **By hand, on the dev stack** (Postgres and Redis from compose; identity-service on 8082 and control-api on 8081 from their jars, profile `local`, identity started from its own directory so the relative key path resolves; all stopped afterwards):
  1. `POST /api/v1/auth/register`: 201, no password in the body.
  2. `POST /api/v1/auth/login`: 200, with `Cache-Control: no-cache, no-store, max-age=0, must-revalidate` and `Pragma: no-cache` (set by Spring Security's defaults).
  3. That token, with no grants, on control-api `GET /api/v1/applications`: **403** (no `teams` claim, so no permission).
  4. A team and a `DEPLOYER` membership inserted by SQL (the admin API is I6); a new login: header `{typ: JWT, alg: RS256}`, claims `sub`, `aud: appfleet`, `iss: appfleet-identity`, `jti`, `iat`, `exp` 900 s later, and `teams` with the four DEPLOYER permissions for that team, no `roles`, no `perms`.
  5. That token on control-api `POST /api/v1/applications` for that team: **201**; `GET /api/v1/applications`: **200** with the application; `POST /api/v1/deployments/<id>/rollback` (a permission DEPLOYER lacks): **403**. **No change to control-api's code or configuration**: it used its default dev public key.
  6. Rows left in the dev database: one user, one team, one membership and one application, all named `e2e-...`.
- The six mutation checks (section 8.2) were done on the scratch copy and not repeated on the real tree.
- The concepts-guide lesson `sec-access-token` was added the same day. All five lessons added on 2026-10-06 were opened in headless Chrome with `#/lessons/<id>`: each mounts and shows its own readout, with no console errors.
