package io.appfleet.identity;

import org.junit.jupiter.api.Test;
import org.springframework.dao.DataIntegrityViolationException;

import java.util.UUID;

import static org.assertj.core.api.Assertions.assertThatThrownBy;

/** The audit's rules that live in the database, with plain SQL. */
class LoginAuditConstraintTest extends IdentityIntegrationTest {

    private void insert(String event, String outcome, UUID userId) {
        jdbc.update("insert into login_audit (id, occurred_at, event, outcome, user_id) values (?, now(), ?, ?, ?)",
                UUID.randomUUID(), event, outcome, userId);
    }

    @Test
    void aLoginOutcome_belongsToALoginEvent() {
        insert("LOGIN", "BAD_CREDENTIALS", null);
        insert("LOGIN", "LOCKED", null);
        insert("REFRESH_REUSE", "REUSED", null);
    }

    @Test
    void anUnknownOutcome_isRefused() {
        assertThatThrownBy(() -> insert("LOGIN", "WHATEVER", null))
                .isInstanceOf(DataIntegrityViolationException.class).hasMessageContaining("ck_login_audit_event_outcome");
    }

    @Test
    void aReuseOutcome_cannotBelongToALogin() {
        assertThatThrownBy(() -> insert("LOGIN", "REUSED", null)).isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void aLoginOutcome_cannotBelongToAReuse() {
        assertThatThrownBy(() -> insert("REFRESH_REUSE", "SUCCESS", null)).isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void anUnknownEvent_isRefused() {
        assertThatThrownBy(() -> insert("LOGOUT", "SUCCESS", null)).isInstanceOf(DataIntegrityViolationException.class);
    }

    @Test
    void aUserThatDoesNotExist_isRefused() {
        assertThatThrownBy(() -> insert("LOGIN", "SUCCESS", UUID.randomUUID())).isInstanceOf(DataIntegrityViolationException.class);
    }
}