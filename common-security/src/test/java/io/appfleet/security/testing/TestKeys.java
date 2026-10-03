package io.appfleet.security.testing;

import org.springframework.core.io.ClassPathResource;
import org.springframework.security.converter.RsaKeyConverters;

import java.io.IOException;
import java.io.InputStream;
import java.security.KeyPair;
import java.security.KeyPairGenerator;
import java.security.NoSuchAlgorithmException;
import java.security.interfaces.RSAPrivateKey;
import java.security.interfaces.RSAPublicKey;

public final class TestKeys {
    public static final RSAPublicKey PUBLIC;
    public static final RSAPrivateKey PRIVATE;
    /** A valid RSA private key that does NOT match PUBLIC: for the wrongKey() token. */
    public static final RSAPrivateKey OTHER_PRIVATE;

    static {
        try (InputStream pub = new ClassPathResource("keys/dev-public.pem").getInputStream();
             InputStream priv = new ClassPathResource("keys/dev-private.pem").getInputStream()) {
            PUBLIC = RsaKeyConverters.x509().convert(pub);
            PRIVATE = RsaKeyConverters.pkcs8().convert(priv);

            KeyPairGenerator gen = KeyPairGenerator.getInstance("RSA");
            gen.initialize(2048);
            KeyPair other = gen.generateKeyPair();
            OTHER_PRIVATE = (RSAPrivateKey) other.getPrivate();
        } catch (IOException | NoSuchAlgorithmException e) {
            throw new ExceptionInInitializerError(e);
        }
    }

    private TestKeys() {}

}

