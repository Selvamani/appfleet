# control-api — schema normalization (0NF → 3NF, BCNF-validated)

**Spec:** [01-CONTROL-API.md §S1](../../specs/project/01-CONTROL-API.md) · Slice **S1** · Schema **`control`**

Per spec: *"Design in 3NF on paper first. Photograph the paper into `/docs` — it is the artefact for 'walk me from unnormalized to 3NF.'"* This is that artefact, written up rather than photographed, since the design happened directly in this form. Companion: [control-api.md](control-api.md) (S0 skeleton design) and `control-api/src/main/resources/db/migration/V1__init.sql` (the frozen result of this process).

The domain model driving this is the one in the spec:

```
Application ──1:N──> Release            (version, artifactRef, checksum)
     └──1:N──> Deployment  ✱ state machine — (application × environment × release)
                    └── currentStatus   ✱ deliberately denormalised

Environment ──1:N──> Node

Catalogue:  BaseImage ──1:N──> AppImage ──1:N──> ImageVersion
                                                     └── pipelineState  ✱ FSM

AuditEvent           (append-only)
OutboxMessage        (transactional outbox)
```

Two independent chains get normalized here: the **deployment chain** (`Application` → `Release` → `Deployment`, plus `Environment` → `Node`) and the **catalogue chain** (`BaseImage` → `AppImage` → `ImageVersion`). `AuditEvent` and `OutboxMessage` are addressed separately at the end — they're flat, single-purpose tables with no repeating groups or composite natural keys, so they never enter the normalization argument at all.

---

## 0NF — the shape the data lands in if nobody normalizes it

A single flat row, as it would look if someone modeled "a deployment record" as one denormalized table without thinking about structure:

| deployment_id | app_name | app_owner_team | release_version | release_artifact_ref | release_checksum | env_name | node_hostnames | status |
|---|---|---|---|---|---|---|---|---|
| 1 | checkout-service | team-payments | v1.2.0 | s3://.../v1.2.0.jar | abc123 | prod | node-a, node-b, node-c | HEALTHY |

The immediate problem: `node_hostnames` holds **multiple values in one cell** — a repeating group. One environment can have many nodes, and cramming that list into a single column is exactly what 1NF forbids.

## 1NF — atomic values, no repeating groups

**Rule:** every column holds one atomic value; no multi-valued cells, no repeating groups.

**Fix:** pull the node list into its own table, one row per node:

```
deployment_id | node_hostname
1             | node-a
1             | node-b
1             | node-c
```

The main row is now atomic:

| deployment_id | app_name | app_owner_team | release_version | release_artifact_ref | release_checksum | env_name | status |
|---|---|---|---|---|---|---|---|
| 1 | checkout-service | team-payments | v1.2.0 | s3://.../v1.2.0.jar | abc123 | prod | HEALTHY |

This satisfies 1NF, but it's still one table carrying facts about four different things (application, release, environment, deployment) at once.

The catalogue chain has the identical problem in miniature: an app image with several versions listed in one row (`image_versions: v1, v2, v3`) is the same repeating-group violation. Same fix — one row per version, in its own table.

## 2NF — no partial dependency on part of a composite key

**Rule:** 1NF, plus no non-key column depends on only *part* of the primary key. Only bites when the key is composite (multiple columns).

To expose the problem, consider the *natural* key before introducing surrogate ids: `(app_name, release_version, env_name)` identifies one deployment. Check each non-key column against the full key:

| Column | Depends on | Verdict |
|---|---|---|
| `app_owner_team` | `app_name` only | **Partial dependency** — violates 2NF |
| `release_artifact_ref`, `release_checksum` | `(app_name, release_version)` only | **Partial dependency** — violates 2NF |
| `status` | the full triple | OK |

**Fix:** split off anything depending on a subset of the key into its own table, keyed by that subset:

```
application(app_name PK, app_owner_team)
release(app_name FK, release_version, release_artifact_ref, release_checksum, PK(app_name, release_version))
deployment(deployment_id PK, app_name FK, release_version FK, env_name FK, status)
```

This is also the point where a surrogate `id` (UUID) naturally replaces the composite natural key in the real schema — same underlying logic, cleaner foreign keys downstream.

Applying the same check to the catalogue chain: `app_image.maintainer`, considered against a natural key of `(base_image_name, app_image_name, version)`, depends only on `(base_image_name, app_image_name)` — partial dependency, same fix, split `app_image` out from `image_version`.

**Tables at 2NF (deployment chain):**

| Table | Columns |
|---|---|
| `application` | `id` PK, `name`, `description`, `app_owner_team` |
| `release` | `id` PK, `application_id` FK, `version`, `artifact_ref`, `checksum` |
| `environment` | `id` PK, `name` |
| `node` | `id` PK, `environment_id` FK, `hostname` |
| `deployment` | `id` PK, `application_id` FK, `release_id` FK, `environment_id` FK, `status` |

**Tables at 2NF (catalogue chain):**

| Table | Columns |
|---|---|
| `base_image` | `id` PK, `name`, `registry` |
| `app_image` | `id` PK, `base_image_id` FK, `name`, `maintainer` |
| `image_version` | `id` PK, `app_image_id` FK, `version`, `pipeline_state` |

Every column now depends on its own table's **full** key — no partial dependencies remain. Nothing yet checked for transitive dependency; that's the 3NF pass.

## 3NF — no transitive dependency on a non-key column

**Rule:** 2NF, plus no non-key column depends on *another non-key column* rather than on the key directly.

Check `application(app_name, app_owner_team)`: if this table also carried, say, `team_lead_email`, that value depends on `app_owner_team`, not on `app_name` — a transitive dependency, violating 3NF. The fix isn't a new table on control-api's side at all: **that column doesn't belong here.** `Team`/`User` live in identity-service (per spec's own "Ownership note"), and control-api keeps only `owner_team_id` — a plain reference by id, never a JPA relationship or a stash of team-derived attributes. Renaming `app_owner_team` → `owner_team_id` and storing *only* the id closes this off structurally: there's nothing team-derived sitting on `application` for a future column addition to accidentally make transitive.

Running the same check across every 2NF table:

| Table | Column checked | Transitively dependent on a non-key column? |
|---|---|---|
| `application` | `owner_team_id` | No — stores only the id, no team-derived attributes |
| `release` | `artifact_ref`, `checksum` | No — each depends on `release.id` directly |
| `environment` | `name` | No |
| `node` | `hostname` | No |
| `deployment` | `status` | No |
| `base_image` | `registry` | No — this image's own attribute |
| `app_image` | `maintainer` | No — depends on this specific app image, not on `base_image_id` (different app images under the same base image can have different maintainers) |
| `image_version` | `pipeline_state` | No |

No violations found. This is the 3NF schema:

**Deployment chain:** `application(id, name, description, owner_team_id)`, `release(id, application_id, version, artifact_ref, checksum)`, `environment(id, name)`, `node(id, environment_id, hostname)`, `deployment(id, application_id, release_id, environment_id, status)`.

**Catalogue chain:** `base_image(id, name, registry)`, `app_image(id, base_image_id, name, maintainer)`, `image_version(id, app_image_id, version, pipeline_state)`.

## The one deliberate exception, layered on top of 3NF — not a normalization mistake

`deployment.current_status` — a duplicate of `status`, added *after* reaching 3NF, on purpose, for read-path speed (avoiding a join/aggregation over task history on every status read). This is a genuine 3NF violation, done deliberately and documented, per spec: *"Write the justification in `/docs` — read path, write path, what keeps it consistent (the `AFTER_COMMIT` listener), and what could make it drift."*

- **Read path:** any query needing "what's the current status of this deployment" reads `deployment.current_status` directly — no join to task/attempt history required.
- **Write path:** task/attempt state transitions are the source of truth; `current_status` is a cache of the latest one.
- **Consistency mechanism:** a `@TransactionalEventListener(AFTER_COMMIT)` listener (S6) updates `current_status` after the transaction that changed the underlying task state commits — never inside the same transaction, so a rollback of the state change can't leave `current_status` reflecting a change that never actually happened.
- **Drift risk:** if the `AFTER_COMMIT` listener fails to fire, throws, or the app crashes between the triggering commit and the listener running, `current_status` can lag behind the true state until the next transition triggers a fresh update. No mechanism in this schema alone repairs that automatically — worth a periodic reconciliation job if drift ever becomes observable in practice, not built as part of S1.

Two additional, unrelated pieces of enforcement get added to `deployment` alongside this — not normalization concerns, but domain integrity constraints belonging on the same table:

- `CHECK (status IN ('PENDING','VALIDATING','DEPLOYING','HEALTHY','DEGRADED','FAILED','ROLLED_BACK'))` — the state machine's legal values, enforced in the database, not just in application code.
- A **partial unique index** on `(application_id, environment_id)` `WHERE status NOT IN ('FAILED','ROLLED_BACK')` — "one active deployment per (application, environment)," per spec.

## BCNF validation

**Rule:** BCNF is 3NF plus a stricter condition — for *every* functional dependency `X → Y`, `X` must be a candidate key (a superkey). 3NF tolerates one loophole BCNF closes: a transitive dependency is allowed in 3NF if its determinant happens to be part of *some* candidate key, even a non-prime one. BCNF violations only actually appear when a table has **two or more overlapping candidate keys** and a proper subset of one determines an attribute outside it.

Checked against every table, with the natural-key `UNIQUE` constraints each table needs anyway to make those natural keys real candidate keys (not just attributes that happen not to repeat yet):

| Table | Candidate keys | Violation? |
|---|---|---|
| `application` | `id`; `name` (`UNIQUE`) | No — every determinant is a full candidate key |
| `release` | `id`; `(application_id, version)` (`UNIQUE`) | No |
| `environment` | `id`; `name` (`UNIQUE`) | No — 2-attribute table, trivially BCNF |
| `node` | `id`; `(environment_id, hostname)` (`UNIQUE`) | No |
| `deployment` | `id` only | No — the partial unique index on `(application_id, environment_id)` is **not** a true candidate key for BCNF purposes; it's a conditional constraint over a subset of rows (`WHERE status NOT IN (...)`), not a full-relation uniqueness guarantee |
| `base_image` | `id`; `name` (`UNIQUE`) | No |
| `app_image` | `id`; `(base_image_id, name)` (`UNIQUE`) | No |
| `image_version` | `id`; `(app_image_id, version)` (`UNIQUE`) | No |
| `audit_event` | `id` only | No — flat, single-key, trivially BCNF |
| `outbox_message` | `id` only | No — flat, single-key, trivially BCNF |

**Verdict:** the schema is already in BCNF once the natural-key `UNIQUE` constraints are actually declared (see below) — no table requires further splitting. BCNF violations need overlapping composite natural keys with a partial determinant, and no table here has that shape: every table has exactly one surrogate key plus, at most, one non-overlapping natural key.

## Constraints that make the assumed candidate keys real

The BCNF check above assumes several natural keys are enforced `UNIQUE`. They have to be declared explicitly in `V1__init.sql`, or they're not actually candidate keys — just attributes that happen not to collide yet:

- `application.name` — `UNIQUE`
- `release(application_id, version)` — `UNIQUE`
- `environment.name` — `UNIQUE`
- `node(environment_id, hostname)` — `UNIQUE`
- `base_image.name` — `UNIQUE`
- `app_image(base_image_id, name)` — `UNIQUE`
- `image_version(app_image_id, version)` — `UNIQUE`

## Result

The frozen schema — every table above, plus the `CHECK`, the partial unique index, and the natural-key `UNIQUE` constraints — is committed as `control-api/src/main/resources/db/migration/V1__init.sql`. Per repo convention ([00-BUILD-GUIDE.md](../../specs/project/00-BUILD-GUIDE.md): "Migrations, Flyway, `V<n>__<snake_case>.sql`, per service, never edited after commit"), this file does not change after this point — any future schema change is a new `V2__...` migration, additive, never a rewrite of this one.
