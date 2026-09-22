# task-service — implementation spec

**[← Build Guide](00-BUILD-GUIDE.md)** · Slices **S4, S6** · Schema **`task`** · **Horizontally scaled — no fixed port**

Task lifecycle, retries, DLQ. Extracted first because it has a **different scaling profile** (queue depth, not request rate) and **different failure semantics** (retry and resume, not request/response) from the API. **Write that sentence down when you extract it — it is the answer to "why did you split this?"**

---

## Domain model

```
Task ──1:N──> Attempt        each execution try: startedAt, finishedAt, outcome, workerInstance
 │
 ├── state: QUEUED → CLAIMED → RUNNING → SUCCEEDED | FAILED | DEAD
 ├── retryPolicy: maxAttempts, backoffBase, jitter
 └── idempotencyToken        set by control-api, carried end-to-end
```

- [ ] Attempts are **append-only** — the retry history *is* the debugging story
- [ ] `DEAD` = retries exhausted → dead-letter topic **and** queryable state

## Consumption — two strategies behind one interface *(Automatter's shape, in Spring)*

- [ ] `TaskIntake` interface; **record listener** and **batch listener** implementations; chosen by config *(Strategy + Factory — name them in the code docs)*
- [ ] Consumer group `task-service`; **partition count is the parallelism ceiling** — you prove this in S7
- [ ] **Name the actor-model equivalence in the code doc:** partition keyed by aggregate id = a mailbox — one message at a time, in order, per deployment. **You ran Akka for years; this is the same guarantee on a durable substrate.** Saying so turns a Kafka detail into a distributed-systems answer
- [ ] **Manual ack** after the DB write, not before — and be able to say what auto-ack would risk
- [ ] **Idempotent consumer:** processed-message table keyed by `idempotencyToken`, checked in the same transaction as the state change. **Duplicate delivery test:** send the same command twice, one task
- [ ] **Rebalance drill:** kill a worker mid-task; watch the partition reassign; prove the task is not lost *(claimed-but-stale reaper reclaims it)* and not duplicated *(idempotency)*

## Retry engine

- [ ] **Exponential backoff with jitter** — implement it yourself: `delay = base * 2^attempt ± jitter`. **No jitter → thundering herd; you've fought this in production, say so in the code doc**
- [ ] Delayed retry via a scheduled requeue *(a `retry_at` column claimed by the reaper — simpler and more inspectable than Kafka delay topics; note the trade-off)*
- [ ] **Retry only retryable failures** — a taxonomy: `TRANSIENT` (retry), `PERMANENT` (dead-letter now), `UNKNOWN` (retry with cap)
- [ ] After `maxAttempts` → `task.work.DLT` with failure metadata headers
- [ ] **DLQ replay endpoint:** `POST /api/v1/dlq/{taskId}/replay` (OPERATOR) — resets attempts, requeues, audit-logged

## Work claiming — the other queue

Some work arrives via DB polling, not Kafka *(the reaper, delayed retries)*:

- [ ] **`SELECT … FOR UPDATE SKIP LOCKED`** claim query — multiple instances, no double-claim, no blocking. **This is the "queue in a table" answer, and why you don't always need a broker**
- [ ] Stale-claim reaper: `CLAIMED` older than lease → back to `QUEUED`. **Fires on every instance when scaled — fix with the claim table itself** *(the fix and the bug are the same mechanism; notice that)*

## Bounded execution

- [ ] Executor with **bounded queue** + `CallerRunsPolicy` — and a load test showing what the unbounded default does instead *(heap growth → OOM; capture the curve)*
- [ ] **Graceful shutdown:** in-flight tasks finish or release their claim; `SIGTERM` drill under load, **zero lost tasks** — this is the scale-down proof for S7

## Deliberate bugs owned here

| Build it broken | Then |
|---|---|
| **Duplicate delivery** processed twice | idempotent consumer |
| **Rebalance drops in-flight work** | ack discipline + reclaim |
| **No jitter** — synchronized retry storm | jitter; chart the two patterns |
| **Unbounded queue OOM** | bounded + `CallerRunsPolicy` |
| **Double-claim without `SKIP LOCKED`** | the claim query |
| **Work lost on scale-down** | graceful shutdown |

## Definition of done

- [ ] `mvn verify` green — Testcontainers Postgres + Kafka
- [ ] Runs scaled: `docker compose up --scale task-service=3` with correct behaviour
- [ ] The rebalance and shutdown drills documented in `/docs` with what you observed

> **Unlocks:** *"Exactly-once — really?"* · *"What happens during a consumer group rebalance?"* · *"Queue in a table?"* · *"How do you retry safely?"* · the S7 scaling chart
