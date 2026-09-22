# Appfleet

Application fleet management platform — control plane, deployments, task
lifecycle, container orchestration, read-model dashboards. Spec-driven build,
no reference implementation copied.

Specs: [`docs/specs/`](docs/specs/) — start at
[SPRING-PROJECT.md](docs/specs/SPRING-PROJECT.md), module specs and the
two-developer split in [`docs/specs/project/`](docs/specs/project/). Copied
in from the job-search repo (`JobSearch/prep/`); edit there, re-copy here.
Some links inside these files point up to the wider interview-prep corpus
(syllabus, checklists) that isn't copied — those won't resolve from here,
everything Appfleet-specific does.

Modules: common-events, common-security, fleet-audit-starter, control-api,
identity-service, task-service, node-agent, query-service, client-sdk.

## Status: skeleton, no logic

What's here: parent + all 10 module `pom.xml`, a bare `@SpringBootApplication`
per service, `application.yml` per service (ports, Kafka/Redis/Postgres
connection wired to env vars), a Flyway `V1__init.sql` placeholder per service
with its own schema, `docker-compose.yml` (Postgres 16, Redis 7, Kafka KRaft,
healthchecks, explicit topic creation — `task.work` at 6 partitions).

`mvn validate` and `mvn compile` both pass clean from this state.

What's not here: every business rule, every entity, every endpoint. That's
Week 1+ — see [Two-Developer Split](docs/specs/project/07-TWO-DEVELOPER-SPLIT.md)
and the per-module specs in `docs/specs/project/`.

```
docker compose up -d   # postgres, redis, kafka + topic init
mvn verify              # currently: nothing to test yet
```
