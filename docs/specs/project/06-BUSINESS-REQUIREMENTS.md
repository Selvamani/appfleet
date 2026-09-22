# Business Requirements — what Appfleet is for

**[← The Spring Boot Project](../SPRING-PROJECT.md)** · **Read before [Build Guide](00-BUILD-GUIDE.md)** — the specs say *what to build*; this says *why anyone would want it*.

---

## The need, in plain words

> **Engineering teams lose track of three things as they grow:**
>
> 1. **What is running where?** — nobody can answer without asking around
> 2. **Who is allowed to change it?** — whoever has the credentials can deploy anything
> 3. **What happened when they did?** — the history lives in chat logs and memory
>
> **Appfleet is one place that answers all three** — plus it runs heavyweight tools (IDEs, design suites, vendor software) **in the browser, on demand**, so nobody installs them on laptops.
>
> That is the whole pitch. Everything below is detail.

**If you can say those four lines from memory, you can open any interview conversation about this project.** No technology words appear in them — deployments, permissions, history, tools. Technology enters only when someone asks *how*.

> **Why this document matters for interviews:** every system design round opens with five minutes of requirements, and every project conversation opens with *"what does it do?"* Answering with technology — "it's microservices on Kafka" — is the junior answer. Answering with the problem, the users and the constraints, *then* the technology, is the senior one. **This document is that answer, written down and rehearsed.**

---

## 1 · The problem, with texture

A mid-size product company (~200 engineers, ~40 teams' worth of applications) delivers software and heavyweight tooling the way most do:

- **Deployments are tribal.** Each team has scripts; nobody can answer *"what version of what is running where?"* without asking around
- **Access is coarse.** Whoever has the CI credentials can deploy anything, to anywhere, including production — and afterwards nobody can say who did
- **Heavyweight tools don't fit laptops.** Design suites, IDEs pinned to toolchains, vendor planning tools — every engineer installs, patches and licenses their own copy, and "works on my machine" is a weekly incident
- **Audit is reconstruction.** When something breaks — or compliance asks — the history is assembled from chat logs and memory

**Appfleet** is the internal platform that fixes this: a single control plane where teams register applications, deploy releases to environments through a governed, audited pipeline, and launch heavyweight tools as **on-demand, isolated, browser-delivered sessions** instead of local installs.

> **The elevator version to rehearse (20 seconds):** *"Appfleet answers three questions a growing engineering org loses the ability to answer: what is running where, who is allowed to change it, and what happened when they did — and it delivers heavyweight tooling on demand instead of onto laptops."*

## 2 · Who uses it — personas drive the RBAC model

| Persona | Wants | Role | Sees |
|---|---|---|---|
| **Application developer** | See their team's deployments and task history; launch tool sessions; no surprises | `VIEWER` | Own teams only |
| **Release manager** | Deploy and roll back **their team's** applications; trust that a deploy either lands or reports why | `DEPLOYER` *(per team)* | Own teams |
| **Platform operator** | Fleet health, stuck-task triage, DLQ replay, node drain | `OPERATOR` | Everything operational |
| **Security / IT admin** | Manage users, teams and grants; enforce least privilege; answer "who can do what?" | `ADMIN` | Everything |
| **Auditor** *(occasional)* | A complete, immutable answer to "who did what, when, to what?" | `VIEWER` + audit read | Audit trail |

**This table is where the RBAC design comes from** — scoped grants exist because release managers are per-team; permissions-as-atoms exist because the auditor role wasn't known on day one and adding it must not need code. **When asked "why such an elaborate auth model?", the answer is this table, not Spring Security.**

## 3 · Functional requirements

Each requirement names the component that satisfies it — **this table is the traceability an interviewer probes when they ask "why does this service exist?"**

### FR-1 · Application & release registry — *control-api*
- **FR-1.1** Teams register applications they own; ownership is enforced, not advisory
- **FR-1.2** Releases are immutable once registered (version, artifact, checksum)
- **FR-1.3** *"What version runs where?"* answered in one query, for any scope

### FR-2 · Governed deployments — *control-api + task-service*
- **FR-2.1** Deploying is an **asynchronous, tracked operation** — accepted immediately, progress observable, outcome recorded *(the 202 + task model)*
- **FR-2.2** A deployment is **exactly-once in effect**: retrying a submission must never deploy twice *(idempotency keys)*
- **FR-2.3** Only one active deployment per application per environment *(the partial unique index)*
- **FR-2.4** Every deployment moves through **explicit, legal states** — no undefined limbo *(the FSM)*
- **FR-2.5** Rollback is first-class, not a re-deploy hack *(the Saga compensation)*
- **FR-2.6** Transient failures retry with backoff; permanent ones dead-letter for operator replay — **failure handling is a product feature, not plumbing**

### FR-3 · Access control — *identity-service*
- **FR-3.1** Every action is authenticated; every privileged action is authorized **against the specific object** *(the IDOR fix is a requirement, not a nicety)*
- **FR-3.2** Grants are **per team** — deployer on Team A implies nothing about Team B
- **FR-3.3** Revoking access takes effect within minutes, not at token expiry *(the denylist)*
- **FR-3.4** Machines (agents, services) authenticate as principals with scoped credentials — no shared secrets
- **FR-3.5** Self-service profile and password flows; admin-managed everything else

### FR-4 · On-demand tool sessions — *node-agent + catalogue*
- **FR-4.1** A curated **catalogue** of containerised tools, versioned, built on shared base images
- **FR-4.2** Any authorized user launches a session in the browser — **no local install, ever**
- **FR-4.3** Idle sessions are reclaimed automatically *(capacity is finite and shared)*
- **FR-4.4** Sessions are isolated: one user's session can never see another's

### FR-5 · Observability & history — *query-service*
- **FR-5.1** A dashboard answering *"what is happening right now?"* — per team, filtered to what the viewer may see
- **FR-5.2** Complete deployment/task history, **fast regardless of volume** *(the read model exists because FR-5.2 must not tax the write path)*
- **FR-5.3** Reads may be seconds stale, but staleness is **visible** (`asOf`), never silent

### FR-6 · Audit — *cross-cutting*
- **FR-6.1** Every state change and every login attempt recorded: who, what, when, from where, correlation id
- **FR-6.2** Audit records survive the failure of the action they describe *(the `REQUIRES_NEW` requirement)*
- **FR-6.3** Append-only; users deactivate rather than delete

## 4 · Non-functional requirements — with numbers

**NFRs without numbers are decoration.** These are deliberately modest — realistic for an internal platform, defensible in an interview, and *measurable in Slice 7*.

| # | Requirement | Target | Verified by |
|---|---|---|---|
| NFR-1 | Control-plane availability (business hours) | **99.9%** | graceful-shutdown + rolling-restart drills |
| NFR-2 | Deployment command accepted | **p99 < 500 ms** | load test |
| NFR-3 | Dashboard reads | **p99 < 200 ms** at 100 RPS | load test + cache hit ratio |
| NFR-4 | Task throughput | **≥ 100 tasks/min sustained**, burst 5× | the scaling chart |
| NFR-5 | Session cold start | **< 30 s**; warm pool < 5 s | session-density measurements |
| NFR-6 | Access revocation propagation | **< 5 min** | the denylist test |
| NFR-7 | Zero lost work on deploy/scale-down of Appfleet itself | **0 tasks lost** | the SIGTERM drill |
| NFR-8 | Audit completeness | 100% of privileged actions | audit coverage test |
| NFR-9 | Read staleness | **< 5 s** typical, visible always | projection-lag gauge |
| NFR-10 | Recovery: broker or a service instance fails | no data loss; degrade, don't cascade | kill-tests (outbox, rebalance, lease) |

> **Interview use:** these ten lines are a worked example of the "non-functional requirements" step in the [system-design framework](../SYSTEM-DESIGN-QUESTIONS.md). Practising pulling numbers like these out of a vague prompt is exactly what the first five minutes of that round is.

## 5 · Explicitly out of scope — and why saying so is senior

| Not building | Because |
|---|---|
| A UI beyond the API | The buyers of this project (interviewers) are reading the backend |
| Billing / chargeback | No requirement demands it; adding it is résumé-driven development |
| Multi-region | NFR-1 is 99.9% business-hours — one region satisfies it. **Know what would change if it became 99.99% always** |
| External IdP integration | Profile-switchable later (FR-3 stays); building it now duplicates identity-service's teaching value |
| Approval workflows / change advisory | Real platforms grow these; the FSM leaves an obvious seam. **Name the seam when asked about extensibility** |

**Scope discipline is a feature of the requirements, not a compromise of them.** *"I deliberately didn't build X because no requirement demanded it — here's the seam where it would go"* is one of the strongest sentences available in a project walkthrough.

## 6 · Success metrics — how the business would judge it

- **Time-to-answer** for "what's running where?": hours of asking around → **one query**
- **Unauthorized-action rate**: unknown (no enforcement) → **0, with an audit trail proving it**
- **Tool onboarding**: per-laptop installs → **catalogue publish once, sessions for everyone**
- **Incident reconstruction**: chat archaeology → **correlation-id walk through the audit trail**
- **Deploy confidence**: "run the script and watch" → **submit, observe states, roll back first-class**

## 7 · The narrative arc — rehearse this

The story told forward, the way you'd answer *"tell me about a project you're proud of"*:

1. **Problem** — a growing org loses track of what runs where, who may change it, and what happened *(20 s)*
2. **Users** — five personas, from developer to auditor, with genuinely different needs *(20 s)*
3. **Shape** — a control plane + workers + agents + a read side; **each service bound by a different resource**, which is why they're separate *(30 s)*
4. **The interesting bits** — pick two for the audience: the fencing-token lease for a distributed-systems interviewer, the IDOR-then-`PermissionEvaluator` for a security-minded one, rebuild-from-topic for a data one *(60 s)*
5. **Honesty** — what it doesn't do, what its measured limits are, and what you'd build next *(20 s)*

- [ ] **First: the four plain-words lines at the top, from memory.** They are the door into everything else
- [ ] Write your own version of this arc, out loud, under 3 minutes
- [ ] Then the 20-second elevator version from §1
- [ ] Then map every FR to its component from memory — if you can't, the traceability isn't yours yet
