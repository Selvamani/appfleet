CREATE TABLE application (
                             id              uuid PRIMARY KEY,
                             name            text NOT NULL,
                             description     text,
                             owner_team_id   uuid NOT NULL,
                             created_at      timestamptz NOT NULL,
                             CONSTRAINT uq_application_name UNIQUE (name)
);

CREATE TABLE release (
                         id              uuid PRIMARY KEY,
                         application_id  uuid NOT NULL REFERENCES application(id),
                         version         text NOT NULL,
                         artifact_ref    text NOT NULL,
                         checksum        text NOT NULL,
                         created_at      timestamptz NOT NULL,
                         CONSTRAINT uq_release_app_version UNIQUE (application_id, version)
);

CREATE TABLE environment (
                             id              uuid PRIMARY KEY,
                             name            text NOT NULL,
                             CONSTRAINT uq_environment_name UNIQUE (name)
);

CREATE TABLE node (
                      id              uuid PRIMARY KEY,
                      environment_id  uuid NOT NULL REFERENCES environment(id),
                      hostname        text NOT NULL,
                      CONSTRAINT uq_node_env_hostname UNIQUE (environment_id, hostname)
);

CREATE TABLE deployment (
                            id              uuid PRIMARY KEY,
                            application_id  uuid NOT NULL REFERENCES application(id),
                            release_id      uuid NOT NULL REFERENCES release(id),
                            environment_id  uuid NOT NULL REFERENCES environment(id),
                            status          text NOT NULL
                                CHECK (status IN ('PENDING','VALIDATING','DEPLOYING','HEALTHY','DEGRADED','FAILED','ROLLED_BACK')),
                            current_status  text NOT NULL,
                            created_at      timestamptz NOT NULL,
                            updated_at      timestamptz NOT NULL
);

CREATE UNIQUE INDEX uq_deployment_active_per_app_env
    ON deployment (application_id, environment_id)
    WHERE status NOT IN ('FAILED','ROLLED_BACK');

CREATE TABLE base_image (
                            id              uuid PRIMARY KEY,
                            name            text NOT NULL,
                            registry        text NOT NULL,
                            CONSTRAINT uq_base_image_name UNIQUE (name)
);

CREATE TABLE app_image (
                           id              uuid PRIMARY KEY,
                           base_image_id   uuid NOT NULL REFERENCES base_image(id),
                           name            text NOT NULL,
                           maintainer      text,
                           CONSTRAINT uq_app_image_base_name UNIQUE (base_image_id, name)
);

CREATE TABLE image_version (
                               id              uuid PRIMARY KEY,
                               app_image_id    uuid NOT NULL REFERENCES app_image(id),
                               version         text NOT NULL,
                               pipeline_state  text NOT NULL,
                               CONSTRAINT uq_image_version_app_version UNIQUE (app_image_id, version)
);

CREATE TABLE audit_event (
                             id              uuid PRIMARY KEY,
                             actor           text NOT NULL,
                             action          text NOT NULL,
                             target_type     text NOT NULL,
                             target_id       uuid NOT NULL,
                             detail          text,
                             occurred_at     timestamptz NOT NULL
);

CREATE TABLE outbox_message (
                                id              uuid PRIMARY KEY,
                                aggregate_id    uuid NOT NULL,
                                payload         jsonb NOT NULL,
                                created_at      timestamptz NOT NULL,
                                sent_at         timestamptz
);
