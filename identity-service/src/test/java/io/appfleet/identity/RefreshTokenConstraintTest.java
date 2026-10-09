package io.appfleet.identity;

import org.junit.jupiter.api.Test;
import org.springframework.dao.DataIntegrityViolationException;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** The refresh-token rules that live in the database: plain SQL, no entities. */
class RefreshTokenConstraintTest extends IdentityIntegrationTest {

    private UUID user() {
        UUID id = UUID.randomUUID();
        jdbc.update("insert into app_user (id, email, display_name, password_hash, status, created_at) values (?, ?, 'n', 'h', 'ACTIVE', now())",
                id, "rt-" + UUID.randomUUID() + "@x.io");
        return id;
    }

    private void insert(UUID user, UUID family, String hash, String status, boolean used, boolean revoked) {
        jdbc.update("""
                insert into refresh_token (id, user_id, family_id, family_started_at, token_hash, status, issued_at, expires_at, used_at, revoked_at)
                values (?, ?, ?, now(), ?, ?, now(), now() + interval '7 days',
                        case when ? then now() end, case when ? then now() end)
                """, UUID.randomUUID(), user, family, hash, status, used, revoked);
    }

    @Test
    void aFamily_cannotHaveTwoActiveLinks() {
        UUID user = user(), family = UUID.randomUUID();
        insert(user, family, "h-" + UUID.randomUUID(), "ACTIVE", false, false);
        assertThatThrownBy(() -> insert(user, family, "h-" + UUID.randomUUID(), "ACTIVE", false, false))
                .isInstanceOf(DataIntegrityViolationException.class).hasMessageContaining("uq_refresh_token_one_active_per_family");
    }

    @Test
    void aFamily_mayHaveManyUsedLinksAndOneActive() {
        UUID user = user(), family = UUID.randomUUID();
        insert(user, family, "h-" + UUID.randomUUID(), "USED", true, false);
        insert(user, family, "h-" + UUID.randomUUID(), "USED", true, false);
        insert(user, family, "h-" + UUID.randomUUID(), "ACTIVE", false, false);
        assertThat(jdbc.queryForObject("select count(*) from refresh_token where family_id = ?", Integer.class, family)).isEqualTo(3);
    }

    @Test
    void theSameTokenHash_isRefused() {
        UUID user = user();
        String hash = "h-" + UUID.randomUUID();
        insert(user, UUID.randomUUID(), hash, "ACTIVE", false, false);
        assertThatThrownBy(() -> insert(user, UUID.randomUUID(), hash, "ACTIVE", false, false))
                .isInstanceOf(DataIntegrityViolationException.class).hasMessageContaining("uq_refresh_token_hash");
    }

    @Test
    void usedWithoutATimestamp_isRefused() {
        assertThatThrownBy(() -> insert(user(), UUID.randomUUID(), "h-" + UUID.randomUUID(), "USED", false, false))
                .isInstanceOf(DataIntegrityViolationException.class).hasMessageContaining("ck_refresh_token_used");
    }

    @Test
    void revokedWithoutATimestamp_isRefused() {
        assertThatThrownBy(() -> insert(user(), UUID.randomUUID(), "h-" + UUID.randomUUID(), "REVOKED", false, false))
                .isInstanceOf(DataIntegrityViolationException.class).hasMessageContaining("ck_refresh_token_revoked");
    }

    @Test
    void anUnknownStatus_isRefused() {
        assertThatThrownBy(() -> insert(user(), UUID.randomUUID(), "h-" + UUID.randomUUID(), "SPENT", false, false))
                .isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void aTokenForAnUnknownUser_isRefused() {
        assertThatThrownBy(() -> insert(UUID.randomUUID(), UUID.randomUUID(), "h-" + UUID.randomUUID(), "ACTIVE", false, false))
                .isInstanceOf(DataIntegrityViolationException.class);
    }
}