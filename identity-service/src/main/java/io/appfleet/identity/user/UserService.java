package io.appfleet.identity.user;

import io.appfleet.identity.user.UserDTOs.Profile;
import io.appfleet.identity.auth.AuthExceptions.AccountLockedException;
import io.appfleet.identity.auth.AuthExceptions.WrongCurrentPasswordException;
import io.appfleet.identity.auth.AuthExceptions.InvalidCredentialsException;
import io.appfleet.identity.auth.AuthExceptions.WeakPasswordException;
import io.appfleet.identity.auth.LockoutService;
import io.appfleet.identity.auth.PasswordPolicy;
import io.appfleet.identity.team.TeamMembershipRepository;
import io.appfleet.identity.token.SessionRevocationService;
import org.springframework.security.crypto.password.PasswordEncoder;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.time.Duration;
import java.util.Optional;
import java.util.UUID;

/** What a signed-in user may do to their own account. The caller's id comes from the token, never from the request. */
@Service
public class UserService {

    private final UserRepository users;
    private final TeamMembershipRepository memberships;
    private final PasswordEncoder encoder;
    private final PasswordPolicy policy;
    private final LockoutService lockout;
    private final SessionRevocationService sessions;

    public UserService(UserRepository users, TeamMembershipRepository memberships, PasswordEncoder encoder,
                       PasswordPolicy policy, LockoutService lockout, SessionRevocationService sessions) {
        this.users = users;
        this.memberships = memberships;
        this.encoder = encoder;
        this.policy = policy;
        this.lockout = lockout;
        this.sessions = sessions;
    }

    @Transactional(readOnly = true)
    public Profile me(UUID userId) {
        return profile(active(userId));
    }

    @Transactional
    public Profile rename(UUID userId, String displayName) {
        AppUser user = active(userId);
        user.rename(displayName.trim());
        return profile(user);
    }

    /**
     * The current password is checked first, and a wrong one counts as a failed sign-in on the SAME counter as the login:
     * a stolen access token must not become a way to guess the password without limit. On success every session of the
     * user ends (refresh tokens revoked, live access tokens denylisted), this one included, so the caller signs in again.
     */
    @Transactional
    public void changePassword(UUID userId, String currentPassword, String newPassword) {
        AppUser user = active(userId);
        String email = user.getEmail();
        Optional<Duration> locked = lockout.lockedFor(email);
        if (locked.isPresent()) throw new AccountLockedException(locked.get());
        if (!encoder.matches(currentPassword, user.getPasswordHash())) {
            lockout.recordFailure(email);
            throw new WrongCurrentPasswordException();
        }
        policy.check("newPassword", newPassword, email);
        if (encoder.matches(newPassword, user.getPasswordHash()))
            throw new WeakPasswordException("newPassword", "must differ from the current password");
        lockout.clear(email);
        user.changePasswordHash(encoder.encode(newPassword));
        sessions.revokeAllSessions(userId);
    }

    /** A token can outlive its user (denylist off): a deactivated or unknown user gets the same 401 as a bad sign-in. */
    private AppUser active(UUID userId) {
        return users.findById(userId).filter(u -> u.getStatus() == UserStatus.ACTIVE).orElseThrow(InvalidCredentialsException::new);
    }

    private Profile profile(AppUser u) {
        var grants = memberships.findGrantsByUserId(u.getId()).stream().map(g -> new UserDTOs.Grant(g.teamId(), g.roleName())).toList();
        return new Profile(u.getId(), u.getEmail(), u.getDisplayName(), u.getStatus(), u.getCreatedAt(), grants);
    }
}
