package io.appfleet.identity.admin;

import io.appfleet.identity.admin.AdminDTOs.PageOf;
import io.appfleet.identity.admin.AdminDTOs.UserSummary;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RequestParam;
import org.springframework.web.bind.annotation.RestController;

import java.util.UUID;

/** Platform administrators only. /users/me (UserController) is a literal path and wins over /users/{id}. */
@RestController
@RequestMapping("/api/v1/users")
public class UserAdminController {

    private final UserAdminService users;

    public UserAdminController(UserAdminService users) {
        this.users = users;
    }

    @GetMapping
    @PreAuthorize("@guard.platformAdmin(authentication)")
    PageOf<UserSummary> list(@RequestParam(required = false) UUID cursor, @RequestParam(defaultValue = "50") int limit) {
        return users.list(cursor, limit);
    }

    @GetMapping("/{id}")
    @PreAuthorize("@guard.platformAdmin(authentication)")
    UserSummary get(@PathVariable UUID id) {
        return users.get(id);
    }

    @PostMapping("/{id}/deactivate")
    @PreAuthorize("@guard.platformAdmin(authentication)")
    UserSummary deactivate(@PathVariable UUID id, @AuthenticationPrincipal Jwt jwt) {
        return users.deactivate(UUID.fromString(jwt.getSubject()), id);
    }
}