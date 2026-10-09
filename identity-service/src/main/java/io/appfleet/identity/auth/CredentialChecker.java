package io.appfleet.identity.auth;


import io.appfleet.identity.user.AppUser;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Component;

import java.security.SecureRandom;
import java.util.Base64;

/**
 * Checks a password in the same time whether or not the user exists. For an unknown email it checks against a hash
 * made at start-up with the configured cost, so the work is the same BCrypt run and the clock says nothing.
 * (Measured at cost 12: a wrong password took 174 ms, an unknown user 4 ms before this, see the I5 doc.)
 */
@Component
public class CredentialChecker {

    private final PasswordEncoder encoder;
    private final String dummyHash;

    public CredentialChecker(PasswordEncoder encoder) {
        this.encoder = encoder;
        byte[] random = new byte[24];
        new SecureRandom().nextBytes(random);
        this.dummyHash = encoder.encode(Base64.getEncoder().encodeToString(random));
    }

    /** Always does one BCrypt check. An unknown user (null) never matches. */
    public boolean matches(String rawPassword, AppUser userOrNull) {
        boolean matched = encoder.matches(rawPassword, userOrNull != null ? userOrNull.getPasswordHash() : dummyHash);
        return userOrNull != null && matched;
    }
}
