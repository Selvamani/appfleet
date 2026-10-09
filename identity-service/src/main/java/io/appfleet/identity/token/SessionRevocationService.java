package io.appfleet.identity.token;

import io.appfleet.security.RedisJwtDenylist;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Clock;
import java.time.Instant;
import java.util.List;
import java.util.UUID;

/**
 * Ends sessions: the refresh side is revoked in the database, and every access token those sessions still have in the
 * air goes on the Redis denylist until it could no longer be accepted.
 *
 * Order matters and is deliberate: the database first, Redis last, all in one transaction. If Redis fails, the
 * transaction rolls back, the caller sees an error and can retry, and nothing is half done on the refresh side. If the
 * commit fails after Redis was written, a token is refused that did not need to be, which is the safe direction.
 */
@Service
public class SessionRevocationService {

    private final RefreshTokenRepository tokens;
    private final RedisJwtDenylist denylist;
    private final Clock clock;

    public SessionRevocationService(RefreshTokenRepository tokens, RedisJwtDenylist denylist, Clock clock) {
        this.tokens = tokens;
        this.denylist = denylist;
        this.clock = clock;
    }

    /** Logout: whatever refresh token of the session is presented, used or not, the whole family ends. Unknown tokens do nothing. */
    @Transactional
    public void logout(String presentedRefreshToken) {
        tokens.findByTokenHash(TokenHasher.hash(presentedRefreshToken)).ifPresent(link -> revokeFamily(link.getFamilyId()));
    }

    @Transactional
    public void revokeFamily(UUID familyId) {
        Instant now = clock.instant();
        tokens.revokeActiveInFamily(familyId, now);
        deny(tokens.findLiveAccessTokensOfFamily(familyId, now.minus(denylist.clockSkew())));
    }

    /** Every session of one user: used when something about the user changes that tokens already issued would not show (a role). */
    @Transactional
    public int revokeAllSessions(UUID userId) {
        Instant now = clock.instant();
        int cut = tokens.revokeActiveForUser(userId, now);
        deny(tokens.findLiveAccessTokensOfUser(userId, now.minus(denylist.clockSkew())));
        return cut;
    }

    private void deny(List<AccessRef> refs) {
        refs.forEach(r -> denylist.revoke(r.jti().toString(), r.expiresAt()));
    }
}