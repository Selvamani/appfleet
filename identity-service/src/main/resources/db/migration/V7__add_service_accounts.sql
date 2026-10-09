-- I7: service accounts and their API keys. A service account is a machine principal that belongs to ONE team and holds ONE role in it.
-- It is not a user: it has no password, no email, and it never appears in app_user.
CREATE TABLE service_account (
                                 id          uuid PRIMARY KEY,
                                 team_id     uuid NOT NULL REFERENCES team(id),
                                 role_id     uuid NOT NULL REFERENCES role(id),
                                 name        text NOT NULL,
                                 status      text NOT NULL CHECK (status IN ('ACTIVE', 'DISABLED')),
                                 created_at  timestamptz NOT NULL,
                                 created_by  uuid NOT NULL REFERENCES app_user(id),
                                 disabled_at timestamptz,
                                 CONSTRAINT uq_service_account_team_name UNIQUE (team_id, name),
                                 CONSTRAINT ck_service_account_name CHECK (name ~ '^[a-z0-9][a-z0-9-]{1,62}$'),
    CONSTRAINT ck_service_account_disabled CHECK ((status = 'DISABLED') = (disabled_at IS NOT NULL))
);
CREATE INDEX idx_service_account_team ON service_account (team_id);

-- One row per key. Only the SHA-256 of the key is stored (a key is 256 random bits, so a fast hash is enough: there is nothing to guess).
-- The prefix is the public half of the key (it names the row); the hash CHECK makes a plain-text key impossible to insert.
CREATE TABLE api_key (
                         id                 uuid PRIMARY KEY,
                         service_account_id uuid NOT NULL REFERENCES service_account(id),
                         prefix             text NOT NULL,
                         key_hash           text NOT NULL,
                         status             text NOT NULL CHECK (status IN ('ACTIVE', 'REVOKED')),
                         created_at         timestamptz NOT NULL,
                         created_by         uuid NOT NULL REFERENCES app_user(id),
                         revoked_at         timestamptz,
                         last_used_at       timestamptz,
                         CONSTRAINT uq_api_key_prefix UNIQUE (prefix),
                         CONSTRAINT uq_api_key_hash UNIQUE (key_hash),
                         CONSTRAINT ck_api_key_hash_shape CHECK (key_hash ~ '^[0-9a-f]{64}$'),
    CONSTRAINT ck_api_key_revoked CHECK ((status = 'REVOKED') = (revoked_at IS NOT NULL))
);
CREATE INDEX idx_api_key_account ON api_key (service_account_id);