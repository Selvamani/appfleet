# control-api — S3.4: task history, pagination and the offset-versus-cursor benchmark

**Spec:** [01-CONTROL-API.md §S3](../../specs/project/01-CONTROL-API.md) — `GET /api/v1/deployments/{id}/tasks?cursor=`, *"opaque cursor (encoded keyset), stable under concurrent inserts. Keep an offset endpoint too, and benchmark both at page 10,000 — numbers into `/docs`"* · [§S1](../../specs/project/01-CONTROL-API.md) seed generator and performance exercise · Slice **S3.4** of [control-api-s3-rest.md](control-api-s3-rest.md)

Companion: [control-api-s3-2-applications-releases.md](control-api-s3-2-applications-releases.md) §5 (the cursor rules this step reuses), [control-api-s3-3-deployments.md](control-api-s3-3-deployments.md) (`TaskResponse`, `WebIntegrationTest`), [control-api-s1-exercises.md](control-api-s1-exercises.md) §1 and §4 (the parked seed generator and index exercise this step un-parks). **Status: implemented and measured 2026-10-01, `mvn verify` green (164 tests, 2 skipped by design). Results in section 12.**

This step has two halves of very different size. The endpoints are small: they repeat the S3.2 cursor pattern on a child collection. The benchmark is the real work: it needs 1M+ rows, an index that does not exist yet, and measurements on the dev database by hand. The plan doc's open question 5 is answered here with its recommendation: the S1 seed generator is un-parked at the start of S3.4. S1 exercise 4 (seq scan, composite index, before and after) is the same query as this step's benchmark, so it is done here too.

## 1. What already exists

- `CursorCodec`, `CursorPage<T>(items, nextCursor)`, `InvalidCursorException` and its handler, and the `HandlerMethodValidationException` handler for `@Min`/`@Max` on request parameters (all from S3.2).
- `TaskResponse.from(Task)`, `TaskService.get`, `TaskController` (`GET /tasks/{id}`), `TaskRepository.findByDeployment` and `existsByDeployment_IdAndTaskTypeAndStatusIn` (S3.3).
- `DeploymentController` with `POST /deployments`, `GET /deployments/{id}` and `POST /deployments/{id}/rollback`.
- `WebIntegrationTest` with one shared Postgres container, `MockMvc` and `JdbcTemplate`.
- **No index on `task.deployment_id`.** `V2` left it out on purpose (S1 exercise 4, "find it broken first"). Postgres does not index foreign-key columns by itself.
- `infra/seed/seed-tasks.sql` holds only the application-picker fragment copied from the S1 doc. There is no working generator.
- The dev database is the compose Postgres on port 55432, schema `control`, Flyway at `V3`.

## 2. Endpoints

| Method and path | Success | Errors |
|---|---|---|
| `GET /api/v1/deployments/{id}/tasks?cursor=&limit=` | 200 `CursorPage<TaskResponse>` | 400 malformed id, `limit` out of range, bad `cursor`; 404 unknown deployment |
| `GET /api/v1/deployments/{id}/tasks/by-offset?page=&size=` | 200 `OffsetPage<TaskResponse>` | 400 malformed id, `page` or `size` out of range; 404 unknown deployment |

The offset endpoint exists **only** for the benchmark (plan doc §3.5) and is documented as not recommended. S3.7 marks it deprecated in OpenAPI.

## 3. Decisions

1. **Oldest first, keyset on `id` ascending.** Same rule as `GET /applications` (plan doc §3.5), so `CursorCodec` and the `limit + 1` logic are reused unchanged. UUIDv7 ids sort by creation time, so `id` order is history order. A newest-first view is a later `order` parameter if a client needs it. The index in decision 7 serves both directions, because a B-tree can be scanned backwards.
2. **Unknown deployment is 404; a known deployment with no tasks is 200 with an empty page.** Telling the two apart costs one primary-key lookup (`existsById`) per request. Returning an empty page for an unknown id would save that lookup but would hide typos and stale links.
3. **The offset twin is a separate path, `/tasks/by-offset`,** not `page`/`size` parameters on the cursor path. One path per mode means there is no "what if both `cursor` and `page` are sent" rule to define, and the endpoint can be deleted later without touching the real one.
4. **Offset returns a `Slice`, not a `Page`.** A `Page` runs a `count(*)` on every request. On the benchmark deployment that is a separate cost of its own, and it would blur the comparison. With `Slice`, both endpoints fetch `size + 1` rows to compute "is there more", so the only difference left is `OFFSET` versus `id > cursor`. The cost of the count that a typical offset API adds is measured once on its own (section 8, step 6) and reported next to the numbers.
5. **`page` is 0-based** (Spring Data's `PageRequest` convention). "Page 10,000" means `page=10000&size=20`, which is `OFFSET 200000`. That needs at least 200,021 tasks in one deployment, so the benchmark deployment gets 250,000.
6. **`page` has a minimum of 0 and no maximum.** The benchmark needs the depth. A production offset API would cap the depth (Elasticsearch's `max_result_window` is the well-known example) precisely because of what this benchmark shows. Recorded, not built.
7. **Index `idx_task_deployment_id ON task (deployment_id, id)`, in a new `V4` migration.** This replaces the `(deployment_id, created_at DESC)` index proposed in S1 exercise 4. Reasons:
   - The keyset query is `WHERE deployment_id = ? AND id > ? ORDER BY id LIMIT n`. The equality column goes first and the range-and-sort column second (leftmost-prefix rule), so Postgres seeks straight to the cursor position inside one deployment and reads `n` entries in order.
   - `(deployment_id, created_at)` cannot serve `id > ?`. It would serve a `created_at` keyset, but the cursor is an id.
   - With UUIDv7, `id` order is creation order, so the same index serves "most recent first" (the S1 exercise's query rewritten as `ORDER BY id DESC`) by scanning backwards.
   - It also serves, through its leftmost column, the S3.3 open-rollback check and the foreign-key checks Postgres runs when a deployment is deleted (section 9 shows why that matters).
   - **Not `CREATE INDEX CONCURRENTLY`.** Flyway runs each migration in a transaction, and `CONCURRENTLY` cannot run inside one. On the dev database a short write lock is fine. Production would need the migration marked non-transactional (Flyway's per-script `executeInTransaction=false`). Recorded for the interview answer, not built.
8. **Seed data: one deliberately oversized deployment.** 250,000 tasks on one deployment is not realistic for this domain, where a deployment has a handful of tasks. It exists only to measure `OFFSET` at the depth the spec asks for. The other 950,000 tasks are spread with the skew the S1 doc asked for. **Correction to the S1 doc:** its weights of 100 to 1 give the 3 hot applications about 96% of the volume, not the ~70% it states. Weights of 13 to 1 give 69.4% of the spread tasks (75.8% overall, counting the benchmark deployment), measured on a throwaway run.
9. **Seed ids are UUIDv7, generated in SQL.** Postgres 16 has no `uuidv7()` (it arrives in 18), and `gen_random_uuid()` is v4. With v4 ids the keyset would still be stable, but `id` order would be random relative to time, so "history order" would be meaningless and the B-tree insert pattern would differ from production. The generator overlays a millisecond timestamp onto a v4 uuid and switches the version bits, the same layout as `Uuidv7.generate()`.
10. **Placement.** `TaskService` gets the two read methods; it already owns `TaskResponse`. `DeploymentController` gets the two mappings, because the path belongs to the deployment resource and the path variable is the deployment id. `TaskService` depends on `DeploymentRepository` for the 404 check, which follows the existing `Task` → `Deployment` dependency direction.

## 4. DTOs

Reuse `TaskResponse` and `CursorPage<T>`. One new record, next to `CursorPage`:

```java
// io.appfleet.control.web
public record OffsetPage<T>(List<T> items, int page, int size, boolean hasNext) {}
```

No `total`, by decision 4.

## 5. Repository and service

`TaskRepository` gains three derived methods:

```java
List<Task> findByDeployment_IdOrderByIdAsc(UUID deploymentId, Limit limit);
List<Task> findByDeployment_IdAndIdGreaterThanOrderByIdAsc(UUID deploymentId, UUID after, Limit limit);
Slice<Task> findSliceByDeployment_IdOrderByIdAsc(UUID deploymentId, Pageable pageable);
```

The first page uses the first method, later pages the second, exactly as `ApplicationService.list`. The third returns a `Slice`, so Spring Data fetches `size + 1` rows and runs no count query. Spring Data ignores the word between `find` and `By`, so `findSliceBy` is only a readable name.

`TaskService`:

```java
@Transactional(readOnly = true)
public CursorPage<TaskResponse> history(UUID deploymentId, UUID after, int limit) {
    requireDeployment(deploymentId);
    Limit fetch = Limit.of(limit + 1);
    List<Task> rows = after == null
            ? taskRepository.findByDeployment_IdOrderByIdAsc(deploymentId, fetch)
            : taskRepository.findByDeployment_IdAndIdGreaterThanOrderByIdAsc(deploymentId, after, fetch);
    boolean hasNext = rows.size() > limit;
    List<Task> page = hasNext ? rows.subList(0, limit) : rows;
    String nextCursor = hasNext ? CursorCodec.encode(page.getLast().getId()) : null;
    return new CursorPage<>(page.stream().map(TaskResponse::from).toList(), nextCursor);
}

@Transactional(readOnly = true)
public OffsetPage<TaskResponse> historyByOffset(UUID deploymentId, int page, int size) {
    requireDeployment(deploymentId);
    Slice<Task> slice = taskRepository.findSliceByDeployment_IdOrderByIdAsc(deploymentId, PageRequest.of(page, size));
    return new OffsetPage<>(slice.map(TaskResponse::from).getContent(), page, size, slice.hasNext());
}

private void requireDeployment(UUID deploymentId) {
    if (!deploymentRepository.existsById(deploymentId)) {
        throw new NotFoundException("Deployment", deploymentId);
    }
}
```

`TaskResponse.from` reads `task.getDeployment().getId()`, which a lazy proxy answers without loading the deployment. **Verify in the SQL log** that a page is exactly two statements: the `existsById` lookup and one `select` on `task`.

A cursor taken from a different deployment's task is not an error: it is a valid position, and the query returns this deployment's tasks after it (plan doc §3.5, "a tampered cursor is just a different valid position"). A cursor past the last task gives an empty page.

## 6. Controller

`DeploymentController` gains a `TaskService` constructor parameter and two mappings:

```java
@GetMapping("/{id}/tasks")
public CursorPage<TaskResponse> tasks(@PathVariable UUID id,
                                      @RequestParam(required = false) String cursor,
                                      @RequestParam(defaultValue = "20") @Min(1) @Max(100) int limit) {
    UUID after = cursor == null ? null : CursorCodec.decode(cursor);
    return taskService.history(id, after, limit);
}

@GetMapping("/{id}/tasks/by-offset")
public OffsetPage<TaskResponse> tasksByOffset(@PathVariable UUID id,
                                              @RequestParam(defaultValue = "0") @Min(0) int page,
                                              @RequestParam(defaultValue = "20") @Min(1) @Max(100) int size) {
    return taskService.historyByOffset(id, page, size);
}
```

Same limits as `GET /applications`: default 20, range 1 to 100. Out-of-range values go through the existing `HandlerMethodValidationException` handler to 400 `validation-failed`.

## 7. Tests

Test class `TaskHistoryEndpointsTest extends WebIntegrationTest`. Fixtures come from repositories: a deployment saved directly, and its tasks saved with `taskRepository.save(new Task(deployment, Task.DEPLOY))`.

**The expected order is the ids sorted, not the insertion order.** Tasks saved in quick succession often share a millisecond, and within one millisecond UUIDv7 order is random (S3.2 §5). Compare against the list of id strings sorted ascending, as `ApplicationPaginationTest` does. Lower-case hex string order equals Postgres's bytewise `uuid` order.

| # | Case | Expected |
|---|---|---|
| 1 | 5 tasks, `limit=2`, follow `nextCursor` | 3 pages of 2, 2 and 1; ids in ascending order; together exactly the 5 ids; last `nextCursor` is null |
| 2 | 21 tasks, no `limit` | 20 items and a `nextCursor` |
| 3 | tasks on two deployments | each deployment's pages contain only its own tasks |
| 4 | deployment with no tasks | 200, `items` empty, `nextCursor` null |
| 5 | unknown deployment, both endpoints | 404 `not-found` |
| 6 | `GET /deployments/not-a-uuid/tasks` | 400 `validation-failed`, `errors[].field == "id"` |
| 7 | `limit` 0, 101, `abc`; `cursor=???` | 400 `validation-failed`, field `limit` or `cursor` |
| 8 | insert a task between page 1 and page 2 | no id twice; every id that existed before the traversal appears |
| 9 | offset: `page=0&size=2` on 5 tasks; then `page=2`; then `page=3` | first two ids and `hasNext` true; one id and `hasNext` false; empty and `hasNext` false |
| 10 | walk all pages with both endpoints, `size=limit=2` | the same ids in the same order |
| 11 | offset `page=-1`, `size=0`, `size=101` | 400 `validation-failed` |
| 12 | cursor built from another deployment's task id | 200, a valid page (cursors are not bound to a deployment) |

The benchmark is not part of the test suite. It runs by hand against the dev database (section 8).

## 8. The benchmark (the `/docs` artefact)

Run against the dev compose Postgres (port 55432), with the app on profile `local`. Record the Postgres version and the machine. Warm the cache by running each query once before measuring, then take the **median of 5 runs**. Use `EXPLAIN (ANALYZE, BUFFERS)`: `BUFFERS` shows how many pages each plan touched, which explains the milliseconds.

Set up once in `psql`:

```sql
SET search_path TO control;
\set d <benchmark_deployment_id printed by the seed script>
-- the last id of page 9,999 (row 199,999, 0-based): the cursor a client holds when it asks for page 10,000
SELECT id AS cursor_id FROM task WHERE deployment_id = :'d' ORDER BY id OFFSET 199999 LIMIT 1 \gset
```

The queries, exactly as the endpoints issue them (`limit + 1`, `size + 1`):

```sql
-- offset, page 10,000
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM task WHERE deployment_id = :'d' ORDER BY id LIMIT 21 OFFSET 200000;

-- keyset, the same position
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM task WHERE deployment_id = :'d' AND id > :'cursor_id' ORDER BY id LIMIT 21;

-- S1 exercise 4's query, for its before/after
EXPLAIN (ANALYZE, BUFFERS)
SELECT * FROM task WHERE deployment_id = :'d' ORDER BY id DESC LIMIT 20;
```

Steps:

1. **Before the index.** Run the three queries for the benchmark deployment and for one quiet deployment. **Do not assume a seq scan.** In the throwaway run behind this doc, the keyset query without the index walked `task_pkey` from the cursor and filtered on `deployment_id`: because UUIDv7 ids are globally time-ordered, walking the primary key looks cheap to the planner. Record the plan the planner actually picks.
2. **Apply `V4`** (boot the app, or run Flyway), then run `ANALYZE task`.
3. **After the index.** Same queries. Expect `Index Scan using idx_task_deployment_id` for both forms. The offset form still reads 200,000 index entries before it returns anything, because its index condition is only `deployment_id = ...`. `BUFFERS` shows the difference.
4. **Depth curve.** Offset and keyset at page indexes 0, 100, 1,000 and 10,000 (offsets 0, 2,000, 20,000 and 200,000), median of 5 runs each, into one table. Expected shape: offset grows with depth, keyset stays flat. Write down the measured numbers, not this expectation.
5. **HTTP level.** Time `GET .../tasks/by-offset?page=10000&size=20` and `GET .../tasks?cursor=<c>&limit=20` with `curl -s -o /dev/null -w '%{time_total}\n'`, 10 warm runs, median. The cursor is base64url of the id text: `printf '%s' "$CURSOR_ID" | base64 -w0 | tr '+/' '-_' | tr -d '='`.
6. **The count a `Page` would add.** Time `SELECT count(*) FROM task WHERE deployment_id = :d` once and report it next to the offset numbers.

**Also watch:** the S3.3 open-rollback check (`existsByDeployment_IdAndTaskTypeAndStatusIn`) on the benchmark deployment. In the throwaway run it stayed a `Parallel Seq Scan` even with the index, because 250,000 of 1.2 M rows match and none of them is open, so Postgres must look at all of them anyway. For a quiet deployment expect the index. Record both; it is a planner decision based on selectivity, not a missing index.

What goes into the Results section: the before and after plans, buffer counts, the depth-curve table, the HTTP medians and the count cost. That section is both the spec's pagination benchmark and S1 exercise 4's before/after numbers.

## 9. The seed generator

**Lives in:** `infra/seed/seed-tasks.sql` (replaces the current fragment) and `infra/seed/seed-clean.sql`. Committed, never run by Flyway or the build. Run by hand against the dev database while it is at `V3`, so that step 1 of section 8 sees the table without the index.

```
psql -h localhost -p 55432 -U appfleet -d appfleet -v ON_ERROR_STOP=1 -f infra/seed/seed-tasks.sql
```

Tested on a throwaway Postgres 16 container with `V1` to `V3` applied: tasks in about 6 s, attempts in about 10 s. Checks that passed: every id has version 7 and variant `10`, the timestamp in every id equals `created_at` to the millisecond, there are zero order inversions between `id` and `created_at` inside any deployment, the benchmark deployment holds exactly 250,000 tasks, and no seeded task is `PENDING` or `RUNNING` (so the S3.3 open-rollback check is never tripped by seed data).

```sql
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
```

`infra/seed/seed-clean.sql` removes only seed rows, in foreign-key order:

```sql
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
```

In the throwaway run without the index, cleanup took about 20 s, and **10 s of it was deleting 600 deployments**: each deleted row makes Postgres check that no `task` row still references it, and without an index on `task.deployment_id` every check scans `task`. Re-run the cleanup after `V4` and record the difference; it is a second, independent argument for the index.

Rows created through the API against seed deployments (for example a rollback request) are removed too, because the deletes go by deployment. Their audit rows stay: `audit_event` has no foreign key, by design.

## 10. Order of work: find it broken first

1. Put the generator and the cleanup script into `infra/seed/`. Run the generator against the dev database **at `V3`**. Check counts, skew and the printed benchmark deployment id.
2. Benchmark "before" (section 8, step 1). Do this **before** `V4` exists in the source tree, because the next app boot applies it.
3. Write test case 1 with no endpoint. Run: 404. Record it.
4. `OffsetPage`, the three repository methods, `TaskService.history` and `historyByOffset`, the two controller mappings. Cases 1 to 12.
5. `V4__add_task_deployment_index.sql`. `mvn verify` (Testcontainers applies `V4` too).
6. Benchmark "after" (section 8, steps 2 to 6). Re-run the cleanup timing.
7. SQL log check: two statements per page.
8. Results section here. Tick S1 exercises 1 and 4 in the S1 doc with a link to this doc, and record the weight correction there.

## 11. Not in S3.4

- A newest-first `order` parameter (decision 1).
- Total counts on either endpoint (decision 4).
- A depth cap on the offset endpoint (decision 6).
- `CREATE INDEX CONCURRENTLY` and non-transactional migrations (decision 7).
- Signed or deployment-bound cursors.
- An attempts endpoint. Attempts are seeded for S1 completeness only.
- S1 exercises 2 (window function) and 5 (deadlock drill). They need seed data, which now exists, but they are separate pieces of work.

## 12. Results

Everything below was observed, not assumed. Final state: `mvn verify` green, 164 tests, 2 skipped by design; `TaskHistoryEndpointsTest` 19 tests (cases 1 to 12, several parameterised). Measurements on the dev compose database, PostgreSQL 16.15, median of 5 warm runs unless stated otherwise.

**Seed data**

- Dev database: 1,200,101 tasks and 1,416,629 attempts over 600 seed deployments. The task count per deployment is deterministic (rounded weights), so it matched the throwaway run exactly.
- Skew, measured on the throwaway run with the same counts: the 3 hot applications own 69.4% of the spread tasks and 75.8% of all tasks. The S1 doc's weight of 100 to 1 gave 96% on the first throwaway run; corrected to 13 to 1 (decision 8).
- Benchmark deployment: `seed-app-01` in `seed-prod`, 250,000 tasks. Quiet deployment used for comparison: `seed-app-10` in `seed-prod`, 570 tasks.
- Generator runtime: about 6 s for tasks and 10 s for attempts.

**Mistakes caught before they shipped**

| What | How it showed | Cause |
|---|---|---|
| Offset endpoint unreachable | Review: `@GetMapping("/id/tasks/by-offset")` | Missing braces. A request to `/{uuid}/tasks/by-offset` would be 404, and `/id/tasks/by-offset` would be 500 (`MissingPathVariableException`). Same slip as S3.2's `@GetMapping` without `/{id}` |
| Unknown deployment returned 200 on the cursor endpoint | Review: `history` never called `requireDeployment` | Only `historyByOffset` checked. Case 5 would have failed for `/tasks` |
| Skew far from the S1 doc's claim | Throwaway run: hot applications at 96% | The S1 doc's 100-to-1 weights cannot give ~70%; 13-to-1 does |
| "Expect a seq scan" was wrong for the keyset query | Throwaway run and the dev database | Without the index, Postgres walks `task_pkey` from the cursor and filters on `deployment_id`. Global UUIDv7 order makes that plan look cheap to the planner (see below) |

Section 10 step 3 (test case 1 seen failing with no endpoint) was not recorded: the endpoints existed before the tests were written.

**Before and after `idx_task_deployment_id`**

| Query | Before (`V3`) | After (`V4`) |
|---|---|---|
| Hot deployment, offset page 10,000 (`OFFSET 200000`) | 54.7 ms. Parallel seq scan, then a sort that spilled about 20 MB to disk (external merge); 14.8k buffers plus temp files | 17.3 ms. Index scan on `idx_task_deployment_id`, still reading 200,021 entries to skip 200,000; 3,660 buffers |
| Hot deployment, keyset at the same position | 0.044 ms. Index scan on `task_pkey` from the cursor, filter on `deployment_id`; 4 buffers | 0.039 ms. Index range scan, both conditions in the index; 4 buffers |
| Hot deployment, newest 20 (S1 exercise 4, `ORDER BY id DESC`) | 0.038 ms. Backward scan on `task_pkey` | 0.041 ms. Backward scan on `idx_task_deployment_id` |
| Quiet deployment, keyset first page | **123 ms.** Scan on `task_pkey`, 862,964 rows removed by the filter; 860k buffers | **0.040 ms.** 4 buffers |
| Quiet deployment, newest 20 | 20.2 ms. Backward scan on `task_pkey`, 305,271 rows removed | 0.042 ms |
| Open-rollback check (S3.3), quiet deployment | 25.1 ms. Parallel seq scan | 0.098 ms. Bitmap scan on the new index |
| Open-rollback check, hot deployment | 25.1 ms. Parallel seq scan | 25.1 ms. Still a parallel seq scan: 250k of 1.2M rows match and none is open, so the planner reads them all anyway |
| `count(*)` for the hot deployment (what a `Page` adds per request) | 21.2 ms. Parallel seq scan | 14.9 ms. Parallel index-only scan |
| Delete the 600 seed deployments (foreign-key checks on `task`) | 10,080 ms (throwaway run) | 64 ms (dev database, inside a rolled-back transaction) |

**How to read the "before" keyset numbers.** The hot deployment's 0.044 ms before the index is a property of the seed layout, not of keyset pagination. All `k = 10` seed deployments share one `created_at`, so their tasks interleave only for the first few seconds of their timelines. By position 200,000 the hot deployment's ids are contiguous in `task_pkey`, and the walk finds 21 matches in 4 buffers. The quiet deployment shows the real behaviour without the index: the planner estimated that matches would come early (cost 3,906) and instead walked past 863k other rows. Without the right index, keyset speed depended on where a deployment's rows happened to sit in global id order.

**Depth curve after the index** (hot deployment, 20 per page, SQL only)

| Page index | Offset | Offset query | Keyset query |
|---|---|---|---|
| 0 | 0 | 0.035 ms | 0.038 ms |
| 100 | 2,000 | 0.232 ms | 0.038 ms |
| 1,000 | 20,000 | 1.884 ms | 0.042 ms |
| 10,000 | 200,000 | 17.306 ms | 0.039 ms |

Offset cost grows linearly, about 0.087 µs per skipped row, because every skipped row is still read from the index. Keyset cost is flat.

**HTTP level** (`curl`, median of 10 warm requests, app on profile `local`)

| Request | Median |
|---|---|
| `GET /deployments/{id}/tasks/by-offset?page=10000&size=20` | 24.4 ms |
| `GET /deployments/{id}/tasks?cursor=…&limit=20`, same position | 9.2 ms |
| Offset page 0 | 8.9 ms |
| Cursor first page | 8.7 ms |

About 8.7 ms of every request is fixed cost (HTTP, MVC, JSON, two statements). The 15 ms gap at depth matches the 17 ms SQL difference. Both endpoints returned the same first item at page 10,000.

**Confirmed live**

- One page is exactly two statements, each under the request's correlation id: `select count(*) from control.deployment where id=?` (Spring Data's `existsById` is a primary-key `count(*)`, which costs the same as `select 1` because at most one row can match), then `select ... from control.task where deployment_id=? [and id>?] order by id fetch first ? rows only`.
- `V4` applied by Flyway on boot in 0.52 s for 1.2M rows. The index is 57 MB.
- `ANALYZE task` after creating the index was needed for the plans above; the seed script already analyses after loading.

**Still true, recorded not fixed**

- The offset endpoint has no depth cap (decision 6). At page 10,000 it is 2.6 times slower over HTTP and 440 times slower in SQL than the cursor, and it grows with depth.
- The open-rollback check on a very large deployment remains a sequential scan. A partial index on open tasks would fix it if it ever mattered; no realistic deployment has 250k tasks.
- `CREATE INDEX` in `V4` takes a write lock for its duration (0.52 s here). Production would use `CONCURRENTLY` in a non-transactional migration (decision 7).

## Definition of done

- [x] Seed generator and cleanup script in `infra/seed/`, run against the dev database, counts and skew checked
- [x] Benchmark "before" plans recorded with the dev database at `V3`
- [x] Test case 1 seen failing (404) before the endpoint existed: **not recorded**, the endpoints existed before the tests (section 12)
- [x] `OffsetPage`, repository methods, `TaskService` methods and both mappings implemented
- [x] `TaskHistoryEndpointsTest` cases 1 to 12 green
- [x] `V4__add_task_deployment_index.sql` added, `mvn verify` green
- [x] Benchmark "after": plans, buffers, depth curve, HTTP medians and count cost recorded
- [x] A page observed in the SQL log as exactly two statements
- [x] Results section written; S1 exercises 1 and 4 ticked in the S1 doc, with the weight correction
- [x] `mvn verify` green
