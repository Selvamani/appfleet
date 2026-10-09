package io.appfleet.identity;

import org.junit.jupiter.api.Test;

import java.util.List;
import java.util.Map;
import java.util.TreeMap;

import static org.assertj.core.api.Assertions.assertThat;

/** The migration ran, Hibernate's validate accepted the mappings (the context started), and the seed is exactly this. */
class SchemaAndSeedTest extends IdentityIntegrationTest {

    @Test
    void roles_areTheFourSeeded() {
        List<String> roles = jdbc.queryForList("select name from role order by name", String.class);
        assertThat(roles).containsExactly("ADMIN", "DEPLOYER", "OPERATOR", "VIEWER");
    }

    @Test
    void permissions_areTheVocabulary() {
        List<String> permissions = jdbc.queryForList("select name from permission order by name", String.class);
        assertThat(permissions).containsExactly(
                "application:create", "application:read", "catalog:publish", "deployment:create",
                "deployment:read", "deployment:rollback", "node:drain", "user:manage");
    }

    @Test
    void eachRole_holdsOnlyItsOwnPermissions() {
        Map<String, List<String>> own = new TreeMap<>();
        jdbc.query("""
                select r.name as role_name, p.name as permission_name
                from role_permission rp join role r on r.id = rp.role_id join permission p on p.id = rp.permission_id
                order by r.name, p.name
                """, rs -> {
            own.computeIfAbsent(rs.getString("role_name"), k -> new java.util.ArrayList<>()).add(rs.getString("permission_name"));
        });
        assertThat(own).containsOnlyKeys("ADMIN", "DEPLOYER", "OPERATOR", "VIEWER");
        assertThat(own.get("VIEWER")).containsExactly("application:read", "deployment:read");
        assertThat(own.get("DEPLOYER")).containsExactly("application:create", "deployment:create");
        assertThat(own.get("OPERATOR")).containsExactly("deployment:rollback", "node:drain");
        assertThat(own.get("ADMIN")).containsExactly("catalog:publish", "user:manage");
    }
}