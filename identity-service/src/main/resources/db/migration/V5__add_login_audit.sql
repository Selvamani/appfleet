-- I5: the login audit. One row per sign-in attempt and per refresh-token reuse, written in its own transaction so that a
-- refused (rolled-back) login still leaves its row. Append-only: the database refuses UPDATE, DELETE and TRUNCATE.
CREATE TABLE login_audit (
                             id             uuid PRIMARY KEY,
                             occurred_at    timestamptz NOT NULL,
                             event          text NOT NULL,
                             outcome        text NOT NULL,
                             email          text,
                             user_id        uuid REFERENCES app_user(id),
                             ip             text,
                             user_agent     text,
                             correlation_id text,
                             CONSTRAINT ck_login_audit_event_outcome CHECK (
                                 (event = 'LOGIN' AND outcome IN ('SUCCESS', 'BAD_CREDENTIALS', 'UNKNOWN_USER', 'DEACTIVATED', 'LOCKED'))
                                     OR (event = 'REFRESH_REUSE' AND outcome = 'REUSED'))
);
CREATE INDEX idx_login_audit_user_time ON login_audit (user_id, occurred_at DESC);
CREATE INDEX idx_login_audit_time ON login_audit (occurred_at DESC);

CREATE FUNCTION login_audit_append_only() RETURNS trigger AS $$
BEGIN
    RAISE EXCEPTION 'login_audit is append-only';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_login_audit_no_change BEFORE UPDATE OR DELETE ON login_audit
    FOR EACH ROW EXECUTE FUNCTION login_audit_append_only();
CREATE TRIGGER trg_login_audit_no_truncate BEFORE TRUNCATE ON login_audit
    FOR EACH STATEMENT EXECUTE FUNCTION login_audit_append_only();