# Week 1-2 spec — Dev A (control-api)

**[← Two-developer split](07-TWO-DEVELOPER-SPLIT.md)** · Full spec: [01-CONTROL-API.md](01-CONTROL-API.md)

Pulled from S0/S1/S3/S4 of the full spec. JPA (S2), 1M-row SQL evidence, and the
outbox kill-test's full rigor are deferred to Week 6 — see the split doc's
table. Week 1-2 gets a real, running write path with no auth yet.

## Week 1 — skeleton + schema + basic CRUD

**Skeleton (S0):**
- [ ] Boot 4.1.x, Java 21+, module builds inside the parent
- [ ] `@ConfigurationProperties(prefix = "appfleet")`, typed, validated — **no `@Value` anywhere**
- [ ] Profiles: `local`, `test`, `prod`
- [ ] `fleet-audit-starter`: `@ConditionalOnProperty(appfleet.audit.enabled)` + `@ConditionalOnMissingBean`, proven with `ApplicationContextRunner` tests
- [ ] Actuator: health, info, metrics exposed, everything else locked

**Schema (S1, schema portion only):**
- [ ] Domain: `Application ──1:N──> Release`, `Application ──1:N──> Deployment` (application × environment × release), `Environment ──1:N──> Node`
- [ ] 3NF on paper first — photograph it into `/docs`
- [ ] Flyway `V1__`, never `ddl-auto` beyond `validate`
- [ ] DB constraints, not just JPA: FKs, `CHECK` on state values, **partial unique index — one active deployment per (application, environment)**
- [ ] `ownerTeamId` on Application as a plain column — not a JPA relationship (Team lives in identity-service from S4 on)

**Basic CRUD (S3 subset — no idempotency/rate-limit/pagination yet):**
```
POST /api/v1/applications           201 + Location
GET  /api/v1/applications
POST /api/v1/applications/{id}/releases
```
- [ ] Bean Validation on every request DTO; DTOs are records; never entities out of controllers
- [ ] `@RestControllerAdvice` → `ProblemDetail` for validation + not-found, at minimum

**Week 1 demo:** register an application and a release via REST, `docker compose up -d` all healthy.

## Week 2 — FSM, outbox, idempotency

**Deployment FSM (S1 top):**
- [ ] States: `PENDING → VALIDATING → DEPLOYING → HEALTHY | FAILED | DEGRADED | ROLLED_BACK`
- [ ] Enum owning its **legal transitions** — illegal transition throws, always, no bypass flag
- [ ] Transitions emit events; status never set directly by a controller
- [ ] `deployment.current_status` denormalised — note the justification in `/docs` (full write-up deferred to Week 6, but the column and the AFTER_COMMIT sync exist now)

**Outbox (pulled forward from S4):**
- [ ] `OutboxMessage` written in the **same transaction** as the state change
- [ ] Poller publishes to Kafka, marks sent, deletes
- [ ] Kill-test: stop the app between commit and publish, restart, prove the message still goes out
- [ ] `POST /api/v1/deployments` now real: `202 Accepted` + `Location: /tasks/{id}`

**Idempotency (S3):**
- [ ] `Idempotency-Key` header on `POST /deployments`: Redis `SET NX` with TTL
- [ ] Same key → original response replayed; in-flight duplicate → `409`
- [ ] Test: two concurrent identical POSTs, exactly one deployment

**Week 2 demo:** `POST /deployments` runs outbox → Kafka → (Dev B's task-service picks it up). Full write-path pipeline, no auth, no read side yet.

## Definition of done, both weeks

- [ ] Everything in [00-BUILD-GUIDE.md](00-BUILD-GUIDE.md) §Definition of done
- [ ] `mvn verify` green with Testcontainers Postgres + Redis + Kafka
- [ ] 3NF paper photo in `/docs`
