package io.appfleet.identity.admin;

import io.appfleet.identity.admin.AdminDTOs.RoleView;
import io.appfleet.identity.common.ApiExceptions.ConflictException;
import io.appfleet.identity.common.ApiExceptions.InvalidFieldException;
import io.appfleet.identity.rbac.Permission;
import io.appfleet.identity.rbac.PermissionRepository;
import io.appfleet.identity.rbac.Role;
import io.appfleet.identity.rbac.RoleRepository;
import org.springframework.dao.DataIntegrityViolationException;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Set;

/**
 * A new role is a database row, not a code change (plan decision 2). A role made here is not part of the RoleHierarchy: it
 * grants exactly the permissions listed, and nothing more. Roles are not edited or deleted: a role change would change the
 * tokens of everyone who holds it (open question 2 of I6b).
 */
@Service
public class RoleAdminService {

    private final RoleRepository roles;
    private final PermissionRepository permissions;

    public RoleAdminService(RoleRepository roles, PermissionRepository permissions) {
        this.roles = roles;
        this.permissions = permissions;
    }

    @Transactional(readOnly = true)
    public List<RoleView> list() {
        return roles.findAllBy().stream().sorted(Comparator.comparing(Role::getName)).map(RoleAdminService::view).toList();
    }

    @Transactional
    public RoleView create(String name, String description, List<String> permissionNames) {
        if (roles.existsByName(name)) throw new ConflictException("a role with that name exists");
        Set<String> wanted = new HashSet<>(permissionNames);
        List<Permission> found = permissions.findByNameIn(wanted);
        if (found.size() != wanted.size()) {
            Set<String> known = new HashSet<>();
            found.forEach(p -> known.add(p.getName()));
            String unknown = wanted.stream().filter(n -> !known.contains(n)).sorted().findFirst().orElse("?");
            throw new InvalidFieldException("permissions", "unknown permission: " + unknown);
        }
        try {
            return view(roles.save(new Role(name, description.trim(), new HashSet<>(found))));
        } catch (DataIntegrityViolationException e) {
            throw new ConflictException("a role with that name exists");
        }
    }

    private static RoleView view(Role r) {
        return new RoleView(r.getName(), r.getDescription(), r.getPermissions().stream().map(Permission::getName).sorted().toList());
    }
}