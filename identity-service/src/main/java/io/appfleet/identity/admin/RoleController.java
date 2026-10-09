package io.appfleet.identity.admin;

import io.appfleet.identity.admin.AdminDTOs.CreateRole;
import io.appfleet.identity.admin.AdminDTOs.RoleView;
import jakarta.validation.Valid;
import org.springframework.http.HttpStatus;
import org.springframework.http.ResponseEntity;
import org.springframework.security.access.prepost.PreAuthorize;
import org.springframework.web.bind.annotation.GetMapping;
import org.springframework.web.bind.annotation.PostMapping;
import org.springframework.web.bind.annotation.RequestBody;
import org.springframework.web.bind.annotation.RequestMapping;
import org.springframework.web.bind.annotation.RestController;

import java.util.List;

@RestController
@RequestMapping("/api/v1/roles")
public class RoleController {

    private final RoleAdminService roles;

    public RoleController(RoleAdminService roles) {
        this.roles = roles;
    }

    @GetMapping
    @PreAuthorize("@guard.platformAdmin(authentication)")
    List<RoleView> list() {
        return roles.list();
    }

    @PostMapping
    @PreAuthorize("@guard.platformAdmin(authentication)")
    ResponseEntity<RoleView> create(@Valid @RequestBody CreateRole request) {
        return ResponseEntity.status(HttpStatus.CREATED).body(roles.create(request.name(), request.description(), request.permissions()));
    }
}