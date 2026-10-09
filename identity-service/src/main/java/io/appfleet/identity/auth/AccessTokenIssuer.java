package io.appfleet.identity.auth;

import com.nimbusds.jose.JOSEException;
import com.nimbusds.jose.JOSEObjectType;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.RSASSASigner;
import com.nimbusds.jose.jwk.KeyUse;
import com.nimbusds.jose.jwk.RSAKey;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import io.appfleet.identity.config.IdentityJwtProperties;
import io.appfleet.identity.rbac.PermissionResolver;
import io.appfleet.identity.serviceaccount.ServiceAccount;
import io.appfleet.identity.team.TeamMembershipRepository;
import io.appfleet.identity.team.TeamRole;
import io.appfleet.identity.user.AppUser;
import org.springframework.security.converter.RsaKeyConverters;
import org.springframework.stereotype.Component;
import org.springframework.transaction.annotation.Transactional;

import java.io.IOException;
import java.io.InputStream;
import java.security.GeneralSecurityException;
import java.security.KeyFactory;
import java.security.interfaces.RSAPrivateCrtKey;
import java.security.interfaces.RSAPrivateKey;
import java.security.interfaces.RSAPublicKey;
import java.security.spec.RSAPublicKeySpec;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.Date;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;


/**
 * Signs an access token that carries exactly the claim contract of control-api: iss, sub, aud, jti, iat, exp,
 * and teams (team id to the permission list that team grants). It never writes a roles claim.
 */
@Component
public class AccessTokenIssuer {

    /** Most team grants one token may carry; the measured sizes behind it. */
    public static final int MAX_TEAMS = 10;

    private final IdentityJwtProperties properties;
    private final RSAPrivateKey key;
    private final TeamMembershipRepository memberships;
    private final PermissionResolver resolver;
    private final Clock clock;
    private final RSAKey publicJwk;

    public AccessTokenIssuer(IdentityJwtProperties properties, TeamMembershipRepository memberships,
                             PermissionResolver resolver, Clock clock) throws IOException {
        this.properties = properties;
        this.memberships = memberships;
        this.resolver = resolver;
        this.clock = clock;
        try (InputStream in = properties.privateKeyLocation().getInputStream()) {
            this.key = RsaKeyConverters.pkcs8().convert(in);   // a missing or unreadable key fails startup
        }
        this.publicJwk = publicJwkOf(key);
    }


    /**
    * The public half of the signing key as a JWK, with its RFC 7638 thumbprint as the kid: a key id that is derived from the key
     * itself, so it needs no configuration and cannot name a different key than the one it labels.
    */
    public RSAKey publicJwk() {
       return publicJwk;
   }

    static RSAKey publicJwkOf(RSAPrivateKey privateKey) {
        if (!(privateKey instanceof RSAPrivateCrtKey crt))
           throw new IllegalStateException("the signing key must be an RSA key with its CRT parameters (a PKCS8 PEM from openssl is)");
        try {
           RSAPublicKey publicKey = (RSAPublicKey) KeyFactory.getInstance("RSA")
                  .generatePublic(new RSAPublicKeySpec(crt.getModulus(), crt.getPublicExponent()));
          return new RSAKey.Builder(publicKey).keyUse(KeyUse.SIGNATURE).algorithm(JWSAlgorithm.RS256).keyIDFromThumbprint().build();
        } catch (GeneralSecurityException | JOSEException e) {
            throw new IllegalStateException("cannot derive the public key of the signing key", e);
        }
    }

    @Transactional(readOnly = true)
    public IssuedToken issue(AppUser user) {
        List<TeamRole> grants = memberships.findGrantsByUserId(user.getId());
        if (grants.size() > MAX_TEAMS)
            throw new IllegalStateException("user " + user.getId() + " has " + grants.size()
                    + " team grants; one token carries at most " + MAX_TEAMS);
        return sign(user.getId(), grants, properties.accessTokenTtl());
    }

    /**
     * A token for a service account: the same claim contract (sub is the account's id, teams holds its ONE grant), a shorter
     * life, and no refresh token behind it. control-api reads it exactly as it reads a user's.
    */
    @Transactional(readOnly = true)
    public IssuedToken issueForService(ServiceAccount account, Duration ttl) {
        return sign(account.getId(), List.of(new TeamRole(account.getTeam().getId(), account.getRole().getName())), ttl);
    }

    private IssuedToken sign(UUID subject, List<TeamRole> grants, Duration ttl) {
        Map<String, List<String>> byRole = new HashMap<>();
        Map<String, List<String>> teams = new LinkedHashMap<>();
        for (TeamRole grant : grants) {
            teams.put(grant.teamId().toString(), byRole.computeIfAbsent(grant.roleName(),
                    role -> resolver.permissionsFor(role).stream().sorted().toList()));
        }

        Instant issuedAt = clock.instant();
        Instant expiresAt = issuedAt.plus(ttl);
        String jti = UUID.randomUUID().toString();

        JWTClaimsSet.Builder claims = new JWTClaimsSet.Builder()
                .issuer(properties.issuer())
                .subject(subject.toString())
                .audience(properties.audience())
                .jwtID(jti)
                .issueTime(Date.from(issuedAt))
                .expirationTime(Date.from(expiresAt));
        if (!teams.isEmpty()) claims.claim("teams", teams);  // absent, not empty, when the user has no grants (as TestJwt does)

        try {
            SignedJWT jwt = new SignedJWT(
                    new JWSHeader.Builder(JWSAlgorithm.RS256).type(JOSEObjectType.JWT).keyID(publicJwk.getKeyID()).build(), claims.build());
            jwt.sign(new RSASSASigner(key));
            return new IssuedToken(jwt.serialize(), issuedAt, expiresAt, jti);
        } catch (JOSEException e) {
            throw new IllegalStateException("could not sign the access token", e);
        }
    }

    public record IssuedToken(String value, Instant issuedAt, Instant expiresAt, String jti) {}
}
