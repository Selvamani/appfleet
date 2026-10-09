package io.appfleet.identity.serviceaccount;

import io.appfleet.identity.serviceaccount.ServiceAccountDTOs.AccountView;
import io.appfleet.identity.serviceaccount.ServiceAccountDTOs.CreateServiceAccount;
import io.appfleet.identity.serviceaccount.ServiceAccountDTOs.CreatedAccount;
import io.appfleet.identity.serviceaccount.ServiceAccountDTOs.IssuedKey;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.security.core.annotation.AuthenticationPrincipal;
import org.springframework.security.oauth2.jwt.Jwt;
import org.springframework.web.bind.annotation.DeleteMapping;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PathVariable;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;
import java.util.UUID;

/**
 * The service accounts of a team, managed by that team's administrators (or the platform's). A service account lives under its
 * team in the path, and the service looks it up with that team id: the same account id under another team is a 404.
 */
@RestController
@RequestMapping("/api/v1/teams/{teamId}/service-accounts")
public class ServiceAccountController {

    private final ServiceAccountService service;

    public ServiceAccountController(ServiceAccountService service) {
        this.service = service;
    }

    @PostMapping
    @PreAuthorize("@guard.teamAdmin(authentication, #teamId)")
    ResponseEntity<CreatedAccount> create(@PathVariable UUID teamId, @Valid @RequestBody CreateServiceAccount request, @AuthenticationPrincipal Jwt jwt) {
        return ResponseEntity.status(HttpStatus.CREATED).body(service.create(teamId, UUID.fromString(jwt.getSubject()), request.name(), request.role()));
    }

    @GetMapping
    @PreAuthorize("@guard.teamAdmin(authentication, #teamId)")
    List<AccountView> list(@PathVariable UUID teamId) {
        return service.list(teamId);
    }

    @PostMapping("/{accountId}/keys")
    @PreAuthorize("@guard.teamAdmin(authentication, #teamId)")
    ResponseEntity<IssuedKey> addKey(@PathVariable UUID teamId, @PathVariable UUID accountId, @AuthenticationPrincipal Jwt jwt) {
        return ResponseEntity.status(HttpStatus.CREATED).body(service.addKey(teamId, accountId, UUID.fromString(jwt.getSubject())));
    }

    @DeleteMapping("/{accountId}/keys/{keyId}")
    @PreAuthorize("@guard.teamAdmin(authentication, #teamId)")
    ResponseEntity<Void> revokeKey(@PathVariable UUID teamId, @PathVariable UUID accountId, @PathVariable UUID keyId) {
        service.revokeKey(teamId, accountId, keyId);
        return ResponseEntity.noContent().build();
    }

    @PostMapping("/{accountId}/disable")
    @PreAuthorize("@guard.teamAdmin(authentication, #teamId)")
    AccountView disable(@PathVariable UUID teamId, @PathVariable UUID accountId) {
        return service.disable(teamId, accountId);
    }
}