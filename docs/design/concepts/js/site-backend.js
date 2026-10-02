/*
 * site-backend.js: content for "How Appfleet works" (appfleet-concepts.html), the backend concepts site.
 * Loaded after core.js and before the lessons and app.js. app.js renders whatever AF.site holds.
 */
(function () {
  'use strict';

  AF.site = {
    id: 'backend',
    copy: {
      "siteTitle": "How Appfleet works",
      "heroTitle": "Follow one deployment through Appfleet",
      "heroLede": "Step through it stop by stop. Each stop names the idea that keeps the request safe, and links to a lesson where you can break that idea and watch what happens.",
      "heroAside": "Appfleet is a control plane for an engineering organisation: it records what runs where, who may change it, and what happened when they did. It is built in slices, so some stops work today and some are still plans. Each stop says which.",
      "baysLabel": "Components the deployment passes through",
      "stripTitle": "billing-api 2.4.0",
      "stripSub": "to staging",
      "stripNote": "The paper strip is the deployment. Its colour changes when the deployment settles.",
      "layersTitle": "Lessons, by layer",
      "mapTitle": "System map",
      "mapLede": "Five services and three pieces of infrastructure. Each service is separate because it runs out of a different resource first. Pick one to see what it owns and what limits it.",
      "mapDefault": "control",
      "roadTitle": "Roadmap",
      "roadLede": "The system is built in slices, one per week, and has to pass its tests at the end of every slice. Services are split off only when they need to scale or fail differently. Status as of 2 October 2026:",
      "roadDefault": "S3",
      "roadListLabel": "Slices in build order",
      "stancesTitle": "Design choices",
      "stancesLede": "The reasoning behind the shape of the system, including the things it deliberately does not do.",
      "mappingTitle": "Actor-model guarantees, without an actor framework",
      "mappingLede": "Appfleet uses no actor library, but each guarantee an actor system gives you has a counterpart here. Open a row to see where.",
      "mappingHead": [
        "Guarantee",
        "With actors",
        "In Appfleet"
      ],
      "mappingMore": "In Appfleet: ",
      "regimeTitle": "Coordinate or converge?",
      "regimeLede": "When two writers change the same data at the same moment, you can either let one win and refuse the other, or accept both and merge them. Pick the data and see which fits.",
      "regimeLegend": "The data",
      "regimeDefault": "release",
      "questionsTitle": "Questions people ask"
    },

  bays: [
    { id: 'client', name: 'Client', role: 'Release manager, console or SDK' },
    { id: 'control', name: 'control-api', role: 'Decides, writes, answers 202' },
    { id: 'redis', name: 'Redis', role: 'Keys, buckets, leases, cache' },
    { id: 'postgres', name: 'Postgres', role: 'One schema per service' },
    { id: 'kafka', name: 'Kafka', role: 'Topics keyed by deployment' },
    { id: 'task', name: 'task-service', role: 'Retries and dead letters' },
    { id: 'agent', name: 'node-agent', role: 'Runs containers on a node' },
    { id: 'query', name: 'query-service', role: 'Read models with asOf' }
  ],

  stops: [
    { bay: 'client', state: 'not sent yet', tone: 'flight', status: 'built', now: 'Works today (S3.3, S3.5). The JWT arrives in S4.',
      title: 'A release manager asks for a deployment',
      text: 'The console sends POST /api/v1/deployments for billing-api 2.4.0 to staging. Two headers ride along: an Idempotency-Key, so a retry can never deploy twice, and a JWT that says who is asking.',
      tags: ['rd-idempotency', 'sec-jwt'] },
    { bay: 'control', state: 'checking', tone: 'flight', status: 'progress', now: 'Correlation id works today. Rate limiting is designed; JWT checks come in S4.',
      title: 'Filters run before any business code',
      text: 'A filter stamps a correlation id on the request and into the log context, so every log line and message about this request can be found later. From S4 the JWT is verified locally with identity-service\'s public key, and the rate limiter takes one token from the team\'s bucket.',
      tags: ['sp-filters', 'sec-jwt', 'rd-ratelimit'] },
    { bay: 'redis', state: 'key claimed', tone: 'flight', status: 'built', now: 'Works today (S3.5).',
      title: 'The idempotency key is claimed',
      text: 'A Lua script stores the key only if it is new. If the same key comes back, the client gets the first answer replayed, or a 409 while the first request is still running. Different body with the same key gets a 422.',
      tags: ['rd-idempotency'] },
    { bay: 'control', state: 'authorising', tone: 'flight', status: 'planned', now: 'Planned for S4.',
      title: 'May this person deploy this application?',
      text: 'Knowing the role is not enough. A PermissionEvaluator compares the caller\'s team grants with the application\'s owner team. Without that object-level check, a deployer on one team could deploy another team\'s application.',
      tags: ['sec-idor', 'sec-rbac', 'sp-proxy'] },
    { bay: 'postgres', state: 'PENDING', tone: 'flight', status: 'built', now: 'Works today (S1 to S3.3). The outbox row joins in S4.',
      title: 'One transaction writes everything',
      text: 'The deployment row in PENDING, its DEPLOY task and an audit row commit together. A partial unique index refuses a second active deployment to staging, and the @Version column stops two writers from overwriting each other.',
      tags: ['pg-fsm', 'pg-constraints', 'pg-optimistic', 'pg-transactions', 'kf-outbox'] },
    { bay: 'client', state: 'PENDING', tone: 'flight', status: 'built', now: 'Works today (S3.3).',
      title: '202 Accepted, right away',
      text: 'The answer comes back before any container starts: 202 with Location /api/v1/tasks/{id}. The client polls that address. Slow work never holds a request thread, and every failure comes back in one error shape.',
      tags: ['ar-async', 'sp-errors'] },
    { bay: 'kafka', state: 'PENDING', tone: 'flight', status: 'planned', now: 'Planned for S4. Topics already exist in docker compose.',
      title: 'The command is published, reliably',
      text: 'A poller reads committed outbox rows and publishes them to deployment.commands, keyed by the deployment id. Same key, same partition, so every message about this deployment stays in order.',
      tags: ['kf-outbox', 'kf-partitions'] },
    { bay: 'task', state: 'VALIDATING', tone: 'flight', status: 'planned', now: 'Planned for S4.',
      title: 'task-service takes the work once, in effect',
      text: 'Kafka may deliver the same command twice. task-service records the idempotency token in the same transaction as the task, acknowledges only after it commits, and attaches a retry policy with backoff and jitter.',
      tags: ['kf-idempotent-consumer', 'kf-retry', 'pg-skiplocked'] },
    { bay: 'agent', state: 'DEPLOYING', tone: 'flight', status: 'progress', now: 'Container runtimes are built on a branch. The lease and fencing come in S5.',
      title: 'The agent holding the node\'s lease runs it',
      text: 'task.work reaches the node-agent that holds the Redis lease for the node. Its fencing token goes on every write, so an agent that was paused and lost its lease cannot overwrite newer state. Configuration picks the container runtime.',
      tags: ['rd-lease', 'rd-heartbeat', 'sp-autoconfig'] },
    { bay: 'kafka', state: 'HEALTHY', tone: 'healthy', status: 'planned', now: 'Planned for S5 and S6.',
      title: 'Progress flows back as events',
      text: 'TaskStarted, then TaskSucceeded, go to task.events with the fencing token and correlation id in the headers. If a step fails for good, rollback runs as compensating steps, not as a distributed transaction.',
      tags: ['kf-partitions', 'sp-filters', 'kf-retry', 'ar-saga'] },
    { bay: 'query', state: 'HEALTHY', tone: 'healthy', status: 'planned', now: 'Planned for S6.',
      title: 'The read side catches up',
      text: 'query-service applies each event once, updates its read tables, evicts the cached dashboard entry and moves its asOf mark forward. Because the topic keeps the events, it can rebuild every read table from scratch.',
      tags: ['kf-cqrs', 'rd-cache', 'pg-schema'] },
    { bay: 'client', state: 'HEALTHY', tone: 'healthy', status: 'planned', now: 'Planned for S6 and S7.',
      title: 'The dashboard shows it, and says how fresh it is',
      text: 'Dashboard reads never touch the write database. They carry asOf, so a view that is a few seconds behind says so. Each service scales on its own bottleneck, and failures in one dependency are contained.',
      tags: ['kf-cqrs', 'rd-cache', 'ar-split', 'ar-resilience'] }
  ],

  leaves: [
    [['client', 'Idempotency-Key 7f3a…']],
    [['control', 'X-Correlation-Id c-7f3a91d2']],
    [['redis', 'idempotency:v1:deployments:7f3a… in progress']],
    [['control', 'hasPermission(app, deploy)']],
    [['postgres', 'deployment PENDING, version 0'], ['postgres', 'task DEPLOY PENDING'], ['postgres', 'audit_event'], ['postgres', 'outbox_message (S4)']],
    [['client', '202, Location /api/v1/tasks/0192…'], ['redis', 'key completed, kept 24 h']],
    [['kafka', 'deployment.commands, key 0192f3a1']],
    [['task', 'attempt 1, backoff with jitter'], ['kafka', 'task.work, partition 3']],
    [['redis', 'node:lease:stg-node-02, token 4417'], ['agent', 'DockerRuntime.start()']],
    [['kafka', 'task.events TaskSucceeded']],
    [['query', 'deployment_summary updated'], ['redis', 'dashboard cache evicted']],
    [['client', 'asOf 14:02:31, 3 s behind']]
  ],

  mapNodes: [
    { id: 'client', x: 9, y: 50, name: 'Client', sub: 'console, CLI, SDK', kind: 'svc', status: 'planned',
      role: 'Anything that calls the APIs: the planned web console, scripts, and the typed client SDK (S7).',
      rows: [['Talks to', 'identity-service to sign in, control-api to change things, query-service to read.'], ['Rule', 'Writes go to control-api; reads go to query-service. Staleness shows as asOf.']],
      lessons: ['ar-async', 'sp-errors', 'kf-cqrs'] },
    { id: 'identity', x: 31, y: 15, name: 'identity-service', sub: ':8082', kind: 'svc', status: 'planned',
      role: 'Who you are and what you may do in general: users, teams, roles, permissions, tokens.',
      rows: [['Owns', 'User, Role, Permission, Team, RefreshToken, ApiKey, LoginAudit'], ['Bound by', 'CPU: BCrypt is slow on purpose'], ['Scales on', 'CPU and login rate'], ['Ceiling', 'CPU cores']],
      lessons: ['sec-rbac', 'sec-jwt'] },
    { id: 'control', x: 31, y: 50, name: 'control-api', sub: ':8081', kind: 'svc', status: 'built',
      role: 'The write model and the authority on what should be true. Most of what is built today lives here.',
      rows: [['Owns', 'Application, Release, Deployment, Task, AuditEvent, catalogue, outbox'], ['Bound by', 'Request rate and database writes'], ['Scales on', 'Requests per second, p99 latency'], ['Ceiling', 'The database connection pool, not the instance count']],
      lessons: ['pg-fsm', 'pg-optimistic', 'rd-idempotency', 'sp-errors', 'sec-idor'] },
    { id: 'query', x: 31, y: 86, name: 'query-service', sub: ':8085', kind: 'svc', status: 'planned',
      role: 'The read side: tables shaped for each question, built from events, cached in Redis.',
      rows: [['Owns', 'deployment_summary, application_history, fleet_view, task_timeline'], ['Bound by', 'Read rate'], ['Scales on', 'Requests per second and cache hit ratio'], ['Ceiling', 'Redis, then read replicas']],
      lessons: ['kf-cqrs', 'rd-cache', 'pg-schema'] },
    { id: 'kafka', x: 58, y: 50, name: 'Kafka', sub: 'KRaft, topics by domain', kind: 'infra', status: 'planned',
      role: 'Carries commands and events between services. Infrastructure exists in docker compose; no service uses it yet.',
      rows: [['Topics', 'deployment.commands, task.events, deployment.events (3 partitions each), task.work (6), task.work.DLT'], ['Key', 'The aggregate id, so ordering holds per deployment'], ['Guarantee', 'At least once; consumers make it once in effect']],
      lessons: ['kf-partitions', 'kf-outbox', 'kf-idempotent-consumer', 'kf-retry', 'kf-cqrs'] },
    { id: 'task', x: 84, y: 26, name: 'task-service', sub: ':8083, scaled out', kind: 'svc', status: 'planned',
      role: 'Task lifecycle: attempts, retries with backoff and jitter, dead letters, replay.',
      rows: [['Owns', 'Task, Attempt, retry policy'], ['Bound by', 'Queue depth'], ['Scales on', 'Kafka consumer lag'], ['Ceiling', 'Partition count: a 7th consumer on 6 partitions sits idle']],
      lessons: ['kf-idempotent-consumer', 'kf-retry', 'pg-skiplocked', 'sp-scheduled'] },
    { id: 'agent', x: 84, y: 74, name: 'node-agent', sub: ':8084, one per node', kind: 'svc', status: 'progress',
      role: 'Drives containers on one node through a pluggable runtime, and hosts on-demand tool sessions.',
      rows: [['Owns', 'Node lease, container lifecycle, sessions'], ['Bound by', 'Number of nodes'], ['Scales on', 'Nodes per agent'], ['Ceiling', 'Leases are one to one with nodes']],
      lessons: ['rd-lease', 'rd-heartbeat', 'sp-autoconfig'] },
    { id: 'postgres', x: 58, y: 12, name: 'Postgres 16', sub: 'one schema per service', kind: 'infra', status: 'built',
      role: 'One instance, one schema per service. No service reads another service\'s schema.',
      rows: [['Used for', 'Write models, constraints, the outbox, a queue in a table (SKIP LOCKED), read models'], ['Migrations', 'Flyway per service, never edited after commit']],
      lessons: ['pg-constraints', 'pg-pagination', 'pg-skiplocked', 'pg-schema'], links: ['identity', 'control', 'task', 'query'] },
    { id: 'redis', x: 58, y: 88, name: 'Redis 7', sub: 'key prefix per service', kind: 'infra', status: 'built',
      role: 'Not just a cache. Each use answers a different question.',
      rows: [['Used for', 'Idempotency keys (built), rate limit buckets, node leases with fencing, heartbeat sorted set, service registry, read cache, token denylist, login lockout counters']],
      lessons: ['rd-idempotency', 'rd-ratelimit', 'rd-lease', 'rd-heartbeat', 'rd-cache'], links: ['identity', 'control', 'task', 'query', 'agent'] }
  ],

  mapEdges: [
    ['client', 'identity'], ['client', 'control'], ['client', 'query'], ['identity', 'control'],
    ['control', 'kafka'], ['kafka', 'task'], ['kafka', 'agent'], ['kafka', 'query']
  ],

  slices: [
    { id: 'S0', name: 'Skeleton', week: 'Week 2', items: [
      ['built', 'docker compose: Postgres 16, Redis 7, Kafka in KRaft mode, topics created up front (task.work with 6 partitions, task.work.DLT)'],
      ['built', 'Typed, validated @ConfigurationProperties; local, test and prod profiles; actuator locked down'],
      ['built', 'fleet-audit-starter, a home-made auto-configuration', 'sp-autoconfig']] },
    { id: 'S1', name: 'Schema and SQL', week: 'Week 3', items: [
      ['built', '3NF schema with Flyway V1 to V4, constraints in the database', 'pg-constraints'],
      ['built', 'Partial unique index: one active deployment per application and environment', 'pg-constraints'],
      ['built', 'Seed of 1.2 million tasks; composite index measured before and after', 'pg-pagination'],
      ['built', 'Recursive CTE for image lineage'],
      ['planned', 'Window-function report: latest deployment per application per environment'],
      ['planned', 'Deadlock drill and lock-ordering fix']] },
    { id: 'S2', name: 'JPA', week: 'Week 4', items: [
      ['built', 'N+1 built, then fixed three ways', 'pg-nplusone'],
      ['built', '@Version optimistic locking, fail fast with 409', 'pg-optimistic'],
      ['built', 'LazyInitializationException fixed without open-in-view', 'sp-lazy'],
      ['built', '@Transactional self-invocation kept as a disabled test', 'sp-proxy'],
      ['built', 'REQUIRES_NEW audit that survives a rollback; checked-exception rollback rules', 'pg-transactions'],
      ['built', 'Deployment state machine with illegal transitions rejected', 'pg-fsm']] },
    { id: 'S3', name: 'REST and Redis', week: 'Week 5', items: [
      ['built', 'S3.1 One error shape (ProblemDetail) and correlation ids', 'sp-errors'],
      ['built', 'S3.2 Applications and releases with cursor pages'],
      ['built', 'S3.3 Deployments: 202 Accepted, rollback, GET /tasks/{id}', 'ar-async'],
      ['built', 'S3.4 Task history: cursor against offset at page 10,000', 'pg-pagination'],
      ['built', 'S3.5 Idempotency keys in Redis', 'rd-idempotency'],
      ['designed', 'S3.6 Rate limiting with a token bucket per team', 'rd-ratelimit'],
      ['planned', 'S3.7 OpenAPI documentation']] },
    { id: 'S4', name: 'RBAC and the first splits', week: 'Week 6', items: [
      ['planned', 'identity-service: JWT signed RS256, refresh rotation, denylist, lockout', 'sec-jwt'],
      ['planned', 'Scoped grants and role hierarchy', 'sec-rbac'],
      ['planned', 'IDOR built first, then fixed with a PermissionEvaluator', 'sec-idor'],
      ['planned', 'task-service extracted; transactional outbox in control-api', 'kf-outbox'],
      ['planned', 'Idempotent consumer; record and batch listener strategies', 'kf-idempotent-consumer']] },
    { id: 'S5', name: 'node-agent and observability', week: 'Week 7', items: [
      ['progress', 'Pluggable container runtimes: Docker, Simulated, Swarm (built on a branch, no tests yet)', 'sp-autoconfig'],
      ['planned', 'Redis lease with fencing token', 'rd-lease'],
      ['planned', 'Heartbeats in a sorted set; service registry; fleet health indicator', 'rd-heartbeat'],
      ['planned', 'Correlation ids carried across Kafka, and the MDC leak drill', 'sp-filters'],
      ['planned', 'On-demand tool sessions with idle reaping']] },
    { id: 'S6', name: 'Patterns and CQRS', week: 'Week 8', items: [
      ['planned', 'query-service projections with asOf and rebuild from the topic', 'kf-cqrs'],
      ['planned', 'Cache-aside with event-driven eviction; stampede fix', 'rd-cache'],
      ['planned', 'Reaper that fires on every instance, then fixed', 'sp-scheduled'],
      ['planned', 'Rollback as a saga', 'ar-saga'],
      ['planned', 'State pattern refactor; AFTER_COMMIT listener for the denormalised status', 'pg-schema']] },
    { id: 'S7', name: 'Resilience and scale', week: 'Week 9', items: [
      ['planned', 'Timeouts, retries with jitter, circuit breaker, bulkhead', 'ar-resilience'],
      ['planned', 'Dead-letter replay endpoint', 'kf-retry'],
      ['planned', 'Scaling measurements: where each service stops scaling', 'ar-split'],
      ['planned', 'Graceful shutdown under load with zero lost tasks', 'ar-resilience'],
      ['planned', 'Typed client SDK, published and versioned']] },
    { id: 'UI', name: 'Web console', week: 'After the API', items: [
      ['designed', 'React plan in docs/design/ux/web-console-react-plan.md; clickable preview in docs/design/ux/appfleet-ux-preview.html']] }
  ],

  mappingRows: [
    ['One message at a time per entity', 'The actor\'s mailbox', 'A Kafka partition keyed by deployment id: one consumer thread, in order', 'kf-partitions'],
    ['State owned by exactly one writer', 'One actor per entity', 'A node lease with a fencing token: one agent drives one node', 'rd-lease'],
    ['Explicit state machines', 'An FSM inside the actor', 'The Deployment state machine, guarded by @Version', 'pg-fsm'],
    ['Supervision and restart', 'A supervisor strategy', 'Retry policy, dead-letter topic and a reaper, all inspectable as data', 'kf-retry'],
    ['Moving entities between machines', 'Cluster sharding', 'Consumer group rebalancing when workers join or die', 'kf-partitions'],
    ['Backpressure', 'Bounded mailboxes', 'Bounded executors, 202 with polling, and load shedding with 429', 'ar-async']
  ],

  regimes: {
    release: {
      label: 'Which release runs in staging',
      pick: 'Coordinate',
      text: 'Two different releases cannot be merged into one running container. Exactly one writer must win, and the other must be told. Appfleet uses @Version, a partial unique index, partition ordering and fencing tokens so a second writer is refused rather than merged. During a network split it waits rather than accepting both.',
      lessons: ['pg-optimistic', 'rd-lease', 'pg-constraints']
    },
    presence: {
      label: 'Which users have a tool session open',
      pick: 'Converge',
      text: 'Presence changes all the time and two views of it merge cleanly: take the union of sessions seen, remove ones observed ending. A CRDT such as an observed-remove set keeps accepting updates during a split and agrees afterwards. Availability matters more than a single arbiter here.',
      lessons: ['rd-heartbeat']
    },
    counter: {
      label: 'How many deployments ran today',
      pick: 'Either, carefully',
      text: 'A counter can converge (a grow-only counter per replica, summed), but in Appfleet the count is a read-side projection. It is rebuilt from the event log, so the write side never needs to merge anything. Projections must still ignore duplicate events or replays double the count.',
      lessons: ['kf-cqrs']
    }
  },

  questions: [
    ['Why not event sourcing?', 'The write side stays a normal database, and the read side is a projection that can be rebuilt from Kafka. That gives most of the read-scaling benefit without making every write path replay history. CQRS does not require event sourcing.', 'kf-cqrs'],
    ['Why fail closed for idempotency but open for rate limiting?', 'If Redis is down and the idempotency check is skipped, a retry can deploy twice: wrong and expensive, so the API answers 503. If the rate limiter is skipped, some team gets more requests than its share for a while: cheap, so requests go through. Same Redis, opposite answers, because the cost of being wrong differs.', 'rd-ratelimit'],
    ['Why answer 404 instead of 403?', 'A 403 confirms the object exists. For a caller who may not see another team\'s application, 404 hides that it exists at all.', 'sec-idor'],
    ['Why fail fast on an optimistic-lock conflict instead of retrying?', 'The second writer decided based on data that is now old. Retrying silently would apply a decision nobody made. The 409 tells the client to re-read and decide again.', 'pg-optimistic'],
    ['Why one Postgres with a schema per service, not a database per service?', 'The boundary that matters is that no service reads another\'s schema. One instance keeps the local setup honest and small. In production the schemas would move to separate databases without code changes.', 'pg-schema'],
    ['Why UUIDv7 and not random UUIDs?', 'UUIDv7 starts with a timestamp, so new ids sort after old ones. Index pages fill in order, and the id itself works as a stable cursor for pagination.', 'pg-pagination'],
    ['Why not a distributed transaction across services?', 'Two-phase commit holds locks in every service until a coordinator decides, and the coordinator becomes a single point of failure. Kafka does not take part in XA transactions anyway. A saga with compensating steps fits better.', 'ar-saga'],
    ['Why not Kubernetes, a service mesh or an API gateway?', 'None of the requirements need them, and each would take weeks without teaching the concepts this project is about. docker compose is enough. Each is a named seam where it would go later.', 'ar-split'],
    ['Why not start with microservices?', 'The system started as one service and splits only when a part needs to scale or fail differently. Each split has a written reason. That is the strangler pattern, applied to its own code.', 'ar-split']
  ],
  };
})();
