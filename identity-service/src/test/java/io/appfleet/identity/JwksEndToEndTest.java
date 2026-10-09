package io.appfleet.identity;

import com.nimbusds.jose.JOSEException;
import com.nimbusds.jose.JOSEObjectType;
import com.nimbusds.jose.JWSAlgorithm;
import com.nimbusds.jose.JWSHeader;
import com.nimbusds.jose.crypto.RSASSASigner;
import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.KeyUse;
import com.nimbusds.jose.jwk.RSAKey;
import com.nimbusds.jose.jwk.gen.RSAKeyGenerator;
import com.nimbusds.jwt.JWTClaimsSet;
import com.nimbusds.jwt.SignedJWT;
import io.appfleet.security.JwtSecurityAutoConfiguration;
import org.junit.jupiter.api.Test;
import org.junit.jupiter.api.io.TempDir;
import org.springframework.boot.autoconfigure.AutoConfigurations;
import org.springframework.boot.builder.SpringApplicationBuilder;
import org.springframework.boot.test.context.runner.ApplicationContextRunner;
import org.springframework.context.ConfigurableApplicationContext;
import org.springframework.security.oauth2.jwt.JwtDecoder;
import org.springframework.security.oauth2.jwt.JwtException;
import tools.jackson.databind.JsonNode;
import tools.jackson.databind.json.JsonMapper;

import java.net.URI;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.file.Files;
import java.nio.file.Path;
import java.time.Duration;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Date;
import java.util.List;
import java.util.UUID;
import java.util.function.Consumer;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/**
 * identity-service as a REAL separate application (its own context, its own port), and a validating side built exactly as
 * control-api builds it (common-security's auto-configuration, pointed at the JWKS URL). What is proved here, end to end:
 * a token from identity is accepted; identity can then stop and the validator still authorises (nothing on the request path
 * calls identity); and a key rotated out of the set is refused once its grace is over, while a recently retired key still works.
 */
class JwksEndToEndTest {

    private static final JsonMapper JSON = new JsonMapper();
    private static final HttpClient HTTP = HttpClient.newHttpClient();

    // ------------------------------------------------------------------ the two sides

    private ConfigurableApplicationContext startIdentity(String... extra) {
        List<String> args = new ArrayList<>(List.of(
                "--server.port=0", "--spring.main.banner-mode=off",
                "--spring.datasource.url=" + IdentityIntegrationTest.postgres.getJdbcUrl(),
                "--spring.datasource.username=" + IdentityIntegrationTest.postgres.getUsername(),
                "--spring.datasource.password=" + IdentityIntegrationTest.postgres.getPassword(),
                "--spring.data.redis.host=" + IdentityIntegrationTest.redis.getHost(),
                "--spring.data.redis.port=" + IdentityIntegrationTest.redis.getMappedPort(6379),
                "--appfleet.identity.jwt.private-key-location=classpath:keys/dev-private.pem",
                "--appfleet.identity.password.bcrypt-cost=4",
                "--appfleet.security.jwt.public-key-location=classpath:keys/dev-public.pem",
                "--appfleet.security.jwt.issuer=appfleet-identity"));
        args.addAll(List.of(extra));
        return new SpringApplicationBuilder(IdentityServiceApplication.class).run(args.toArray(String[]::new));
    }

    private static String base(ConfigurableApplicationContext identity) {
        return "http://localhost:" + identity.getEnvironment().getProperty("local.server.port");
    }

    /** What control-api is: the decoder of common-security's auto-configuration, reading its key from the JWKS URL. */
    private static void validator(String jwksUrl, Consumer<JwtDecoder> test) {
        new ApplicationContextRunner()
                .withConfiguration(AutoConfigurations.of(JwtSecurityAutoConfiguration.class))
                .withPropertyValues("appfleet.security.jwt.jwks-uri=" + jwksUrl, "appfleet.security.jwt.issuer=appfleet-identity",
                        "appfleet.security.jwt.jwks-min-refresh-interval=0s")
                .run(ctx -> test.accept(ctx.getBean(JwtDecoder.class)));
    }

    private static JsonNode post(String url, Object body) throws Exception {
        HttpResponse<String> r = HTTP.send(HttpRequest.newBuilder(URI.create(url)).header("Content-Type", "application/json")
                .POST(HttpRequest.BodyPublishers.ofString(JSON.writeValueAsString(body))).build(), HttpResponse.BodyHandlers.ofString());
        return JSON.readTree(r.body());
    }

    private static String signInToIdentity(String base) throws Exception {
        String email = "e2e-" + UUID.randomUUID() + "@example.io";
        post(base + "/api/v1/auth/register", java.util.Map.of("email", email, "displayName", "E2E", "password", "correct horse battery"));
        return post(base + "/api/v1/auth/login", java.util.Map.of("email", email, "password", "correct horse battery")).get("accessToken").asString();
    }

    private static String signedBy(RSAKey key, String kid) {
        Instant now = Instant.now();
        JWTClaimsSet claims = new JWTClaimsSet.Builder().issuer("appfleet-identity").subject(UUID.randomUUID().toString()).audience("appfleet")
                .jwtID(UUID.randomUUID().toString()).issueTime(Date.from(now)).expirationTime(Date.from(now.plusSeconds(300))).build();
        try {
            SignedJWT jwt = new SignedJWT(new JWSHeader.Builder(JWSAlgorithm.RS256).type(JOSEObjectType.JWT).keyID(kid).build(), claims);
            jwt.sign(new RSASSASigner(key));
            return jwt.serialize();
        } catch (JOSEException e) {
            throw new IllegalStateException(e);
        }
    }

    private static RSAKey newKey() throws JOSEException {
        return new RSAKeyGenerator(2048).keyUse(KeyUse.SIGNATURE).algorithm(JWSAlgorithm.RS256).keyIDFromThumbprint(true).generate();
    }

    private static Path publicPem(Path dir, RSAKey key, String name) throws Exception {
        String pem = "-----BEGIN PUBLIC KEY-----\n" + Base64.getMimeEncoder(64, "\n".getBytes()).encodeToString(key.toRSAPublicKey().getEncoded()) + "\n-----END PUBLIC KEY-----\n";
        return Files.writeString(dir.resolve(name), pem);
    }

    // ------------------------------------------------------------------ the tests

    @Test
    void aTokenFromIdentity_isAccepted_andAfterIdentityStops_theValidatorStillAuthorises() throws Exception {
        ConfigurableApplicationContext identity = startIdentity();
        try {
            String base = base(identity);
            String token = signInToIdentity(base);
            validator(base + "/.well-known/jwks.json", decoder -> {
                assertThat(decoder.decode(token).getSubject()).as("accepted while identity is up").isNotBlank();

                identity.close();                                              // identity-service is gone
                assertThatThrownBy(() -> HTTP.send(HttpRequest.newBuilder(URI.create(base + "/.well-known/jwks.json")).build(), HttpResponse.BodyHandlers.ofString()))
                        .as("nothing answers on identity's port any more").isInstanceOf(java.io.IOException.class);

                for (int i = 0; i < 20; i++) assertThat(decoder.decode(token).getSubject()).as("still accepted, from the cached keys").isNotBlank();
                assertThatThrownBy(() -> decoder.decode(signedBy(newKeyUnchecked(), "a-key-nobody-published"))).as("and a stranger is still refused").isInstanceOf(JwtException.class);
            });
        } finally {
            identity.close();
        }
    }

    private static RSAKey newKeyUnchecked() {
        try {
            return newKey();
        } catch (JOSEException e) {
            throw new IllegalStateException(e);
        }
    }

    @Test
    void aRetiredKey_isHonouredInsideItsGrace_andRefusedOnceTheGraceIsOver(@TempDir Path dir) throws Exception {
        RSAKey recent = newKey();       // retired a minute ago: its tokens may still be alive
        RSAKey ancient = newKey();      // retired an hour ago: every token it signed has expired
        Path recentPem = publicPem(dir, recent, "recent.pem");
        Path ancientPem = publicPem(dir, ancient, "ancient.pem");
        ConfigurableApplicationContext identity = startIdentity(
                "--appfleet.identity.jwks.retired-keys[0].public-key-location=file:" + recentPem.toUri().getPath(),
                "--appfleet.identity.jwks.retired-keys[0].retired-at=" + Instant.now().minus(Duration.ofMinutes(1)),
                "--appfleet.identity.jwks.retired-keys[1].public-key-location=file:" + ancientPem.toUri().getPath(),
                "--appfleet.identity.jwks.retired-keys[1].retired-at=" + Instant.now().minus(Duration.ofHours(1)));
        try {
            String url = base(identity) + "/.well-known/jwks.json";
            JWKSet published = JWKSet.parse(HTTP.send(HttpRequest.newBuilder(URI.create(url)).build(), HttpResponse.BodyHandlers.ofString()).body());
            assertThat(published.getKeys()).as("the signing key and the recently retired one, not the ancient one").hasSize(2);
            assertThat(published.getKeyByKeyId(recent.getKeyID())).isNotNull();
            assertThat(published.getKeyByKeyId(ancient.getKeyID())).isNull();

            validator(url, decoder -> {
                assertThat(decoder.decode(signInToIdentityQuietly(base(identity))).getSubject()).as("the current key").isNotBlank();
                assertThat(decoder.decode(signedBy(recent, recent.getKeyID())).getSubject()).as("a retired key inside its grace is still honoured").isNotBlank();
                assertThatThrownBy(() -> decoder.decode(signedBy(ancient, ancient.getKeyID()))).as("a rotated-out key after its grace is refused, with a perfect signature").isInstanceOf(JwtException.class);
            });
        } finally {
            identity.close();
        }
    }

    private static String signInToIdentityQuietly(String base) {
        try {
            return signInToIdentity(base);
        } catch (Exception e) {
            throw new IllegalStateException(e);
        }
    }
}