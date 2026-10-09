-- I4: remember which access token each refresh link issued, so that logging out can denylist it.
-- Nullable: rows written before this migration have none (and their access tokens have long expired).
ALTER TABLE refresh_token
    ADD COLUMN access_jti        uuid,
    ADD COLUMN access_expires_at timestamptz;