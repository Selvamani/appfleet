package io.appfleet.security;

import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.KeySourceException;
import com.nimbusds.jose.jwk.source.JWKSource;
import com.nimbusds.jose.jwk.source.JWKSourceBuilder;
import com.nimbusds.jose.proc.JWSKeySelector;
import com.nimbusds.jose.proc.JWSVerificationKeySelector;
import com.nimbusds.jose.proc.SecurityContext;
import com.nimbusds.jose.util.DefaultResourceRetriever;
import com.nimbusds.jwt.proc.DefaultJWTProcessor;
import org.springframework.security.oauth2.jwt.NimbusJwtDecoder;

import java.net.MalformedURLException;
import java.net.URL;
import java.security.Key;
import java.util.List;

/**
 * Builds the decoder for a JWKS endpoint. What it guarantees, each with a test:
 * RS256 only (a token with another algorithm finds no key); a token must NAME its key (no kid, no key); the key set is cached,
 * so a request makes no network call while the cache holds; an unknown kid triggers one re-fetch (rotation), rate limited;
 * and when the endpoint is down the last good key set keeps serving for the outage tolerance, so a restart of the issuer
 * does not stop the services that only validate.
 * The time claims, the issuer and the audience are NOT checked here: the validators of the auto-configuration do it, as for a static key.
 */
final class JwksJwtDecoders {

    private JwksJwtDecoders() {}

    static NimbusJwtDecoder create(JwtProperties p) {
        URL url;
        try {
            url = p.jwksUri().toURL();
        } catch (MalformedURLException e) {
            throw new IllegalArgumentException("appfleet.security.jwt.jwks-uri is not a URL: " + p.jwksUri(), e);
        }
        JWKSourceBuilder<SecurityContext> builder = JWKSourceBuilder
                .<SecurityContext>create(url, new DefaultResourceRetriever(2000, 2000, 65536))
                .cache(p.jwksCacheTtl().toMillis(), Math.min(5000, p.jwksCacheTtl().toMillis() / 2))   // a fetch may take at most 5 s, and never half the cache life
                .refreshAheadCache(false)            // no background refresh: a key is fetched on first use and when a kid is unknown or the cache has expired
                .outageTolerant(p.jwksOutageTtl().toMillis());
        builder = p.jwksMinRefreshInterval().isZero() ? builder.rateLimited(false) : builder.rateLimited(p.jwksMinRefreshInterval().toMillis());
        JWKSource<SecurityContext> source = builder.build();

        DefaultJWTProcessor<SecurityContext> processor = new DefaultJWTProcessor<>();
        processor.setJWSKeySelector(new RequireKeyId(new JWSVerificationKeySelector<>(JWSAlgorithm.RS256, source)));
        processor.setJWTClaimsSetVerifier((claims, context) -> { });
        return new NimbusJwtDecoder(processor);
    }

    /** A token that does not say which key signed it is refused, whatever its signature. identity-service always sets the kid. */
    private record RequireKeyId(JWSKeySelector<SecurityContext> delegate) implements JWSKeySelector<SecurityContext> {
        @Override
        public List<? extends Key> selectJWSKeys(JWSHeader header, SecurityContext context) throws KeySourceException {
            return header.getKeyID() == null ? List.of() : delegate.selectJWSKeys(header, context);
        }
    }
}