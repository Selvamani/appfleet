package io.appfleet.security.testing;

import com.nimbusds.jose.JOSEException;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.MACSigner;
import com.nimbusds.jose.crypto.RSASSASigner;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.PlainJWT;
import com.nimbusds.jwt.SignedJWT;

import java.security.interfaces.RSAPrivateKey;
import java.time.Duration;
import java.time.Instant;
import java.util.*;

public final class TestJwt {

    public static final String ISSUER = "appfleet-identity";
    public static final String AUDIENCE = "appfleet";
    private final String sub;
    private final Map<String, List<String>> teams = new LinkedHashMap<>();
    private final List<String> perms = new ArrayList<>();
    private String issuer = ISSUER;
    private String audience = AUDIENCE;
    private Instant issuedAt = Instant.now();
    private Instant expiresAt = issuedAt.plus(Duration.ofMinutes(15));
    private Instant notBefore;                       // null = claim absent
    private RSAPrivateKey key = TestKeys.PRIVATE;
    private Mode mode = Mode.RS256;
    private TestJwt(String sub) {
        this.sub = sub;
    }

    public static TestJwt forUser(UUID userId) {
        return new TestJwt(userId.toString());
    }

    // --- claims ---------------------------------------------------------------
    public TestJwt team(UUID teamId, String... permissions) {
        teams.computeIfAbsent(teamId.toString(), k -> new ArrayList<>()).addAll(List.of(permissions));
        return this;
    }

    public TestJwt perm(String... permissions) {
        perms.addAll(List.of(permissions));
        return this;
    }

    public TestJwt issuer(String issuer) {
        this.issuer = issuer;
        return this;
    }

    public TestJwt audience(String audience) {
        this.audience = audience;
        return this;
    }

    /**
     * From now; may be negative (token already expired).
     */
    public TestJwt expiresIn(Duration d) {
        this.expiresAt = Instant.now().plus(d);
        if (!expiresAt.isAfter(issuedAt)) this.issuedAt = expiresAt.minus(Duration.ofMinutes(15));
        return this;
    }

    public TestJwt expired() {
        return expiresIn(Duration.ofHours(-1));
    }

    public TestJwt notYetValid() {
        this.notBefore = Instant.now().plus(Duration.ofHours(1));
        return this;
    }

    // --- signing defects ------------------------------------------------------
    public TestJwt wrongKey() {
        this.key = TestKeys.OTHER_PRIVATE;
        return this;
    }

    public TestJwt hs256WithPublicKeyAsSecret() {
        this.mode = Mode.HS256_PUBLIC_KEY;
        return this;
    }

    public TestJwt algNone() {
        this.mode = Mode.NONE;
        return this;
    }

    // --- output ---------------------------------------------------------------
    public String sign() {
        JWTClaimsSet.Builder b = new JWTClaimsSet.Builder()
                .issuer(issuer)
                .subject(sub)
                .audience(audience)
                .jwtID(UUID.randomUUID().toString())
                .issueTime(Date.from(issuedAt))
                .expirationTime(Date.from(expiresAt));
        if (notBefore != null) b.notBeforeTime(Date.from(notBefore));
        if (!teams.isEmpty()) b.claim("teams", teams);
        if (!perms.isEmpty()) b.claim("perms", perms);
        JWTClaimsSet claims = b.build();
        try {
            return switch (mode) {
                case RS256 -> {
                    SignedJWT jwt = new SignedJWT(new JWSHeader(JWSAlgorithm.RS256), claims);
                    jwt.sign(new RSASSASigner(key));
                    yield jwt.serialize();
                }
                case HS256_PUBLIC_KEY -> {
                    SignedJWT jwt = new SignedJWT(new JWSHeader(JWSAlgorithm.HS256), claims);
                    jwt.sign(new MACSigner(TestKeys.PUBLIC.getEncoded()));
                    yield jwt.serialize();
                }
                case NONE -> new PlainJWT(claims).serialize();
            };
        } catch (JOSEException e) {
            throw new IllegalStateException(e);
        }
    }

    public String bearer() {
        return "Bearer " + sign();
    }

    private enum Mode {RS256, HS256_PUBLIC_KEY, NONE}
}
