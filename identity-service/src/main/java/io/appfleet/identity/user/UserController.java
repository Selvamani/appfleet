package io.appfleet.identity.user;

import io.appfleet.identity.user.UserDTOs.ChangePassword;
import io.appfleet.identity.user.UserDTOs.Profile;
import io.appfleet.identity.user.UserDTOs.UpdateProfile;
import jakarta.validation.Valid;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.*;

import java.util.UUID;

/**
 * Self-service: the user is always the token's subject. Every handler carries its own @PreAuthorize, even when the rule is
 * only "signed in": EveryEndpointIsAnnotatedTest fails the build for a handler that has none.
 */
@RestController
@RequestMapping("/api/v1/users/me")
public class UserController {

    private final UserService users;

    public UserController(UserService users) {
        this.users = users;
    }

    @GetMapping
    @PreAuthorize("isAuthenticated()")
    Profile me(@AuthenticationPrincipal Jwt jwt) {
        return users.me(subject(jwt));
    }

    @PutMapping
    @PreAuthorize("isAuthenticated()")
    Profile update(@Valid @RequestBody UpdateProfile request, @AuthenticationPrincipal Jwt jwt) {
        return users.rename(subject(jwt), request.displayName());
    }

    @PostMapping("/password")
    @PreAuthorize("isAuthenticated()")
    ResponseEntity<Void> changePassword(@Valid @RequestBody ChangePassword request, @AuthenticationPrincipal Jwt jwt) {
        users.changePassword(subject(jwt), request.currentPassword(), request.newPassword());
        return ResponseEntity.noContent().build();
    }

    private static UUID subject(Jwt jwt) {
        return UUID.fromString(jwt.getSubject());
    }
}
