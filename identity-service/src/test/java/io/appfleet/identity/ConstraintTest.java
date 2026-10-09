package io.appfleet.identity;

import org.junit.jupiter.api.Test;
import org.springframework.dao.DataIntegrityViolationException;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** The rules live in the database, not only in JPA: each statement below goes around the entities with plain SQL. */
class ConstraintTest extends IdentityIntegrationTest {

    private UUID insertUser(String email) {
        UUID id = UUID.randomUUID();
        jdbc.update("insert into app_user (id, email, display_name, password_hash, status, created_at) "
                + "values (?, ?, 'n', 'h', 'ACTIVE', now())", id, email);
        return id;
    }

    private UUID insertTeam(String name) {
        UUID id = UUID.randomUUID();
        jdbc.update("insert into team (id, name, created_at) values (?, ?, now())", id, name);
        return id;
    }

    private UUID roleId(String name) {
        return jdbc.queryForObject("select id from role where name = ?", UUID.class, name);
    }

    @Test
    void duplicateEmail_isRefused() {
        String email = "dup-" + UUID.randomUUID() + "@x.io";
        insertUser(email);
        assertThatThrownBy(() -> insertUser(email))
                .isInstanceOf(DataIntegrityViolationException.class).hasMessageContaining("uq_app_user_email");
    }

    @Test
    void upperCaseEmail_isRefused_soTwoSpellingsCannotCoexist() {
        assertThatThrownBy(() -> insertUser("Mixed-" + UUID.randomUUID() + "@X.io"))
                .isInstanceOf(DataIntegrityViolationException.class).hasMessageContaining("ck_app_user_email_lower");
    }

    @Test
    void unknownStatus_isRefused() {
        assertThatThrownBy(() -> jdbc.update("insert into app_user (id, email, display_name, password_hash, status, created_at) "
                + "values (?, ?, 'n', 'h', 'DELETED', now())", UUID.randomUUID(), "s-" + UUID.randomUUID() + "@x.io"))
                .isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void deactivatedWithoutATimestamp_isRefused() {
        assertThatThrownBy(() -> jdbc.update("insert into app_user (id, email, display_name, password_hash, status, created_at) "
                + "values (?, ?, 'n', 'h', 'DEACTIVATED', now())", UUID.randomUUID(), "d-" + UUID.randomUUID() + "@x.io"))
                .isInstanceOf(DataIntegrityViolationException.class).hasMessageContaining("ck_app_user_deactivated");
    }

    @Test
    void duplicateRoleName_isRefused() {
        assertThatThrownBy(() -> jdbc.update("insert into role (id, name, description) values (?, 'VIEWER', 'again')", UUID.randomUUID()))
                .isInstanceOf(DataIntegrityViolationException.class).hasMessageContaining("uq_role_name");
    }

    @Test
    void permissionNameWithoutTheResourceActionShape_isRefused() {
        assertThatThrownBy(() -> jdbc.update("insert into permission (id, name, description) values (?, 'deployment', 'x')", UUID.randomUUID()))
                .isInstanceOf(DataIntegrityViolationException.class).hasMessageContaining("ck_permission_name");
        assertThatThrownBy(() -> jdbc.update("insert into permission (id, name, description) values (?, 'Deployment:Create', 'x')", UUID.randomUUID()))
                .isInstanceOf(DataIntegrityViolationException.class).hasMessageContaining("ck_permission_name");
    }

    @Test
    void secondRoleForTheSameUserAndTeam_isRefused() {
        UUID user = insertUser("m-" + UUID.randomUUID() + "@x.io");
        UUID team = insertTeam("t-" + UUID.randomUUID());
        String sql = "insert into team_membership (id, user_id, team_id, role_id, created_at) values (?, ?, ?, ?, now())";
        jdbc.update(sql, UUID.randomUUID(), user, team, roleId("VIEWER"));
        assertThatThrownBy(() -> jdbc.update(sql, UUID.randomUUID(), user, team, roleId("ADMIN")))
                .isInstanceOf(DataIntegrityViolationException.class).hasMessageContaining("uq_team_membership_user_team");
    }

    @Test
    void membershipWithAnUnknownRole_isRefused() {
        UUID user = insertUser("f-" + UUID.randomUUID() + "@x.io");
        UUID team = insertTeam("f-" + UUID.randomUUID());
        assertThatThrownBy(() -> jdbc.update(
                "insert into team_membership (id, user_id, team_id, role_id, created_at) values (?, ?, ?, ?, now())",
                UUID.randomUUID(), user, team, UUID.randomUUID()))
                .isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void aRoleThatIsInUse_cannotBeDeleted() {
        UUID user = insertUser("r-" + UUID.randomUUID() + "@x.io");
        UUID team = insertTeam("r-" + UUID.randomUUID());
        jdbc.update("insert into team_membership (id, user_id, team_id, role_id, created_at) values (?, ?, ?, ?, now())",
                UUID.randomUUID(), user, team, roleId("DEPLOYER"));
        assertThatThrownBy(() -> jdbc.update("delete from role where name = 'DEPLOYER'"))
                .isInstanceOf(DataIntegrityViolationException.class);
        assertThat(jdbc.queryForObject("select count(*) from role where name = 'DEPLOYER'", Integer.class)).isEqualTo(1);
    }
}