# control-api — S1 remaining exercises (seed data, window function, recursive CTE, performance, deadlock)

**Spec:** [01-CONTROL-API.md §S1](../../specs/project/01-CONTROL-API.md) · Slice **S1** · Schema **`control`**

Companion: [control-api-schema-3nf.md](control-api-schema-3nf.md) (0NF→3NF/BCNF, the frozen `V1__init.sql`) and [control-api.md](control-api.md) (S0). That doc closed out the schema design and constraint work. Five S1 items remain, all needing either new tables or real data volume to be meaningful:

1. Seed generator (1M+ synthetic tasks/attempts, realistic skew)
2. Window-function report (latest deployment per application per environment)
3. Recursive CTE (image lineage)
4. Performance exercise (seq scan → composite index, before/after numbers)
5. Deadlock drill (opposite lock order, captured log, fix)

## Where each piece of SQL below actually lives

Not everything in this doc becomes application code, and not everything that does becomes the same *kind* of file. Three destinations, and every SQL block below is tagged with which one it is:

| Destination | What goes there | Committed? | Runs automatically? |
|---|---|---|---|
| **Flyway migration** — `control-api/src/main/resources/db/migration/V2__add_task_attempt_and_image_lineage.sql` | Real schema: `task`/`attempt` tables, `base_image.parent_base_image_id`, later `idx_task_deployment_created` | Yes | Yes — Flyway applies it on every future app boot, same as `V1__init.sql` |
| **Seed script** — `infra/seed/seed-tasks.sql` (new file/directory) | The seed generator only | Yes | No — run manually via `psql`/IntelliJ Query Console whenever you want the data populated (e.g. after a volume wipe) |
| **Exploration only — nothing in the repo** | Window-function queries, the recursive CTE, `EXPLAIN ANALYZE` before/after, the deadlock drill's two-session SQL | No | No — pasted into IntelliJ's Query Console (bound to the `control` schema data source) or `psql`, run by hand. The *output* (results, query plans, the captured deadlock error text) gets written up as prose in `/docs` — that write-up is the actual spec deliverable, not the SQL itself |

Each numbered section below repeats which row it belongs to as a **Lives in:** line, so it's unambiguous locally too, not just here.

## A decision this doc has to make first: where do `task`/`attempt` live?

The spec asks control-api's S1 to seed "1M+ synthetic tasks/attempts" and to find "the seq scan on task history" — but per the domain model and the module table in [00-BUILD-GUIDE.md](../../specs/project/00-BUILD-GUIDE.md), task/attempt state is **task-service's** eventual schema, extracted from control-api at **S4**. task-service doesn't exist yet.

This isn't a contradiction — it's the same pattern the spec already commits to everywhere else: **build the monolith first, extract later.** control-api is explicitly "the largest module... everything else was extracted from it." Team/User will move to identity-service at S4; task/attempt moves to task-service at S4 too. Building `task`/`attempt` tables in `control` schema now, then cutting them over to a `task` schema owned by task-service at S4, is consistent with how the rest of this project is sequenced — not a shortcut around it.

**Decision:** add `task` and `attempt` tables to `control-api`'s own schema now, in a new migration (`V2__`, since `V1__init.sql` is already applied against a live database and — per convention — never edited after commit). These are exactly the tables `deployment.current_status`'s `AFTER_COMMIT` listener (S6) will read from later, so building them now isn't wasted work even after the S4 extraction.

## New migration — `V2__add_task_attempt_and_image_lineage.sql`

Two additions, for two different exercises:

**1. `task` / `attempt`** — for the seed generator, window-function report's data, and the performance exercise.

**2. `base_image.parent_base_image_id`** — a self-referential FK. Without this, `base_image → app_image → image_version` is only two joins deep with a fixed depth — walkable with plain joins, not something that actually needs a *recursive* CTE. Real Docker base images commonly build `FROM` another base image (e.g. `ubuntu` → `node` → `myapp-base`), which is a genuinely unbounded-depth chain — that's the shape the spec's "recursive CTE: image lineage" exercise is asking for. Adding one nullable self-referencing column on `base_image` is what makes the exercise real instead of decorative.

```sql
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
```

`uq_attempt_task_number` is the same BCNF discipline as `V1`: `(task_id, attempt_number)` is a real candidate key (attempt 1, 2, 3... of a given task), not just an attribute that happens not to collide yet.

---

## 1. Seed generator

> **Done in S3.4 (2026-10-01).** The working generator and its cleanup script are designed, tested and measured in [control-api-s3-4-task-history.md](control-api-s3-4-task-history.md) §9 and §12. Two corrections to this section: the weights of 100 to 1 below give the hot applications about 96% of the volume, not ~70%; the generator uses 13 to 1 (69.4% measured). It also assigns task counts per deployment instead of sampling an application per row, and generates UUIDv7 ids in SQL so that `id` order is creation order.

**Lives in:** `infra/seed/seed-tasks.sql` — committed, but never auto-run. You execute it by hand.

**Goal:** 1M+ rows across `task`/`attempt`, with **realistic skew** — a few hot applications generating most of the volume, many quiet ones generating almost none. Uniform random distribution across applications would be the easy version and the wrong one — real systems don't look like that, and a flat distribution wouldn't stress an index the same way a skewed one does (this matters directly for exercise 4).

**Approach:** a plain SQL generator using `generate_series` + `random()`, run once via `psql`/a migration-adjacent script (**not** a Flyway migration itself — seed data is not schema, and per convention Flyway migrations are never edited after commit, which seed-data regeneration would violate the spirit of). A one-off `.sql` file under `docs/` or a `scripts/` directory, run manually, is the right shape — not something `mvn verify` runs on every build.

**Skew shape:** Zipfian-ish, cheap to fake without a real Zipf implementation — weight application selection by `1 / (rank)` using a small `CASE` or a weighted `application` subset:

```sql
-- 20 applications: first 3 are "hot" (own ~70% of task volume), rest are "quiet"
WITH app_weights AS (
    SELECT id, row_number() OVER (ORDER BY created_at) AS rn
    FROM application
),
weighted AS (
    SELECT id,
           CASE WHEN rn <= 3 THEN 100 ELSE 1 END AS weight
    FROM app_weights
)
-- pick a weighted-random application per generated task by expanding weight into a pool,
-- then sampling from the pool uniformly
SELECT id FROM (
    SELECT id, generate_series(1, weight) FROM weighted
) pool
ORDER BY random()
LIMIT 1;
```

Wrapped in a `generate_series(1, 1_200_000)` driving loop (via `INSERT ... SELECT ... FROM generate_series`), each iteration:
- picks an application via the weighted pool above (cached once, not recomputed per row — recompute the pool as a temp table first, then sample from it 1.2M times)
- picks one of that application's `deployment` rows (or creates a synthetic one if none exist yet for that app/environment pair)
- inserts a `task` row, then 1-3 `attempt` rows per task (most tasks succeed on attempt 1; a fixed ~15% retry rate is enough skew to be realistic without over-engineering the generator)

**Volume target:** spec says "1M+" — aim for ~1.2M `task` rows, ~1.5M `attempt` rows (accounting for retries), comfortably over the line without being needlessly slow to regenerate.

**Where the generator script lives:** `infra/seed/seed-tasks.sql` (new directory — infra-adjacent, not a migration, not application code). Document the exact row counts and skew parameters used at the top of the file as a comment, since "realistic skew" isn't machine-checkable — the numbers chosen are a judgment call worth being explicit about.

---

## 2. Window-function report — latest deployment per application per environment

**Lives in:** nowhere in the repo. Run by hand in IntelliJ's Query Console (or `psql`); the results/`EXPLAIN` output get written into `/docs`, not the SQL itself.

This one needs no seed data beyond `deployment` rows (independent of the task/attempt volume above). Spec: `ROW_NUMBER() OVER (PARTITION BY ...)`, top-N per group.

```sql
SELECT application_id, environment_id, id AS deployment_id, status, created_at
FROM (
    SELECT
        d.*,
        ROW_NUMBER() OVER (
            PARTITION BY application_id, environment_id
            ORDER BY created_at DESC
        ) AS rn
    FROM deployment d
) ranked
WHERE rn = 1;
```

**Top-N per group variant** (spec explicitly calls out "top-N per group" as the pattern to demonstrate, not just top-1) — last 3 deployments per application/environment, e.g. for a rollback-candidate list:

```sql
SELECT application_id, environment_id, id AS deployment_id, status, created_at
FROM (
    SELECT
        d.*,
        ROW_NUMBER() OVER (
            PARTITION BY application_id, environment_id
            ORDER BY created_at DESC
        ) AS rn
    FROM deployment d
) ranked
WHERE rn <= 3
ORDER BY application_id, environment_id, rn;
```

Write both queries into `/docs` alongside their `EXPLAIN` output once real data exists — the spec frames this as an interview answer ("offset vs cursor, with your own benchmark" is the S3 version of this same instinct; this is the S1 warm-up for it).

---

## 3. Recursive CTE — image lineage

**Lives in:** the `parent_base_image_id` column is schema (goes into the `V2__` migration below); the recursive CTE query itself lives nowhere in the repo — run by hand, output written into `/docs`.

Needs the `base_image.parent_base_image_id` column from the `V2` migration above. Walking from a leaf `app_image` up through however many `base_image` ancestors exist:

```sql
WITH RECURSIVE lineage AS (
    -- anchor: the base image directly under a given app image
    SELECT bi.id, bi.name, bi.parent_base_image_id, 0 AS depth
    FROM base_image bi
    JOIN app_image ai ON ai.base_image_id = bi.id
    WHERE ai.id = :app_image_id

    UNION ALL

    -- recursive step: walk up to each row's parent
    SELECT parent.id, parent.name, parent.parent_base_image_id, lineage.depth + 1
    FROM base_image parent
    JOIN lineage ON lineage.parent_base_image_id = parent.id
)
SELECT * FROM lineage ORDER BY depth;
```

Seed a genuine multi-level chain to make this non-trivial — e.g. `debian` → `node-base` → `checkout-service-base`, three `base_image` rows with `parent_base_image_id` chained, one `app_image` pointing at the leaf. Without at least 3 levels, the recursive CTE degenerates to something a single self-join could've done, which defeats the point of the exercise.

---

## 4. Performance exercise — seq scan → composite index

> **Done in S3.4 (2026-10-01)** with a different index: `idx_task_deployment_id ON task (deployment_id, id)` in `V4__add_task_deployment_index.sql`, because the task history endpoint pages by an `id` cursor and `(deployment_id, created_at DESC)` cannot serve `id > ?`. With UUIDv7 ids, the same index serves "most recent first" by scanning backwards (`ORDER BY id DESC`). The leftmost-prefix reasoning below still holds: equality column first, then the range and sort column. Measured result for this section's query (newest 20 for one deployment): 20.2 ms before, 0.042 ms after, for a deployment with 570 tasks. The plan before the index was **not** a seq scan but a backward walk of `task_pkey` that discarded 305,271 rows. Full before and after plans and numbers: [control-api-s3-4-task-history.md](control-api-s3-4-task-history.md) §12.

**Lives in:** mixed. The `EXPLAIN ANALYZE` commands (steps 1 and 3) run by hand, nowhere in the repo. The `CREATE INDEX` in step 2 is schema — it goes into the `V2__` migration below (or a follow-up `V3__` if you'd rather add it as its own separately-dated step once the seq scan is actually observed).

**Step 1 — find the seq scan.** The realistic query this table exists to serve: "most recent tasks for a given deployment, most recent first" (e.g. a deployment detail page's task history panel):

```sql
EXPLAIN ANALYZE
SELECT * FROM task
WHERE deployment_id = '<some-uuid>'
ORDER BY created_at DESC
LIMIT 20;
```

Against 1.2M seeded rows with **no index on `task.deployment_id`** (the `V2` migration above deliberately doesn't add one yet — this is the "find it broken first" step), expect `Seq Scan on task` in the plan, cost proportional to total table size regardless of how few rows match.

**Step 2 — design the composite index.** Not just `(deployment_id)` alone — the query also sorts by `created_at DESC`. A composite index on `(deployment_id, created_at DESC)` lets Postgres satisfy both the filter *and* the sort from the index directly, avoiding a separate sort step:

```sql
CREATE INDEX idx_task_deployment_created ON task (deployment_id, created_at DESC);
```

**Leftmost-prefix reasoning, written down (spec explicitly asks for this, not just the index):** `deployment_id` goes first because the query's `WHERE` clause is an equality filter on it — equality columns belong before range/sort columns in a composite index's column order, so Postgres can seek directly to the matching `deployment_id` block instead of scanning entries for other deployments. `created_at DESC` goes second, matching the query's `ORDER BY` direction exactly, so the index's own physical order already satisfies the sort — no separate `Sort` node needed in the plan. Reversing the order (`created_at, deployment_id`) would make the index useless for this query: Postgres can't seek efficiently on a leading column that isn't the equality filter.

**Step 3 — re-measure**, same `EXPLAIN ANALYZE`, expect `Index Scan using idx_task_deployment_created` and execution time down by (write down the actual before/after numbers once run against the real seeded data — don't guess a number here, measure it).

**Write into `/docs`:** the before plan, the after plan, and the actual millisecond numbers — this is one of the four `/docs` artefacts the module's Definition of Done requires.

---

## 5. Deadlock drill

**Lives in:** nowhere in the repo — run in two separate `psql`/Query Console sessions by hand. Only the captured error text and the write-up go into `/docs`.

**Setup:** pick one `deployment` row (id `D`) and its parent `application` row (id `A`). Two concurrent `psql` sessions, opposite update order:

**Session 1:**
```sql
BEGIN;
UPDATE deployment SET status = 'DEGRADED' WHERE id = 'D';
-- pause here — do not commit yet
UPDATE application SET description = 'note from session 1' WHERE id = 'A';
COMMIT;
```

**Session 2** (started while Session 1 is paused after its first `UPDATE`):
```sql
BEGIN;
UPDATE application SET description = 'note from session 2' WHERE id = 'A';
-- pause here — do not commit yet
UPDATE deployment SET status = 'HEALTHY' WHERE id = 'D';
COMMIT;
```

Session 1 holds a lock on `D`, waits on `A` (held by Session 2). Session 2 holds a lock on `A`, waits on `D` (held by Session 1). Classic circular wait — Postgres's deadlock detector fires within `deadlock_timeout` (default 1s) and kills one transaction with:

```
ERROR: deadlock detected
DETAIL: Process ... waits for ShareLock on transaction ...; blocked by process ...
```

**Capture:** the exact error + `DETAIL` line from whichever session gets killed — that's the log artifact for `/docs`.

**Fix — consistent lock ordering:** always update `application` before `deployment` (or always the reverse — the direction doesn't matter, only that every code path picks the *same* one). If both sessions update in the same order, the second session simply **waits** for the first to finish and commit, instead of deadlocking. Re-run both sessions with both scripts updated to the same order, confirm no deadlock, both commits succeed serially.

**Write into `/docs`:** the captured deadlock log, the fix (lock-ordering rule stated explicitly, e.g. "always touch `application` before `deployment` in any transaction that needs both"), and a one-line note on why this is a code-review-time discipline (no database constraint can enforce "always lock in this order" — it has to be a convention every transaction honors).

---

## Definition of done (these 5 items)

- [ ] `V2__add_task_attempt_and_image_lineage.sql` written and applied
- [x] *(done in S3.4: 1,200,101 tasks, 1,416,629 attempts, hot applications 69.4% of spread tasks)* `infra/seed/seed-tasks.sql` written, run once, ≥1M combined `task`+`attempt` rows confirmed (`SELECT count(*) FROM task` / `attempt`), skew confirmed (top 3 applications own the large majority of rows — a quick `GROUP BY application_id` count check)
- [ ] Window-function query + top-N variant run against seeded data, output sane (spot-check a few applications manually)
- [ ] `base_image` chain seeded ≥3 levels deep, recursive CTE returns full lineage in correct depth order
- [x] *(done in S3.4 with `(deployment_id, id)`; the "before" plan was a primary-key walk, not a seq scan)* Seq scan captured (`EXPLAIN ANALYZE` output saved), index created, leftmost-prefix reasoning written down, re-measured, before/after numbers in `/docs`
- [ ] Deadlock captured (exact error text), lock-ordering fix applied and re-tested clean, note in `/docs`
