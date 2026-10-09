package io.appfleet.security;

import com.nimbusds.jose.JOSEException;
import com.nimbusds.jose.JOSEObjectType;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.MACSigner;
import com.nimbusds.jose.crypto.RSASSASigner;
import com.nimbusds.jose.jwk.JWK;
import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.KeyUse;
import com.nimbusds.jose.jwk.RSAKey;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import com.sun.net.httpserver.HttpServer;
import io.appfleet.security.testing.TestKeys;
import org.junit.jupiter.api.AfterEach;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtException;

import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.nio.charset.StandardCharsets;
import java.security.PrivateKey;
import java.time.Duration;
import java.time.Instant;
import java.util.Date;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.atomic.AtomicInteger;
import java.util.function.Consumer;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;
import static org.awaitility.Awaitility.await;

/**
 * The decoder that reads its key from a JWKS endpoint, against a real HTTP server on a local port (the JDK's own).
 * It proves what the services rely on: the keys are cached (the server can go away), an unknown kid is fetched once more,
 * a key that left the set is refused after the cache expires, and the algorithm and the kid are pinned.
 */
class JwksDecoderTest {

    private HttpServer server;
    private volatile String body;
    private final AtomicInteger fetches = new AtomicInteger();

    private final ApplicationContextRunner runner = new ApplicationContextRunner()
            .withConfiguration(AutoConfigurations.of(JwtSecurityAutoConfiguration.class));

    @BeforeEach
    void startServer() throws IOException {
        server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
        server.createContext("/.well-known/jwks.json", exchange -> {
            fetches.incrementAndGet();
            byte[] bytes = body.getBytes(StandardCharsets.UTF_8);
            exchange.getResponseHeaders().add("Content-Type", "application/json");
            exchange.sendResponseHeaders(200, bytes.length);
            exchange.getResponseBody().write(bytes);
            exchange.close();
        });
        server.start();
    }

    @AfterEach
    void stopServer() {
        server.stop(0);
    }

    private String url() {
        return "http://127.0.0.1:" + server.getAddress().getPort() + "/.well-known/jwks.json";
    }

    private static RSAKey publicKey(String kid) {
        return new RSAKey.Builder(TestKeys.PUBLIC).keyID(kid).keyUse(KeyUse.SIGNATURE).algorithm(JWSAlgorithm.RS256).build();
    }

    private static RSAKey otherPublicKey(String kid) throws JOSEException {
        var other = (java.security.interfaces.RSAPrivateCrtKey) TestKeys.OTHER_PRIVATE;
        try {
            var pub = (java.security.interfaces.RSAPublicKey) java.security.KeyFactory.getInstance("RSA")
                    .generatePublic(new java.security.spec.RSAPublicKeySpec(other.getModulus(), other.getPublicExponent()));
            return new RSAKey.Builder(pub).keyID(kid).keyUse(KeyUse.SIGNATURE).algorithm(JWSAlgorithm.RS256).build();
        } catch (java.security.GeneralSecurityException e) {
            throw new JOSEException(e.getMessage(), e);
        }
    }

    private void serve(JWK... keys) {
        body = new JWKSet(List.of(keys)).toString();
    }

    private static JWTClaimsSet.Builder claims() {
        Instant now = Instant.now();
        return new JWTClaimsSet.Builder().issuer("appfleet-identity").subject(UUID.randomUUID().toString()).audience("appfleet")
                .jwtID(UUID.randomUUID().toString()).issueTime(Date.from(now)).expirationTime(Date.from(now.plusSeconds(300)));
    }

    private static String token(String kid, PrivateKey key, JWTClaimsSet claims) {
        JWSHeader.Builder header = new JWSHeader.Builder(JWSAlgorithm.RS256).type(JOSEObjectType.JWT);
        if (kid != null) header.keyID(kid);
        SignedJWT jwt = new SignedJWT(header.build(), claims);
        try {
            jwt.sign(new RSASSASigner(key));
        } catch (JOSEException e) {
            throw new IllegalStateException(e);
        }
        return jwt.serialize();
    }

    private static String token(String kid) {
        return token(kid, TestKeys.PRIVATE, claims().build());
    }

    private void decoder(Consumer<JwtDecoder> test, String... extraProperties) {
        runner.withPropertyValues("appfleet.security.jwt.jwks-uri=" + url(), "appfleet.security.jwt.issuer=appfleet-identity",
                        "appfleet.security.jwt.jwks-min-refresh-interval=0s")
                .withPropertyValues(extraProperties)
                .run(ctx -> test.accept(ctx.getBean(JwtDecoder.class)));
    }

    @Test
    void aTokenWhoseKidIsInTheKeySet_decodes() {
        serve(publicKey("k1"));
        decoder(d -> assertThat(d.decode(token("k1")).getSubject()).isNotBlank());
    }

    @Test
    void aWrongSignature_underAKnownKid_isRefused() {
        serve(publicKey("k1"));
        decoder(d -> assertThatThrownBy(() -> d.decode(token("k1", TestKeys.OTHER_PRIVATE, claims().build()))).isInstanceOf(JwtException.class));
    }

    @Test
    void anUnknownKid_isRefused() {
        serve(publicKey("k1"));
        decoder(d -> assertThatThrownBy(() -> d.decode(token("nobody"))).isInstanceOf(JwtException.class));
    }

    @Test
    void aTokenWithoutAKid_isRefused_evenWithAGoodSignature() {
        serve(publicKey("k1"));
        decoder(d -> assertThatThrownBy(() -> d.decode(token(null))).isInstanceOf(JwtException.class));
    }

    @Test
    void anHs256Token_signedWithThePublicKeyBytesAsTheSecret_isRefused() {
        serve(publicKey("k1"));
        decoder(d -> {
            byte[] secret = TestKeys.PUBLIC.getEncoded();
            SignedJWT jwt = new SignedJWT(new JWSHeader.Builder(JWSAlgorithm.HS256).keyID("k1").build(), claims().build());
            try {
                jwt.sign(new MACSigner(secret.length >= 32 ? secret : java.util.Arrays.copyOf(secret, 32)));
            } catch (JOSEException e) {
                throw new IllegalStateException(e);
            }
            assertThatThrownBy(() -> d.decode(jwt.serialize())).isInstanceOf(JwtException.class);
        });
    }

    @Test
    void theTimeClaimsTheIssuerAndTheAudience_stillApply() {
        serve(publicKey("k1"));
        decoder(d -> {
            Instant past = Instant.now().minusSeconds(3600);
            JWTClaimsSet expired = claims().issueTime(Date.from(past.minusSeconds(60))).expirationTime(Date.from(past)).build();
            assertThatThrownBy(() -> d.decode(token("k1", TestKeys.PRIVATE, expired))).isInstanceOf(JwtException.class);
            assertThatThrownBy(() -> d.decode(token("k1", TestKeys.PRIVATE, claims().issuer("someone-else").build()))).isInstanceOf(JwtException.class);
            assertThatThrownBy(() -> d.decode(token("k1", TestKeys.PRIVATE, claims().audience("another-service").build()))).isInstanceOf(JwtException.class);
        });
    }

    @Test
    void afterTheIssuerIsGone_theCachedKeysStillValidate_noNetworkOnTheRequestPath() {
        serve(publicKey("k1"));
        decoder(d -> {
            d.decode(token("k1"));
            int fetched = fetches.get();
            assertThat(fetched).isGreaterThanOrEqualTo(1);
            for (int i = 0; i < 50; i++) d.decode(token("k1"));
            assertThat(fetches.get()).as("fifty more tokens, no further fetch").isEqualTo(fetched);

            server.stop(0);
            assertThat(d.decode(token("k1")).getSubject()).as("the issuer is down; the cache answers").isNotBlank();
        });
    }

    @Test
    void whenTheIssuerIsDownAndTheCacheHasExpired_theLastGoodKeysStillServe() {
        serve(publicKey("k1"));
        decoder(d -> {
            assertThat(d.decode(token("k1")).getSubject()).isNotBlank();
            server.stop(0);
            try {
                Thread.sleep(700);                                   // longer than the 300 ms cache: a re-fetch is due, and fails
            } catch (InterruptedException e) {
                Thread.currentThread().interrupt();
            }
            assertThat(d.decode(token("k1")).getSubject()).as("outage tolerance: the last good key set is used").isNotBlank();
        }, "appfleet.security.jwt.jwks-cache-ttl=300ms", "appfleet.security.jwt.jwks-outage-ttl=1m");
    }

    @Test
    void anUnknownKid_triggersOneRefetch_soARotatedInKeyIsAcceptedWithoutARestart() {
        serve(publicKey("old"));
        decoder(d -> {
            d.decode(token("old"));
            serve(publicKey("old"), publicKey("new"));          // the issuer rotated: a new key joined the set
            assertThat(d.decode(token("new")).getSubject()).isNotBlank();
        });
    }

    @Test
    void aKeyThatLeftTheSet_isRefusedOnceTheCacheExpires() {
        serve(publicKey("old"), publicKey("current"));
        decoder(d -> {
            assertThat(d.decode(token("old")).getSubject()).isNotBlank();
            serve(publicKey("current"));                         // "old" is retired and dropped from the set
            await().atMost(Duration.ofSeconds(10)).pollInterval(Duration.ofMillis(200)).untilAsserted(() ->
                    assertThatThrownBy(() -> d.decode(token("old"))).isInstanceOf(JwtException.class));
            assertThat(d.decode(token("current")).getSubject()).isNotBlank();
        }, "appfleet.security.jwt.jwks-cache-ttl=300ms");
    }

    @Test
    void aRotatedKeysTokens_signedByAnotherKeyUnderTheSameKid_areRefused() throws JOSEException {
        serve(otherPublicKey("k1"));                             // the set says k1 is the OTHER key
        decoder(d -> assertThatThrownBy(() -> d.decode(token("k1"))).isInstanceOf(JwtException.class));
    }

    @Test
    void bothSourcesOrNeither_stopTheStartup_withAClearMessage() {
        runner.withPropertyValues("appfleet.security.jwt.jwks-uri=" + url(), "appfleet.security.jwt.public-key-location=classpath:keys/dev-public.pem",
                        "appfleet.security.jwt.issuer=appfleet-identity")
                .run(ctx -> assertThat(ctx).hasFailed().getFailure().rootCause().hasMessageContaining("exactly one of"));
        runner.withPropertyValues("appfleet.security.jwt.issuer=appfleet-identity")
                .run(ctx -> assertThat(ctx).as("no source at all: the JWT beans stay off").doesNotHaveBean(JwtDecoder.class));
    }

    @Test
    void aMinRefreshIntervalAsLongAsTheCache_stopsTheStartup() {
        runner.withPropertyValues("appfleet.security.jwt.jwks-uri=" + url(), "appfleet.security.jwt.issuer=appfleet-identity",
                        "appfleet.security.jwt.jwks-cache-ttl=1m", "appfleet.security.jwt.jwks-min-refresh-interval=2m")
                .run(ctx -> assertThat(ctx).hasFailed().getFailure().rootCause().hasMessageContaining("must be shorter than jwks-cache-ttl"));
    }

    @Test
    void aJwksUriThatIsNotHttp_stopsTheStartup() {
        runner.withPropertyValues("appfleet.security.jwt.jwks-uri=file:///etc/keys.json", "appfleet.security.jwt.issuer=appfleet-identity")
                .run(ctx -> assertThat(ctx).hasFailed().getFailure().rootCause().hasMessageContaining("http or https"));
    }
}