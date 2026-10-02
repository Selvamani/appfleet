-- Synthetic volume for S1 exercises 1 and 4 and the S3.4 pagination benchmark.
-- Run by hand against the dev database, never by Flyway or the build:
--   psql -h localhost -p 55432 -U appfleet -d appfleet -v ON_ERROR_STOP=1 -f infra/seed/seed-tasks.sql
--
-- Parameters (judgement calls, written down because "realistic skew" is not machine-checkable):
--   20 applications (seed-app-01 .. 20), the first 3 are hot; 3 environments; 5 releases per application
--   per (application, environment): 9 finished deployments (FAILED / ROLLED_BACK) + 1 HEALTHY = 600 deployments
--   tasks:    250,000 on one benchmark deployment (seed-app-01, seed-prod, HEALTHY)
--             950,000 spread over the other 599 deployments, weight 13 for hot applications, 1 for quiet ones
--             (hot applications get about 70 % of the spread tasks, about 76 % overall)
--   attempts: 1 per task, a 2nd for ~15 %, a 3rd for ~3 %  (about 1.4 M rows)
-- All ids are UUIDv7 with the same layout as Uuidv7.generate(), so id order is creation order.
-- Refuses to run twice: seed rows are recognised by the 'seed-' name prefix.

\timing on
BEGIN;
SET LOCAL search_path TO control;

DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM application WHERE name LIKE 'seed-%') THEN
        RAISE EXCEPTION 'seed data already present; run seed-clean.sql first';
END IF;
END $$;

-- 48-bit Unix millisecond timestamp, version 7, variant 10, the rest random.
-- Postgres 16 has no uuidv7(); this overlays the timestamp onto a v4 uuid and turns version 4 into 7.
CREATE FUNCTION pg_temp.uuidv7(ts timestamptz) RETURNS uuid
    LANGUAGE sql VOLATILE AS $$
SELECT encode(
               set_bit(set_bit(
                               overlay(uuid_send(gen_random_uuid())
                                   PLACING substring(int8send(floor(extract(epoch FROM ts) * 1000)::bigint) FROM 3)
                    FROM 1 FOR 6),
                               52, 1), 53, 1),
               'hex')::uuid
$$;

CREATE TEMP TABLE seed_env ON COMMIT DROP AS
SELECT pg_temp.uuidv7(now() - interval '400 days') AS id, name
FROM unnest(ARRAY['seed-dev', 'seed-staging', 'seed-prod']) AS name;
INSERT INTO environment (id, name) SELECT id, name FROM seed_env;

CREATE TEMP TABLE seed_app ON COMMIT DROP AS
SELECT pg_temp.uuidv7(now() - interval '400 days' + n * interval '1 minute') AS id,
       format('seed-app-%s', lpad(n::text, 2, '0')) AS name,
       n <= 3 AS hot
FROM generate_series(1, 20) AS n;
INSERT INTO application (id, name, description, owner_team_id, created_at)
SELECT id, name, 'synthetic', gen_random_uuid(), now() - interval '400 days' FROM seed_app;

CREATE TEMP TABLE seed_release ON COMMIT DROP AS
SELECT pg_temp.uuidv7(now() - interval '390 days' + r * interval '1 day') AS id, a.id AS application_id, r
FROM seed_app a CROSS JOIN generate_series(1, 5) AS r;
INSERT INTO release (id, application_id, version, artifact_ref, checksum, created_at)
SELECT id, application_id, format('v1.%s.0', r), format('registry/seed:v1.%s.0', r),
       'sha256:' || repeat('0', 64), now() - interval '390 days'
FROM seed_release;

-- 10 deployments per (application, environment); k = 10 is the single active one (partial unique index).
CREATE TEMP TABLE seed_deployment ON COMMIT DROP AS
SELECT pg_temp.uuidv7(now() - interval '380 days' + k * interval '30 days') AS id,
       a.id AS application_id, e.id AS environment_id, a.hot,
       a.name = 'seed-app-01' AND e.name = 'seed-prod' AND k = 10 AS benchmark,
       CASE WHEN k = 10 THEN 'HEALTHY' WHEN k % 3 = 0 THEN 'FAILED' ELSE 'ROLLED_BACK' END AS status,
       now() - interval '380 days' + k * interval '30 days' AS created_at,
    k
FROM seed_app a CROSS JOIN seed_env e CROSS JOIN generate_series(1, 10) AS k;

INSERT INTO deployment (id, application_id, release_id, environment_id, status, current_status,
                        created_at, updated_at, version)
SELECT d.id, d.application_id,
       (SELECT r.id FROM seed_release r WHERE r.application_id = d.application_id AND r.r = (d.k % 5) + 1),
       d.environment_id, d.status, d.status, d.created_at, d.created_at, 0
FROM seed_deployment d;

ALTER TABLE seed_deployment ADD COLUMN task_count int;
UPDATE seed_deployment SET task_count = 250000 WHERE benchmark;
UPDATE seed_deployment d
SET task_count = round(950000.0 * (CASE WHEN d.hot THEN 13 ELSE 1 END)
    / (SELECT sum(CASE WHEN hot THEN 13 ELSE 1 END) FROM seed_deployment WHERE NOT benchmark))
WHERE NOT d.benchmark;

-- One millisecond apart within a deployment, so ids are strictly increasing per deployment.
INSERT INTO task (id, deployment_id, task_type, status, created_at, updated_at)
SELECT pg_temp.uuidv7(d.created_at + i * interval '1 millisecond'),
       d.id,
       CASE WHEN i % 50 = 0 THEN 'ROLLBACK' ELSE 'DEPLOY' END,
       CASE WHEN random() < 0.05 THEN 'FAILED' ELSE 'SUCCEEDED' END,
       d.created_at + i * interval '1 millisecond',
    d.created_at + i * interval '1 millisecond' + interval '1 second'
FROM seed_deployment d
    CROSS JOIN LATERAL generate_series(1, d.task_count) AS i;

INSERT INTO attempt (id, task_id, attempt_number, status, started_at, finished_at, error_detail)
SELECT pg_temp.uuidv7(t.created_at + (n - 1) * interval '1 second'),
       t.id, n,
       CASE WHEN n < t.attempts THEN 'FAILED' ELSE t.status END,
       t.created_at + (n - 1) * interval '1 second',
    t.created_at + n * interval '1 second' - interval '100 milliseconds',
    CASE WHEN n < t.attempts OR t.status = 'FAILED' THEN 'synthetic failure' END
FROM (SELECT t.id, t.status, t.created_at,
             CASE WHEN x < 0.03 THEN 3 WHEN x < 0.15 THEN 2 ELSE 1 END AS attempts
      FROM (SELECT task.*, random() AS x FROM task
            WHERE deployment_id IN (SELECT id FROM seed_deployment)) t) t
CROSS JOIN LATERAL generate_series(1, t.attempts) AS n;

COMMIT;

-- Fresh statistics, so EXPLAIN plans reflect the new volume.
ANALYZE control.task;
ANALYZE control.attempt;
ANALYZE control.deployment;

-- What was created, and the benchmark target.
SELECT (SELECT count(*) FROM control.task) AS tasks, (SELECT count(*) FROM control.attempt) AS attempts;
SELECT a.name, count(*) AS tasks
FROM control.task t JOIN control.deployment d ON d.id = t.deployment_id JOIN control.application a ON a.id = d.application_id
WHERE a.name LIKE 'seed-%' GROUP BY a.name ORDER BY tasks DESC LIMIT 5;
SELECT d.id AS benchmark_deployment_id
FROM control.deployment d JOIN control.application a ON a.id = d.application_id JOIN control.environment e ON e.id = d.environment_id
WHERE a.name = 'seed-app-01' AND e.name = 'seed-prod' AND d.status = 'HEALTHY';