-- I1: the users, the RBAC vocabulary and the scoped grants. Refresh tokens, API keys and the
-- login audit get their own migrations in the steps that use them (I3, I5, I7).

CREATE TABLE app_user (
                          id              uuid PRIMARY KEY,
                          email           text NOT NULL,
                          display_name    text NOT NULL,
                          password_hash   text NOT NULL,
                          status          text NOT NULL CHECK (status IN ('ACTIVE', 'DEACTIVATED')),
                          created_at      timestamptz NOT NULL,
                          deactivated_at  timestamptz,
                          CONSTRAINT uq_app_user_email UNIQUE (email),
                          CONSTRAINT ck_app_user_email_lower CHECK (email = lower(email)),
                          CONSTRAINT ck_app_user_deactivated CHECK ((status = 'DEACTIVATED') = (deactivated_at IS NOT NULL))
);

CREATE TABLE permission (
                            id          uuid PRIMARY KEY,
                            name        text NOT NULL,
                            description text NOT NULL,
                            CONSTRAINT uq_permission_name UNIQUE (name),
                            CONSTRAINT ck_permission_name CHECK (name ~ '^[a-z]+:[a-z]+$')
    );

CREATE TABLE role (
                      id          uuid PRIMARY KEY,
                      name        text NOT NULL,
                      description text NOT NULL,
                      CONSTRAINT uq_role_name UNIQUE (name)
);

CREATE TABLE role_permission (
                                 role_id       uuid NOT NULL REFERENCES role(id),
                                 permission_id uuid NOT NULL REFERENCES permission(id),
                                 PRIMARY KEY (role_id, permission_id)
);

CREATE TABLE team (
                      id         uuid PRIMARY KEY,
                      name       text NOT NULL,
                      created_at timestamptz NOT NULL,
                      CONSTRAINT uq_team_name UNIQUE (name)
);

-- the scoped grant: one role per user per team
CREATE TABLE team_membership (
                                 id         uuid PRIMARY KEY,
                                 user_id    uuid NOT NULL REFERENCES app_user(id),
                                 team_id    uuid NOT NULL REFERENCES team(id),
                                 role_id    uuid NOT NULL REFERENCES role(id),
                                 created_at timestamptz NOT NULL,
                                 CONSTRAINT uq_team_membership_user_team UNIQUE (user_id, team_id)
);
CREATE INDEX idx_team_membership_team ON team_membership (team_id);

-- Seed: permissions are the atoms, roles are bundles. Each role lists only its OWN permissions;
-- what a role inherits comes from the RoleHierarchy in code (ADMIN > OPERATOR > DEPLOYER > VIEWER).
INSERT INTO permission (id, name, description) VALUES
                                                   (gen_random_uuid(), 'application:read',    'List and read applications and releases'),
                                                   (gen_random_uuid(), 'deployment:read',     'Read deployments and their task history'),
                                                   (gen_random_uuid(), 'application:create',  'Create applications and releases'),
                                                   (gen_random_uuid(), 'deployment:create',   'Request a deployment'),
                                                   (gen_random_uuid(), 'deployment:rollback', 'Roll a deployment back'),
                                                   (gen_random_uuid(), 'node:drain',          'Drain a node'),
                                                   (gen_random_uuid(), 'catalog:publish',     'Publish to the image catalogue'),
                                                   (gen_random_uuid(), 'user:manage',          'Manage users, roles and teams');

INSERT INTO role (id, name, description) VALUES
                                             (gen_random_uuid(), 'VIEWER',   'Read-only'),
                                             (gen_random_uuid(), 'DEPLOYER', 'Creates applications and deployments'),
                                             (gen_random_uuid(), 'OPERATOR', 'Rolls back and drains nodes'),
                                             (gen_random_uuid(), 'ADMIN',    'Publishes to the catalogue and manages users');

INSERT INTO role_permission (role_id, permission_id)
SELECT r.id, p.id
FROM (VALUES
          ('VIEWER',   'application:read'),
          ('VIEWER',   'deployment:read'),
          ('DEPLOYER', 'application:create'),
          ('DEPLOYER', 'deployment:create'),
          ('OPERATOR', 'deployment:rollback'),
          ('OPERATOR', 'node:drain'),
          ('ADMIN',    'catalog:publish'),
          ('ADMIN',    'user:manage')
     ) AS m(role_name, permission_name)
         JOIN role r ON r.name = m.role_name
         JOIN permission p ON p.name = m.permission_name;