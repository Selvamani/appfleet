\timing on
BEGIN;
SET LOCAL search_path TO control;
DELETE FROM attempt WHERE task_id IN (
    SELECT t.id FROM task t JOIN deployment d ON d.id = t.deployment_id
                            JOIN application a ON a.id = d.application_id WHERE a.name LIKE 'seed-%');
DELETE FROM task WHERE deployment_id IN (
    SELECT d.id FROM deployment d JOIN application a ON a.id = d.application_id WHERE a.name LIKE 'seed-%');
DELETE FROM deployment WHERE application_id IN (SELECT id FROM application WHERE name LIKE 'seed-%');
DELETE FROM release WHERE application_id IN (SELECT id FROM application WHERE name LIKE 'seed-%');
DELETE FROM application WHERE name LIKE 'seed-%';
DELETE FROM environment WHERE name LIKE 'seed-%';
COMMIT;
VACUUM ANALYZE control.task;
VACUUM ANALYZE control.attempt;