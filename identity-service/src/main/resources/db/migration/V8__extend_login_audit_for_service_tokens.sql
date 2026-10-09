-- I7: the login audit also records the exchange of an API key for a token (event SERVICE_TOKEN), and which service account it was about.
-- ALTER TABLE does not fire the append-only triggers (they are BEFORE UPDATE OR DELETE and BEFORE TRUNCATE), and the existing rows still satisfy the new CHECK.
ALTER TABLE login_audit ADD COLUMN service_account_id uuid REFERENCES service_account(id);

ALTER TABLE login_audit DROP CONSTRAINT ck_login_audit_event_outcome;
ALTER TABLE login_audit ADD CONSTRAINT ck_login_audit_event_outcome CHECK (
    (event = 'LOGIN' AND outcome IN ('SUCCESS', 'BAD_CREDENTIALS', 'UNKNOWN_USER', 'DEACTIVATED', 'LOCKED'))
        OR (event = 'REFRESH_REUSE' AND outcome = 'REUSED')
        OR (event = 'SERVICE_TOKEN' AND outcome IN ('SUCCESS', 'INVALID_KEY')));