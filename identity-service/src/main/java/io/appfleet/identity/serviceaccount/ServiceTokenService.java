package io.appfleet.identity.serviceaccount;

import io.appfleet.identity.audit.ClientInfo;
import io.appfleet.identity.audit.LoginAuditService;
import io.appfleet.identity.audit.LoginOutcome;
import io.appfleet.identity.auth.AccessTokenIssuer;
import io.appfleet.identity.auth.AuthExceptions.InvalidCredentialsException;
import io.appfleet.identity.serviceaccount.ServiceAccountDTOs.ServiceTokenResponse;
import io.appfleet.identity.token.TokenHasher;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.UUID;

/**
 * Turns an API key into a short-lived access token, so every other service validates only JWTs and the key never travels
 * past this one endpoint. Every refusal is the same 401 as a wrong password: an unknown key, a wrong secret, a revoked
 * key and a disabled account cannot be told apart by the caller. The audit can tell them apart (INVALID_KEY, with the
 * account when the prefix named one).
 */
@Service
public class ServiceTokenService {

    private static final Duration TOUCH_EVERY = Duration.ofMinutes(1);

    private final ApiKeyRepository keys;
    private final AccessTokenIssuer issuer;
    private final LoginAuditService audit;
    private final ServiceAccountProperties properties;
    private final Clock clock;

    public ServiceTokenService(ApiKeyRepository keys, AccessTokenIssuer issuer, LoginAuditService audit,
                               ServiceAccountProperties properties, Clock clock) {
        this.keys = keys;
        this.issuer = issuer;
        this.audit = audit;
        this.properties = properties;
        this.clock = clock;
    }

    @Transactional
    public ServiceTokenResponse exchange(String presentedKey, ClientInfo client) {
        // The hash is computed whatever the key looks like, so a malformed key and an unknown one cost the same as a real one.
        String presentedHash = TokenHasher.hash(presentedKey);
        ApiKey key = ApiKeyGenerator.prefixOf(presentedKey).flatMap(keys::findByPrefix).orElse(null);

        boolean hashMatches = key != null && MessageDigest.isEqual(
                key.getKeyHash().getBytes(StandardCharsets.UTF_8), presentedHash.getBytes(StandardCharsets.UTF_8));
        if (!hashMatches || !key.isActive() || !key.getServiceAccount().isActive()) {
            audit.recordServiceToken(LoginOutcome.INVALID_KEY, key == null ? null : key.getServiceAccount().getId(), client);
            throw new InvalidCredentialsException();
        }

        ServiceAccount account = key.getServiceAccount();
        AccessTokenIssuer.IssuedToken token = issuer.issueForService(account, properties.tokenTtl());
        audit.recordServiceToken(LoginOutcome.SUCCESS, account.getId(), client);
        UUID keyId = key.getId();
        Instant now = clock.instant();
        keys.touch(keyId, now, now.minus(TOUCH_EVERY));   // last: the bulk update clears the persistence context
        return new ServiceTokenResponse(token.value(), "Bearer", Duration.between(token.issuedAt(), token.expiresAt()).toSeconds());
    }
}