package io.appfleet.identity;

import com.nimbusds.jose.crypto.RSASSAVerifier;
import com.nimbusds.jose.jwk.JWKSet;
import com.nimbusds.jose.jwk.RSAKey;
import com.nimbusds.jwt.SignedJWT;
import org.junit.jupiter.api.Test;
import tools.jackson.databind.JsonNode;

import java.net.http.HttpResponse;

import static org.assertj.core.api.Assertions.assertThat;

/** GET /.well-known/jwks.json over real HTTP, and the contract between the token header and the set. */
class JwksEndpointTest extends AuthHttpTest {

    private static final String JWKS = "/.well-known/jwks.json";

    @Test
    void theEndpoint_isOpen_publicallyCacheable_andHoldsOnePublicKey() throws Exception {
        HttpResponse<String> r = get(JWKS);
        assertThat(r.statusCode()).isEqualTo(200);
        assertThat(r.headers().firstValue("Content-Type").orElse("")).startsWith("application/json");
        assertThat(r.headers().firstValue("Cache-Control").orElse("")).contains("public").contains("max-age=300");

        JsonNode keys = body(r).get("keys");
        assertThat(keys.size()).isEqualTo(1);
        JsonNode k = keys.get(0);
        assertThat(k.get("kty").asString()).isEqualTo("RSA");
        assertThat(k.get("use").asString()).isEqualTo("sig");
        assertThat(k.get("alg").asString()).isEqualTo("RS256");
        assertThat(k.get("kid").asString()).as("the kid is the RFC 7638 thumbprint of the key it labels")
                .isEqualTo(((RSAKey) JWKSet.parse(r.body()).getKeys().get(0)).computeThumbprint().toString());
        assertThat(k.get("n").asString()).isNotBlank();
        assertThat(k.get("e").asString()).isNotBlank();
        for (String secret : new String[]{"d", "p", "q", "dp", "dq", "qi"})
            assertThat(k.has(secret)).as("no private member '" + secret + "'").isFalse();
    }

    @Test
    void theKidOfAToken_namesAKeyInTheSet_andThatKeyVerifiesTheSignature() throws Exception {
        String token = tokenFor(uniqueEmail());
        SignedJWT jwt = SignedJWT.parse(token);
        String kid = jwt.getHeader().getKeyID();
        assertThat(kid).as("every token names its key").isNotBlank();

        JWKSet set = JWKSet.parse(get(JWKS).body());
        RSAKey key = (RSAKey) set.getKeyByKeyId(kid);
        assertThat(key).as("the token's kid is in the published set").isNotNull();
        assertThat(jwt.verify(new RSASSAVerifier(key))).as("and that public key verifies the signature").isTrue();
    }

    @Test
    void theSetIsTheSameOnEveryCall_andOnlyGetIsAllowed() throws Exception {
        assertThat(get(JWKS).body()).isEqualTo(get(JWKS).body());
        assertThat(send("POST", JWKS, null, "{}").statusCode()).as("not a place to write").isIn(401, 403, 405);
    }

}