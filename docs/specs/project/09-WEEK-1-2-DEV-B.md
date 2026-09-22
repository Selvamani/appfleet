# Week 1-2 spec — Dev B (task-service, node-agent)

**[← Two-developer split](07-TWO-DEVELOPER-SPLIT.md)** · Full specs: [03-TASK-SERVICE.md](03-TASK-SERVICE.md) · [04-NODE-AGENT.md](04-NODE-AGENT.md)

Retry engine, DLQ, rebalance drill, node lease/fencing, sessions and MDC
propagation are deferred to Weeks 4-6 — see the split doc's table. Week 1-2
gets a real, running consume-and-execute path, single strategy, no failure
handling yet.

## Week 1 — task-service skeleton + schema + claim

**Domain (from task-service spec):**
- [ ] `Task ──1:N──> Attempt` — each execution try: `startedAt`, `finishedAt`, `outcome`, `workerInstance`
- [ ] Task state: `QUEUED → CLAIMED → RUNNING → SUCCEEDED | FAILED | DEAD`
- [ ] `retryPolicy` (maxAttempts, backoffBase, jitter) and `idempotencyToken` columns now — logic wired later
- [ ] Attempts are append-only

**Consumption (single strategy only this week):**
- [ ] `TaskIntake` interface; **record listener** implementation only — batch listener + config-driven choice deferred to Week 5
- [ ] Consumer group `task-service`, consuming `deployment.commands`
- [ ] Manual ack after the DB write, not before

**Work claiming:**
- [ ] `SELECT … FOR UPDATE SKIP LOCKED` claim query — multiple instances, no double-claim, no blocking
- [ ] Skeleton only this week: the stale-claim reaper itself is Week 2+ once there's something to reap

**Week 1 demo:** manually publish a message to `deployment.commands` (test producer or CLI), task-service consumes and logs it, claim query runs against a seeded `QUEUED` row.

## Week 2 — node-agent skeleton + Simulated runtime

**Core abstraction (from node-agent spec, Simulated only this week):**
```
ContainerRuntime    start(spec) · stop(id) · status(id) · logs(id) · list()
 └── SimulatedRuntime   state machine + configurable latency/failure
```
- [ ] One interface, `SimulatedRuntime` wired by `@ConditionalOnProperty(appfleet.runtime)` — `DockerRuntime` and `SwarmRuntime` deferred to Week 4
- [ ] `ApplicationContextRunner` test proving exactly one runtime is wired per profile
- [ ] Configurable start latency and failure rate on `SimulatedRuntime` — this is what makes load testing possible later, note it in the code doc now

**Events (basic, no MDC propagation yet):**
- [ ] Consume `task.work`, drive the simulated container, emit `task.events` (`TaskStarted` / `Succeeded` / `Failed`)
- [ ] Correlation id carried as a plain header, read and forwarded — the MDC-across-Kafka discipline and the deliberate leak bug are Week 6

**task-service side, to close the loop:**
- [ ] task-service now **produces** `task.work` (keyed by deployment id) after claiming a command, so node-agent has something to consume
- [ ] task-service consumes `task.events`, updates `Task`/`Attempt` state

**Week 2 demo:** Dev A's `POST /deployments` → outbox → `deployment.commands` → task-service claims, produces `task.work` → node-agent (simulated) "runs" it, emits `task.events` → task-service updates status. Full pipeline, no auth, no read side.

## Definition of done, both weeks

- [ ] `mvn verify` green — Testcontainers Postgres (task-service) + Kafka (both)
- [ ] task-service and node-agent each start and stay healthy under `docker compose up -d`
- [ ] Correlation id visible end to end in logs, even without the full MDC discipline yet
