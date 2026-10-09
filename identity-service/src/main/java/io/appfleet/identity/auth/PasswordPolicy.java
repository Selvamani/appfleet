package io.appfleet.identity.auth;

import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Component;

import java.io.BufferedReader;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.UncheckedIOException;
import java.nio.charset.StandardCharsets;
import java.util.HashSet;
import java.util.Locale;
import java.util.Set;

/**
 * The password rules, in one place, for registration and for a password change. Length (12 to 72 bytes) is only part of
 * it: a long password that is on every breach list is still a weak one. The messages name the rule, never the password.
 */
@Component
public class PasswordPolicy {

    private static final int MAX_BYTES = 72;       // BCrypt reads no more than this
    private static final int MIN_LOCAL_PART = 4;   // an email name shorter than this is too common to forbid

    private final Set<String> common = new HashSet<>();

    public PasswordPolicy() {
        try (BufferedReader in = new BufferedReader(new InputStreamReader(
                new ClassPathResource("common-passwords.txt").getInputStream(), StandardCharsets.UTF_8))) {
            in.lines().map(String::trim).filter(l -> !l.isEmpty() && !l.startsWith("#"))
                    .forEach(l -> common.add(l.toLowerCase(Locale.ROOT)));
        } catch (IOException e) {
            throw new UncheckedIOException("the common-password list cannot be read", e);   // fail at start-up, not at the first check
        }
    }

    /** Throws when the password is refused. {@code field} is the request field the error is reported on. */
    public void check(String field, String password, String email) {
        if (password.getBytes(StandardCharsets.UTF_8).length > MAX_BYTES) throw new AuthExceptions.PasswordTooLongException(field);
        String lower = password.toLowerCase(Locale.ROOT);
        if (common.contains(lower)) throw new AuthExceptions.WeakPasswordException(field, "is on the list of common passwords");
        String localPart = email.substring(0, email.indexOf('@') < 0 ? email.length() : email.indexOf('@'));
        if (lower.equals(email) || (localPart.length() >= MIN_LOCAL_PART && lower.contains(localPart)))
            throw new AuthExceptions.WeakPasswordException(field, "must not contain your email address");
    }
}
