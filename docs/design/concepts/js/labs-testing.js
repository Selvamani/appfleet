/*
 * labs-testing.js: the Testing lessons for "How Appfleet works" (group 'testing', orders 1 to 9).
 *
 * One AF.register call per lesson. Every example is a test, a result or a mutation check that exists in
 * control-api or its design docs as of 2026-10-05; numbers come from surefire reports and the Results
 * sections. Anything that was not measured is labelled as such in the UI.
 */
(function () {
  'use strict';

  const h = AF.h;
  const ui = AF.ui;
  const SVGNS = 'http://www.w3.org/2000/svg';

  // ---------- shared helpers (identical in labs-spring-2.js and labs-testing.js) ----------

  /** SVG element builder (AF.h creates HTML elements only). */
  function s(tag, attrs, ...kids) {
    const el = document.createElementNS(SVGNS, tag);
    if (attrs) {
      Object.keys(attrs).forEach(k => {
        const v = attrs[k];
        if (v === null || v === undefined || v === false) return;
        if (k === 'style') Object.assign(el.style, v);
        else el.setAttribute(k, String(v));
      });
    }
    (function add(list) {
      list.forEach(k => {
        if (k === null || k === undefined || k === false) return;
        if (Array.isArray(k)) add(k);
        else if (k instanceof Node) el.appendChild(k);
        else el.appendChild(document.createTextNode(String(k)));
      });
    })(kids);
    return el;
  }

  const controls = (...kids) => h('div', { class: 'sim-controls' }, kids);
  const stage = (...kids) => h('div', { class: 'sim-stage' }, kids);
  const readouts = (...items) => h('div', { class: 'readouts' }, items.map(r => r.el));
  const note = text => h('p', { class: 'muted small' }, text);
  const label = text => h('span', { class: 'small muted' }, text);
  const setCode = (pre, text) => { pre.firstChild.textContent = text; };
  const setLabel = (readout, text) => { readout.el.firstChild.textContent = text; };
  const fmt = v => Number(v).toLocaleString('en-US');
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));
  const pace = (ctx, ms) => AF.sleep(ctx, ctx.reducedMotion ? Math.min(ms, 90) : ms);


  // =====================================================================
  // Testing 1. Unit, slice or full context
  // =====================================================================
  AF.register({
    id: 'te-pyramid',
    group: 'testing',
    order: 1,
    title: 'Unit, slice or full context: the cheapest test that can fail',
    question: 'Why does Appfleet have a 0.02-second test for TeamAccess and a test class that needs real containers for rate limiting, and how do you choose?',
    status: 'built',
    slice: 'S0 to S4.5',
    where: [
      'control-api/src/test/java/io/appfleet/control/security/TeamAccessTest.java (13 tests, no Spring)',
      'control-api/src/test/java/io/appfleet/control/ratelimit/RateLimitInterceptorTest.java (Mockito), web/CursorCodecTest.java',
      'control-api/src/test/java/io/appfleet/control/web/ProblemShapeTest.java (@WebMvcTest with excludeFilters)',
      'control-api/src/test/java/io/appfleet/control/web/WebIntegrationTest.java (@SpringBootTest + MockMvc + Postgres + Redis), web/JwtAuthenticationTest.java (RANDOM_PORT)',
      'control-api/target/surefire-reports/*.txt; docs/design/control-api/control-api-s3-1-foundations.md (section 5), control-api-s3-6-rate-limiting.md'
    ],
    idea: [
      'A test is a claim plus a place to check it. The cheapest place is a plain object: new it up, call a method, assert. The next is a slice such as @WebMvcTest, where Spring builds only the web layer. Then the full context: @SpringBootTest with MockMvc and real containers, and last a real HTTP server on a random port. Each step up sees more of the system and costs more seconds, so the rule is to put each claim at the cheapest level that can still fail for the right reason, and to know what that level cannot see.',
      'Appfleet uses all four. TeamAccessTest has 13 tests and no Spring; its surefire line reads 0.021 s. RateLimitInterceptorTest uses Mockito for the limiter (5 tests, 0.173 s), and CursorCodecTest is pure code (3 tests, 0.001 s). ProblemShapeTest is a @WebMvcTest slice (31 tests, 0.246 s) with a probe controller; it needed excludeFilters for RateLimitInterceptor and WebConfig because a slice also picks up HandlerInterceptor and WebMvcConfigurer beans, and those want a TeamResolver and a RateLimiter. Endpoint tests extend WebIntegrationTest (real Postgres and Redis through MockMvc), and JwtAuthenticationTest runs a real server (21 tests, 3.052 s).',
      'What each level cannot see is the whole point. A unit test never proves the wiring. A slice does not apply the security chain, so in S3.1 19 green slice tests never showed that every endpoint would be 401 to a real client. MockMvc has no Tomcat, so container-level behaviour is invisible to it. And the first test class in a JVM that needs containers pays for starting them: BaseImageLineageTest shows 6.987 s for 3 tests, OutboxMessageTest 7.224 s for 1, while later classes sharing the same containers show 0.013 s (ApplicationOwnerIndexTest) to 0.873 s (CrossTeamMatrixTest, 23 tests). The cost is paid once, not per test.'
    ],
    terms: [
      ['Unit test', 'No Spring context. Construct the object, pass fakes or Mockito mocks, assert on the result. TeamAccessTest and CursorCodecTest are examples.'],
      ['Web slice', '@WebMvcTest builds only the MVC layer: controllers, advice, filters, plus HandlerInterceptor and WebMvcConfigurer beans. No database, and no security chain unless you add it.'],
      ['excludeFilters', 'A component-scan filter on a slice test that keeps named beans out. ProblemShapeTest excludes RateLimitInterceptor and WebConfig.'],
      ['Full context', '@SpringBootTest with the whole application, real Postgres and Redis containers, and MockMvc to send requests without a server.'],
      ['Real HTTP', '@SpringBootTest(webEnvironment = RANDOM_PORT) and a real HTTP client. The only level that sees Tomcat.']
    ],
    tryIt: [
      'Pick "A permission rule for a team" and click each level under "Test level". Unit and MockMvc can fail for the right reason; the slice shows "no" because it has no security chain.',
      'Pick "A jsonb column mapping" and walk the four levels: only a level with a real Postgres can fail. The measured cost is 7.224 s because that class started the containers.',
      'Pick "A pure cursor encoder" at "MockMvc with containers": it can fail, but you pay the container start for something CursorCodecTest checks in 0.001 s.',
      'Pick "A 401 from a real bearer token over HTTP" and compare "Slice" with "Real HTTP". The slice never ran the security chain.',
      'Watch the "Cheapest level that works" readout change per claim; the rule is to write the test there.'
    ],
    breakIt: 'Put every claim at the top level. Nothing is missed, but the suite grows by seconds with every class that needs its own context, a failure points at the whole stack instead of at one method, and people stop running it. The opposite break is just as real: test the 401 in a slice. It goes green, and S3.1 recorded that 19 green slice tests never showed the real security chain.',
    say: 'I put each claim at the cheapest level that can still fail for the right reason: TeamAccess in a 13-test unit class that takes 0.021 s, the problem shape in a @WebMvcTest slice, the jsonb mapping and constraint names against real Postgres, and the bearer-token 401 over a real HTTP server, because each level has things the cheaper one cannot see.',
    quiz: {
      q: 'In S3.1 the 19 ProblemShapeTest slice tests were green, yet no real client could have called any endpoint. Why?',
      options: [
        'The probe controller used the wrong content type',
        'The @WebMvcTest slice does not apply the security chain, so the missing authentication was invisible to it',
        'Mockito had replaced the database',
        'The slice ran on a random port that was blocked'
      ],
      answer: 1,
      why: 'Spring Security was active with its defaults and answered 401 to everything outside /actuator/health, but the slice had no security configuration, so nothing in it could fail. The fix was a test at a higher level: TemporaryOpenChainTest on a real server, later JwtAuthenticationTest.'
    },
    mount(el, ctx) {
      // Every number below is a line from control-api/target/surefire-reports (class, tests, seconds).
      // "no such test" means Appfleet has no test of that kind for that claim; the lab says so instead of inventing one.
      const LEVELS = [
        { value: 'unit', label: 'Unit (no Spring)' },
        { value: 'slice', label: 'Slice (@WebMvcTest)' },
        { value: 'mvc', label: 'MockMvc with containers' },
        { value: 'http', label: 'Real HTTP (RANDOM_PORT)' }
      ];
      const LNAME = { unit: 'a unit test', slice: 'a web slice', mvc: 'MockMvc with containers', http: 'a real HTTP server' };
      const CLAIMS = {
        perm: {
          label: 'A permission rule for a team',
          code: "// TeamAccessTest.permissionHeldOnlyForAnotherTeam_isDenied\ntoken(claims with team B holding application:read);\nassertThat(access.has(\"application:read\", teamA)).isFalse();",
          best: 'Unit: TeamAccessTest, 13 tests, 0.021 s',
          unit: { tone: 'ok', cls: 'TeamAccessTest', tests: 13, sec: 0.021, text: 'Yes. TeamAccess reads the Jwt from the SecurityContext, so a 13-test class with a hand-built token covers every rule (other team, other permission, global perm, malformed claims). It cannot see whether a controller actually asks TeamAccess.' },
          slice: { tone: 'bad', cls: null, text: 'No. The slice has no security chain and no JWT, so there is nothing for the rule to read. No slice test of this exists in Appfleet.' },
          mvc: { tone: 'warn', cls: 'ObjectAuthorizationTest', tests: 14, sec: 0.476, text: 'Yes, and it proves the wiring: a request with a token for team B gets a problem body for team A’s object. It misses nothing the rule needs, but a failure points at the whole stack.' },
          http: { tone: 'warn', cls: 'JwtAuthenticationTest', tests: 21, sec: 3.052, text: 'It can fail, but this class is about token validation. The team rule adds nothing a MockMvc test does not already show, at the highest cost.' }
        },
        shape: {
          label: 'The problem JSON shape',
          code: "// ProblemShapeTest, @WebMvcTest + probe controller\nmockMvc.perform(get(\"/probe/not-found\"))\n  .andExpect(jsonPath(\"$.type\").value(\"urn:appfleet:problem:not-found\"));",
          best: 'Slice: ProblemShapeTest, 31 tests, 0.246 s',
          unit: { tone: 'warn', cls: null, text: 'You could call a handler method on ApiExceptionHandler directly, but that skips the servlet filter that adds the correlation id and the real content negotiation. No such unit test exists in Appfleet.' },
          slice: { tone: 'ok', cls: 'ProblemShapeTest', tests: 31, sec: 0.246, text: 'Yes. The probe controller throws each exception, the real ApiExceptionHandler and CorrelationIdFilter turn it into problem+json, and no database is needed. It cannot see the security chain, so 401 and 403 bodies are not covered here.' },
          mvc: { tone: 'warn', cls: 'PermissionEnforcementTest', tests: 27, sec: 0.168, text: 'Yes, and it includes the security chain (forbidden_onARealEndpoint_hasProblemShape asserts type, status and correlationId). Worth keeping for 401 and 403, not for every exception.' },
          http: { tone: 'warn', cls: 'JwtAuthenticationTest', tests: 21, sec: 3.052, text: 'Yes (noToken_is401_withProblemShape reads the header and the body from a real response), but it is the slowest way to check a JSON field.' }
        },
        unique: {
          label: 'A unique constraint under concurrency',
          code: "// RealConstraintNamesTest\nrepo.save(new Application(name, \"d\", team));\nassertThat(constraintName(thrown)).isEqualTo(\"uq_application_name\");",
          best: 'Containers: RealConstraintNamesTest, 2 tests, 1.975 s',
          unit: { tone: 'bad', cls: null, text: 'No. A unit test has no database, and a constraint is exactly the guard that lives in the database.' },
          slice: { tone: 'bad', cls: null, text: 'No. The slice has no database (S3.1 chose it for that reason).' },
          mvc: { tone: 'ok', cls: 'RealConstraintNamesTest', tests: 2, sec: 1.975, text: 'Yes. Real Postgres reports uq_application_name and uq_deployment_active_per_app_env. That test saves sequentially; the race itself is not in these reports, but only a real database can arbitrate it. MockMvc adds the 409 mapping on top.' },
          http: { tone: 'warn', cls: 'JwtAuthenticationTest', tests: 21, sec: 3.052, text: 'It could fail the same way, but no Appfleet test does this over HTTP, and it adds only Tomcat to a database question.' }
        },
        jsonb: {
          label: 'A jsonb column mapping',
          code: "// OutboxMessageTest\nrepository.saveAndFlush(new OutboxMessage(id, \"{...}\"));\n// ERROR: column \"payload\" is of type jsonb but expression is of type character varying",
          best: 'Containers: OutboxMessageTest, 1 test, 7.224 s (it started the containers)',
          unit: { tone: 'bad', cls: null, text: 'No. Hibernate never talks to Postgres in a unit test, so a String bound as varchar is never refused.' },
          slice: { tone: 'bad', cls: null, text: 'No. The slice has no JPA and no database.' },
          mvc: { tone: 'ok', cls: 'OutboxMessageTest', tests: 1, sec: 7.224, text: 'Yes, and it failed red before @JdbcTypeCode(SqlTypes.JSON): "column payload is of type jsonb but expression is of type character varying". The 7.224 s is mostly container and context start; later classes in the same JVM reuse them.' },
          http: { tone: 'warn', cls: null, text: 'It would fail the same way, but no Appfleet test goes through a real server for this, and the HTTP layer adds nothing to a column-type question.' }
        },
        bearer: {
          label: 'A 401 from a real bearer token over HTTP',
          code: "// JwtAuthenticationTest, RANDOM_PORT\nvar r = getWithToken(APPS, user().wrongKey().sign());\nassertThat(challenge(r)).contains(\"invalid_token\");",
          best: 'Real HTTP: JwtAuthenticationTest, 21 tests, 3.052 s',
          unit: { tone: 'warn', cls: 'ProblemAuthenticationEntryPointTest', tests: 6, sec: 0.012, text: 'It checks what the entry point writes (6 tests, 0.012 s in common-security), but not that the chain calls it for a bad token.' },
          slice: { tone: 'bad', cls: 'ProblemShapeTest', tests: 31, sec: 0.246, text: 'No. The slice does not apply the security chain; ProblemShapeTest cannot fail on a bad token.' },
          mvc: { tone: 'ok', cls: 'PermissionEnforcementTest', tests: 27, sec: 0.168, text: 'Mostly. MockMvc runs the real filter chain (S3.2 logged 66 Securing lines), so status and problem body are real. It has no Tomcat, so the container-level cases are out of reach.' },
          http: { tone: 'ok', cls: 'JwtAuthenticationTest', tests: 21, sec: 3.052, text: 'Yes. A real server, a real HTTP client, the real WWW-Authenticate header, and paths no controller handles (an unknown path is 401 without a token, 403 with one).' }
        },
        cursor: {
          label: 'A pure cursor encoder',
          code: "// CursorCodecTest\nassertThat(CursorCodec.decode(CursorCodec.encode(id))).isEqualTo(id);\nassertThatThrownBy(() -> CursorCodec.decode(\"???\")).isInstanceOf(InvalidCursorException.class);",
          best: 'Unit: CursorCodecTest, 3 tests, 0.001 s',
          unit: { tone: 'ok', cls: 'CursorCodecTest', tests: 3, sec: 0.001, text: 'Yes. Encode, decode, malformed and non-UUID input are all plain method calls. It cannot see how the endpoint uses the cursor.' },
          slice: { tone: 'warn', cls: 'ProblemShapeTest', tests: 31, sec: 0.246, text: 'It can fail, but you pay for a Spring slice to check a static method. The number shown is a slice class that exists, not a cursor test.' },
          mvc: { tone: 'warn', cls: 'ApplicationPaginationTest', tests: 9, sec: 0.280, text: 'The endpoint test proves the cursor works through the API, which is a different claim. As a check on the encoder alone it is slower and blurrier.' },
          http: { tone: 'warn', cls: null, text: 'It can fail, but nothing is gained over the unit test, and no Appfleet test does this over HTTP.' }
        }
      };

      const verdict = ui.verdict();
      const rCan = ui.readout('Can fail for the right reason?');
      const rCost = ui.readout('Measured cost');
      const rBest = ui.readout('Cheapest level that works');
      const codeBox = ui.code('', 'The claim as a test');
      const seeLine = h('p', { class: 'small' });
      let shown = 'no such test';
      const costBar = ui.bar({ label: 'Seconds (root scale)', max: Math.sqrt(8), value: 0, format: () => shown });

      const claim = ui.choice('Claim', Object.keys(CLAIMS).map(k => ({ value: k, label: CLAIMS[k].label })), 'perm', update);
      const level = ui.choice('Test level', LEVELS, 'unit', update);

      function update() {
        const C = CLAIMS[claim.get()];
        const cell = C[level.get()];
        setCode(codeBox, C.code);
        const can = cell.tone === 'ok' ? 'Yes' : cell.tone === 'bad' ? 'No' : 'Yes, but not worth it';
        rCan.set(can, cell.tone === 'bad' ? 'bad' : cell.tone);
        rBest.set(C.best.split(':')[0]);
        if (cell.cls && cell.sec !== undefined) {
          shown = cell.cls + ': ' + cell.tests + ' tests, ' + cell.sec + ' s';
          costBar.set(Math.sqrt(cell.sec), cell.tone === 'bad' ? 'warn' : cell.tone);
          rCost.set(cell.sec + ' s', cell.tone === 'bad' ? 'warn' : null);
        } else {
          shown = 'no such test';
          costBar.set(0);
          rCost.set('no such test');
        }
        seeLine.textContent = 'Cheapest working placement: ' + C.best + '.';
        verdict.set(cell.tone, LNAME[level.get()].charAt(0).toUpperCase() + LNAME[level.get()].slice(1) + ' for "' + C.label.toLowerCase() + '". ' + cell.text);
      }

      el.append(
        controls(claim.el, level.el),
        stage(h('div', { class: 'sim-cols' },
          ui.panel('The claim', codeBox),
          ui.panel('What it costs', costBar.el, seeLine))),
        readouts(rCan, rCost, rBest),
        note('Costs are the Time elapsed lines in control-api/target/surefire-reports (and common-security for ProblemAuthenticationEntryPointTest), quoted as class, test count and seconds. They are per class, not per test, and the first container class in a JVM includes starting Postgres and Redis. Where the lab says "no such test", Appfleet has none and no number is shown.'),
        verdict.el
      );
      update();
    }
  });

  // =====================================================================
  // Testing 2. Real Postgres, Redis and Kafka in tests
  // =====================================================================
  AF.register({
    id: 'te-testcontainers',
    group: 'testing',
    order: 2,
    title: 'Real Postgres, Redis and Kafka in tests',
    question: 'Why does every web test start real containers instead of an in-memory database, and what did that catch that H2 never would have?',
    status: 'built',
    slice: 'S2 to S4.5',
    where: [
      'control-api/src/test/java/io/appfleet/control/web/WebIntegrationTest.java (static block, Startables.deepStart, @ServiceConnection)',
      'control-api/src/test/java/io/appfleet/control/web/RealConstraintNamesTest.java (per-class @Container), outbox/OutboxMessageTest.java, outbox/OutboxIndexTest.java, web/ApplicationOwnerIndexTest.java',
      'pom.xml (testcontainers.version 1.21.4, argLine -Duser.timezone=UTC)',
      'docs/design/control-api/control-api-s3-3-deployments.md (section on currentSchema), control-api-s4-5-outbox.md (section 9.1), control-api-s2-service-layer-tests.md'
    ],
    idea: [
      'Testcontainers starts a real Docker container for a test, and Spring Boot’s @ServiceConnection turns that container into the application’s datasource or Redis connection, with no URL to copy by hand. The point is that production runs Postgres 16 and Redis 7, so tests run the same images. An in-memory database such as H2 is a different engine with its own SQL, types and error messages, so a test that passes on it can say nothing about Postgres.',
      'Appfleet starts one Postgres and one Redis per JVM: WebIntegrationTest declares them as static fields and a static block calls Startables.deepStart(postgres, redis).join(), so every subclass reuses them, and Spring caches the application context. RealConstraintNamesTest and a few others use their own per-class @Container instead. Real Postgres caught the jsonb binding error in S4.5 (column "payload" is of type jsonb but expression is of type character varying, OutboxMessageTest, red until @JdbcTypeCode(SqlTypes.JSON)), constraint names such as uq_application_name and the partial index uq_deployment_active_per_app_env, the composite index definitions that ApplicationOwnerIndexTest and OutboxIndexTest read from pg_indexes, and the {h-schema} placeholder that native SQL needs.',
      'It has traps of its own. @ServiceConnection replaces the whole JDBC URL, so the currentSchema=control parameter is dropped and raw JdbcTemplate SQL fails with relation "task" does not exist; the fix is withUrlParam("currentSchema", "control") on the container (S3.3 Results). On this machine Docker Desktop must be running (S3.6 recorded 104 tests and 16 Testcontainers errors without it), the JVM needs -Duser.timezone=UTC because the legacy Asia/Calcutta alias is rejected by recent Postgres images, and Testcontainers 1.20.4 could not talk to this Docker version, so the project uses 1.21.4.'
    ],
    terms: [
      ['Testcontainers', 'A library that starts throwaway Docker containers from tests and stops them afterwards. Needs Docker running.'],
      ['@ServiceConnection', 'A Spring Boot annotation on a container field. Boot reads the container’s host and port and builds the datasource or Redis connection from it.'],
      ['Singleton container', 'One container per JVM, started in a static block of a shared base class. WebIntegrationTest does this with Startables.deepStart.'],
      ['{h-schema}', 'A Hibernate placeholder in native SQL that expands to the configured default schema. Needed because the connection’s own schema is not reliable.'],
      ['pg_indexes', 'A Postgres catalog view holding each index’s definition. ApplicationOwnerIndexTest reads indexdef from it to check (owner_team_id, id).']
    ],
    tryIt: [
      'Leave "Database" on "Real Postgres container", pick "A jsonb column" and keep "Code has the fix" off: you see the real error text. Switch it on and the row turns green.',
      'Switch "Database" to "H2 in memory" for the same feature. The lab says the engine cannot raise this error, and labels it as standard knowledge, not measured here.',
      'Pick "Raw SQL on the test connection" and toggle the fix: relation "task" does not exist becomes a pass once withUrlParam("currentSchema", "control") is on.',
      'Pick "JVM time zone Asia/Calcutta" to see the Postgres connection failure and the argLine that fixes it.',
      'Under "Container lifecycle" switch between "Singleton per JVM" and "One pair per class" and drag "Test classes that need containers" to see how many containers are started.'
    ],
    breakIt: 'Switch "Database" to H2 and run through the list: jsonb, partial index, constraint name and advisory lock all stop being tested against the engine that production uses. Everything stays green and the first real failure arrives in production. That is the case the lab labels "cannot fail for the right reason".',
    say: 'Every web test runs against real Postgres and Redis through Testcontainers with @ServiceConnection, started once per JVM in WebIntegrationTest, because an in-memory database would not have produced the jsonb binding error, the constraint names or the partial index definitions we assert on, and I record machine facts like Docker Desktop running and -Duser.timezone=UTC.',
    quiz: {
      q: 'After switching a test to @ServiceConnection, repository calls worked but JdbcTemplate said relation "task" does not exist. Why?',
      options: [
        'Flyway had not run, so the tables did not exist',
        '@ServiceConnection replaces the datasource URL and drops currentSchema=control; Hibernate still qualifies names with default_schema, raw SQL does not',
        'Redis had taken the table name',
        'Postgres 16 does not allow a table called task'
      ],
      answer: 1,
      why: 'Flyway had created the tables in the control schema, and Hibernate named the schema itself, so repositories worked. Raw SQL used the connection’s default search path. withUrlParam("currentSchema", "control") on the container fixed it, and the same cause is why native queries need {h-schema}.'
    },
    mount(el, ctx) {
      // Postgres cells: errors and results recorded in the S2, S3.3, S3.6 and S4.5 docs and in the test classes.
      // H2 cells: standard knowledge about H2, NOT measured in Appfleet. Each says so on screen.
      const STD = ' (standard H2 behaviour, not measured in Appfleet)';
      const FEATURES = {
        jsonb: {
          label: 'A jsonb column',
          pg: {
            broken: { tone: 'bad', text: 'Red, recorded in S4.5 section 9.1 (OutboxMessageTest.outboxMessage_roundTripsThroughJpa): ERROR: column "payload" is of type jsonb but expression is of type character varying. Hibernate bound the String as varchar.' },
            fixed: { tone: 'ok', text: 'Green with @JdbcTypeCode(SqlTypes.JSON) on the field. The test also reads a jsonb operator on payload in SQL, so the column really holds jsonb.' }
          },
          h2: { tone: 'bad', text: 'H2 has no Postgres jsonb type and would not make Postgres’s varchar-to-jsonb check, so the test could pass or fail for an unrelated reason while production fails.' + STD }
        },
        partial: {
          label: 'A partial unique index',
          pg: {
            broken: { tone: 'ok', text: 'Real Postgres reports the index by name: RealConstraintNamesTest expects uq_deployment_active_per_app_env for a second active deployment of the same app and environment.' },
            fixed: { tone: 'ok', text: 'Same result. Nothing to fix; the test asserts the real constraint name, and the 409 mapping depends on it.' }
          },
          h2: { tone: 'bad', text: 'H2 does not support partial indexes (a CREATE INDEX with a WHERE clause), so the migration and the guard it creates cannot be reproduced.' + STD }
        },
        native: {
          label: 'Native SQL with a schema',
          pg: {
            broken: { tone: 'bad', text: 'Seen in S2: the native lineage query could not find base_image until it was written FROM {h-schema}base_image, because the schema is control, not public.' },
            fixed: { tone: 'ok', text: 'Green with {h-schema}: BaseImageLineageTest, 3 tests, passes on real Postgres.' }
          },
          h2: { tone: 'warn', text: 'H2 would resolve schemas by its own rules, so a missing {h-schema} might never show.' + STD }
        },
        raw: {
          label: 'Raw SQL on the test connection',
          pg: {
            broken: { tone: 'bad', text: 'Seen in S3.3: relation "task" does not exist from JdbcTemplate. @ServiceConnection replaced the JDBC URL and dropped currentSchema=control; Hibernate and Flyway name the schema themselves, so only raw SQL noticed.' },
            fixed: { tone: 'ok', text: 'Green with new PostgreSQLContainer<>("postgres:16").withUrlParam("currentSchema", "control"), as in WebIntegrationTest.' }
          },
          h2: { tone: 'warn', text: 'With H2 the URL is written by hand, so this particular trap (a Testcontainers URL replacing yours) does not exist, and neither does the lesson it taught.' + STD }
        },
        name: {
          label: 'A unique-constraint name',
          pg: {
            broken: { tone: 'ok', text: 'RealConstraintNamesTest: duplicate application name reports uq_application_name; the advice maps constraint names to 409 problems.' },
            fixed: { tone: 'ok', text: 'Same result; there is nothing broken to fix. The name is the contract.' }
          },
          h2: { tone: 'bad', text: 'H2 words violations differently and may name constraints itself, so a mapping keyed on the Postgres name would be tested against the wrong text.' + STD }
        },
        lock: {
          label: 'An advisory lock or SKIP LOCKED',
          pg: {
            broken: { tone: 'idle', text: 'Designed, not built yet: the S4.5 plan (section 5, step 5) puts a native FOR UPDATE SKIP LOCKED query with {h-schema} and an advisory lock in OutboxPoller. No test of it exists in the repository at the time of writing.' },
            fixed: { tone: 'idle', text: 'Designed, not built yet. When it exists it can only be proved on real Postgres.' }
          },
          h2: { tone: 'bad', text: 'H2 has no pg_advisory_lock functions, so the claim cannot be expressed there at all.' + STD }
        },
        crud: {
          label: 'Plain CRUD',
          pg: {
            broken: { tone: 'ok', text: 'Passes on real Postgres: ApplicationEndpointsTest, 13 tests, 2.942 s in the report.' },
            fixed: { tone: 'ok', text: 'Passes. This is the case an in-memory database is good enough for.' }
          },
          h2: { tone: 'ok', text: 'Passes on H2 too. The simple case is not where the engines differ.' + STD }
        },
        tz: {
          label: 'JVM time zone Asia/Calcutta',
          pg: {
            broken: { tone: 'bad', text: 'Seen in S2: the connection failed with invalid value for parameter "TimeZone": "Asia/Calcutta". Recent Postgres images reject the legacy alias.' },
            fixed: { tone: 'ok', text: 'Green with <argLine>-Duser.timezone=UTC</argLine> in the root pom.xml.' }
          },
          h2: { tone: 'warn', text: 'An in-memory database has no server to refuse the alias, so the problem would not appear until a real Postgres is used.' + STD }
        }
      };

      const verdict = ui.verdict();
      const rDb = ui.readout('Engine under test');
      const rOut = ui.readout('Result');
      const rBox = ui.readout('Containers started');
      const boxNote = h('p', { class: 'small' });

      const db = ui.choice('Database', [
        { value: 'pg', label: 'Real Postgres container' },
        { value: 'h2', label: 'H2 in memory' }
      ], 'pg', update);
      const feature = ui.choice('Feature', Object.keys(FEATURES).map(k => ({ value: k, label: FEATURES[k].label })), 'jsonb', update);
      const fix = ui.toggle('Code has the fix', false, update);
      const life = ui.choice('Container lifecycle', [
        { value: 'single', label: 'Singleton per JVM' },
        { value: 'perclass', label: 'One pair per class' }
      ], 'single', update);
      const classes = ui.slider({ label: 'Test classes that need containers', min: 1, max: 20, step: 1, value: 8, onInput: update });

      function update() {
        const F = FEATURES[feature.get()];
        fix.el.style.display = db.get() === 'pg' ? '' : 'none';
        let cell;
        if (db.get() === 'pg') {
          cell = fix.get() ? F.pg.fixed : F.pg.broken;
          rDb.set('postgres:16 (and redis:7)');
        } else {
          cell = F.h2;
          rDb.set('H2, in memory', 'warn');
        }
        rOut.set(cell.tone === 'ok' ? 'passes' : cell.tone === 'bad' ? 'fails or lies' : cell.tone === 'idle' ? 'not built yet' : 'might hide it', cell.tone === 'idle' ? null : cell.tone);
        verdict.set(cell.tone, cell.text);

        const n = classes.get();
        const started = life.get() === 'single' ? 2 : 2 * n;
        rBox.set(started + (life.get() === 'single' ? ' (Postgres + Redis, once)' : ' (' + n + ' pairs)'), life.get() === 'single' ? 'ok' : 'warn');
        boxNote.textContent = life.get() === 'single'
          ? 'WebIntegrationTest: static fields plus Startables.deepStart(postgres, redis).join() run once when the first subclass loads; Spring caches the context. In the reports the first container class shows 6.987 s (BaseImageLineageTest) and a later one 0.013 s (ApplicationOwnerIndexTest).'
          : 'RealConstraintNamesTest does this with @Container and @Testcontainers: its own Postgres and its own context, 2 tests in 1.975 s. Fine for one class, expensive if every class did it. The count here is exact; the seconds are not extrapolated.';
      }

      el.append(
        controls(db.el, feature.el, fix.el, life.el, classes.el),
        stage(h('div', { class: 'sim-cols' },
          ui.panel('Machine facts that matter',
            h('ul', { class: 'small' },
              h('li', null, 'Docker Desktop must be running. Without it S3.6 saw 104 tests and 16 errors: Can’t get Docker image: postgres:16.'),
              h('li', null, 'Testcontainers 1.21.4 (1.20.4 got BadRequestException, Status 400, from NpipeSocketClientProviderStrategy).'),
              h('li', null, '-Duser.timezone=UTC in the root pom argLine.'))),
          ui.panel('Containers for this suite', boxNote))),
        readouts(rDb, rOut, rBox),
        note('Postgres rows quote errors and results recorded in the S2, S3.3, S3.6 and S4.5 docs and test classes. H2 rows are general knowledge about H2 and are labelled "standard H2 behaviour, not measured in Appfleet": the project never ran its tests on H2.'),
        verdict.el
      );
      update();
    }
  });

  // =====================================================================
  // Testing 3. MockMvc and the real security chain
  // =====================================================================
  AF.register({
    id: 'te-mockmvc',
    group: 'testing',
    order: 3,
    title: 'MockMvc and the real security chain',
    question: 'How can a test with no server still get a real 401 and a real 403 problem body, and what can it not see?',
    status: 'built',
    slice: 'S3.1, S4.1, S4.3',
    where: [
      'control-api/src/test/java/io/appfleet/control/web/TestAuth.java (MockMvcBuilderCustomizer defaultAuthorization)',
      'control-api/src/test/java/io/appfleet/control/web/WebIntegrationTest.java, PermissionEnforcementTest.java, JwtAuthenticationTest.java',
      'common-security/src/test/java/io/appfleet/security/testing/TestJwt.java, TestKeys.java (RS256 test key pair)',
      'docs/design/control-api/control-api-s4-1-jwt-validation.md (red run, section 6.1), control-api-s3-2-applications-releases.md (MockMvc runs the real chain)'
    ],
    idea: [
      'MockMvc builds a request and sends it straight to the DispatcherServlet, with no network and no Tomcat. With @SpringBootTest and @AutoConfigureMockMvc the request also passes through the real Spring Security filter chain, so a missing or bad token gets the real 401 and a token without the permission gets the real 403 problem body. S3.2 confirmed this: with FilterChainProxy at DEBUG, three classes logged 66 "Securing GET|POST /api/v1/applications" lines, and an earlier fail-first check saw 401 with the temporary open chain disabled.',
      'Appfleet signs tokens with TestJwt and the RSA key pair in common-security (RS256, validated by the same decoder as production). So that 70 existing mockMvc.perform calls stay about behaviour and not authorization, TestAuth registers a MockMvcBuilderCustomizer that sets defaultRequest with a valid Bearer header carrying every permission. Without it, the S4.1 red run failed 92 and errored 1 of 212 tests with 401. A test that cares about authorization sends its own Authorization header, which replaces the default (PermissionEnforcementTest.send does this with TestAuth.tokenWith and tokenWithout).',
      'What MockMvc cannot see is the server. JwtAuthenticationTest starts the application on RANDOM_PORT and uses a real HTTP client, because the container’s own behaviour only exists there: the WWW-Authenticate challenge as a real client receives it, a path no controller handles being 401 without a token and 403 with one, the actuator and docs paths, and what a real server does with two Authorization headers (the test records it without assuming). MockMvc is the cheap default; real HTTP is for what only the server decides.'
    ],
    terms: [
      ['MockMvc', 'A test client that calls the DispatcherServlet directly, with no port and no Tomcat. With @AutoConfigureMockMvc it still goes through the Spring Security filter chain.'],
      ['MockMvcBuilderCustomizer', 'A bean that adjusts the MockMvc builder. TestAuth uses it to set defaultRequest, so every request carries a default Bearer token.'],
      ['TestJwt', 'A builder in common-security test code that signs tokens: forUser, team(...), perm(...), expired(), wrongKey(), algNone(), and so on.'],
      ['Problem body', 'The application/problem+json answer with type, status, correlationId. 401 is urn:appfleet:problem:unauthorized, 403 is urn:appfleet:problem:forbidden.'],
      ['RANDOM_PORT', 'A SpringBootTest mode that starts the real embedded server on a free port. Needed for anything Tomcat decides.']
    ],
    tryIt: [
      'Set "Token" to "No token", "Transport" to "MockMvc" and switch "Default-token customizer" on, then off: on gives 200 because TestAuth injects a token, off gives the real 401.',
      'Keep the customizer on and pick "Wrong key": the per-request header overrides the default, and the result is 401 with invalid_token.',
      'Pick "Valid, no permissions": 403 with urn:appfleet:problem:forbidden and no WWW-Authenticate header.',
      'Switch "Transport" to "Real HTTP": the customizer no longer has any effect, because it belongs to MockMvc, and the extra assertions list gains the WWW-Authenticate header and Tomcat-level cases.',
      'Read the "Assertions this transport can make" panel for each transport and compare which ones Appfleet actually asserts.'
    ],
    breakIt: 'Turn "Default-token customizer" off with "No token" and MockMvc. That is the S4.1 red run: 92 failed and 1 errored of 222 tests, all with 401, in DeploymentEndpointsTest (24), TaskHistoryEndpointsTest (19), ApplicationEndpointsTest (13) and others, because the tests never said who they were. The 130 that passed never reached the chain.',
    say: 'MockMvc runs the real security filter chain, so I get real 401 and 403 problem bodies without a server, using RS256 tokens from TestJwt and a MockMvcBuilderCustomizer in TestAuth that installs a default token, and I keep one RANDOM_PORT test class for what only Tomcat decides, like the WWW-Authenticate header and unmapped paths.',
    quiz: {
      q: 'Why does TestAuth install a default Authorization header through a MockMvcBuilderCustomizer instead of each test adding its own token?',
      options: [
        'MockMvc cannot send headers per request',
        'The chain is off in MockMvc, so a header is needed to turn it on',
        'Most tests are about behaviour, not authorization, so a default valid token keeps them short, and tests about authorization override it per request',
        'Tokens are only valid when set globally'
      ],
      answer: 2,
      why: 'Once S4.1 turned authentication on, 92 of 212 tests failed with 401 because they sent no token. The default token (all permissions, 12-hour expiry, signed by TestJwt) fixed that in one place, and PermissionEnforcementTest builds its own header with TestAuth.tokenWith or tokenWithout to test the rules.'
    },
    mount(el, ctx) {
      // Outcomes follow JwtAuthenticationTest (real HTTP) and PermissionEnforcementTest (MockMvc).
      // The default-token merge (a per-request header wins over defaultRequest) is standard Spring MockMvc behaviour;
      // PermissionEnforcementTest relies on it.
      const PROBLEM = 'urn:appfleet:problem:';
      const OUT = {
        none: { status: 401, type: PROBLEM + 'unauthorized', www: 'Bearer', tone: 'bad', src: 'JwtAuthenticationTest.noToken_is401_withProblemShape: the challenge is exactly "Bearer", a missing token carries no error=.' },
        expired: { status: 401, type: PROBLEM + 'unauthorized', www: 'Bearer, contains invalid_token', tone: 'bad', src: 'JwtAuthenticationTest.expired_is401, and detailNeverNamesTheFailure: the same detail and challenge as a wrong key, never saying "expired".' },
        wrongKey: { status: 401, type: PROBLEM + 'unauthorized', www: 'Bearer, contains invalid_token', tone: 'bad', src: 'JwtAuthenticationTest.wrongKey_is401_invalidToken. TestJwt signs with TestKeys.OTHER_PRIVATE, a valid RSA key that does not match the public key.' },
        all: { status: 200, type: '(none, success)', www: 'absent', tone: 'ok', src: 'JwtAuthenticationTest.validToken_passes (HTTP, application:read) and every endpoint test through the default token (MockMvc).' },
        noperm: { status: 403, type: PROBLEM + 'forbidden', www: 'absent over HTTP', tone: 'warn', src: 'PermissionEnforcementTest.tokenWithNoPermissions_is403 (MockMvc, GET applications). Over HTTP, JwtAuthenticationTest.forbidden_hasProblemShape checks 403, the forbidden type and no WWW-Authenticate on a test-only endpoint.' }
      };

      const verdict = ui.verdict();
      const rTok = ui.readout('Token actually sent');
      const rStatus = ui.readout('Status');
      const rType = ui.readout('Problem type');
      const rWww = ui.readout('WWW-Authenticate');
      const asserts = h('ul', { class: 'small' });

      const token = ui.choice('Token', [
        { value: 'none', label: 'No token' },
        { value: 'expired', label: 'Expired' },
        { value: 'wrongKey', label: 'Wrong key' },
        { value: 'all', label: 'Valid, all permissions' },
        { value: 'noperm', label: 'Valid, no permissions' }
      ], 'none', update);
      const cust = ui.toggle('Default-token customizer', true, update);
      const transport = ui.choice('Transport', [
        { value: 'mvc', label: 'MockMvc' },
        { value: 'http', label: 'Real HTTP' }
      ], 'mvc', update);

      function assertionList(t) {
        const rows = [
          ['Status code', 'ok', 'asserted in both: status().isForbidden() / r.statusCode()'],
          ['Content-Type application/problem+json', 'ok', t === 'mvc' ? 'content().contentTypeCompatibleWith(...) in PermissionEnforcementTest' : 'asserted in assertUnauthorizedProblem'],
          ['Problem type and correlationId', 'ok', t === 'mvc' ? 'jsonPath("$.type"), jsonPath("$.correlationId")' : 'body(r) plus the X-Correlation-Id header equal to the body value'],
          ['WWW-Authenticate challenge', t === 'http' ? 'ok' : 'idle', t === 'http' ? 'asserted in JwtAuthenticationTest (Bearer, invalid_token, no error_description)' : 'not asserted in Appfleet’s MockMvc tests; ProblemAuthenticationEntryPointTest checks the handler directly. A MockMvc test could read it too (standard behaviour, not done here).'],
          ['Unmapped path: 401 without a token, 403 with one', t === 'http' ? 'ok' : 'idle', t === 'http' ? 'unknownPath_is401WithoutToken_403WithOne, needs the real container error handling' : 'not a MockMvc test in Appfleet; it is asserted over real HTTP'],
          ['Actuator and docs paths, two Authorization headers', t === 'http' ? 'ok' : 'idle', t === 'http' ? 'healthAndInfoAreOpen_otherActuatorDenied, docsPathsAreOpen, twoAuthorizationHeaders_recorded' : 'asserted only over real HTTP in Appfleet']
        ];
        return rows.map(r => h('li', { class: 'is-' + r[1] }, r[0] + ': ' + r[2]));
      }

      function update() {
        const t = transport.get();
        const custOn = cust.get() && t === 'mvc';
        cust.el.style.display = t === 'mvc' ? '' : 'none';
        let eff = token.get();
        let sent;
        if (eff === 'none' && custOn) {
          eff = 'all';
          sent = 'default token injected by TestAuth';
        } else if (eff === 'none') {
          sent = 'no Authorization header';
        } else if (custOn) {
          sent = TOKLABEL(eff) + ' (overrides the default)';
        } else {
          sent = TOKLABEL(eff);
        }
        const o = OUT[eff];
        rTok.set(sent);
        rStatus.set(o.status, o.tone === 'bad' ? 'bad' : o.tone);
        rType.set(o.type);
        rWww.set(t === 'mvc' ? o.www + ' (not asserted in MockMvc tests)' : o.www);
        AF.clear(asserts);
        assertionList(t).forEach(li => asserts.appendChild(li));
        let msg = o.src;
        if (token.get() === 'none' && custOn) msg = 'The customizer turned "no token" into a valid one, so the request is 200. This is on purpose: 70 mockMvc.perform calls stay about behaviour. Switch the customizer off to see the real 401 (the S4.1 red run: 92 failed and 1 errored of 222). ' + o.src;
        if (token.get() === 'none' && !custOn && t === 'mvc') msg = 'Real 401 with a real problem body from the real chain, no server needed. This is the S4.1 red run: 92 failed and 1 errored of 222 tests. ' + o.src;
        if (eff === 'noperm' && t === 'http') msg = 'Same chain over a real server. Appfleet’s HTTP 403 test uses a different endpoint, so this exact request is not run over HTTP; the status is the same rule (standard expectation, not measured for this request). ' + o.src;
        verdict.set(o.tone, msg);
      }
      function TOKLABEL(k) {
        return { none: 'none', expired: 'expired token', wrongKey: 'wrong-key token', all: 'valid token, all permissions', noperm: 'valid token, no permissions' }[k];
      }

      el.append(
        controls(token.el, cust.el, transport.el),
        stage(h('div', { class: 'sim-cols' },
          ui.panel('Assertions this transport can make', asserts),
          ui.panel('Where tokens come from',
            ui.code("TestJwt.forUser(sub)\n  .team(TEAM, \"application:read\")\n  .expiresIn(Duration.ofHours(12))\n  .sign();      // RS256, TestKeys.PRIVATE\n\n// TestAuth.defaultAuthorization()\nbuilder.defaultRequest(get(\"/\")\n  .header(AUTHORIZATION, \"Bearer \" + defaultToken()));", 'Token builder and the default request')))),
        readouts(rTok, rStatus, rType, rWww),
        note('Outcomes come from JwtAuthenticationTest (21 tests over real HTTP) and PermissionEnforcementTest (27 tests through MockMvc). The rule that a per-request header replaces the default request header is standard Spring MockMvc behaviour that PermissionEnforcementTest relies on; it was not measured separately.'),
        verdict.el
      );
      update();
    }
  });


  // ===== Testing, fragment B: te-redfirst (4), te-fixtures (5), te-assertj (6) =====

  AF.register({
    id: 'te-redfirst',
    group: 'testing',
    order: 4,
    title: 'Red first: a test that has never failed proves nothing',
    question: 'How do you know a green test can actually go red, and what did the red runs in this project catch that reading the code would not?',
    status: 'built',
    slice: 'S3.3 to S4.5',
    where: [
      'docs/design/control-api/control-api-s4-4-idor.md, sections 9.1, 9.5 and 9.6 (red run, mutation table, stale class trap)',
      'docs/design/control-api/control-api-s4-3-method-security.md, sections 9.1, 9.2 and 9.4; control-api-s4-2-principal.md, section 9',
      'docs/design/control-api/control-api-s4-5-outbox.md, sections 9.1 and 9.2 (the jsonb error, the wrong prediction)',
      'control-api/src/test/java/io/appfleet/control/web/ObjectAuthorizationTest.java, CrossTeamMatrixTest.java, PermissionEnforcementTest.java; security/TeamAccessTest.java; outbox/OutboxMessageTest.java'
    ],
    idea: [
      'A test that has never failed has not shown that it can. It might assert something that is always true, run against code that already behaves, or fail for a reason that has nothing to do with the behaviour you care about. So the method used from S3 to S4.5 has two halves. Red first: write the test, run it against the current code, and read why it fails (it must fail on the missing behaviour, not on a typo or a setup error). Then, after the fix turns it green, mutation checks: copy the repository to a scratch directory, break the fix one change at a time, and confirm that the test written for that change goes red.',
      'The red runs in the docs are specific. S4.4 wrote the 14 tests of ObjectAuthorizationTest against the S4.3 code: 12 red, 2 green, and every denial the doc promised was a success (a 202 where 422 was required, a 200 where 404 was). Test 10 was an error, not a failure, because the foreign body had no $.detail; that was red for the right reason through the wrong mechanism, so the helper was made tolerant. S4.3 had two red runs, 15 failures with no enforcement and 14 with the annotations but no @EnableMethodSecurity; the one-test difference (test 6, the annotation-presence check) is why behaviour tests exist as well. S4.5 ran OutboxMessageTest without @JdbcTypeCode(SqlTypes.JSON) and got the real error: column "payload" is of type jsonb but expression is of type character varying. Reading the entity would not have told anyone whether a String binds to jsonb.',
      'Red first has traps, and four are recorded. A prediction can be wrong: S4.5 predicted rejectedRequests_writeNoMessage would be green for the wrong reason, and it was red, because its last step asserts exactly one row. A mutation can hit more than you meant: in S4.3 mutation (a) the three methods shared the same annotation line, so three rows changed, not one. A stale compiled class can fake a failure: in S4.4 section 9.6 the restored source kept its old timestamp, Maven said "Nothing to compile", and a mutation from the previous run stayed active. And a mutation table only shows that these tests catch these breaks; S4.2 test 5 was never seen red on its own, and the doc says the write-before-fix order cannot be proved from the working tree.'
    ],
    terms: [
      ['Red first', 'Run the new test against the current code and confirm it fails, and fails for the reason you predicted, before writing the fix.'],
      ['Red for the wrong reason', 'The test fails, but on a typo, a missing fixture or a thrown exception instead of the behaviour under test. It proves nothing yet.'],
      ['Mutation check', 'Break the fix on purpose, one change at a time, on a scratch copy, and watch the matching test go red. If none does, the test is not guarding that change.'],
      ['Scratch copy', 'The repository copied without target and run through the reactor, so the real files and ~/.m2 are never touched.'],
      ['Stale class', 'A compiled class from an earlier mutation that Maven did not rebuild, because the restored source kept its old timestamp.']
    ],
    tryIt: [
      'Pick the Mutation "S4.4 (a) owner check removed from GET /tasks/{id}": exactly 1 of 27 tests fails, the one written for it. The other 26 stay green, and that is the point.',
      'Pick "S4.4 (b) the flattening bug put back": 13 tests fail across two suites, because the original bug is caught by both the integration tests and the unit table.',
      'Pick "S4.3 (a) wrong permission on three shared lines": 7 of 27 fail, because three methods carried the identical annotation line.',
      'Pick "S4.4 (h) matrix row deleted (test file only)" and switch on "Only a test file changed since the last run": a second failure appears that the mutation did not cause.',
      'With that toggle still on, switch on "Touch the restored file first": the false failure disappears and 1 of 21 remains.'
    ],
    breakIt: 'Leave the restored source with its old timestamp after a mutation, and then change only a test file. Maven reports "Nothing to compile" for main, the mutated class from the previous run is still on the classpath, and a clean test fails for a reason that is not in the code you are looking at. In the lab this is the "Only a test file changed since the last run" switch with "Touch the restored file first" off. Touching every restored file before the next run is the rule the S4.4 doc adopted.',
    say: 'I write the test first and read why it is red, then after the fix I break it one change at a time on a scratch copy; in S4.4 each of five mutations was caught by exactly the test written for it, and the one time a run looked wrong it was a stale compiled class, not the code.',
    quiz: {
      q: 'In S4.4 section 9.6, the run for mutation (h) also showed the rollback row of the matrix failing, though (h) only deleted a row from the test table. What was the cause?',
      options: [
        'Deleting a table row also deletes the rollback endpoint from the controller',
        'Stale compiled output: mutation (g) had changed main code, its source was restored with the old timestamp, and Maven reported "Nothing to compile", so the mutated class stayed',
        'The rollback test is flaky and fails one run in ten',
        'The matrix test shares a Postgres container with the other classes and read their rows'
      ],
      answer: 1,
      why: 'Source restored with its old timestamp looks unchanged to Maven. The clean rerun, with the restored file touched, failed only the meta-check theTableCoversEveryApiHandler, which is 1 of 21.'
    },
    mount(el, ctx) {
      // Every count and test name below is copied from the Results sections of the S4.3 and S4.4 docs (see where).
      const PERM = 'PermissionEnforcementTest';
      const OBJ = 'ObjectAuthorizationTest';
      const TA = 'TeamAccessTest';
      const MX = 'CrossTeamMatrixTest';
      const MUTS = {
        s43a: {
          label: 'S4.3 (a) wrong permission, 3 shared lines',
          where: 'S4.3 section 9.4',
          target: 'DeploymentController (main code)',
          change: '// DeploymentController, three methods share one annotation line:\n// deployment:read replaced by deployment:create\n// GET /deployments/{id}, /tasks and /tasks/by-offset all change, not one.',
          main: true,
          suites: [{ name: PERM, total: 27, n: 7, names: ['test 6: the table of operations no longer matches the annotations', 'test 1 rows 7, 9, 10: a token that holds deployment:create now passes', 'test 2 rows 7, 9, 10: a token with only deployment:read is refused'] }],
          verdict: 'Seven of 27. The mutation changed three methods because their annotation lines were identical, so three rows fail in each kind of test. The wrong permission is caught by the meta-test and by both behaviour tests, which is what the matrix is for.'
        },
        a: {
          label: 'S4.4 (a) owner check removed from GET /tasks/{id}',
          where: 'S4.4 section 9.5',
          target: 'TaskService.get (main code)',
          change: '// TaskService.get(id)\n// the owner check is removed;\n// the task is returned to any caller who holds the permission.',
          main: true,
          suites: [{ name: OBJ, total: 14, n: 1, names: ['reader_ofTeamA_cannotRead_teamBsTaskHistory_orTask'] }, { name: TA, total: 13, n: 0, names: [] }],
          verdict: 'One of 14 ObjectAuthorizationTest, none of 13 TeamAccessTest. The unit table cannot see a missing call to TeamAccess; only the endpoint test that asks for team B’s task from team A can.'
        },
        b: {
          label: 'S4.4 (b) the flattening bug put back',
          where: 'S4.4 section 9.5',
          target: 'TeamAccess.allows (main code)',
          change: '// TeamAccess.allows\n// returns true if ANY team grants the permission,\n// instead of the object’s own team (the S4.3 flattening).',
          main: true,
          suites: [
            { name: OBJ, total: 14, n: 10, names: ['10 tests: every exploit test except the two list tests (8, 14) and the two green pins (12, 13)'] },
            { name: TA, total: 13, n: 3, names: ['permissionHeldOnlyForAnotherTeam_isDenied', 'aDifferentPermissionForTheObjectsTeam_isDenied', 'require_throws… (name abbreviated in the doc)'] }
          ],
          verdict: '13 failures across two suites. The original bug is caught by the integration tests and by the unit table, which is the double coverage the doc wanted for it.'
        },
        c: {
          label: 'S4.4 (c) rollback owner check after the state checks',
          where: 'S4.4 section 9.5',
          target: 'DeploymentService.requestRollback (main code)',
          change: '// DeploymentService.requestRollback\n// the owner check moves after the state checks:\n// a foreign, already rolled-back deployment now answers 409, not 404.',
          main: true,
          suites: [{ name: OBJ, total: 14, n: 1, names: ['ownerCheck_runsBeforeStateChecks'] }, { name: TA, total: 13, n: 0, names: [] }],
          verdict: 'One of 14. Only the test that sets up a foreign ROLLED_BACK deployment sees the ordering: the 409 would reveal that the object exists.'
        },
        d: {
          label: 'S4.4 (d) list filter dropped',
          where: 'S4.4 section 9.5',
          target: 'ApplicationService.list (main code)',
          change: '// ApplicationService.list\n// if (true) for the global branch:\n// the list is no longer filtered by the caller’s teams.',
          main: true,
          suites: [{ name: OBJ, total: 14, n: 2, names: ['list_showsOnlyTheCallersTeams', 'callerWithOnlyAnEmptyTeam_seesAnEmptyList_notAnError'] }, { name: TA, total: 13, n: 0, names: [] }],
          verdict: 'Two of 14. A list never denies, so no endpoint-by-endpoint matrix row can catch a missing filter; these two tests are that guard.'
        },
        e: {
          label: 'S4.4 (e) global perms ignored',
          where: 'S4.4 section 9.5',
          target: 'TeamAccess (main code)',
          change: '// TeamAccess\n// a global grant in the perms claim is ignored;\n// only the teams map is read.',
          main: true,
          suites: [
            { name: OBJ, total: 14, n: 1, names: ['globalPerms_applyToEveryTeam'] },
            { name: TA, total: 13, n: 2, names: ['scopeFor_aGlobalGrantIsEveryTeam', 'globalPerm_appliesToEveryTeam'] }
          ],
          verdict: 'Three failures across two suites. Test 13 was green before the check existed, "green for the wrong reason", and was kept as the pin for this decision; this mutation shows the pin works.'
        },
        h: {
          label: 'S4.4 (h) matrix row deleted (test file only)',
          where: 'S4.4 section 9.6',
          target: 'CrossTeamMatrixTest (a test file)',
          change: '// CrossTeamMatrixTest\n// the tasks/by-offset row is deleted from the table,\n// standing for an endpoint added without a row.',
          main: false,
          suites: [{ name: MX, total: 22, n: 1, names: ['theTableCoversEveryApiHandler, naming GET /api/v1/deployments/{id}/tasks/by-offset'] }],
          verdict: 'One of 21 (the table has one row fewer, which removes it from both parameterized tests, so 21 tests run, not 23). The meta-check names the endpoint that has no row.'
        }
      };
      const STALE_EXTRA = 'the POST .../rollback foreign row: 202 instead of 404 (FALSE: left over from mutation (g))';

      const verdict = ui.verdict();
      const stageBody = h('div');
      const codeBox = ui.code('', 'The mutation');
      const rTarget = ui.readout('Changed');
      const rRun = ui.readout('Tests run');
      const rFail = ui.readout('Failed');
      const rCaught = ui.readout('Caught by the test written for it');

      const mut = ui.choice('Mutation', Object.keys(MUTS).map(k => ({ value: k, label: MUTS[k].label })), 'a', update);
      const only = ui.toggle('Only a test file changed since the last run', false, update);
      const touch = ui.toggle('Touch the restored file first', false, update);

      function update() {
        const key = mut.get();
        const M = MUTS[key];
        const suites = M.suites.map(x => Object.assign({}, x, { names: x.names.slice() }));
        const stale = key === 'h' && only.get() && !touch.get();
        if (stale) {
          suites[0].n = 2;
          suites[0].names.push(STALE_EXTRA);
        }
        setCode(codeBox, M.change + '\n// source: ' + M.where);
        rTarget.set(M.target);
        const run = suites.reduce((a, x) => a + x.total, 0);
        const fail = suites.reduce((a, x) => a + x.n, 0);
        rRun.set(run);
        rFail.set(fail + (stale ? ' (1 false)' : ''), stale ? 'bad' : fail ? 'ok' : 'bad');
        rCaught.set(stale ? 'yes, plus a stale failure' : fail ? 'yes' : 'no', stale ? 'warn' : fail ? 'ok' : 'bad');
        AF.clear(stageBody);
        suites.forEach(x => {
          const b = ui.bar({ label: x.name, max: x.total, value: x.n, tone: x.n ? (stale ? 'warn' : 'ok') : 'idle', format: v => v + ' of ' + x.total + ' failed' });
          stageBody.append(b.el);
          if (x.names.length) {
            stageBody.append(h('ul', { class: 'small' }, x.names.map(n => h('li', { class: n === STALE_EXTRA ? 'muted' : null }, n))));
          }
        });
        if (stale) {
          verdict.set('warn', 'Two of 21, and one of them is not real. Only a test file changed, so Maven said "Nothing to compile" for main and the mutated class from (g) was still in target. A clean rerun fails only the meta-check (1 of 21). This is the trap recorded in S4.4 section 9.6.');
        } else if (key === 'h' && only.get() && touch.get()) {
          verdict.set('ok', 'The restored file was touched, so Maven recompiled main and (g) is gone: 1 of 21, the meta-check only. The S4.4 rule for later scratch runs is to touch every restored file.');
        } else if (key !== 'h' && only.get()) {
          verdict.set('idle', 'This mutation changed a main file, so Maven recompiled the module and the toggle has no effect. That is why the 9.5 series was not affected by the trap. ' + M.verdict);
        } else {
          verdict.set('ok', M.verdict);
        }
      }

      el.append(
        controls(mut.el, only.el, touch.el),
        stage(h('div', { class: 'sim-cols' },
          ui.panel('Which tests went red', stageBody),
          ui.panel('What was broken', codeBox))),
        readouts(rTarget, rRun, rFail, rCaught),
        note('Counts and names are the recorded results in the S4.3 and S4.4 docs (scratch copy, one change at a time, 2026-10-05); nothing here is re-run. In (b) the doc lists the 10 integration failures by rule, not by name, so the lab does too. The stale-class case is only recorded for (h) after (g); the lab does not simulate it for other mutations.'),
        verdict.el
      );
      update();
    }
  });

  AF.register({
    id: 'te-fixtures',
    group: 'testing',
    order: 5,
    title: 'Test data: fixtures, ownership and isolation',
    question: 'The tests share one database and never roll back, so how do they not step on each other, and why did the check on team ownership break nothing at first?',
    status: 'built',
    slice: 'S3.3, S4.4',
    where: [
      'control-api/src/test/java/io/appfleet/control/web/TestFixtures.java (fixture, fixtureFor, deploymentFor, deploymentIn, tasks)',
      'control-api/src/test/java/io/appfleet/control/web/WebIntegrationTest.java (one Postgres and one Redis per JVM), TestAuth.java (TEAM, TEAM_A, TEAM_B, ALL_PERMISSIONS)',
      'web/ApplicationPaginationTest.java (TRUNCATE application CASCADE), ObjectAuthorizationTest.java',
      'docs/design/control-api/control-api-s4-4-idor.md, sections 4.3, 9.2, 9.4; control-api-s3-3-deployments.md, section 10 and the S2 scope note'
    ],
    idea: [
      'Integration tests that share a database cannot assume it is empty, and they cannot roll back (the web tests go through MockMvc and commit). So isolation is a set of habits: every fixture creates fresh rows with unique names, tests count a delta (before and after a request) instead of an absolute number, and a test that has to start from nothing says so explicitly. Tokens are test data too: a test chooses who the caller is.',
      'In Appfleet, WebIntegrationTest starts one Postgres and one Redis for the whole JVM, and TestFixtures creates rows such as app-<8 random hex>. Absolute counts are only safe where the test owns its container: the S2 tests keep their own containers because DeploymentNPlusOneTest expects exactly 51 statements for 50 deployments. ApplicationPaginationTest is the exception among the web tests: it runs TRUNCATE application CASCADE before each test, because it counts pages. S3.3 learned why: its earlier cleanup deleted releases that other classes’ deployments still referenced, a foreign-key error that depended on class order, fixed and then run in alphabetical and reverse order.',
      'The S4.4 lesson is about ownership. The fixtures created applications for a random owner team, which was harmless while nothing checked ownership. The moment the check existed, every fixture would have been another team’s object, and nearly every test would have turned red for a reason unrelated to the new behaviour. So the doc moved the fixtures and the API-created applications onto TestAuth.TEAM first, ran the suite (288 tests, only the 12 expected red), and only then wired the check. What this does not give you is parallel safety: tests still share rows, so the unique names and deltas matter.'
    ],
    terms: [
      ['Fixture', 'Rows a test needs before it starts. TestFixtures.fixtureFor(team) saves an application, a release and an environment with unique names, owned by that team.'],
      ['Absolute count versus delta', 'Absolute: "the table has 3 rows". Delta: "the count rose by 3". Only the delta survives rows left by other tests.'],
      ['Unique name', 'app-<random suffix>, so two tests (or two runs) never collide on the unique name constraint.'],
      ['TRUNCATE ... CASCADE', 'Empties a table and everything that references it. ApplicationPaginationTest does it before each test and is the one web test that does.'],
      ['Order independence', 'The suite is green in alphabetical and in reverse order (S3.3, 145 tests). A pass that depends on order is a hidden coupling.']
    ],
    tryIt: [
      'Leave the defaults ("Unique names" off, "Cleanup" None, "Fixture owner" Random team, "Owner check" Off) and read both orders: tests fail by name collision and by an absolute count.',
      'Switch on "Unique names": the collisions go. The count test still depends on order, so pick "Delta: count before and after" to remove that.',
      'Switch "Owner check" on while "Fixture owner" is "Random team": the fixture test gets a 404, the S4.4 situation.',
      'Pick "Caller’s team" for "Fixture owner": green again, and the verdict says the move was made before wiring the check.',
      'Try "TRUNCATE CASCADE before the test" with unique names off and flip "Order": the cleanup hides a collision, which is why it is the exception and not the habit.'
    ],
    breakIt: 'Turn on "Owner check" with "Fixture owner" left on "Random team". Nothing in the test itself changed, yet a test that only reads its own fixture now fails with 404. The code is right and the data is wrong. With the check off the same data passes, so a suite that never had the check cannot tell you that its data is unusable.',
    say: 'The web tests share one Postgres and never roll back, so every fixture has unique names, counts are deltas, and the one table-wipe test uses TRUNCATE CASCADE; in S4.4 I moved every fixture onto the caller’s team before wiring the ownership check, so the red count showed only the new behaviour.',
    quiz: {
      q: 'Why did the S4.4 doc move TestFixtures.fixture() onto TestAuth.TEAM before wiring the owner check?',
      options: [
        'Postgres rejects rows with a random owner team',
        'Otherwise every fixture would be another team’s object to the default token and nearly every test would fail for reasons unrelated to the new behaviour',
        'TestAuth.TEAM is faster to create than a random UUID',
        'The owner check only works for fixed team ids'
      ],
      answer: 1,
      why: 'Section 4.3 calls it the S4.1 lesson again: turning a check on in a suite that never had one is most of the work. After the move the suite was 288 tests with exactly the 12 expected red.'
    },
    mount(el, ctx) {
      // Illustrative model of one shared table. The rules are the ones in TestFixtures, WebIntegrationTest and
      // ApplicationPaginationTest; the three small tests are stand-ins, not copies of real test methods.
      const TEAM = 'TEAM';
      const OTHER = 'random';
      const TESTS = {
        t1: 'createApplication_returns201',
        t2: 'list_hasMyThreeApplications',
        t3: 'getFixtureApplication_returns200'
      };
      let seq = 0;

      function simulate(order, o) {
        const rows = [];
        const out = [];
        const causes = new Set();
        seq = 0;
        const nm = base => (o.unique ? base + '-' + (0x3f9a00 + (++seq) * 7).toString(16) : base);
        const create = (name, owner) => {
          if (rows.some(r => r.name === name)) return 409;
          rows.push({ name, owner });
          return 201;
        };
        const visible = () => rows.filter(r => !o.check || r.owner === TEAM);
        order.forEach(id => {
          if (id === 't1') {
            const st = create(nm('demo'), TEAM);
            if (st === 201) out.push({ id, ok: true, text: 'POST /applications answered 201' });
            else { out.push({ id, ok: false, text: 'expected: 201 but was: 409 (the name "demo" is taken)' }); causes.add('name'); }
          } else if (id === 't2') {
            if (o.cleanup === 'truncate') rows.length = 0;
            const before = visible().length;
            ['page-1', 'page-2', 'page-3'].forEach(b => create(nm(b), TEAM));
            const after = visible().length;
            const measured = o.cleanup === 'delta' ? after - before : after;
            if (measured === 3) out.push({ id, ok: true, text: (o.cleanup === 'delta' ? 'delta ' : 'count ') + measured + ' as expected' });
            else { out.push({ id, ok: false, text: 'expected: 3 but was: ' + measured + ' (rows from other tests are counted)' }); causes.add('count'); }
          } else {
            const owner = o.owner === 'team' ? TEAM : OTHER;
            const st = create(nm('demo'), owner);
            if (st === 409) { out.push({ id, ok: false, text: 'setup error: the name "demo" is already taken' }); causes.add('name'); return; }
            const get = (!o.check || owner === TEAM) ? 200 : 404;
            if (get === 200) out.push({ id, ok: true, text: 'GET answered 200' });
            else { out.push({ id, ok: false, text: 'expected: 200 but was: 404 (the fixture belongs to another team)' }); causes.add('owner'); }
          }
        });
        return { rows, out, causes, passed: out.filter(r => r.ok).length };
      }

      const verdict = ui.verdict();
      const tableBox = h('div', { class: 'stack' });
      const resLog = ui.log({ label: 'Test results', max: 10 });
      const rFwd = ui.readout('Passed, forward order');
      const rRev = ui.readout('Passed, reverse order');
      const rRows = ui.readout('Rows left in the table');
      const rSame = ui.readout('Same result in both orders');

      const unique = ui.toggle('Unique names', false, update);
      const cleanup = ui.choice('Cleanup', [
        { value: 'none', label: 'None: absolute count' },
        { value: 'delta', label: 'Delta: count before and after' },
        { value: 'truncate', label: 'TRUNCATE CASCADE before the test' }
      ], 'none', update);
      const owner = ui.choice('Fixture owner', [
        { value: 'random', label: 'Random team' },
        { value: 'team', label: 'Caller’s team' }
      ], 'random', update);
      const check = ui.toggle('Owner check (S4.4)', false, update, { tone: 'danger' });
      const order = ui.choice('Order', [
        { value: 'fwd', label: 'Forward' },
        { value: 'rev', label: 'Reverse' }
      ], 'fwd', update);

      function update() {
        const o = { unique: unique.get(), cleanup: cleanup.get(), owner: owner.get(), check: check.get() };
        const F = simulate(['t1', 't2', 't3'], o);
        const R = simulate(['t3', 't2', 't1'], o);
        const shown = order.get() === 'fwd' ? F : R;
        AF.clear(tableBox);
        shown.rows.forEach(r => tableBox.append(ui.token(r.name + ' | owner ' + (r.owner === TEAM ? 'TEAM' : 'random team'), r.owner === TEAM ? 'ok' : 'warn')));
        if (!shown.rows.length) tableBox.append(h('span', { class: 'muted small' }, 'The table is empty.'));
        resLog.clear();
        shown.out.forEach(r => resLog.add((r.ok ? 'PASS ' : 'FAIL ') + TESTS[r.id] + ': ' + r.text, r.ok ? 'ok' : 'bad'));
        rFwd.set(F.passed + ' of 3', F.passed === 3 ? 'ok' : 'bad');
        rRev.set(R.passed + ' of 3', R.passed === 3 ? 'ok' : 'bad');
        rRows.set(shown.rows.length);
        const sameIds = JSON.stringify(F.out.map(r => r.ok ? 1 : 0).sort()) === JSON.stringify(R.out.map(r => r.ok ? 1 : 0).sort())
          && F.out.every(f => R.out.find(r => r.id === f.id).ok === f.ok);
        rSame.set(sameIds ? 'yes' : 'no', sameIds ? 'ok' : 'bad');

        const causes = new Set([...F.causes, ...R.causes]);
        const msgs = [];
        if (causes.has('name')) msgs.push('Fixed names collide: whichever test creates "demo" second gets a 409 or a setup error, so which one fails depends on order.');
        if (causes.has('count')) msgs.push('The absolute count includes rows other tests left behind, so it passes or fails by order and by who owns those rows. A delta or a TRUNCATE removes that.');
        if (causes.has('owner')) msgs.push('With the owner check on, a fixture owned by a random team is another team’s object to the caller: 404 where the test expects 200. S4.4 moved the fixtures onto TestAuth.TEAM before wiring the check.');
        if (msgs.length) {
          verdict.set('bad', msgs.join(' '));
        } else if (o.owner === 'random' && !o.check) {
          verdict.set('warn', 'Green, but only because nothing checks ownership yet. The random owner is a time bomb: turn "Owner check (S4.4)" on and the fixture test fails. This was the state of the suite before S4.4.');
        } else if (o.cleanup === 'truncate' && !o.unique) {
          verdict.set('warn', 'Green in both orders, but the TRUNCATE wiped the earlier test’s "demo" row, which hid the name collision. That is why it is the exception for a test that counts pages, not a habit; turn "Unique names" on to remove the hidden coupling.');
        } else {
          verdict.set('ok', 'Green in both orders, as the S3.3 suite was (145 tests, alphabetical and reverse): unique names, a delta or a wipe for the count, and fixtures on the caller’s team.');
        }
      }

      el.append(
        controls(unique.el, cleanup.el, owner.el, check.el, order.el),
        stage(h('div', { class: 'sim-cols' },
          ui.panel('The shared table after the run', tableBox),
          ui.panel('Results', resLog.el))),
        readouts(rFwd, rRev, rRows, rSame),
        note('An illustrative model of one shared table: the three tests are stand-ins for the rules in TestFixtures, WebIntegrationTest and ApplicationPaginationTest, not real test methods. In the real suite names are app-<8 random hex> and the ids are random. The 145-test and 288-test figures are from the S3.3 and S4.4 Results sections.'),
        verdict.el
      );
      update();
    }
  });

  AF.register({
    id: 'te-assertj',
    group: 'testing',
    order: 6,
    title: 'AssertJ and JsonPath: assertions that explain themselves',
    question: 'Why does Appfleet allow only AssertJ assertThat in tests, and how do you assert on a JSON body or a list of outcomes without brittle strings?',
    status: 'built',
    slice: 'S2 to S4.5',
    where: [
      'control-api/src/test/java/io/appfleet/control/web/ObjectAuthorizationTest.java (JsonPath helpers, doesNotContain, isZero)',
      'web/CrossTeamMatrixTest.java (.as(row.toString())), PermissionEnforcementTest.java (isNotIn(401, 403), jsonPath matchers)',
      'web/ApplicationEndpointsTest.java (containsExactlyInAnyOrder(201, 409)), DeploymentEndpointsTest.java (202, 409; extracting)',
      'web/JwtAuthenticationTest.java (containsEntry); grep for org.hamcrest finds only ApplicationEndpointsTest, DeploymentEndpointsTest, ProblemShapeTest'
    ],
    idea: [
      'A good assertion fails with a message that tells you what was wrong without opening the test. AssertJ’s assertThat(actual) reads like a sentence and prints both values; .as("description") adds a label, which matters for row-driven tests where one method runs 11 times. For lists, containsExactly says order matters and containsExactlyInAnyOrder says it does not; isNotIn, filteredOn and extracting cover the rest. For JSON, read a field with a path (JsonPath, com.jayway.jsonpath) instead of comparing the whole body string, so a changing correlationId or field order does not break the test.',
      'In Appfleet the rule is AssertJ only, with one exception that is enforced by where the imports are: Hamcrest appears only inside MockMvc matchers. A search of the tests for org.hamcrest finds three files (ApplicationEndpointsTest, DeploymentEndpointsTest and ProblemShapeTest), and each uses it as an argument to header().string(...) or content().string(...), for example startsWith("/api/v1/applications/"). Everything else is assertThat. Real examples: the concurrent create asserts containsExactlyInAnyOrder(201, 409) and the deployment races use (202, 409), because two threads finish in either order; PermissionEnforcementTest asserts isNotIn(401, 403) with the row as the description, because a random id may legitimately be 404; ObjectAuthorizationTest reads $.type and $.items[*].id with JsonPath.',
      'None of this makes a test correct. A fluent assertion on the wrong value still passes, and a JsonPath on the body can agree with itself while the HTTP status differs. The message shapes also differ by library: MockMvc matchers print "Status expected:<403> but was:<202>" (seen in S4.3), AssertJ prints "expected: 1L but was: 2L" or "Expected size: 1 but was: 0" (seen in S3.3 and S4.5), so a reader learns to recognise which layer failed.'
    ],
    terms: [
      ['assertThat(actual)', 'AssertJ’s entry point. The failure prints the actual and the expected value in a readable form.'],
      ['.as("...")', 'A description shown at the front of the failure message. Used with row-driven tests so the failing row is named.'],
      ['containsExactlyInAnyOrder', 'Same elements, any order. The right choice for the outcomes of two concurrent requests.'],
      ['JsonPath', 'A path expression into a JSON document, such as $.type, $.items[*].id or $.errors[0].field, read with com.jayway.jsonpath.JsonPath.read.'],
      ['MockMvc matcher', 'status().isForbidden() and jsonPath("$.type").value(...) are checks passed to andExpect; Hamcrest matchers such as startsWith are allowed only as their arguments.']
    ],
    tryIt: [
      'Pick the Scenario "A status code" with the Style "assertThat with a description": the lab shows the failure message shape and that the test is not brittle.',
      'Pick "Two concurrent creates" and compare "Raw equals" with "Collection assertion": the first fails randomly by thread order.',
      'Pick "A problem body field" with "Raw equals": the whole-body comparison is brittle because of fields such as the correlation id.',
      'Pick "List must not contain team B’s id" and look at the label on the failure message: it says whether the shape was seen in the project or reconstructed.',
      'Pick "No row is written" with "JsonPath read": the lab explains why a response body cannot answer a question about the database.'
    ],
    breakIt: 'Compare the whole response body to a stored string. The first time the body gains a field, or a correlationId differs between runs, the test fails and says only that two long strings differ. In the lab, pick "A problem body field" with "Raw equals on a string". Reading the one field with JsonPath removes the noise and makes the failure name the field.',
    say: 'We use AssertJ only, so every failure prints actual against expected, with .as() naming the row; we read JSON with JsonPath rather than comparing bodies, use containsExactlyInAnyOrder for concurrent outcomes like 201 and 409, and keep Hamcrest strictly inside MockMvc matchers.',
    quiz: {
      q: 'Two threads create the same application name at once. Which assertion is correct for the two status codes?',
      options: [
        'assertThat(statuses).containsExactly(201, 409)',
        'assertThat(statuses).containsExactlyInAnyOrder(201, 409)',
        'assertThat(statuses.get(0)).isEqualTo(201)',
        'assertThat(statuses).hasSize(2)'
      ],
      answer: 1,
      why: 'ApplicationEndpointsTest asserts containsExactlyInAnyOrder(201, 409). Which thread wins is not defined, so an order-sensitive assertion would fail at random; hasSize(2) would pass for [201, 201].'
    },
    mount(el, ctx) {
      // Entries: code (Java as the project writes it, or the alternative), fail (message shape), src 'real' or 'std',
      // tone for brittleness, why. 'real' shapes come from the project docs; 'std' are standard library shapes reconstructed here.
      const SC = [
        { value: 'status', label: 'A status code' },
        { value: 'problem', label: 'A problem body field' },
        { value: 'ids', label: 'List must not contain team B’s id' },
        { value: 'race', label: 'Two concurrent creates' },
        { value: 'rows', label: 'No row is written' }
      ];
      const ST = [
        { value: 'raw', label: 'Raw equals on a string' },
        { value: 'desc', label: 'assertThat with a description' },
        { value: 'coll', label: 'Collection assertion' },
        { value: 'jp', label: 'JsonPath read' }
      ];
      const E = (code, fail, src, tone, brittle, why) => ({ code, fail, src, tone, brittle, why });
      const DATA = {
        status: {
          raw: E('assertTrue(r.getStatus() == 404);   // not used in the project',
            'expected: true but was: false', 'std', 'bad', 'Brittle',
            'The message hides the status. You learn the test failed, not whether the answer was 200, 403 or 500.'),
          desc: E('assertThat(r.getStatus()).isEqualTo(404);   // ObjectAuthorizationTest\nassertThat(status(row, foreign, token)).as(row.toString()).isEqualTo(row.foreignStatus());   // CrossTeamMatrixTest',
            'expected: 404 but was: 200   (with .as(row), the row text is shown in front)', 'std', 'ok', 'Not brittle',
            'Prints both values, and .as names the operation in a table of 11 rows. Same shape as the real "expected: 1L but was: 2L" of S3.3.'),
          coll: E('assertThat(status).as(op.toString()).isNotIn(401, 403);   // PermissionEnforcementTest',
            'Expecting actual: 403 not to be in: [401, 403]   (reconstructed shape)', 'std', 'ok', 'Not brittle',
            'States exactly what matters: the permission check passed. A 404 for a random id is fine, so the test does not demand 200.'),
          jp: E('assertThat((int) JsonPath.read(body, "$.status")).isEqualTo(404);   // an option, not used in the project',
            'expected: 404 but was: 200   (reconstructed shape)', 'std', 'warn', 'Careful',
            'It checks the problem body’s own status field, not the HTTP status line. The two normally agree, which is exactly why a bug in one would be missed here.')
        },
        problem: {
          raw: E('assertThat(body).isEqualTo(storedJson);   // not used in the project',
            'expected: "{...whole body...}" but was: "{...whole body...}"   (reconstructed shape)', 'std', 'bad', 'Brittle',
            'The body carries a correlationId and the request path, which differ per call, and any new field breaks it. The diff of two long strings does not name the field.'),
          desc: E('assertThat(type(r)).isEqualTo(PROBLEM + "not-found");   // ObjectAuthorizationTest, type() reads $.type',
            'expected: "urn:appfleet:problem:not-found" but was: "urn:appfleet:problem:forbidden"   (reconstructed shape)', 'std', 'ok', 'Not brittle',
            'One field, read by path, compared to a constant. The failure names the two problem types.'),
          coll: E('assertThat(body(r)).containsEntry("type", "urn:appfleet:problem:unauthorized");   // JwtAuthenticationTest',
            'Expecting map: {...} to contain entry: "type"="urn:appfleet:problem:unauthorized"   (reconstructed shape)', 'std', 'ok', 'Not brittle',
            'Checks one entry of the parsed body and ignores the rest.'),
          jp: E('.andExpect(jsonPath("$.type").value("urn:appfleet:problem:forbidden"))   // PermissionEnforcementTest',
            'JSON path "$.type" expected:<urn:appfleet:problem:forbidden> but was:<urn:appfleet:problem:not-found>   (reconstructed shape)', 'std', 'ok', 'Not brittle',
            'The path names the field in the failure. Hamcrest, when used, lives only inside matchers like this one.')
        },
        ids: {
          raw: E('assertFalse(body.contains(theirsId));   // not used in the project',
            'expected: false but was: true', 'std', 'bad', 'Brittle',
            'A substring check on the whole body: it passes if the id is formatted differently and fails if the id appears in another field. The message does not say where.'),
          desc: E('assertThat(ids).as("ids on the page").doesNotContain(theirs.app().getId().toString());   // .as() added here; the project omits it',
            'Expecting ArrayList: [...] not to contain: "..." but found: ["..."]   (reconstructed shape)', 'std', 'ok', 'Not brittle',
            'The project writes this without .as; the description helps when several lists are checked in one test.'),
          coll: E('assertThat(ids).contains(mine.app().getId().toString());\nassertThat(ids).doesNotContain(theirs.app().getId().toString());   // ObjectAuthorizationTest',
            'Expecting ArrayList: [...] not to contain: "..."   (reconstructed shape)', 'std', 'ok', 'Not brittle',
            'Two assertions: the caller’s own application is present (so an empty list cannot pass) and the other team’s is absent.'),
          jp: E('List<String> ids = JsonPath.read(body, "$.items[*].id");   // helper in ApplicationPaginationTest\nassertThat(ids).doesNotContain(theirsId);',
            'same as the collection assertion once the ids are extracted', 'std', 'ok', 'Not brittle',
            'JsonPath turns the body into a list of ids, then AssertJ asserts on the list. No string searching.')
        },
        race: {
          raw: E('assertEquals(201, statuses.get(0));\nassertEquals(409, statuses.get(1));   // not used in the project',
            'expected: 201 but was: 409   (only on the runs where the other thread wins)', 'std', 'bad', 'Brittle: fails at random',
            'Which of two concurrent requests finishes first is not defined. The test passes on some runs and fails on others for the same correct code.'),
          desc: E('assertThat(statuses).as("two concurrent creates").isEqualTo(List.of(201, 409));   // not used in the project',
            '[two concurrent creates] expected: [201, 409] but was: [409, 201]   (reconstructed shape)', 'std', 'bad', 'Brittle: fails at random',
            'A nice message does not fix a wrong question: this still depends on thread order.'),
          coll: E('assertThat(statuses).containsExactlyInAnyOrder(201, 409);   // ApplicationEndpointsTest\nassertThat(outcomes).extracting(Outcome::status).containsExactlyInAnyOrder(202, 409);   // DeploymentEndpointsTest',
            'Expecting actual: [201, 201] to contain exactly in any order: [201, 409] ... elements not found: [409]   (reconstructed shape)', 'std', 'ok', 'Not brittle',
            'Same elements in any order, so exactly one winner and one conflict, whichever thread is first. [201, 201] and [409, 409] both fail.'),
          jp: E('String type = r.getStatus() >= 400 ? JsonPath.read(r.getContentAsString(), "$.type") : null;   // DeploymentEndpointsTest.race\nassertThat(outcomes).extracting(Outcome::type).contains(PROBLEM + "conflict");',
            'Expecting ArrayList: [...] to contain: "urn:appfleet:problem:conflict"   (reconstructed shape)', 'std', 'ok', 'Not brittle',
            'JsonPath reads the loser’s problem type inside the race helper; extracting then asserts without caring about order.')
        },
        rows: {
          raw: E('assertTrue(count("select count(*) from application where name = ?", name) == 0);   // not used in the project',
            'expected: true but was: false', 'std', 'warn', 'Weak',
            'Hides the count. Knowing it was 1 or 7 tells you whether a request wrote once or many times.'),
          desc: E('assertThat(count("select count(*) from application where name = ?", name)).isZero();   // ObjectAuthorizationTest',
            'expected: 0L but was: 1L   (reconstructed from the real S3.3 shape "expected: 1L but was: 2L")', 'std', 'ok', 'Not brittle',
            'The helper returns a long, so the failure shows the number. The query is scoped to this test’s unique name, so other tests’ rows do not count.'),
          coll: E('assertThat(rows).hasSize(1);   // outbox tests',
            'Expected size: 1 but was: 0', 'real', 'ok', 'Not brittle',
            'Seen in S4.5 for requestDeployment_writesOneOutboxMessage before the outbox write existed.'),
          jp: E('int n = JsonPath.read(body, "$.items.length()");   // an option, not used in the project',
            'expected: 0 but was: 3   (reconstructed shape)', 'std', 'warn', 'Careful',
            'It counts items in a response. A response can say 0 while the table holds a row, so it cannot prove that nothing was written.')
        }
      };
      const REAL = [
        ['Status expected:<403> but was:<202>', 'MockMvc matcher, S4.3 section 9.1'],
        ['expected: 1L but was: 2L', 'AssertJ on an audit row count, S3.3 section 10'],
        ['Expected size: 1 but was: 0', 'AssertJ on outbox rows, S4.5 section 9.2'],
        ['Expecting empty but was: {...}', 'AssertJ on a Spring bean map, S2 lazy-initialization doc']
      ];

      const verdict = ui.verdict();
      const codeBox = ui.code('', 'The assertion');
      const failBox = ui.code('', 'The failure message');
      const rSrc = ui.readout('Failure message');
      const rBrit = ui.readout('Brittleness');
      const rStyle = ui.readout('Style');
      const sc = ui.choice('Scenario', SC, 'status', update);
      const st = ui.choice('Assertion style', ST, 'desc', update);
      const realList = h('ul', { class: 'small' }, REAL.map(r => h('li', null, h('code', null, r[0]), ' (' + r[1] + ')')));

      function update() {
        const e = DATA[sc.get()][st.get()];
        setCode(codeBox, e.code);
        setCode(failBox, e.fail);
        rSrc.set(e.src === 'real' ? 'seen in this project' : 'standard shape, reconstructed', e.src === 'real' ? 'ok' : 'warn');
        rBrit.set(e.brittle, e.tone);
        rStyle.set(/not used in the project|an option, not used|omits it/.test(e.code) ? 'not used as written in Appfleet' : 'used in Appfleet');
        verdict.set(e.tone, e.why);
      }

      el.append(
        controls(sc.el, st.el),
        stage(h('div', { class: 'sim-cols' },
          ui.panel('The assertion', codeBox),
          ui.panel('When it fails', failBox)),
          ui.panel('Real failure messages seen in this project', realList)),
        readouts(rSrc, rBrit, rStyle),
        note('"Seen in this project" means the exact message is in the S2 to S4.5 docs. Other messages are the standard AssertJ or Spring shapes, reconstructed for illustration and labelled so; they were not copied from a run in this repository. Raw-equals styles are shown for contrast and are not used in the control-api tests.'),
        verdict.el
      );
      update();
    }
  });


  // ================= te-parameterized (order 7) =================
  AF.register({
    id: 'te-parameterized',
    group: 'testing',
    order: 7,
    title: 'Parameterized matrix tests and the meta-test',
    question: 'How does one table of eleven operations drive three kinds of tests, and what stops the next endpoint from shipping with no check?',
    status: 'built',
    slice: 'S4.3, S4.4',
    where: [
      'control-api/src/test/java/io/appfleet/control/web/PermissionEnforcementTest.java (record Op, operations(), everyOperation_withoutItsPermission_is403, everyOperation_withOnlyItsPermission_isNot403, everyApiHandler_declaresOnePermission)',
      'control-api/src/test/java/io/appfleet/control/web/CrossTeamMatrixTest.java (record Row, rows(), anotherTeamsObject_getsTheDocumentedDenial, theCallersOwnObject_getsTheNormalAnswer, theTableCoversEveryApiHandler)',
      'docs/design/control-api/control-api-s4-3-method-security.md, section 9.4 (mutation checks)',
      'docs/design/control-api/control-api-s4-4-idor.md, sections 4.4, 9.6'
    ],
    idea: [
      'A parameterized test is one test body run once per row of a table. In JUnit 5 you write @ParameterizedTest and @MethodSource("operations"), and the method returns a Stream of records. The record’s toString becomes the name in the report, so a failure reads "POST /api/v1/deployments/{id}/rollback needs deployment:rollback" and not "test 8". A matrix goes one step further: every operation is tried twice, once expecting the refusal and once expecting the normal answer, so a check that is missing and a check that is too strict both show up.',
      'Appfleet has two matrices over the same eleven operations. PermissionEnforcementTest uses record Op (method, path template, permission, body builder): one test sends a token without the permission and expects 403, another sends a token with only that permission and expects "not 401 and not 403". It has 27 tests in all. CrossTeamMatrixTest uses record Row (path, body, foreignStatus, ownStatus): one test calls team B’s object as a team A caller and expects the documented denial (403, 404, 422 or a filtered 200), another calls the caller’s own object and expects the normal answer (201, 200 or 202). It has 23 tests. Each also has a meta-test that reads RequestMappingHandlerMapping, keeps the handlers under /api/ and compares them with the table. theTableCoversEveryApiHandler requires the same set; everyApiHandler_declaresOnePermission also requires every handler to carry exactly one @PreAuthorize("hasAuthority(...)") matching the table.',
      'The table cannot test what it does not list, which is why the meta-test exists: a new endpoint with no row fails the build and names the handler. It also cannot see everything. The meta-test passes when @EnableMethodSecurity is missing (S4.3 red run 2: annotations present, nothing enforced), and only the behaviour tests catch a final method that Spring cannot proxy. Neither matrix can tell that a list endpoint forgot its filter: GET /applications answers 200 on both sides, so list_showsOnlyTheCallersTeams guards that.'
    ],
    terms: [
      ['@ParameterizedTest and @MethodSource', 'JUnit 5 runs the same test method once for each element of the Stream returned by the named factory method.'],
      ['Test matrix', 'A table of operations crossed with the answers to check. Appfleet crosses eleven operations with a denial and a normal answer.'],
      ['Meta-test', 'A test about the test suite: it compares the table with the real handler mappings, so it fails when the table and the code drift apart.'],
      ['RequestMappingHandlerMapping', 'The Spring bean that knows every controller method and its URL pattern and HTTP method. The meta-test reads it instead of keeping a second list by hand.'],
      ['Mutation check', 'Change the code on purpose in a scratch copy and see which tests turn red. A test that never turns red for anything has not been shown to work.']
    ],
    tryIt: [
      'Leave "Matrix" on "S4.3 permissions" and pick "Wrong permission on 3 methods": the denial matrix, the normal-answer matrix and the meta-test all go red, 7 of 27.',
      'Pick "hasRole instead of hasAuthority": the denial matrix stays green. The only-this-permission test and the meta-test catch it.',
      'Pick "final method": exactly one denial row goes red, and the meta-test stays green because the annotation is still there.',
      'Switch "Matrix" to "S4.4 cross-team" and pick "Delete a table row": only the meta-test goes red, and it names the handler with no row.',
      'Pick "Add endpoint, no row" and then "Annotation deleted" on the S4.4 matrix, and read which of these were measured and which are labelled as reasoning from the code.'
    ],
    breakIt: 'Drop the meta-test and keep only the two parameterized tests. A new endpoint added without a row, or a row deleted from the table, then makes no test go red at all: the matrix checks only what it lists. In the lab, "Delete a table row" shows exactly that: the denial and normal-answer columns are green, and only the meta-test column goes red.',
    say: 'I keep one table of operations that drives a denial test, a normal-answer test and a meta-test that compares the table with Spring’s handler mappings, and I proved each guards something by mutating the code: a wrong permission was caught by three kinds of tests, a final method only by the behaviour test, and a deleted table row only by the meta-test.',
    quiz: {
      q: 'In S4.3, requestRollback was made final, with its @PreAuthorize annotation left in place. Which tests went red?',
      options: [
        'All three kinds: denial, normal-answer and meta-test',
        'Only the meta-test, because the annotation was changed',
        'Only the rollback row of the without-its-permission test; the meta-test stayed green',
        'None; Spring still enforces the annotation on a final method'
      ],
      answer: 2,
      why: 'The meta-test reads annotations and the annotation was still there. A final method cannot be overridden by the CGLIB proxy, so the advice never ran and the call went through with no 403. Only the behaviour test for that row, 1 of 27, saw it.'
    },
    mount(el, ctx) {
      // Row order is the order of operations() in PermissionEnforcementTest and rows() in CrossTeamMatrixTest.
      const ROWS = [
        { m: 'POST', p: '/api/v1/applications', perm: 'application:create', foreign: 403, own: 201 },
        { m: 'GET', p: '/api/v1/applications', perm: 'application:read', foreign: 200, own: 200 },
        { m: 'GET', p: '/api/v1/applications/{id}', perm: 'application:read', foreign: 404, own: 200 },
        { m: 'POST', p: '/api/v1/applications/{id}/releases', perm: 'application:create', foreign: 404, own: 201 },
        { m: 'GET', p: '/api/v1/applications/{id}/releases/{releaseId}', perm: 'application:read', foreign: 404, own: 200 },
        { m: 'POST', p: '/api/v1/deployments', perm: 'deployment:create', foreign: 422, own: 202 },
        { m: 'GET', p: '/api/v1/deployments/{id}', perm: 'deployment:read', foreign: 404, own: 200 },
        { m: 'POST', p: '/api/v1/deployments/{id}/rollback', perm: 'deployment:rollback', foreign: 404, own: 202 },
        { m: 'GET', p: '/api/v1/deployments/{id}/tasks', perm: 'deployment:read', foreign: 404, own: 200 },
        { m: 'GET', p: '/api/v1/deployments/{id}/tasks/by-offset', perm: 'deployment:read', foreign: 404, own: 200 },
        { m: 'GET', p: '/api/v1/tasks/{id}', perm: 'deployment:read', foreign: 404, own: 200 }
      ];
      const NEW_EP = 'GET /api/v1/deployments/{id}/events (hypothetical)';
      const MATS = {
        perm: {
          denial: 'everyOperation_withoutItsPermission_is403',
          normal: 'everyOperation_withOnlyItsPermission_isNot403',
          meta: 'everyApiHandler_declaresOnePermission',
          total: '27',
          col: 'Permission in the Op table'
        },
        team: {
          denial: 'anotherTeamsObject_getsTheDocumentedDenial',
          normal: 'theCallersOwnObject_getsTheNormalAnswer',
          meta: 'theTableCoversEveryApiHandler',
          total: '23',
          col: 'Row: foreign / own answer'
        }
      };
      const MUTS = [
        { value: 'none', label: 'No change' },
        { value: 'newep', label: 'Add endpoint, no row' },
        { value: 'delrow', label: 'Delete a table row' },
        { value: 'wrongperm', label: 'Wrong permission on 3 methods' },
        { value: 'wrongstatus', label: 'Wrong expected status in a row' },
        { value: 'hasrole', label: 'hasRole instead of hasAuthority' },
        { value: 'delann', label: 'Annotation deleted' },
        { value: 'final', label: 'final method' },
        { value: 'ownrelease', label: 'Owner check removed (release)' },
        { value: 'ownrollback', label: 'Owner check removed (rollback)' }
      ];
      const NA = (why) => ({ na: true, text: why });
      const RES = {
        perm: {
          none: { denial: [], normal: [], meta: false, red: '0 of 27', ev: 'measured', text: 'All 27 tests green after enforcement was switched on (S4.3 section 9.3).' },
          newep: { denial: [], normal: [], meta: true, red: '1 (expected)', ev: 'reasoned', newEndpoint: true, text: 'The handler is in the mappings but not in the table (and has no @PreAuthorize), so the meta-test fails. Reasoned from the test code. The closest measured case is S4.3 red run 1, where all 11 handlers had no annotation and the meta-test listed each as "has no @PreAuthorize".' },
          delrow: { denial: [], normal: [], meta: true, red: '1 (expected)', ev: 'reasoned', delRow: 9, text: 'The handler still declares its permission, but the table has no row for it, so the declared map no longer equals the table. Reasoned from the test code; S4.3 did not run it (section 9.6 says the "table row with no endpoint" half was not done). The measured version is in the S4.4 matrix.' },
          wrongperm: { denial: [6, 8, 9], normal: [6, 8, 9], meta: true, red: '7 of 27', ev: 'measured', codeNote: { 6: 'code: deployment:create', 8: 'code: deployment:create', 9: 'code: deployment:create' }, text: 'Mutation (a): deployment:read replaced by deployment:create on the annotation lines. Three methods share that exact line, so three rows changed, not one. Caught by all three kinds of test, which is what the matrix exists for.' },
          wrongstatus: NA('The S4.3 table has no expected status, only a permission. Try this one on the S4.4 matrix.'),
          hasrole: { denial: [], normal: [7], meta: true, red: '2 of 27', ev: 'measured', codeNote: { 7: 'code: hasRole(...)' }, text: 'Mutation (b): hasRole(\'deployment:rollback\') on the rollback method looks for ROLE_deployment:rollback. A role check hides from the "without" test (a token with nothing is refused either way) and shows in the "only" test and in the meta-test.' },
          delann: { denial: [7], normal: [], meta: true, red: '2 of 27', ev: 'measured', codeNote: { 7: 'code: no annotation' }, text: 'Mutation (c): the annotation deleted on the rollback method. The meta-test sees a handler with no @PreAuthorize, and the without-its-permission test for that row gets 202 where it needs 403.' },
          final: { denial: [7], normal: [], meta: false, red: '1 of 27', ev: 'measured', codeNote: { 7: 'code: final method' }, text: 'Mutation (d): requestRollback made final. The annotation is still there, so the meta-test stays green; CGLIB cannot override a final method, so the advice never runs. Only the behaviour test catches a method that is not proxied.' },
          ownrelease: NA('Owner checks are the S4.4 matrix’s job: the permission matrix uses a token that has the permission and tests nothing about teams.'),
          ownrollback: NA('Owner checks are the S4.4 matrix’s job: the permission matrix uses a token that has the permission and tests nothing about teams.')
        },
        team: {
          none: { denial: [], normal: [], meta: false, red: '0 of 23', ev: 'measured', text: 'All 23 green: 11 denial rows, 11 normal-answer rows and the meta-check. Own answers 201, 200, 200, 201, 200, 202, 200, 202, 200, 200, 200; foreign answers 403, 200 (filtered), 404, 404, 404, 422, 404, 404, 404, 404, 404 (S4.4 section 9.6).' },
          newep: { denial: [], normal: [], meta: true, red: '1 (expected)', ev: 'reasoned', newEndpoint: true, text: 'A handler with no row: theTableCoversEveryApiHandler fails and names it. S4.4 section 4.4 designs exactly this; the recorded run (h) shows the mirror image, a row deleted while the handler stays, which is the same mismatch.' },
          delrow: { denial: [], normal: [], meta: true, red: '1 of 21', ev: 'measured', delRow: 9, text: 'Mutation (h): the tasks/by-offset row deleted, standing for an endpoint added without a row. Only theTableCoversEveryApiHandler failed, naming GET /api/v1/deployments/{id}/tasks/by-offset. The first run also showed the rollback row red: that was stale compiled output from mutation (g), not a real failure (recorded in section 9.6).' },
          wrongperm: NA('The cross-team table has no permission column; its caller holds every permission for team A. The S4.3 matrix owns this change.'),
          wrongstatus: { denial: [7], normal: [], meta: false, red: '1 of 23 (expected)', ev: 'reasoned', statusNote: { 7: 'foreign 403 (was 404)' }, text: 'A row that expects the wrong denial fails its own denial test and nothing else. Reasoned from the test code; S4.4 did not run this mutation.' },
          hasrole: NA('This matrix does not vary permissions. Switch to the S4.3 matrix.'),
          delann: NA('This matrix sends a token holding every permission, so it does not look at annotations. Switch to the S4.3 matrix.'),
          final: NA('This matrix does not test the permission proxy. Switch to the S4.3 matrix.'),
          ownrelease: { denial: [4], normal: [], meta: false, red: '1 of 23', ev: 'measured', codeNote: { 4: 'code: owner check removed' }, text: 'Mutation (f): owner check removed from ApplicationService.getRelease. The denial test for GET .../releases/{releaseId} got 200 instead of 404.' },
          ownrollback: { denial: [7], normal: [], meta: false, red: '1 of 23', ev: 'measured', codeNote: { 7: 'code: owner check removed' }, text: 'Mutation (g): owner check removed from requestRollback. The foreign row of POST .../rollback got 202 instead of 404.' }
        }
      };

      const verdict = ui.verdict();
      const matrix = ui.choice('Matrix', [
        { value: 'perm', label: 'S4.3 permissions' },
        { value: 'team', label: 'S4.4 cross-team' }
      ], 'perm', update);
      const mut = ui.choice('Change', MUTS, 'none', update);
      const rTests = ui.readout('Tests in this matrix');
      const rRed = ui.readout('Red tests');
      const rEv = ui.readout('Evidence');
      const rBy = ui.readout('Caught by');
      const tableBox = h('div', { class: 'stack' });

      const cell = (text, tone) => ui.token(text, tone);
      function line(cols, tone) {
        return h('div', { style: 'display:grid;grid-template-columns:minmax(0,3fr) minmax(0,2fr) auto auto;gap:.5rem;align-items:center;padding:.15rem 0' }, cols);
      }

      function update() {
        const mat = MATS[matrix.get()];
        const r = RES[matrix.get()][mut.get()];
        AF.clear(tableBox);
        const rows = ROWS.slice();
        tableBox.append(line([
          h('b', { class: 'small', text: 'Operation (one table row)' }),
          h('b', { class: 'small', text: mat.col }),
          h('b', { class: 'small', text: 'Denial' }),
          h('b', { class: 'small', text: 'Normal' })
        ]));
        rows.forEach((row, i) => {
          const key = row.m + ' ' + row.p;
          const deleted = !r.na && r.delRow === i;
          let info = matrix.get() === 'perm' ? row.perm : 'foreign ' + row.foreign + ' / own ' + row.own;
          if (!r.na && r.statusNote && r.statusNote[i]) info = r.statusNote[i];
          if (!r.na && r.codeNote && r.codeNote[i]) info += '  |  ' + r.codeNote[i];
          const dRed = !r.na && r.denial.indexOf(i) >= 0;
          const nRed = !r.na && r.normal.indexOf(i) >= 0;
          tableBox.append(line([
            h('span', { class: 'small', style: deleted ? 'text-decoration:line-through' : '', text: key }),
            h('span', { class: 'small muted', text: deleted ? 'row deleted from the table' : info }),
            cell(deleted ? 'no row' : dRed ? 'red' : 'green', deleted ? 'idle' : dRed ? 'bad' : 'ok'),
            cell(deleted ? 'no row' : nRed ? 'red' : 'green', deleted ? 'idle' : nRed ? 'bad' : 'ok')
          ]));
        });
        if (!r.na && r.newEndpoint) {
          tableBox.append(line([
            h('span', { class: 'small', text: NEW_EP }),
            h('span', { class: 'small muted', text: 'handler exists, no row in the table' }),
            cell('no row', 'idle'),
            cell('no row', 'idle')
          ]));
        }
        const metaRed = !r.na && r.meta;
        tableBox.append(h('div', { style: 'padding-top:.35rem' },
          cell('meta-test ' + mat.meta + ': ' + (metaRed ? 'red' : 'green'), metaRed ? 'bad' : 'ok')));

        rTests.set(mat.total);
        if (r.na) {
          rRed.set('not applicable');
          rEv.set('—');
          rBy.set('—');
          verdict.set('idle', 'Not applicable to this matrix. ' + r.text);
          return;
        }
        const caught = [];
        if (r.denial.length) caught.push('denial matrix (' + mat.denial + ')');
        if (r.normal.length) caught.push('normal-answer matrix (' + mat.normal + ')');
        if (r.meta) caught.push('meta-test');
        rRed.set(r.red, r.meta || r.denial.length || r.normal.length ? 'bad' : 'ok');
        rEv.set(r.ev === 'measured' ? 'measured (design doc)' : 'reasoned from the code, not run', r.ev === 'measured' ? 'ok' : 'warn');
        rBy.set(caught.length ? caught.join(', ') : 'nothing red');
        const evLabel = r.ev === 'measured' ? '' : ' (Reasoned from the test code, not a recorded run.)';
        if (mut.get() === 'none') verdict.set('ok', r.text);
        else verdict.set(caught.length ? 'ok' : 'bad', r.text + evLabel);
      }

      el.append(
        controls(matrix.el, mut.el),
        stage(ui.panel('The table of eleven operations, and which test goes red', tableBox)),
        readouts(rTests, rRed, rEv, rBy),
        note('Rows and counts are the tables in PermissionEnforcementTest and CrossTeamMatrixTest. "Measured" outcomes are the mutation checks of S4.3 section 9.4 (a to d) and S4.4 section 9.6 (f to h), each run once on a scratch copy. Rows marked "reasoned" follow from reading the test code and were not run. The "events" endpoint is hypothetical.'),
        verdict.el
      );
      update();
    }
  });

  // ================= te-concurrency (order 8) =================
  AF.register({
    id: 'te-concurrency',
    group: 'testing',
    order: 8,
    title: 'Testing races: barriers, outcome sets and repeat runs',
    question: 'How do you write a test that proves exactly one of two simultaneous requests wins, without a sleep and without a flaky result?',
    status: 'built',
    slice: 'S2, S3.3, S3.5, S3.6',
    where: [
      'control-api/src/test/java/io/appfleet/control/web/ApplicationEndpointsTest.java (concurrentCreate_sameName_oneCreated_oneConflict)',
      'control-api/src/test/java/io/appfleet/control/web/DeploymentEndpointsTest.java (race(), concurrentDeployments_sameTarget_one202_one409, concurrentRollbacks_one202_one409_exactlyOneTask)',
      'control-api/src/test/java/io/appfleet/control/web/IdempotencyEndpointsTest.java (concurrentIdenticalPosts_sameKey_exactlyOneDeployment)',
      'control-api/src/test/java/io/appfleet/control/web/RateLimitEndpointsTest.java (concurrentBurst_allowsExactlyCapacity)',
      'docs/design/control-api/control-api-s3-3-deployments.md section 10; control-api-s3-5-idempotency.md section 11.3; control-api-s3-6-rate-limiting.md section 11'
    ],
    idea: [
      'To test a race you must make the requests really overlap. Appfleet uses a CyclicBarrier(n) and a fixed thread pool of n threads: each task calls barrier.await(5, TimeUnit.SECONDS) first, then sends its request, so all n are released together and nobody sleeps. Then the test does not ask who won. It collects every status and asserts on the set: containsExactlyInAnyOrder(201, 409) for a unique name, containsExactlyInAnyOrder(202, 409) for a rollback, containsOnly(200, 429) with exactly 3 allowed for a bucket of capacity 3. The thread order is not stable between runs; the set is.',
      'Then it checks the side effect in the database, because statuses can look right while the data is wrong: exactly one deployment row for the application and environment, exactly one ROLLBACK task row, exactly one deployment for the idempotency key. Finally the test must be seen to fail. S3.3 removed @Lock(OPTIMISTIC_FORCE_INCREMENT) and case 16 failed 5 of 5 runs with [202, 202]; with the lock it passed 10 of 10. S3.6 swapped the Lua script for a read-modify-write in Java and case 5 failed 6 of 6, with all ten requests answered 200 where the capacity was 3.',
      'A concurrency test proves a property under one observed interleaving per run, not for all of them, so Appfleet repeats it in fresh JVMs (S3.5 ran case 6 ten times). It also records what it does not fix: the loser of a lost rollback race leaves an orphan ROLLBACK_REQUESTED audit row in 10 of 10 runs, and case 16 pins that behaviour until S6. A test with n at or below the limit proves nothing: with capacity 3, three requests all pass even with the naive limiter.'
    ],
    terms: [
      ['CyclicBarrier', 'A java.util.concurrent latch that releases all n waiting threads at once, so the requests start together without sleeping.'],
      ['Outcome set', 'The collection of results asserted without caring which thread produced which. Stable across runs, unlike "thread A won".'],
      ['Optimistic force-increment lock', 'A JPA lock mode that bumps the row’s version at commit, so a second concurrent commit fails with ObjectOptimisticLockingFailureException (409 concurrent-modification).'],
      ['Flaky test', 'A test whose result changes with timing alone. Asserting on the winner, or sleeping a fixed time, makes one.'],
      ['Fresh JVM repeat', 'Running the same test several times, each in a new process, so warm caches and leftover state cannot hide an interleaving.']
    ],
    tryIt: [
      'Choose "Force-increment lock" with "Requests" at 2 and press "Repeat the run": 10 of 10 runs pass with [202, 409], the recorded S3.3 result.',
      'Choose "No protection": the set is [202, 202] and the test fails; the recorded S3.3 red run failed 5 of 5.',
      'Choose "Naive Java limiter" and set "Requests" to 10, then to 3: the test has teeth only when requests exceed the capacity of 3.',
      'Choose "Lua script" at 10 requests: exactly 3 allowed, 7 refused, never a 500.',
      'Turn on "Assert which thread won" with the lock and repeat: the test flakes. That run is illustrative, because the winner is chosen at random in the lab.'
    ],
    breakIt: 'Switch "Assert which thread won" on. The protection is unchanged and still lets exactly one request through, but the test now demands that thread 1 is the one, so it passes about half the time. Appfleet asserts on the set of outcomes and never on the winner. (The coin flip in the lab is illustrative, not a measurement.)',
    say: 'I start n requests together with a CyclicBarrier and a fixed thread pool, assert on the set of outcomes and on the database side effect rather than on who won, repeat it in fresh JVMs, and first prove it can fail: without the force-increment lock the rollback race returned [202, 202] in 5 of 5 runs, and the naive Java limiter let all 10 of 10 requests through a bucket of 3.',
    quiz: {
      q: 'Why does concurrentBurst_allowsExactlyCapacity send 10 requests at a bucket of capacity 3 rather than 3 or 4?',
      options: [
        'Ten requests make Redis slower, so the race is more likely',
        'With 3 requests even a broken limiter lets all 3 through, so the test could not fail; 10 exceeds the capacity and exposes overshoot',
        'JUnit needs at least ten threads to run a parallel test',
        'The Lua script only works when more than 5 callers arrive'
      ],
      answer: 1,
      why: 'A check against a limit can only be shown to work with more requests than the limit. The naive read-modify-write let all 10 pass (statuses all 200, expected exactly 3 of 200), and the test failed 6 of 6 runs.'
    },
    mount(el, ctx) {
      // Each protection: what really happened in the recorded runs, plus the arithmetic that extends it to other n.
      // 'meas' is set only where the design docs record a result; everything else is labelled illustrative.
      const P = {
        none: {
          label: 'No protection',
          what: 'rollback with @Lock removed', ok: 202, lose: 409, ex: n => 1, act: n => n,
          assert: 'one 202 and the rest 409',
          meas: { n: 2, runs: 5, text: 'Recorded in S3.3: with @Lock(OPTIMISTIC_FORCE_INCREMENT) removed, case 16 failed 5 of 5 runs in fresh JVMs with [202, 202] instead of [202, 409].' },
          db: 'ROLLBACK task rows: one per winner (reasoned from the design; the red run recorded statuses only)'
        },
        lock: {
          label: 'Force-increment lock',
          what: 'rollback with @Lock(OPTIMISTIC_FORCE_INCREMENT)', ok: 202, lose: 409, ex: n => 1, act: n => 1,
          assert: 'one 202 and the rest 409',
          meas: { n: 2, runs: 10, text: 'Recorded in S3.3: 10 of 10 runs green, the loser was ObjectOptimisticLockingFailureException every time (409 concurrent-modification). Section 10 also records no 500 in any run.' },
          db: 'exactly one ROLLBACK task row (asserted). The loser leaves an orphan audit row: 2 audit rows when it fails at commit (known gap, pinned until S6)'
        },
        unique: {
          label: 'Unique constraint',
          what: 'create an application with the same name', ok: 201, lose: 409, ex: n => 1, act: n => 1,
          assert: 'one 201 and the rest 409',
          meas: { n: 2, runs: null, text: 'concurrentCreate_sameName_oneCreated_oneConflict asserts [201, 409] and is green in the suite. No repeat count was recorded in the docs I read, so the repeat button is illustrative.' },
          db: 'not asserted: the test checks the two statuses only, not the row count'
        },
        claim: {
          label: 'Redis claim (idempotency key)',
          what: 'two POSTs with the same Idempotency-Key', ok: 202, lose: 409, ex: n => 1, act: n => 1,
          assert: 'one deployment; the loser is 409 request-in-progress',
          meas: { n: 2, runs: 10, text: 'Recorded in S3.5 section 11.3: case 6 run 10 times in fresh JVMs, exactly one deployment every time, the loser always 409 request-in-progress, never a replayed 202.' },
          db: 'exactly one deployment row (asserted by deploymentsFor)'
        },
        lua: {
          label: 'Lua script',
          what: 'burst of calls on a bucket of capacity 3', ok: 200, lose: 429, ex: n => Math.min(n, 3), act: n => Math.min(n, 3),
          assert: 'only 200 and 429, exactly 3 of 200',
          meas: { n: 10, runs: null, text: 'Recorded in S3.6: the closing run is green, "exactly 3 of 10 allowed". The Lua script runs as one step in Redis, so there is no gap to race in. A repeat count was not recorded, so the repeat button is illustrative.' },
          db: 'no rows: the bucket is one Redis hash'
        },
        naive: {
          label: 'Naive Java limiter',
          what: 'read-modify-write in Java on a bucket of capacity 3', ok: 200, lose: 429, ex: n => Math.min(n, 3), act: n => n,
          assert: 'only 200 and 429, exactly 3 of 200',
          meas: { n: 10, runs: 6, text: 'Recorded in S3.6: the test failed 6 of 6 runs in fresh JVMs. The last report shows ten 200s where exactly 3 were expected; every thread read a full bucket before any wrote back.' },
          db: 'no rows: the bucket is one Redis hash'
        }
      };
      const verdict = ui.verdict();
      const log = ui.log({ label: 'Runs', max: 12 });
      const lane = h('div', { class: 'stack' });
      let tally = null;
      let lastRun = null;

      const nSlider = ui.slider({ label: 'Requests', min: 2, max: 10, step: 1, value: 2, onInput: reset });
      const prot = ui.choice('Protection', Object.keys(P).map(k => ({ value: k, label: P[k].label })), 'lock', reset);
      const byWinner = ui.toggle('Assert which thread won', false, reset, { tone: 'danger' });
      const rReq = ui.readout('Simultaneous requests');
      const rSet = ui.readout('Outcome set');
      const rTest = ui.readout('Test result');
      const rDb = ui.readout('Database check');
      const rEv = ui.readout('Evidence');

      function conf() {
        const p = P[prot.get()];
        const n = nSlider.get();
        return { p, n, act: p.act(n), ex: p.ex(n), measured: p.meas.n === n };
      }
      function simulate() {
        const c = conf();
        const idx = [];
        for (let i = 0; i < c.n; i++) idx.push(i);
        for (let i = idx.length - 1; i > 0; i--) {
          const j = Math.floor(Math.random() * (i + 1));
          const t = idx[i]; idx[i] = idx[j]; idx[j] = t;
        }
        const winners = new Set(idx.slice(0, c.act));
        const statuses = [];
        for (let i = 0; i < c.n; i++) statuses.push(winners.has(i) ? c.p.ok : c.p.lose);
        const setPass = c.act === c.ex;
        const needsThread1 = byWinner.get() && c.ex === 1;
        const pass = setPass && (!needsThread1 || winners.has(0));
        return { statuses, pass, setPass, winners };
      }
      function setText(statuses) {
        const m = {};
        statuses.forEach(s => { m[s] = (m[s] || 0) + 1; });
        return Object.keys(m).sort().map(k => k + ' x' + m[k]).join(', ');
      }
      function doRuns(count) {
        const c = conf();
        if (!tally) tally = { runs: 0, passed: 0 };
        for (let i = 0; i < count; i++) {
          const r = simulate();
          tally.runs++;
          if (r.pass) tally.passed++;
          lastRun = r;
          log.add('run ' + tally.runs + ' (fresh JVM): [' + r.statuses.join(', ') + ']  ' + (r.pass ? 'pass' : (r.setPass ? 'FAIL: thread 1 did not win' : 'FAIL: ' + c.act + ' winners, expected ' + c.ex)), r.pass ? 'ok' : 'bad');
        }
        update();
      }
      function reset() {
        tally = null;
        lastRun = null;
        log.clear();
        update();
      }

      function update() {
        const c = conf();
        const shown = lastRun || simulate();
        AF.clear(lane);
        shown.statuses.forEach((s, i) => lane.append(ui.token('request ' + (i + 1) + ': ' + s, s === c.p.ok ? (c.act === c.ex ? 'ok' : 'bad') : 'warn')));
        rReq.set(c.n + ' (CyclicBarrier(' + c.n + '))');
        rSet.set(setText(shown.statuses));
        rDb.set(c.p.db);
        rEv.set(c.measured ? (c.p.meas.runs ? 'measured (design doc)' : 'one recorded green run, no repeat count') : 'illustrative arithmetic', c.measured ? 'ok' : 'warn');
        const setPass = c.act === c.ex;
        if (!tally) {
          rTest.set(setPass ? 'would pass: ' + c.p.assert : 'would fail: ' + c.act + ' winners, expected ' + c.ex, setPass ? 'ok' : 'bad');
          const base = c.measured ? c.p.meas.text : 'Illustrative: the numbers follow from the protection’s logic, not from a recorded run for ' + c.n + ' requests. ' + c.p.meas.text;
          const weak = (prot.get() === 'naive' || prot.get() === 'lua') && c.n <= 3 ? ' With ' + c.n + ' requests at capacity 3 even the naive limiter passes: this test cannot fail here.' : '';
          verdict.set(setPass ? (weak ? 'warn' : 'ok') : 'bad', 'Test: ' + c.p.what + ', ' + c.n + ' requests, asserting ' + c.p.assert + '. ' + base + weak);
          return;
        }
        const failed = tally.runs - tally.passed;
        const flaky = tally.passed > 0 && failed > 0;
        rTest.set(tally.passed + ' of ' + tally.runs + ' passed' + (flaky ? ' (flaky)' : ''), failed === 0 ? 'ok' : (flaky ? 'warn' : 'bad'));
        const rec = c.measured && c.p.meas.runs ? ' Recorded count for this case: ' + c.p.meas.runs + ' runs. ' + c.p.meas.text : (c.measured ? ' ' + c.p.meas.text : ' Illustrative run: not a recorded result.');
        const winnerNote = byWinner.get() && c.ex === 1 ? ' The winner is picked at random here (illustrative), so asserting it makes the test flaky.' : '';
        verdict.set(failed === 0 ? 'ok' : (flaky ? 'warn' : 'bad'), tally.passed + ' of ' + tally.runs + ' runs passed.' + rec + winnerNote);
      }

      el.append(
        controls(nSlider.el, prot.el, byWinner.el,
          ui.button('Run once', () => doRuns(1), { variant: 'primary' }),
          ui.button('Repeat the run', () => doRuns(conf().p.meas.runs && conf().measured ? conf().p.meas.runs : 10)),
          ui.button('Clear', reset, { variant: 'quiet' })),
        stage(h('div', { class: 'sim-cols' },
          ui.panel('Requests released by the barrier', lane),
          ui.panel('Runs', log.el))),
        readouts(rReq, rSet, rTest, rDb, rEv),
        note('Measured here: S3.3 section 10 (no lock: 5 of 5 red with [202, 202]; lock: 10 of 10 green), S3.5 section 11.3 (case 6, 10 of 10 runs), S3.6 section 11 (naive limiter: 6 of 6 red; Lua: exactly 3 of 10 allowed). Everything else, including every request count other than the recorded one, is illustrative arithmetic, and the thread that wins is a random pick.'),
        verdict.el
      );
      update();
    }
  });

  // ================= te-characterization (order 9) =================
  AF.register({
    id: 'te-characterization',
    group: 'testing',
    order: 9,
    title: 'Pin tests: recording what the code does, on purpose',
    question: 'When is it right to write a test that asserts today’s surprising behaviour instead of fixing it?',
    status: 'built',
    slice: 'S3.3, S3.6, S4.3, S4.5',
    where: [
      'control-api/src/test/java/io/appfleet/control/web/PermissionEnforcementTest.java (noPermission_withInvalidBody_answer)',
      'control-api/src/test/java/io/appfleet/control/web/RateLimitEndpointsTest.java (unknownRoutes_spendTokens)',
      'control-api/src/test/java/io/appfleet/control/web/DeploymentEndpointsTest.java (concurrentRollbacks_one202_one409_exactlyOneTask)',
      'control-api/src/test/java/io/appfleet/control/deployment/DeploymentNPlusOneTest.java (@Disabled naive_issuesOnePlusNStatements), DeploymentServiceAuditRecordingTest.java (@Disabled createBroken_auditRowDoesNotSurviveRollback)',
      'docs/design/control-api/control-api-s4-3-method-security.md sections 8, 9.3; control-api-s3-3-deployments.md section 5.2; control-api-s4-5-outbox.md section 9.2'
    ],
    idea: [
      'A pin test (the older name is a characterization test) asserts what the code does today, on purpose, when that behaviour is surprising but accepted. It is a signed note with three parts: the observed fact, the reason it is accepted, and a loud failure if the fact ever changes. That is different from a test that merely encodes a bug nobody noticed: there, nobody knows the behaviour is odd, so nobody will understand why the test breaks later.',
      'Appfleet has several, each with its reason. S4.3: a caller without the permission who sends an invalid body gets 400 and not 403, because Spring validates the body before it calls the proxied method; noPermission_withInvalidBody_answer pins it, with a comment. S3.6: unknown routes under /api/** spend a rate-limit token; unknownRoutes_spendTokens pins "1 real request allowed after two 404s". S3.3: the loser of a concurrent rollback leaves an orphan audit row; case 16 expects 2 audit rows when the loser is concurrent-modification. S2: two tests are @Disabled by design as reproducible documentation of a broken version: the naive N+1 and createBroken. And S4.5 shows the other side of prediction: rejectedRequests_writeNoMessage was predicted to pass for the wrong reason, came out red, and is kept because it pins more than the design said.',
      'Do not pin what you have not understood, and do not pin forever. Each pin names the change that should retire it: the filter-chain lock, add-mappings false, the S6 AFTER_COMMIT audit listener. A pin also does not say the behaviour is good: the 400-before-403 leak lets an unauthorised caller learn validation rules, and the S4.3 doc lists it under "what is not true". If the fact is plainly wrong and cheap to fix, fix it.'
    ],
    terms: [
      ['Pin test (characterization test)', 'A test that records the current behaviour, with a comment saying why it is accepted, so any change to it fails loudly.'],
      ['@Disabled by design', 'A test kept in the source but switched off, so a broken version can be reproduced on demand. It shows as skipped in the report.'],
      ['Orphan audit row', 'An audit row committed in its own REQUIRES_NEW transaction before the main commit failed, so it records a change that never happened.'],
      ['Known gap', 'A defect that is written down, tested as it is, and scheduled. S3.3 records the audit orphan for S6.'],
      ['Wrong-reason pass', 'A test that is green because nothing is implemented yet, so it proves nothing until the feature exists.']
    ],
    tryIt: [
      'With the first observation open, pick "Pin it" and read how a future reorder shows up in the suite; then pick "Document only".',
      'Press "Apply the future change" for each choice and compare the log: loud failure, silent regression, or nothing.',
      'Open "Orphan audit row" and read why the partial index was rejected. Then pick "Pin it" and note that the project marks it.',
      'Open "Disabled naive N+1" and see that "Document only" is the project’s choice there.',
      'Open "Prediction was wrong (S4.5)" and compare "Fix it" (loosen the test) with "Pin it" (keep it strict).'
    ],
    breakIt: 'Pick "Document only" on the unknown-routes observation, then apply the future change. Setting spring.web.resources.add-mappings to false stops the interceptor running for unknown routes, so probes become free, and nothing in the suite notices. The S3.6 doc says a count of 3 instead of 1 would be that signal, and only a pinned test turns it into a failure. The lab marks this as reasoned from the doc, not a recorded run.',
    say: 'When I accept surprising behaviour I pin it with a test that has a comment and a doc link, so a change fails loudly: Appfleet pins 400 before 403 on an invalid body, unknown routes spending a rate-limit token, and the orphan audit row of a lost rollback race until S6 fixes audit for every write path.',
    quiz: {
      q: 'Why does case 16 (concurrentRollbacks_one202_one409_exactlyOneTask) expect two audit rows when the loser is a concurrent-modification, rather than one?',
      options: [
        'Two rows is the correct design: one per request',
        'The loser’s REQUIRES_NEW audit row is committed before its commit fails at the version check; the test pins that known gap until S6’s AFTER_COMMIT listener',
        'The test double-counts because both requests share a transaction',
        'Hibernate writes the audit row twice when the force-increment lock is used'
      ],
      answer: 1,
      why: 'The forced version increment happens as a before-completion action at commit, after the audit row is already committed in its own transaction. In 10 of 10 runs of case 16 the loser took this path. The test pins it so the fix in S6 will make it fail loudly and prompt the edit.'
    },
    mount(el, ctx) {
      // Every observation is in the repo. "effect" is what a future change does to the suite:
      // loud (a test fails), silent (nothing fails, behaviour changes), nothing, or costly (more code, no new guard).
      const OBS = {
        order: {
          name: '400 before 403 (S4.3)',
          fact: 'A caller without the permission who posts an invalid body gets 400, not 403: Spring validates the body before it calls the proxied method, so the permission check never ran. Predicted, then confirmed: 27 of 27 green, and the manual check returned 400 too.',
          future: 'someone changes the order, for example adds requestMatchers rules in the filter chain as a second lock',
          project: 'pin',
          why: 'S4.3 section 8, decision 3: accepted if test 7 confirms it, and pinned with a comment. The cost is that an unauthorised caller learns the validation rules; section 9.6 lists it as not fixed.',
          opts: {
            fix: ['costly', 'Add the filter-chain requestMatchers so a caller without the permission gets 403 first. The design rejected this (decision 1): a second list of permissions to keep in step, which would need its own test that the two lists agree.', 'The 403 would then come before validation, and noPermission_withInvalidBody_answer would be rewritten to expect it.'],
            pin: ['loud', 'noPermission_withInvalidBody_answer asserts status 400, with a comment.', 'It goes red (expected 400, got 403) and someone has to decide again, on purpose.'],
            doc: ['silent', 'A sentence in the doc and no test.', 'Callers silently start seeing 403 where they saw 400, and nothing in the build says so. (Reasoned, not run.)']
          }
        },
        routes: {
          name: 'Unknown routes spend tokens (S3.6)',
          fact: 'GET /api/v1/nope twice returns 404 both times, then real requests are allowed once before the 429: the two 404s each spent a token. Observed 1; the design had said "probably". Boot’s static-resource handler matches /**, so the interceptor runs.',
          future: 'someone sets spring.web.resources.add-mappings to false',
          project: 'pin',
          why: 'S3.6 section 7.1, case 8: the behaviour is wanted (a scanner probing for endpoints is limited like any client), so it is not fixed. The test pins the number, so the setting change would force the decision to be looked at again.',
          opts: {
            fix: ['costly', 'Make unknown routes free, for example skip the limiter when no controller matches.', 'More code that removes a protection the design wants to keep.'],
            pin: ['loud', 'unknownRoutes_spendTokens expects exactly 1 allowed request after two 404s.', 'With add-mappings false the interceptor no longer sees unknown routes, the count becomes 3, and the test fails. The doc says a count of 3 would mean exactly that.'],
            doc: ['silent', 'Prose only.', 'Probing for endpoints becomes free and no test notices. (Reasoned from the doc, not run.)']
          }
        },
        audit: {
          name: 'Orphan audit row of a lost race (S3.3)',
          fact: 'The loser of a concurrent rollback has already committed ROLLBACK_REQUESTED in a REQUIRES_NEW transaction when its commit fails with 409 concurrent-modification. In 10 of 10 runs of case 16 the loser took this path.',
          future: 'S6 adds an AFTER_COMMIT listener that records audit only for committed changes',
          project: 'pin',
          why: 'S3.3 section 5.2: a partial unique index on open ROLLBACK tasks plus saveAndFlush was considered and not taken, because S6 fixes audit for every write path at once. Case 16 pins the behaviour: it expects two audit rows when the loser is concurrent-modification.',
          opts: {
            fix: ['costly', 'Add the partial unique index and saveAndFlush the task before the audit, so the loser fails before writing audit, as deploy does.', 'It works but is a one-path fix that S6 makes redundant; the doc chose to teach the lock instead.'],
            pin: ['loud', 'concurrentRollbacks_one202_one409_exactlyOneTask expects 2 audit rows when the loser is concurrent-modification and 1 when it is conflict.', 'When S6 lands, the loser has one row, the test fails, and the edit that follows is the sign that the gap is closed.'],
            doc: ['silent', 'The note in section 5.2 without the assertion.', 'After S6 the note is stale and no test says so. (Reasoned, not run.)']
          }
        },
        disabled: {
          name: 'Disabled naive N+1 (S2)',
          fact: 'DeploymentNPlusOneTest.naive_issuesOnePlusNStatements is @Disabled: it showed 51 statements for 150 tasks, and after @BatchSize on Deployment.tasks it cannot show 51 any more. DeploymentServiceAuditRecordingTest.createBroken_auditRowDoesNotSurviveRollback is @Disabled the same way. These are the "2 skipped by design" in the closing runs.',
          future: 'someone wants to reproduce the original defect',
          project: 'doc',
          why: 'S2 n-plus-one doc and service-layer-tests doc: keep the broken version as a @Disabled test, "documented, reproducible on demand, not run on every build". It is evidence, not a guard.',
          opts: {
            fix: ['nothing', 'Delete the test now that the defect is fixed.', 'The 51 can no longer be reproduced on demand; the evidence is gone.'],
            pin: ['costly', 'Leave the test enabled, asserting 51.', 'It would be red on every build, because the fix made it impossible to show 51, so it would be deleted or ignored soon.'],
            doc: ['nothing', 'Keep it @Disabled.', 'It never runs, protects nothing and breaks nothing; it shows as skipped and can be switched on by hand to reproduce the defect.']
          }
        },
        wrong: {
          name: 'Prediction was wrong (S4.5)',
          fact: 'rejectedRequests_writeNoMessage was predicted to pass for the wrong reason, because nothing writes outbox rows yet. It came out red: its last step, a successful rollback followed by a rejected second one, asserts exactly one row and found none. The test is stronger than the design table said.',
          future: 'someone later makes a rejected rollback write a second outbox message',
          project: 'pin',
          why: 'S4.5 section 9.2 recorded the surprise instead of hiding it, and kept the test as written: it also pins that a rejected rollback adds no second message. (Observed: the red run. The future change is hypothetical.)',
          opts: {
            fix: ['silent', 'Edit the test to pass as predicted by dropping its last step.', 'A rejected rollback that wrote a second message would go unseen. (Reasoned, not run.)'],
            pin: ['loud', 'Keep the test as written, exactly one row.', 'A second message makes the count 2 and the test fails.'],
            doc: ['nothing', 'Only note in the doc that the test is stronger than predicted.', 'Nothing in the suite changes; the doc is right and the test is the guard.']
          }
        }
      };
      const TONE = { loud: 'ok', silent: 'bad', nothing: 'idle', costly: 'warn' };
      const EFFECT = { loud: 'a loud failure', silent: 'a silent regression', nothing: 'nothing', costly: 'more code, no new guard' };
      const verdict = ui.verdict();
      const log = ui.log({ label: 'Future change', max: 8 });
      const factBox = h('p', { class: 'small' });
      const mineBox = h('p', { class: 'small' });
      const obs = ui.choice('Observation', Object.keys(OBS).map(k => ({ value: k, label: OBS[k].name })), 'order', reset);
      const dec = ui.choice('Your decision', [
        { value: 'fix', label: 'Fix it' },
        { value: 'pin', label: 'Pin it' },
        { value: 'doc', label: 'Document only' }
      ], 'pin', reset);
      const rDec = ui.readout('Your decision');
      const rEff = ui.readout('Effect of a later change');
      const rProj = ui.readout('Project chose');
      const rMatch = ui.readout('Same as the project?');

      function reset() {
        log.clear();
        update();
      }
      function update() {
        const o = OBS[obs.get()];
        const opt = o.opts[dec.get()];
        factBox.textContent = 'Observation: ' + o.fact;
        mineBox.textContent = 'What the project did: ' + ({ fix: 'fixed it', pin: 'pinned it', doc: 'documented only' }[o.project]) + '. ' + o.why;
        rDec.set({ fix: 'Fix it', pin: 'Pin it', doc: 'Document only' }[dec.get()]);
        rEff.set(EFFECT[opt[0]], TONE[opt[0]]);
        rProj.set({ fix: 'Fix it', pin: 'Pin it', doc: 'Document only' }[o.project]);
        rMatch.set(dec.get() === o.project ? 'yes' : 'no', dec.get() === o.project ? 'ok' : 'warn');
        verdict.set(TONE[opt[0]], opt[1] + ' ' + opt[2] + (dec.get() === o.project ? ' This is the project’s choice.' : ' The project chose differently: see above.'));
      }
      function apply() {
        const o = OBS[obs.get()];
        const opt = o.opts[dec.get()];
        log.add('Future change: ' + o.future + '.', 'busy');
        log.add('Suite reaction: ' + opt[2], opt[0] === 'loud' ? 'ok' : (opt[0] === 'silent' ? 'bad' : null));
      }

      el.append(
        controls(obs.el, dec.el, ui.button('Apply the future change', apply, { variant: 'primary' })),
        stage(h('div', { class: 'sim-cols' },
          ui.panel('From the repo', factBox, mineBox),
          ui.panel('Future change', log.el))),
        readouts(rDec, rEff, rProj, rMatch),
        note('The observations, test names and the project’s choices come from the S2, S3.3, S3.6, S4.3 and S4.5 docs. The consequence of each decision is reasoning about what a later change would do to the suite; only the red runs and the counts named in the docs were measured, and entries marked "reasoned" were not run.'),
        verdict.el
      );
      update();
    }
  });


  AF.register({
    id: 'te-diagnosing',
    group: 'testing',
    order: 10,
    title: 'Reading a red test when the code never throws',
    question: 'Every Spring test fails to start, or the topic is empty and no exception anywhere: which output tells you the cause, and what did each of the six S4.5 faults look like?',
    status: 'built',
    slice: 'S4.5',
    where: [
      'docs/design/control-api/control-api-s4-5-outbox.md, section 9.5 (the table of six faults and the two design lessons) and section 9.9 (the kill-test, kafka-init exit 1)',
      'docs/design/control-api/control-api-s4-5-outbox-code.md, section 14 (mistakes caught by a test) and section 15 task 0 (the KafkaTemplate and import traps)',
      'control-api/src/main/java/io/appfleet/control/outbox/OutboxPoller.java (the "Outbox cycle failed, will retry" and "Outbox message ... not sent" WARN lines)',
      'control-api/src/main/java/io/appfleet/control/outbox/OutboxProperties.java; control-api/pom.xml (spring-boot-starter-kafka)',
      'control-api/src/main/resources/db/migration/V6__add_outbox_pending_index.sql; control-api/src/test/java/io/appfleet/control/outbox/OutboxIndexTest.java, OutboxPollerTest.java'
    ],
    idea: [
      'When a test goes red you have several outputs to read, and the cause is in only one of them. A compile error is printed by the compiler and stops everything. A context failure (a bean missing, a schema that does not match an entity) fails every Spring test at once, so the list of failing tests tells you only that something shared broke; the cause is the last "Caused by" in the report of any one of them. A native query is a string the compiler cannot check, so its typo shows only when the query runs, and the statement you need is in the org.hibernate.SQL log at DEBUG. A send to a missing topic is reported by the Kafka producer’s own WARN. And a Flyway migration whose file name does not match V<n>__<description>.sql is not an error at all: it is silently not run.',
      'S4.5 produced a clean example of each. Section 9.5 of its doc lists six faults, each a one-character or one-line mistake, each "read from the test output, the log or the SQL, not guessed": a missing import (cannot find symbol: class OutboxProperties), the plain spring-kafka dependency (No qualifying bean of type KafkaTemplate, because Spring Boot 4 needs spring-boot-starter-kafka), @Column(name = "created_id") (Schema validation: missing column [created_id] in table [outbox_message], then created_At, because the check is case-sensitive), a nested record injected as a bean (No qualifying bean of type OutboxProperties), the typo sent_as in two native queries, and the default topic task.word instead of task.work. Two more are in the docs: a migration named after the test (OutboxIndexTest: EmptyResultDataAccessException) and kafka-init exiting 1 on the real stack.',
      'The two that were hardest to see share a cause that is a design choice. OutboxPoller never throws, on purpose, so that a dead broker cannot crash the scheduler; the price is that every bug inside a cycle becomes one WARN line, and a test that asserts on the topic fails with "empty" and no stack trace. With a green build and an empty topic, read the WARN and the SQL log first. And a send to a topic that does not exist blocks until the timeout instead of failing fast, so a wrong topic name looks like a slow, silent failure. This lesson does not repeat the red-first method (see "Red first"); it is about reading the output once a test is red.'
    ],
    terms: [
      ['Root "Caused by"', 'The last cause in a chained stack trace. A context failure wraps the real error several layers deep; the bottom line names it.'],
      ['Schema validation', 'Hibernate, with ddl-auto set to validate, checks every mapped column against the real table when the context starts. Column names are compared case-sensitively here (created_id, then created_At, were both rejected).'],
      ['Native query', 'SQL held in a string in the repository. The compiler cannot check it, so a wrong column name only shows when it runs.'],
      ['org.hibernate.SQL at DEBUG', 'The logger that prints every statement JPA sends. It also shows a statement that Postgres then rejects, with Postgres’s hint.'],
      ['Never-throwing poller', 'OutboxPoller catches RuntimeException inside a cycle and logs "Outbox cycle failed, will retry". Safe for a dead broker, quiet for a bug.'],
      ['Flyway naming', 'Flyway runs only files named V<n>__<description>.sql. Any other name is skipped without an error.']
    ],
    tryIt: [
      'Pick the fault "2. spring-kafka dependency" and the first read "Failing test names": it names every Spring test, so it shows that something shared broke and nothing else. Switch the first read to "Root Caused by of one report" and the cause appears.',
      'Pick "5. sent_as in a native query" and read "Root Caused by": there is none, the poller swallowed it. Switch to "org.hibernate.SQL log" and Postgres names the column and suggests sent_at.',
      'Pick "6. Topic task.word" and read "org.hibernate.SQL log": the SQL is fine, so that read is wasted. "Kafka client WARN" shows UNKNOWN_TOPIC_OR_PARTITION.',
      'Pick "1. Missing import" and read anything except "Compiler output": no test ran, so every other read is empty. Then compare with fault 2, where the compiler is fine and the failure is at startup.',
      'Pick "8. kafka-init exited 1" and note that no read among the six names the cause; the verdict says where it was found.'
    ],
    breakIt: 'Treat the list of failing tests as the diagnosis. When a context fails, every Spring test fails with it, so the list is the same for the missing dependency, the misspelled column and the unregistered bean: three different faults, one identical list. In the lab, choose faults 2, 3 and 4 in turn with "Failing test names" as the first read and see the same output each time; only the root Caused by differs.',
    say: 'When every Spring test fails at once I read the root "Caused by" of one report, not the list of failing tests; and when a poller that never throws leaves the topic empty with a green build, I read its WARN and the org.hibernate.SQL log first, which is how sent_as, task.word and a mis-named Flyway migration were each found in S4.5.',
    quiz: {
      q: 'After you add the poller, 40 Spring tests fail at once, including ones you did not touch. What is the quickest way to the cause?',
      options: [
        'Open the first failing test and step through it in a debugger',
        'Open the report of any one failing test and read the last "Caused by", for example No qualifying bean of type KafkaTemplate',
        'Run the failing tests one at a time to find which one is really broken',
        'Turn on org.hibernate.SQL at DEBUG and read the statements'
      ],
      answer: 1,
      why: 'A context that cannot start fails every test that needs it, so the 40 failures are one fault. Any one report carries the same root cause, and in S4.5 it named the missing bean, the missing column or the unregistered properties. The SQL log is for faults that happen after the context is up, such as a typo in a native query.'
    },
    mount(el, ctx) {
      // Real strings are copied from control-api-s4-5-outbox.md (9.2, 9.5, 9.9) and
      // control-api-s4-5-outbox-code.md (section 14 and task 0). An entry marked r:true is reasoned from the
      // mechanism, not captured from a report, and the lab labels it so.
      const READS = [
        { value: 'compiler', label: 'Compiler output' },
        { value: 'names', label: 'Failing test names' },
        { value: 'cause', label: 'Root Caused by of one report' },
        { value: 'sql', label: 'org.hibernate.SQL log' },
        { value: 'kafka', label: 'Kafka client WARN' },
        { value: 'flyway', label: 'Flyway startup log' }
      ];
      const ORDER = READS.map(r => r.value);
      const readLabel = v => READS.filter(r => r.value === v)[0].label;
      const NOCTX = 'Nothing to read: the module did not compile, so no test ran and no application started.';
      const FAULTS = {
        f1: {
          label: '1. Missing import',
          what: 'RateLimitInterceptorTest builds AppfleetProperties by hand and was missing the import of OutboxProperties.',
          where: 'S4.5 section 9.5, row 1; code doc task 0, trap 2',
          reads: {
            compiler: [2, 'cannot find symbol: class OutboxProperties (in RateLimitInterceptorTest)'],
            names: [0, NOCTX, true],
            cause: [0, NOCTX, true],
            sql: [0, NOCTX, true],
            kafka: [0, NOCTX, true],
            flyway: [0, NOCTX, true]
          }
        },
        f2: {
          label: '2. spring-kafka dependency',
          what: 'control-api/pom.xml listed the plain spring-kafka library. Spring Boot 4 needs spring-boot-starter-kafka for the auto-configuration.',
          where: 'S4.5 section 9.5, row 2; code doc task 0, trap 1',
          reads: {
            compiler: [0, 'Nothing wrong: the library provides the KafkaTemplate class, so the code compiles. The bean is what is missing, and that is a startup fact.', true],
            names: [1, 'Every Spring test is red ("every Spring test failed"). The list shows that something shared broke, not what.'],
            cause: [2, 'No qualifying bean of type \'org.springframework.kafka.core.KafkaTemplate<java.lang.String, java.lang.String>\''],
            sql: [0, 'Nothing useful: the context never finished starting, so no test reaches a query.', true],
            kafka: [0, 'Nothing: no producer was ever created, so there is no Kafka client output.', true],
            flyway: [0, 'Nothing wrong: the migrations are not the problem. A Flyway log, if it appears before the failure, lists normal applied versions.', true]
          }
        },
        f3: {
          label: '3. created_id column',
          what: '@Column(name = "created_id") instead of created_at, then created_At. Hibernate validates entities against the schema at startup and compares column names case-sensitively.',
          where: 'S4.5 section 9.5, row 3',
          reads: {
            compiler: [0, 'Nothing wrong: the column name is a string inside an annotation, which the compiler does not check.', true],
            names: [1, 'Every Spring test is red ("every Spring test failed"), the same list as faults 2 and 4.'],
            cause: [2, 'Schema validation: missing column [created_id] in table [outbox_message]'],
            sql: [0, 'Nothing useful: validation runs while the context starts, before any test sends a statement.', true],
            kafka: [0, 'Nothing: the context did not start, so no producer exists.', true],
            flyway: [0, 'Nothing wrong: the table is correct, it is the entity that is wrong. Applied versions look normal.', true]
          }
        },
        f4: {
          label: '4. OutboxProperties as a bean',
          what: 'OutboxPoller and OutboxScheduling injected the nested record OutboxProperties; only AppfleetProperties is a bean.',
          where: 'S4.5 section 9.5, row 4',
          reads: {
            compiler: [0, 'Nothing wrong: the record exists and the injection point is valid Java. Whether it is a bean is decided at startup.', true],
            names: [1, 'Every Spring test is red ("every Spring test failed"), the same list as faults 2 and 3.'],
            cause: [2, 'No qualifying bean of type OutboxProperties'],
            sql: [0, 'Nothing useful: no test reaches a query when the context does not start.', true],
            kafka: [0, 'Nothing: the poller bean that owns the producer calls never got created.', true],
            flyway: [0, 'Nothing wrong with the migrations.', true]
          }
        },
        f5: {
          label: '5. sent_as in a native query',
          what: 'Typos in two native queries (sent_as, then sent_As). The poller catches the exception, so the test fails on an empty topic and no stack trace.',
          where: 'S4.5 section 9.5, row 5 and the first design lesson',
          reads: {
            compiler: [0, 'Nothing wrong: a native query is a string the compiler cannot check, so a typo compiles.'],
            names: [1, 'OutboxPollerTest is red, with no warning in the test summary. It names the class, not the reason.'],
            cause: [0, 'No exception reaches the test: the poller never throws, so the report shows an assertion on the topic failing as empty, with no Caused by to follow.', true],
            sql: [2, 'WARN Outbox cycle failed, will retry; Postgres: column "sent_as" does not exist. Hint: "Perhaps you meant to reference the column ... sent_at". Found with org.hibernate.SQL at DEBUG.'],
            kafka: [0, 'Nothing: the query failed first, so no send was attempted and the producer had nothing to report.', true],
            flyway: [0, 'Nothing wrong: the column is sent_at in the table; the string in the query is what is wrong.', true]
          }
        },
        f6: {
          label: '6. Topic task.word',
          what: '@DefaultValue("task.word") in OutboxProperties instead of task.work (fixed twice: the first fix missed one). A send to a missing topic blocks until the timeout and fails quietly.',
          where: 'S4.5 section 9.5, row 6 and the second design lesson',
          reads: {
            compiler: [0, 'Nothing wrong: a topic name is a string default.'],
            names: [1, 'OutboxPollerTest is red and, per the doc, "SQL fine". It names the class, not the reason.'],
            cause: [0, 'No exception reaches the test: the failed send is swallowed by the poller, so the report shows an empty topic assertion.', true],
            sql: [0, 'The SQL is fine: the cycle ran and the row was selected. That read rules out the query and tells you nothing more.'],
            kafka: [2, 'The producer’s own WARN: {task.word=UNKNOWN_TOPIC_OR_PARTITION}. The send blocked until the timeout first, so the failure also looked slow.'],
            flyway: [0, 'Nothing wrong with the migrations.', true]
          }
        },
        f7: {
          label: '7. Migration named after the test',
          what: 'The file was named v6_createsThePartialPendingIndex.sql. Flyway only runs V<n>__<description>.sql, so V6 never ran. Not one of the six rows of 9.5; it is from section 9.2 and code doc section 14.',
          where: 'S4.5 section 9.2 (test 14, OutboxIndexTest) and code doc section 14',
          reads: {
            compiler: [0, 'Nothing wrong: SQL files are not compiled.', true],
            names: [1, 'Only OutboxIndexTest is red; the context starts. That is the difference from faults 2 to 4: the list is short.', true],
            cause: [1, 'EmptyResultDataAccessException: Incorrect result size: expected 1, actual 0. It says the index is not there, not why.'],
            sql: [0, 'Nothing useful: the test reads pg_indexes, and the statement is fine; the result is just empty.', true],
            kafka: [0, 'Nothing: Kafka is not involved.', true],
            flyway: [2, 'Wording not captured. The applied versions stop at V5 and the misnamed file is not among them; Flyway skips a file that does not match V<n>__<description>.sql without an error.', true]
          }
        },
        f8: {
          label: '8. kafka-init exited 1',
          what: 'On the real stack, kafka-init could not reach the broker because the broker advertises localhost:9092, so no topics existed and compose disables auto-creation. Found by hand in the kill-test, S4.5 section 9.9.',
          where: 'S4.5 section 9.9, step 3',
          beyond: 'Not among the six reads: "docker compose up kafka-init" exited with code 1 (Timed out waiting for a node assignment). Inside the init container localhost is the container itself.',
          reads: {
            compiler: [0, 'Nothing: the build was green.', true],
            names: [0, 'Nothing red: the doc records no failing test for this; the fault was met on the real stack, not in the suite.', true],
            cause: [0, 'Nothing: no test failed, so there is no report.', true],
            sql: [0, 'Nothing wrong: the row stayed pending (sent_at null), exactly as designed.', true],
            kafka: [1, 'The poller’s WARN, 29 lines in 2.5 minutes: Outbox message ... not sent: KafkaException: Send failed. It says the sends fail, and that no request failed and nothing was lost; it does not say why topics are missing.'],
            flyway: [0, 'Nothing wrong with the migrations.', true]
          }
        }
      };

      const fault = ui.choice('Fault', Object.keys(FAULTS).map(k => ({ value: k, label: FAULTS[k].label })), 'f2', update);
      const first = ui.choice('Read first', READS, 'names', update);

      const verdict = ui.verdict();
      const rFault = ui.readout('Fault source');
      const rLevel = ui.readout('First read shows');
      const rWaste = ui.readout('Reads wasted');
      const rBest = ui.readout('Quickest first read');
      const firstBox = ui.code('', 'First output read');
      const trailBox = ui.code('', 'Reads in standard order until the cause shows');
      const causeBox = ui.code('', 'The fault');

      const LEVEL = ['nothing about the cause', 'a hint, not the cause', 'the cause'];
      const TONE = ['bad', 'warn', 'ok'];
      const cell = (F, r) => {
        const c = F.reads[r];
        return { level: c[0], text: (c[2] ? '[reasoned from the mechanism, not captured] ' : '') + c[1] };
      };

      function update() {
        const F = FAULTS[fault.get()];
        const pick = first.get();
        const levels = ORDER.map(r => F.reads[r][0]);
        const best = Math.max.apply(null, levels);
        const bestRead = ORDER[levels.indexOf(best)];
        const seq = [pick].concat(ORDER.filter(r => r !== pick));
        const hit = seq.findIndex(r => F.reads[r][0] === best);
        const wasted = hit;

        const c = cell(F, pick);
        setCode(causeBox, F.what + '\n\nSource: ' + F.where + (F.beyond ? '\n\n' + F.beyond : ''));
        setCode(firstBox, readLabel(pick) + '\n' + c.text);
        const lines = [];
        for (let i = 1; i <= hit; i++) {
          const r = seq[i];
          lines.push(readLabel(r) + ' (' + LEVEL[F.reads[r][0]] + ')\n  ' + cell(F, r).text);
        }
        setCode(trailBox, hit === 0 ? 'The first read already shows the most that any of the six outputs can show for this fault.' : lines.join('\n'));

        rFault.set(fault.get() === 'f7' || fault.get() === 'f8' ? 'S4.5 docs, outside the 9.5 table' : 'S4.5 table, 9.5');
        rLevel.set(LEVEL[c.level], TONE[c.level]);
        rWaste.set(String(wasted), wasted === 0 ? 'ok' : wasted > 2 ? 'bad' : 'warn');
        rBest.set(readLabel(bestRead), 'ok');

        let text;
        if (wasted === 0) {
          text = 'Quickest first read for this fault: ' + readLabel(bestRead) + '. ' + (best === 2 ? 'It shows the cause.' : 'It is the best of the six, but it shows only a hint.') + ' Zero reads wasted.';
        } else {
          text = readLabel(pick) + ' shows ' + LEVEL[c.level] + ', so ' + wasted + (wasted === 1 ? ' read was' : ' reads were') + ' wasted (counting the other outputs in the standard order) before ' + readLabel(bestRead) + ', the quickest first read, ' + (best === 2 ? 'showed the cause.' : 'gave the best hint.');
        }
        if (best < 2) text += ' No read among the six names the cause: it was found outside them.';
        verdict.set(wasted === 0 ? 'ok' : wasted > 2 ? 'bad' : 'warn', text);
      }

      el.append(
        controls(fault.el, first.el),
        stage(h('div', { class: 'sim-cols' },
          ui.panel('What was wrong', causeBox),
          ui.panel('What you read', firstBox, trailBox))),
        readouts(rFault, rLevel, rWaste, rBest),
        note('Strings in quotation or code form come from control-api-s4-5-outbox.md and control-api-s4-5-outbox-code.md. A line marked "reasoned from the mechanism" was not captured in a report: it is what that output can or cannot contain given when the failure happens. "Reads wasted" counts outputs that did not show the best available information, starting from the one you picked and then following the order compiler, test names, root Caused by, SQL log, Kafka WARN, Flyway log. It is a teaching count, not a measurement.'),
        verdict.el
      );
      update();
    }
  });

  // @@LESSONS@@
})();
