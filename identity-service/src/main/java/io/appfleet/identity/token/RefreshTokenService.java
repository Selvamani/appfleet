package io.appfleet.identity.token;

import io.appfleet.identity.config.RefreshProperties;
import io.appfleet.identity.user.AppUser;
import io.appfleet.identity.user.UserStatus;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Clock;
import java.time.Instant;
import java.util.UUID;

@Service
public class RefreshTokenService {

    private static final Logger log = LoggerFactory.getLogger(RefreshTokenService.class);

    /** The result of presenting a refresh token. A rejection is a RETURN VALUE, not an exception (see rotate). */
    public sealed interface Outcome permits Rotated, Rejected {}

    public record Rotated(AppUser user, String refreshToken, RefreshToken link) implements Outcome {}

    /** A new family's first link: the token (which exists nowhere else) and the managed row. */
    public record Started(String token, RefreshToken link) {}

    /** userId is set when the refusal is a reuse (for the audit); null for the others. */
    public record Rejected(Reason reason, UUID userId) implements Outcome {
        public Rejected(Reason reason) { this(reason, null); }
    }

    public enum Reason { UNKNOWN, EXPIRED, REUSED, REVOKED, USER_INACTIVE }

    private final RefreshTokenRepository tokens;
    private final RefreshProperties properties;
    private final Clock clock;

    public RefreshTokenService(RefreshTokenRepository tokens, RefreshProperties properties, Clock clock) {
        this.tokens = tokens;
        this.properties = properties;
        this.clock = clock;
    }

    /** Login: the first link of a new family. Returns the token itself, which exists in no database. */
    @Transactional
    public Started startFamily(AppUser user) {
        String token = TokenHasher.newToken();
        RefreshToken link = tokens.save(RefreshToken.startFamily(user, TokenHasher.hash(token), clock.instant(),
                properties.tokenTtl(), properties.familyMaxLifetime()));
        return new Started(token, link);
    }

    /**
     * Uses a presented token up and returns its successor. The row is locked first, so two requests with the same
     * token are decided one after the other.
     *
     * A refusal must COMMIT the family revocation it may have done. If this method threw on a reuse, the transaction
     * would roll back and the revocation would be lost, so refusals are returned, and the caller turns them into a 401
     * after the commit.
     */
    @Transactional
    public Outcome rotate(String presented) {
        Instant now = clock.instant();
        RefreshToken current = tokens.findByTokenHash(TokenHasher.hash(presented)).orElse(null);
        if (current == null) return new Rejected(Reason.UNKNOWN);

        switch (current.getStatus()) {
            case USED -> {
                // Someone presents a token that was already rotated: the owner or a thief has an older copy. Cut off the family.
                int cut = tokens.revokeActiveInFamily(current.getFamilyId(), now);
                log.warn("refresh token reuse: user {} family {}; {} active link(s) revoked", current.getUser().getId(), current.getFamilyId(), cut);
                return new Rejected(Reason.REUSED, current.getUser().getId());
            }
            case REVOKED -> {
                return new Rejected(Reason.REVOKED);
            }
            default -> { /* ACTIVE: carry on */ }
        }

        if (current.isExpiredAt(now)) return new Rejected(Reason.EXPIRED);

        AppUser user = current.getUser();
        if (user.getStatus() != UserStatus.ACTIVE) {
            tokens.revokeActiveInFamily(current.getFamilyId(), now);
            return new Rejected(Reason.USER_INACTIVE);
        }

        String next = TokenHasher.newToken();
        RefreshToken child = current.rotate(TokenHasher.hash(next), now, properties.tokenTtl(), properties.familyMaxLifetime());
        tokens.save(current);
        // Hibernate would insert the child before it updates the used link, and the unique index "one ACTIVE link per
        // family" would refuse that moment. Writing the update first keeps the family a chain at every instant.
        tokens.flush();
        RefreshToken saved = tokens.save(child);
        return new Rotated(user, next, saved);
    }
}