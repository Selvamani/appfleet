package io.appfleet.identity.rbac;

import org.springframework.security.access.hierarchicalroles.RoleHierarchy;
import org.springframework.security.core.GrantedAuthority;
import org.springframework.security.core.authority.SimpleGrantedAuthority;
import org.springframework.stereotype.Service;
import org.springframework.transaction.annotation.Transactional;

import java.util.*;
import java.util.stream.Collectors;


/**
 * Turns a role name into the permissions it grants, including everything the role hierarchy implies.
 * The token issuer calls this once per team membership.
 */
@Service
public class PermissionResolver {

    private final RoleHierarchy roleHierarchy;
    private final RoleRepository roles;

    public PermissionResolver(RoleHierarchy roleHierarchy, RoleRepository roles) {
        this.roleHierarchy = roleHierarchy;
        this.roles = roles;
    }

    @Transactional(readOnly = true)
    public Set<String> permissionsFor(String roleName) {
        Map<String, Role> byName  = roles.findAllBy().stream().collect(Collectors.toMap(Role::getName, role -> role));
        if (!byName.containsKey(roleName))
            throw new IllegalArgumentException("unknown role: " + roleName);

        List<String> reachable = roleHierarchy
                .getReachableGrantedAuthorities(List.of(new SimpleGrantedAuthority(roleName)))
                .stream().map(GrantedAuthority::getAuthority).toList();
        Set<String> permissions = new TreeSet<>();
        for(String name : new HashSet<>(reachable)) {
            Role role = byName.get(name);
            if (role == null) throw new IllegalStateException("role hierarchy names a role that is not in the database: " + name);
            role.getPermissions().forEach(p -> permissions.add(p.getName()));
        }
        return permissions;
    }
}
