package io.appfleet.identity.auth;

import com.nimbusds.jose.JOSEException;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.jwk.JWK;
import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.KeyUse;
import com.nimbusds.jose.jwk.RSAKey;
import io.appfleet.identity.config.JwksProperties;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.security.converter.RsaKeyConverters;
import org.springframework.stereotype.Service;

import java.io.IOException;
import java.io.InputStream;
import java.security.interfaces.RSAPublicKey;
import java.time.Clock;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.List;

/**
 * The public keys the verifiers may use, now: the key that signs, and every retired key whose tokens can still be alive.
 * A retired key is published until retiredAt + grace and not a moment longer; after that a token it signed is refused
 * by every service that reads this set, whatever its signature says.
 */
@Service
public class JwkSetService {

    public record Retired(RSAKey key, Instant retiredAt) {
    }

    private final RSAKey current;
    private final List<Retired> retired;
    private final Duration grace;
    private final Clock clock;

    @Autowired
    public JwkSetService(AccessTokenIssuer issuer, JwksProperties properties, Clock clock) throws IOException {
        this(issuer.publicJwk(), load(properties), properties.retireGrace(), clock);
    }

    public JwkSetService(RSAKey current, List<Retired> retired, Duration grace, Clock clock) {
        this.current = current;
        this.retired = List.copyOf(retired);
        this.grace = grace;
        this.clock = clock;
        for (Retired r : retired)
            if (r.key().getKeyID().equals(current.getKeyID()))
                throw new IllegalStateException("a retired key is the key that signs now (kid " + current.getKeyID() + "): the public key of the NEW private key must not be listed as retired");
    }

    /** The set to publish at this moment. Public parts only: there is no way to ask this class for a private one. */
    public JWKSet publicSet() {
        Instant now = clock.instant();
        List<JWK> keys = new ArrayList<>();
        keys.add(current.toPublicJWK());
        for (Retired r : retired)
            if (now.isBefore(r.retiredAt().plus(grace))) keys.add(r.key().toPublicJWK());
        return new JWKSet(keys);
    }

    private static List<Retired> load(JwksProperties properties) throws IOException {
        List<Retired> out = new ArrayList<>();
        for (JwksProperties.RetiredKey k : properties.retiredKeys()) {
            try (InputStream in = k.publicKeyLocation().getInputStream()) {   // an unreadable file fails startup, not the first request
                RSAPublicKey publicKey = RsaKeyConverters.x509().convert(in);
                out.add(new Retired(new RSAKey.Builder(publicKey).keyUse(KeyUse.SIGNATURE).algorithm(JWSAlgorithm.RS256).keyIDFromThumbprint().build(), k.retiredAt()));
            } catch (JOSEException e) {
                throw new IllegalStateException("cannot derive the key id of " + k.publicKeyLocation(), e);
            }
        }
        return out;
    }
}