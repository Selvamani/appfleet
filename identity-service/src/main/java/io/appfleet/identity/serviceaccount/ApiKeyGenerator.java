package io.appfleet.identity.serviceaccount;

import io.appfleet.identity.token.TokenHasher;

import java.util.Optional;

/**
 * An API key looks like {@code afk_<prefix>.<secret>}: a fixed tag, 11 random characters that name the row (public, stored,
 * shown in lists), a dot, and a 43-character secret of 256 random bits. Only the SHA-256 of the WHOLE key is stored.
 * The key is built here once, handed to the caller once, and never kept.
 */
public final class ApiKeyGenerator {

    static final String TAG = "afk_";
    static final int PREFIX_LENGTH = 11;
    static final int SECRET_LENGTH = 43;
    static final int KEY_LENGTH = TAG.length() + PREFIX_LENGTH + 1 + SECRET_LENGTH;

    public record Generated(String prefix, String key, String hash) {}

    private ApiKeyGenerator() {}

    public static Generated generate() {
        String prefix = TokenHasher.newToken().substring(0, PREFIX_LENGTH);
        String key = TAG + prefix + "." + TokenHasher.newToken();
        return new Generated(prefix, key, TokenHasher.hash(key));
    }

    /** The prefix of a well-formed key, or empty when the text cannot be a key (wrong tag, wrong length, no dot where it belongs). */
    public static Optional<String> prefixOf(String key) {
        if (key == null || key.length() != KEY_LENGTH || !key.startsWith(TAG) || key.charAt(TAG.length() + PREFIX_LENGTH) != '.') return Optional.empty();
        return Optional.of(key.substring(TAG.length(), TAG.length() + PREFIX_LENGTH));
    }
}