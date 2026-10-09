package io.appfleet.identity.admin;

import io.appfleet.identity.admin.AdminDTOs.PageOf;
import io.appfleet.identity.admin.AdminDTOs.UserSummary;
import io.appfleet.identity.common.ApiExceptions.ConflictException;
import io.appfleet.identity.common.ApiExceptions.NotFoundException;
import io.appfleet.identity.token.SessionRevocationService;
import io.appfleet.identity.user.AppUser;
import io.appfleet.identity.user.UserRepository;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.UUID;

/** What a platform administrator does to users. Users are deactivated, never deleted (plan decision 12). */
@Service
public class UserAdminService {

    private final UserRepository users;
    private final SessionRevocationService sessions;

    public UserAdminService(UserRepository users, SessionRevocationService sessions) {
        this.users = users;
        this.sessions = sessions;
    }

    @Transactional(readOnly = true)
    public PageOf<UserSummary> list(UUID cursor, int limit) {
        var page = Paging.request(limit);
        var rows = cursor == null ? users.findAllByOrderByIdAsc(page) : users.findByIdGreaterThanOrderByIdAsc(cursor, page);
        return Paging.of(rows, limit, AppUser::getId, UserAdminService::view);
    }

    @Transactional(readOnly = true)
    public UserSummary get(UUID id) {
        return view(users.findById(id).orElseThrow(() -> new NotFoundException("user")));
    }

    /**
     * Ends the account: it cannot sign in or refresh, and every session it has ends NOW (refresh tokens revoked, live
     * access tokens denylisted). Calling it twice changes nothing. An administrator cannot deactivate themselves.
     */
    @Transactional
    public UserSummary deactivate(UUID actorId, UUID targetId) {
        if (actorId.equals(targetId)) throw new ConflictException("you cannot deactivate your own account");
        AppUser user = users.findById(targetId).orElseThrow(() -> new NotFoundException("user"));
        user.deactivate();
        sessions.revokeAllSessions(targetId);
        return view(user);
    }

    private static UserSummary view(AppUser u) {
        return new UserSummary(u.getId(), u.getEmail(), u.getDisplayName(), u.getStatus(), u.getCreatedAt(), u.getDeactivatedAt());
    }
}