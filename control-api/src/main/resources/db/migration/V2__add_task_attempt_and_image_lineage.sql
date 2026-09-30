CREATE TABLE task (
                      id              uuid PRIMARY KEY,
                      deployment_id   uuid NOT NULL REFERENCES deployment(id),
                      task_type       text NOT NULL,
                      status          text NOT NULL
                          CHECK (status IN ('PENDING','RUNNING','SUCCEEDED','FAILED')),
                      created_at      timestamptz NOT NULL,
                      updated_at      timestamptz NOT NULL
);

CREATE TABLE attempt (
                         id              uuid PRIMARY KEY,
                         task_id         uuid NOT NULL REFERENCES task(id),
                         attempt_number  int NOT NULL,
                         status          text NOT NULL
                             CHECK (status IN ('PENDING','RUNNING','SUCCEEDED','FAILED')),
                         started_at      timestamptz NOT NULL,
                         finished_at     timestamptz,
                         error_detail    text,
                         CONSTRAINT uq_attempt_task_number UNIQUE (task_id, attempt_number)
);

ALTER TABLE base_image
    ADD COLUMN parent_base_image_id uuid REFERENCES base_image(id);