package io.appfleet.identity;

import io.appfleet.identity.token.TokenHasher;
import org.junit.jupiter.api.Test;
import org.springframework.dao.DataIntegrityViolationException;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThat;
import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** What the database refuses on its own, whatever the code does: a plain-text key, a half-revoked key, a bad audit row. */
class ServiceAccountConstraintTest extends IdentityIntegrationTest {

    private UUID user() {
        UUID id = UUID.randomUUID();
        jdbc.update("insert into app_user (id, email, display_name, password_hash, status, created_at) values (?, ?, 'x', 'h', 'ACTIVE', now())", id, "c-" + id + "@x.io");
        return id;
    }

    private UUID account(UUID creator) {
        UUID team = UUID.randomUUID();
        jdbc.update("insert into team (id, name, created_at) values (?, ?, now())", team, "t-" + team);
        UUID id = UUID.randomUUID();
        jdbc.update("insert into service_account (id, team_id, role_id, name, status, created_at, created_by) values (?, ?, (select id from role where name = 'VIEWER'), ?, 'ACTIVE', now(), ?)",
                id, team, "acct-" + id.toString().substring(0, 8), creator);
        return id;
    }

    private void insertKey(UUID account, UUID creator, String prefix, String hash, String status, boolean revokedAt) {
        jdbc.update("insert into api_key (id, service_account_id, prefix, key_hash, status, created_at, created_by, revoked_at) values (?, ?, ?, ?, ?, now(), ?, " + (revokedAt ? "now()" : "null") + ")",
                UUID.randomUUID(), account, prefix, hash, status, creator);
    }

    @Test
    void aPlainTextKey_cannotBeStored() {
        UUID creator = user();
        UUID account = account(creator);
        String plain = "afk_" + TokenHasher.newToken().substring(0, 11) + "." + TokenHasher.newToken();
        assertThatThrownBy(() -> insertKey(account, creator, "p" + UUID.randomUUID().toString().substring(0, 10), plain, "ACTIVE", false))
                .isInstanceOf(DataIntegrityViolationException.class).hasMessageContaining("ck_api_key_hash_shape");
        insertKey(account, creator, "q" + UUID.randomUUID().toString().substring(0, 10), TokenHasher.hash(plain), "ACTIVE", false);   // a hash is fine
    }

    @Test
    void aPrefixAndAHash_areEachUnique() {
        UUID creator = user();
        UUID account = account(creator);
        String prefix = "u" + UUID.randomUUID().toString().substring(0, 10);
        String hash = TokenHasher.hash(TokenHasher.newToken());
        insertKey(account, creator, prefix, hash, "ACTIVE", false);
        assertThatThrownBy(() -> insertKey(account, creator, prefix, TokenHasher.hash(TokenHasher.newToken()), "ACTIVE", false)).isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(() -> insertKey(account, creator, "v" + UUID.randomUUID().toString().substring(0, 10), hash, "ACTIVE", false)).isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void revoked_andItsTimestamp_goTogether() {
        UUID creator = user();
        UUID account = account(creator);
        assertThatThrownBy(() -> insertKey(account, creator, "r" + UUID.randomUUID().toString().substring(0, 10), TokenHasher.hash(TokenHasher.newToken()), "REVOKED", false))
                .isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(() -> insertKey(account, creator, "s" + UUID.randomUUID().toString().substring(0, 10), TokenHasher.hash(TokenHasher.newToken()), "ACTIVE", true))
                .isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void aServiceAccountName_isASlug() {
        UUID creator = user();
        UUID team = UUID.randomUUID();
        jdbc.update("insert into team (id, name, created_at) values (?, ?, now())", team, "t-" + team);
        for (String bad : new String[]{"Upper", "has space", "x", "-lead", "under_score"})
            assertThatThrownBy(() -> jdbc.update("insert into service_account (id, team_id, role_id, name, status, created_at, created_by) values (?, ?, (select id from role where name = 'VIEWER'), ?, 'ACTIVE', now(), ?)",
                    UUID.randomUUID(), team, bad, creator)).as(bad).isInstanceOf(DataIntegrityViolationException.class);
    }

    private void audit(String event, String outcome, UUID serviceAccountId) {
        jdbc.update("insert into login_audit (id, occurred_at, event, outcome, service_account_id) values (?, now(), ?, ?, ?)", UUID.randomUUID(), event, outcome, serviceAccountId);
    }

    @Test
    void theAudit_acceptsServiceTokenRows_andOnlyWithTheirOwnOutcomes() {
        UUID account = account(user());
        audit("SERVICE_TOKEN", "SUCCESS", account);
        audit("SERVICE_TOKEN", "INVALID_KEY", null);
        assertThatThrownBy(() -> audit("SERVICE_TOKEN", "BAD_CREDENTIALS", account)).isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(() -> audit("LOGIN", "INVALID_KEY", null)).isInstanceOf(DataIntegrityViolationException.class);
        assertThatThrownBy(() -> audit("SERVICE_TOKEN", "SUCCESS", UUID.randomUUID())).as("an account that does not exist").isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void theAudit_isStillAppendOnly_afterTheMigration() {
        UUID account = account(user());
        UUID id = UUID.randomUUID();
        jdbc.update("insert into login_audit (id, occurred_at, event, outcome, service_account_id) values (?, now(), 'SERVICE_TOKEN', 'SUCCESS', ?)", id, account);
        assertThatThrownBy(() -> jdbc.update("update login_audit set outcome = 'INVALID_KEY' where id = ?", id)).hasMessageContaining("append-only");
        assertThatThrownBy(() -> jdbc.update("delete from login_audit where id = ?", id)).hasMessageContaining("append-only");
        assertThat(jdbc.queryForObject("select outcome from login_audit where id = ?", String.class, id)).isEqualTo("SUCCESS");
    }
}