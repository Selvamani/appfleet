# Appfleet

Application fleet management platform — control plane, deployments, task
lifecycle, container orchestration, read-model dashboards. Spec-driven build,
no reference implementation copied.

Specs: see `JobSearch/prep/project/` in the job-search repo (not committed
here — this repo is the implementation only).

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
Week 1+ — see the Two-Developer Split spec and the per-module specs, kept in
a separate repo (`JobSearch/prep/project/`, not committed here — different
drive, different repo).

```
docker compose up -d   # postgres, redis, kafka + topic init
mvn verify              # currently: nothing to test yet
```
