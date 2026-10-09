-- I3: refresh tokens, one row per link of a rotation chain. Only the SHA-256 of a token is stored.
CREATE TABLE refresh_token (
                               id                 uuid PRIMARY KEY,
                               user_id            uuid NOT NULL REFERENCES app_user(id),
                               family_id          uuid NOT NULL,
                               family_started_at  timestamptz NOT NULL,
                               parent_id          uuid REFERENCES refresh_token(id),
                               token_hash         text NOT NULL,
                               status             text NOT NULL CHECK (status IN ('ACTIVE', 'USED', 'REVOKED')),
                               issued_at          timestamptz NOT NULL,
                               expires_at         timestamptz NOT NULL,
                               used_at            timestamptz,
                               revoked_at         timestamptz,
                               CONSTRAINT uq_refresh_token_hash UNIQUE (token_hash),
                               CONSTRAINT ck_refresh_token_used CHECK ((status = 'USED') = (used_at IS NOT NULL)),
                               CONSTRAINT ck_refresh_token_revoked CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL))
);

-- A family can never fork: at most one link of it is ACTIVE at any time.
CREATE UNIQUE INDEX uq_refresh_token_one_active_per_family ON refresh_token (family_id) WHERE status = 'ACTIVE';
CREATE INDEX idx_refresh_token_user ON refresh_token (user_id);
CREATE INDEX idx_refresh_token_family ON refresh_token (family_id);