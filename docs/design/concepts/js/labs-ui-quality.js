/*
 * labs-ui-quality.js: the "Mocking and testing" and "Design system and access" lessons for
 * "How the Appfleet console works" (appfleet-ui-concepts.html).
 *
 *   ui-msw          MSW in the browser, in hybrid mode and in tests          built, P1
 *   ui-sim-backend  the simulated backend with a clock (src/mocks/db.ts)    built, P1
 *   ui-testing      four layers of tests, queries by role and name          built, P1
 *   ui-types        hand-written wire types, generated after S3.7           in progress, P1 and P2
 *   ui-tokens       tokens.css, CSS Modules, statusTone and StatusChip      built, P1
 *   ui-responsive   rem sizes, four breakpoints, pair layout, table scroll  built, P1
 *   ui-a11y         roles, names, live regions, words next to colour        built, P1
 *
 * Facts come from web-console/ (src/mocks, src/test, src/api, src/styles, src/components,
 * src/features/*.test.tsx, README.md) and docs/design/ux/web-console-react-plan.md §3 and §8.9.
 * The type-check results in ui-types were measured by running tsc 6.0.3 on a copy of
 * web-console with each change applied (2 October 2026).
 */
(function () {
  'use strict';

  const h = AF.h;
  const ui = AF.ui;

  // ---------- small helpers ----------
  const SVG_NS = 'http://www.w3.org/2000/svg';

  /** SVG element builder (AF.h makes HTML elements only). */
  function sv(tag, attrs, ...kids) {
    const el = document.createElementNS(SVG_NS, tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        el.setAttribute(k, String(v));
      }
    }
    for (const kid of kids) {
      if (kid === null || kid === undefined || kid === false) continue;
      el.appendChild(kid instanceof Node ? kid : document.createTextNode(String(kid)));
    }
    return el;
  }

  const controls = (...kids) => h('div', { class: 'sim-controls' }, kids);
  const stage = (...kids) => h('div', { class: 'sim-stage' }, kids);
  const cols = (...kids) => h('div', { class: 'sim-cols' }, kids);
  const readouts = (...items) => h('div', { class: 'readouts' }, items.map(r => r.el));
  const note = text => h('p', { class: 'small muted' }, text);
  const label = text => h('span', { class: 'small muted' }, text);
  const setCode = (pre, text) => { pre.firstChild.textContent = text; };
  /** A token whose text may wrap, for long labels at phone width (layout only). */
  function wrapTok(text, tone) {
    const t = ui.token(text, tone);
    t.style.whiteSpace = 'normal';
    return t;
  }
  /** A code block whose long lines wrap, for narrow panels (layout only). */
  function wrapCode(text, labelText) {
    const pre = ui.code(text, labelText);
    pre.style.whiteSpace = 'pre-wrap';
    pre.style.overflowWrap = 'anywhere';
    return pre;
  }
  const secs = ms => (ms / 1000).toFixed(1) + ' s';
  /** A pause that shrinks to nothing when the reader prefers reduced motion. */
  const pause = (ctx, ms) => AF.sleep(ctx, ctx.reducedMotion ? 0 : ms);

  function hexChars(n) {
    let out = '';
    for (let i = 0; i < n; i++) out += Math.floor(Math.random() * 16).toString(16);
    return out;
  }
  function uuid7() {
    const ts = Date.now().toString(16).padStart(12, '0');
    return ts.slice(0, 8) + '-' + ts.slice(8, 12) + '-7' + hexChars(3) + '-' + '89ab'[Math.floor(Math.random() * 4)] + hexChars(3) + '-' + hexChars(12);
  }
  const short = id => id.slice(0, 8) + '…';

  /** ui.verdict that skips identical updates, so the status region is not re-announced on every tick. */
  function stableVerdict() {
    const v = ui.verdict();
    let last = '';
    return {
      el: v.el,
      set(tone, text) {
        const k = tone + '|' + text;
        if (k === last) return;
        last = k;
        v.set(tone, text);
      },
      clear() { last = ''; v.clear(); }
    };
  }

  /** A .node whose label and sub line can be updated. */
  function liveNode(text, sub, tone) {
    const labelEl = h('span', null, text);
    const subEl = h('span', { class: 'node-sub' }, sub || '');
    const el = AF.tone(h('div', { class: 'node' }, labelEl, subEl), tone || null);
    return {
      el,
      set(l, s, tn) {
        if (l !== null && l !== undefined) labelEl.textContent = l;
        if (s !== null && s !== undefined) subEl.textContent = s;
        AF.tone(el, tn || null);
      }
    };
  }

  function shortLog(labelText, maxRem) {
    const lg = ui.log({ label: labelText });
    lg.el.style.maxHeight = (maxRem || 9) + 'rem';
    return lg;
  }

  // =====================================================================
  // 1. Mock Service Worker (built, P1)
  // =====================================================================
  AF.register({
    id: 'ui-msw',
    group: 'quality',
    order: 1,
    title: 'Mocking the network with MSW',
    question: 'How can the console run, and be tested, before the services it calls exist?',
    status: 'built',
    slice: 'P1',
    where: [
      'web-console/src/mocks/handlers/control.ts',
      'web-console/src/mocks/browser.ts',
      'web-console/src/main.tsx',
      'web-console/src/test/setup.ts'
    ],
    idea: [
      'Mock Service Worker (MSW) answers HTTP requests at the network layer. The app calls fetch as usual; MSW catches the request on its way out, and a handler returns a real Response with a status, headers and a body. The app cannot tell, and that is the point: http.ts, the headers and the error parsing all run exactly as they will against the real service.',
      'In the browser, src/mocks/browser.ts sets up a service worker, and main.tsx starts it with onUnhandledFrame: \'bypass\', so anything without a handler, such as the page\'s own scripts, goes to the network untouched. In tests, src/test/server.ts runs the same handlers in Node, and setup.ts starts it with onUnhandledFrame: \'error\', so a request nobody mocked fails the test.',
      'Hybrid mode adds passthrough(). Handlers for endpoints control-api already has hand the request on to the Vite proxy, which sends it to localhost:8081. Endpoints control-api still lacks answer 501 not-implemented, and so do query-service views, rather than mixing simulated rows with live ones. One set of handlers serves the demo, hybrid mode and every test.'
    ],
    terms: [
      ['Service worker', 'A script the browser runs between a page and the network. It can answer a request itself.'],
      ['Handler', 'A function that matches a method and a path and returns a Response, here from the simulated database.'],
      ['passthrough()', 'An MSW answer that means: do not mock this one, send the real request on.'],
      ['Handler drift', 'Test fakes that still describe last month\'s API while the real one has moved on.']
    ],
    tryIt: [
      'Leave Mode on mock and Endpoint on POST /deployments, and press Send request: the service worker hands it to the handler, which answers 202 from the simulated database.',
      'Switch Mode to hybrid and send again: the handler calls passthrough() and the proxy forwards to control-api on :8081. Try GET /environments and GET /dashboard/overview: 501 not-implemented.',
      'Switch Mode to test, choose No handler and send: the unhandled request fails the test.',
      'Turn on Mock fetch separately in each test, then press Backend renames a field: the tests stay green while the app breaks. Press Fix the screen and watch what the fakes do then.'
    ],
    breakIt: 'Without shared handlers, each test fakes fetch with its own hand-written JSON. When control-api renames a field, those fakes keep the old shape, the tests stay green, and the first person to notice is a user.',
    say: 'MSW intercepts real fetch calls at the network layer, so one set of handlers backed by a simulated database serves the browser demo, hybrid mode with passthrough() to the live control-api, and every test, where an unhandled request fails the test.',
    quiz: {
      q: 'Why does the browser start MSW with onUnhandledFrame: \'bypass\' while the tests start it with \'error\'?',
      options: [
        'Service workers cannot raise errors, so the browser has no other choice',
        'In the browser, requests without a handler, such as the page\'s own scripts, must reach the dev server; in a test, a request without a handler means a handler is missing, and failing loudly beats quietly calling a real network',
        '\'error\' is faster, and test suites need speed',
        'The two settings behave the same; they only change how much is logged'
      ],
      answer: 1,
      why: 'The browser loads its own code through the same network the worker watches, so unmatched requests have to pass. A test has no such traffic: an unmatched request is a gap in the mocks, and \'error\' turns that gap into a failing test instead of a flaky call to whatever happens to be listening.'
    },
    mount(el, ctx) {
      const EP = {
        deploy: { method: 'POST', path: '/api/v1/deployments', kind: 'built' },
        env: { method: 'GET', path: '/api/v1/environments', kind: 'gap' },
        dash: { method: 'GET', path: '/api/v1/dashboard/overview', kind: 'read' },
        none: { method: 'GET', path: '/api/v1/reports/weekly', kind: 'none' }
      };

      let running = false;
      let epoch = 0;
      let reqNo = 0;
      let renamed = false;
      let fixed = false;

      const log = shortLog('Request log', 9);
      const verdict = stableVerdict();
      const driftVerdict = stableVerdict();

      // ---- controls
      /** Stops a request that is still moving, so a new mode or endpoint starts clean. */
      function cancel() {
        epoch++;
        running = false;
        sendBtn.disabled = false;
        resetPath();
      }
      const modeC = ui.choice('Mode', [
        { value: 'mock', label: 'mock' },
        { value: 'hybrid', label: 'hybrid' },
        { value: 'test', label: 'test' }
      ], 'mock', () => cancel());
      const epC = ui.choice('Endpoint', [
        { value: 'deploy', label: 'POST /deployments' },
        { value: 'env', label: 'GET /environments' },
        { value: 'dash', label: 'GET /dashboard/overview' },
        { value: 'none', label: 'No handler' }
      ], 'deploy', () => cancel());
      const sendBtn = ui.button('Send request', () => { send(); }, { variant: 'primary' });
      const fakeT = ui.toggle('Mock fetch separately in each test', false, on => {
        log.add(on ? 'Break: each test replaces fetch with its own hand-written answer'
          : 'Fixed: tests run against the shared handlers through the Node interceptor', on ? 'bad' : 'ok');
        resetPath();
        renderDrift();
      }, { tone: 'danger' });
      const resetBtn = ui.button('Reset', reset, { variant: 'quiet' });

      const renameBtn = ui.button('Backend renames a field', () => {
        if (renamed) return;
        renamed = true;
        log.add('control-api now answers POST /deployments with id instead of deploymentId (illustrative)', 'warn');
        renderDrift();
      });
      const fixBtn = ui.button('Fix the screen', () => {
        if (!renamed || fixed) return;
        fixed = true;
        log.add('DeployPage now reads accepted.id', 'muted');
        renderDrift();
      }, { disabled: true });

      // ---- lanes
      const lanes = [ui.lane('1. The app', 'calls fetch'), ui.lane('2. Caught by'), ui.lane('3. Answered by'), ui.lane('4. Response')];
      const slots = lanes.map(l => {
        const slot = h('div', { class: 'row', style: 'min-height:1.9rem' });
        l.body.appendChild(slot);
        return slot;
      });
      const N = {
        http: liveNode('http.ts', 'adds X-Correlation-Id, then calls fetch'),
        sw: liveNode('Service worker', 'browser: src/mocks/browser.ts'),
        node: liveNode('Node interceptor', 'tests: setupServer in src/test/server.ts'),
        fake: liveNode('Fake fetch in the test', 'hand-written JSON, one per test'),
        handler: liveNode('Handler and simulated db', 'tick(), then control-api\'s rules'),
        proxy: liveNode('Vite proxy, then control-api', 'passthrough() to localhost:8081'),
        notBuilt: liveNode('501 not-implemented', 'notBuilt(): not in the live backend yet'),
        bypass: liveNode('The network, unmocked', 'onUnhandledFrame: \'bypass\''),
        error: liveNode('Unhandled request error', 'onUnhandledFrame: \'error\''),
        fakeAns: liveNode('The test\'s own JSON', 'never checked against control-api')
      };
      lanes[0].body.appendChild(N.http.el);
      ['sw', 'node', 'fake'].forEach(k => lanes[1].body.appendChild(N[k].el));
      ['handler', 'proxy', 'notBuilt', 'bypass', 'error', 'fakeAns'].forEach(k => lanes[2].body.appendChild(N[k].el));
      const respText = h('p', { class: 'small muted' }, 'Nothing sent yet.');
      lanes[3].body.appendChild(respText);

      const rAnswer = ui.readout('Answered by', '—');
      const rStatus = ui.readout('Status', '—');
      const rShared = ui.readout('Handlers in use', 'shared');

      const rApi = ui.readout('control-api sends', 'deploymentId');
      const rMock = ui.readout('Tests are answered with', 'deploymentId');
      const rScreen = ui.readout('DeployPage reads', 'deploymentId');
      const rTests = ui.readout('Full-app tests', 'pass');
      const rApp = ui.readout('App against control-api', 'works');

      el.append(
        controls(modeC.el, epC.el),
        controls(sendBtn, fakeT.el, resetBtn),
        stage(cols(lanes[0].el, lanes[1].el, lanes[2].el, lanes[3].el)),
        readouts(rAnswer, rStatus, rShared),
        verdict.el,
        ui.panel('Handler drift: control-api renames deploymentId to id',
          h('div', { class: 'row' }, renameBtn, fixBtn),
          readouts(rApi, rMock, rScreen, rTests, rApp),
          driftVerdict.el),
        log.el,
        note('The rename is illustrative; control-api has not changed this field. The test that would catch it is the first one in DeployPage.test.tsx, which checks that Follow progress links to /deployments/ followed by a UUID. Paths and wrappers (built, gap, read, notBuilt) are the real ones in src/mocks/handlers; /api/v1/reports/weekly stands for any path no handler matches.')
      );

      // ---- routing: who answers what, in which mode
      function route(mode, ep, fake) {
        if (mode === 'test' && fake) {
          return {
            via: 'fake', by: 'fakeAns', status: ep.kind === 'built' ? '202 Accepted' : '200 OK', tone: 'warn', who: 'the test\'s own JSON',
            text: 'The test replaced fetch, so no handler ran. The answer is whatever the test author typed, and nothing compares it with control-api.' +
              (ep.kind === 'none' ? ' Even a path nobody serves gets an answer, so a missing handler is never noticed.' : '')
          };
        }
        const via = mode === 'test' ? 'node' : 'sw';
        if (ep.kind === 'none') {
          if (mode === 'test') {
            return {
              via, by: 'error', status: 'Request error', tone: 'bad', who: 'nobody: the test fails',
              text: 'No handler matches, and setup.ts starts the server with onUnhandledFrame: \'error\', so the request fails and the test with it. A missing handler shows up at once instead of a test quietly calling the network.'
            };
          }
          return {
            via, by: 'bypass', status: 'Not mocked', tone: 'warn', who: 'the network',
            text: 'No handler matches, and main.tsx starts the worker with onUnhandledFrame: \'bypass\', so the request leaves the browser as if MSW were not there. The same rule lets the page load its own scripts and styles.'
          };
        }
        if (mode === 'hybrid') {
          if (ep.kind === 'built') {
            return {
              via, by: 'proxy', status: '202 Accepted', tone: 'ok', who: 'control-api on :8081',
              text: 'The handler is wrapped in built(), which returns passthrough() in hybrid mode. The request goes on to the Vite proxy, which sends /api/v1/deployments to localhost:8081, and the live control-api answers.'
            };
          }
          return {
            via, by: 'notBuilt', status: '501 not-implemented', tone: 'warn', who: 'notBuilt()',
            text: ep.kind === 'gap'
              ? 'GET /api/v1/environments is backend gap 2: control-api does not have it yet. In hybrid mode gap() answers 501 not-implemented, and the deploy screen falls back to typing the environment.'
              : 'The dashboard is a query-service view (S6). In hybrid mode it answers 501 rather than putting simulated rows next to live ones, and the screen says which service it is waiting for.'
          };
        }
        const test = mode === 'test';
        if (ep.kind === 'built') {
          return {
            via, by: 'handler', status: '202 Accepted', tone: 'ok', who: 'the shared handler',
            text: test
              ? 'The same handler as in the browser, running in Node. setup.ts calls resetDb() before every test, so each test starts from the same seeded world.'
              : 'built() runs tick(), then the handler applies control-api\'s rules to the simulated database: 202 Accepted with a Location header, or 409 if the environment already has an active deployment.'
          };
        }
        if (ep.kind === 'gap') {
          return {
            via, by: 'handler', status: '200 OK', tone: 'ok', who: 'the shared handler',
            text: 'gap() simulates an endpoint control-api does not have yet (gap 2), so the deploy screen can offer a picker of the four environments today.' +
              (test ? ' Tests get the same answer.' : '')
          };
        }
        return {
          via, by: 'handler', status: '200 OK', tone: 'ok', who: 'the shared handler',
          text: test
            ? 'The simulated query-service view, as in the browser. A test can swap one handler for one test with server.use(), as DashboardPage.test.tsx does to check the 501 message.'
            : 'read() simulates query-service: deployments younger than 1.5 s are left out, and asOf says how far behind the view is.'
        };
      }

      function resetPath() {
        const mode = modeC.get();
        const fake = fakeT.get();
        Object.keys(N).forEach(k => N[k].set(null, null, null));
        // nodes this mode can never use are drawn dashed
        const unused = mode === 'test'
          ? (fake ? ['sw', 'node', 'handler', 'proxy', 'notBuilt', 'bypass', 'error'] : ['sw', 'fake', 'proxy', 'notBuilt', 'bypass', 'fakeAns'])
          : ['node', 'fake', 'error', 'fakeAns'].concat(mode === 'mock' ? ['proxy', 'notBuilt'] : []);
        unused.forEach(k => N[k].set(null, null, 'idle'));
        slots.forEach(s => AF.clear(s));
        respText.textContent = 'Nothing sent yet.';
        rShared.set(mode === 'test' && fake ? 'a fake per test' : 'shared', mode === 'test' && fake ? 'bad' : null);
      }

      async function send() {
        if (running) return;
        running = true;
        sendBtn.disabled = true;
        const ep = epoch;
        const no = ++reqNo;
        const mode = modeC.get();
        const e = EP[epC.get()];
        const r = route(mode, e, fakeT.get());
        resetPath();
        log.add('#' + no + ' ' + mode + ' mode: ' + e.method + ' ' + e.path, 'muted');
        const tok = ui.token(e.method + ' ' + e.path.replace('/api/v1', ''), 'busy');
        slots[0].appendChild(tok);
        N.http.set(null, null, 'busy');
        const steps = [[1, r.via], [2, r.by]];
        for (const [lane, node] of steps) {
          await pause(ctx, 420);
          if (!ctx.alive || ep !== epoch) return;
          slots[lane].appendChild(tok);
          N[node].set(null, null, 'busy');
        }
        await pause(ctx, 420);
        if (!ctx.alive || ep !== epoch) return;
        slots[3].appendChild(tok);
        tok.textContent = r.status;
        AF.tone(tok, r.tone);
        N[r.by].set(null, null, r.tone);
        respText.textContent = 'From ' + r.who + '.';
        rAnswer.set(r.who);
        rStatus.set(r.status, r.tone);
        verdict.set(r.tone, r.text);
        log.add('#' + no + ' ' + r.status + ' from ' + r.who, r.tone);
        running = false;
        sendBtn.disabled = false;
      }

      function renderDrift() {
        const fake = fakeT.get();
        const apiField = renamed ? 'id' : 'deploymentId';
        // Shared handlers follow types.ts, which follows control-api; hand-written fakes do not.
        const mockField = fake ? 'deploymentId' : apiField;
        const screenField = fixed ? 'id' : 'deploymentId';
        const testsPass = mockField === screenField;
        const appWorks = apiField === screenField;
        rApi.set(apiField, renamed ? 'warn' : null);
        rMock.set(mockField, mockField !== apiField ? 'bad' : null);
        rScreen.set(screenField);
        rTests.set(testsPass ? 'pass' : 'fail', testsPass ? 'ok' : 'bad');
        rApp.set(appWorks ? 'works' : 'broken', appWorks ? 'ok' : 'bad');
        renameBtn.disabled = renamed;
        fixBtn.disabled = !renamed || fixed;
        if (!renamed) {
          driftVerdict.set(fake ? 'warn' : 'ok', fake
            ? 'Everything agrees for now, but each fake is a copy of today\'s API. Press Backend renames a field.'
            : 'Everything agrees: control-api, the shared handler and the screen all use deploymentId. Press Backend renames a field.');
        } else if (!fake && !fixed) {
          driftVerdict.set('warn', 'Caught before release: types.ts and the shared handler now say id, so the full-app test fails because Follow progress points to /deployments/undefined, and the type check flags the same line. Press Fix the screen.');
        } else if (!fake && fixed) {
          driftVerdict.set('ok', 'Fixed in one place: the handler, the browser demo, hybrid mode and every test agree on id again, and the test passes.');
        } else if (fake && !fixed) {
          driftVerdict.set('bad', 'Tests green, app broken: each test still fakes the old deploymentId, so the suite passes while Follow progress links to /deployments/undefined against the real control-api. That is handler drift.');
        } else {
          driftVerdict.set('bad', 'Now the tests fail on a correct screen: the fakes still describe the old API, and each one has to be found and edited by hand.');
        }
      }

      function reset() {
        epoch++;
        running = false;
        sendBtn.disabled = false;
        reqNo = 0;
        renamed = false;
        fixed = false;
        fakeT.set(false);
        log.clear();
        verdict.clear();
        rAnswer.set('—');
        rStatus.set('—');
        resetPath();
        renderDrift();
      }

      resetPath();
      renderDrift();
    }
  });

  // =====================================================================
  // 2. The simulated backend (built, P1)
  // =====================================================================
  AF.register({
    id: 'ui-sim-backend',
    group: 'quality',
    order: 2,
    title: 'A simulated backend with a clock',
    question: 'How can a screen meet a conflict, a failure and a stale read before the real services exist?',
    status: 'built',
    slice: 'P1',
    where: [
      'web-console/src/mocks/db.ts',
      'web-console/src/mocks/handlers/control.ts',
      'web-console/src/mocks/handlers/query.ts',
      'web-console/src/mocks/respond.ts'
    ],
    idea: [
      'A mock that answers 200 with fixed JSON only ever shows the happy path. The console\'s mock is a small backend instead: src/mocks/db.ts holds one seeded world, with teams, applications, releases, deployments and nodes, plus a clock. Every handler calls tick() first, which moves each deployment forward to the current time, so state changes as long as someone keeps asking.',
      'A new deployment is PENDING, VALIDATING at 1.5 s, DEPLOYING at 4 s and HEALTHY at 9 s. A release candidate such as billing-api 2.5.0-rc1 fails permanently at 12 s and lands in the dead-letter queue. A rollback finishes 5 s after it is requested. Query-service views leave out deployments younger than 1.5 s and carry asOf, like a projection that lags.',
      'The rules are copied from control-api, including the awkward ones. uq_deployment_active_per_app_env refuses a new deployment while one that is not FAILED or ROLLED_BACK exists, so a HEALTHY prod blocks an upgrade with 409 conflict (backend gap 11). Rollback is allowed only from HEALTHY or DEGRADED, else 409 illegal-transition. A repeated Idempotency-Key replays the first 202.'
    ],
    terms: [
      ['Seed', 'The fixed starting data. Seeded deployments are frozen, so the demo looks the same every time.'],
      ['tick()', 'Moves every simulated deployment forward to the current time. Each handler calls it before answering.'],
      ['asOf', 'The moment a read model is current to, so a screen can say how stale its view is.'],
      ['Problem slug', 'The end of the ProblemDetail type, such as conflict or illegal-transition. Screens switch on it.']
    ],
    tryIt: [
      'Choose Environment qa and press Deploy. Watch PENDING, VALIDATING, DEPLOYING and HEALTHY arrive over 9 s, and the dashboard row appear only once the deployment is 1.5 s old. Press Deploy again: the same Idempotency-Key replays the first 202.',
      'Choose prod and press Deploy: 409 conflict, because 2.3.1 is HEALTHY there. Press Roll back twice quickly: the second is 409 conflict, and 5 s later prod is ROLLED_BACK and free. On staging, where 2.4.0 is DEPLOYING, Roll back gets 409 illegal-transition.',
      'With prod free, choose Release 2.5.0-rc1 and press Deploy: it fails at 12 s. Next time, turn off Poll every 2 s while it runs, wait, then press Refresh now: one request catches up every step.',
      'Turn on Mock answers 200 to everything, press Reset and try again: every request succeeds, and the list shows the paths the console never gets to exercise.'
    ],
    breakIt: 'A mock that says yes to everything never sends a 409, a FAILED deployment or a stale read, so the screens that handle them are first seen in production, by users.',
    say: 'The console runs on a simulated backend with a seeded world and a clock that tick() advances on every request, copying control-api\'s rules, including the 409 for a second active deployment, so every failure path can be built and tested before the real service exists.',
    quiz: {
      q: 'The console stops polling while a new deployment is DEPLOYING. Ten seconds later it asks again. What does the simulated backend answer?',
      options: [
        'DEPLOYING: nothing moved while no request arrived',
        'An error, because the clock missed its steps',
        'HEALTHY, with the history stamped at 9 s: tick() catches up to the current time on the next request',
        'VALIDATING, because each request advances one step'
      ],
      answer: 2,
      why: 'There is no timer in db.ts. When a request arrives, tick() compares each deployment\'s start with the current time and applies every step that is due, stamped with the time it should have happened. Polling is what makes it look continuous.'
    },
    mount(el, ctx) {
      const ENVS = ['dev', 'qa', 'staging', 'prod'];
      const PHASES = [[1500, 'VALIDATING'], [4000, 'DEPLOYING'], [9000, 'HEALTHY']];
      const ORDER = ['PENDING', 'VALIDATING', 'DEPLOYING', 'HEALTHY'];
      const FAIL_AT_MS = 12000;
      const ROLLBACK_MS = 5000;
      const LAG_MS = 1500;
      const POLL_MS = 2000;
      const ACTIVE = s => s !== 'FAILED' && s !== 'ROLLED_BACK';
      const LIVE = s => s === 'PENDING' || s === 'VALIDATING' || s === 'DEPLOYING';
      const PATHS = [
        ['accepted', '202 accepted, then PENDING to HEALTHY'],
        ['replay', '202 replayed: same Idempotency-Key'],
        ['conflict', '409 conflict: environment already has an active deployment'],
        ['failed', 'FAILED: release candidate, dead-letter queue'],
        ['rollback', 'Rollback accepted, ROLLED_BACK 5 s later'],
        ['illegal', '409 illegal-transition: rollback from the wrong state'],
        ['twice', '409 conflict: rollback already requested'],
        ['lag', 'Read side behind: new deployment not on the dashboard yet']
      ];
      const NAIVE_REACH = { accepted: true, rollback: true };
      const SEC = 1000;
      const MIN = 60 * SEC;
      const HOUR = 60 * MIN;
      const DAY = 24 * HOUR;
      const sid = n => '0192f3a1-0000-7000-8000-' + n.toString(16).padStart(12, '0');

      let t0 = Date.now();
      const clock = () => Date.now() - t0;
      let deps = [];
      let idem = new Map();
      let seen = new Set();
      let key = '';
      let read = null;
      let lastPoll = 0;
      let lastAnswer = '—';
      let lastTone = null;

      function seed() {
        const mk = (n, env, version, status, ago) => ({
          uuid: sid(n), env, version, status, created: -ago, schedule: null, rollbackAt: null,
          rollbackOpen: false, naiveRollback: false, seeded: true, history: [], taskId: sid(n + 1000)
        });
        return [
          mk(200, 'dev', '2.4.0', 'HEALTHY', 5 * HOUR),
          mk(201, 'staging', '2.3.1', 'ROLLED_BACK', 3 * DAY),
          mk(202, 'staging', '2.4.0', 'DEPLOYING', 1 * MIN),
          mk(203, 'prod', '2.3.0', 'ROLLED_BACK', 5 * DAY),
          mk(204, 'prod', '2.3.1', 'HEALTHY', 160 * MIN)
        ];
      }

      const log = shortLog('Simulated backend log', 9);
      const verdict = stableVerdict();
      const naive = () => naiveT.get();

      // ---- controls
      const relC = ui.choice('Release', [
        { value: '2.4.0', label: '2.4.0' },
        { value: '2.5.0-rc1', label: '2.5.0-rc1' }
      ], '2.4.0', () => newKey());
      const envC = ui.choice('Environment', ENVS.map(e => ({ value: e, label: e })), 'qa', () => newKey());
      const keyTok = ui.token('', null);
      const deployBtn = ui.button('Deploy', deploy, { variant: 'primary' });
      const rollbackBtn = ui.button('Roll back', rollback);
      const refreshBtn = ui.button('Refresh now', () => { request('GET /api/v1/deployments/{id}'); render(); });
      const pollT = ui.toggle('Poll every 2 s', true, on => {
        log.add(on ? 'Polling again: GET every 2 s, as useDeployment does while work is in flight' : 'Polling stopped: no request, so tick() does not run', on ? 'ok' : 'warn');
      });
      const naiveT = ui.toggle('Mock answers 200 to everything', false, on => {
        log.add(on ? 'Break: the mock says yes to every request and walks every deployment to HEALTHY' : 'Fixed: the mock applies control-api\'s rules again', on ? 'bad' : 'ok');
        renderPaths();
      }, { tone: 'danger' });
      const resetBtn = ui.button('Reset', reset, { variant: 'quiet' });

      // ---- stage
      const envLanes = {};
      ENVS.forEach(e => { envLanes[e] = ui.lane(e, 'free'); });
      const readRow = h('div', { class: 'row' });
      const readLine = h('p', { class: 'small muted' });
      const pathsBox = h('div', { class: 'row' });
      const respCode = wrapCode('No response yet.', 'Last response');

      const rClock = ui.readout('Clock', 't = 0.0 s');
      const rLast = ui.readout('Last answer', '—');
      const rSeen = ui.readout('Paths seen', '0 of 8');
      const rNever = ui.readout('Paths this mock can never show', '0');

      el.append(
        controls(relC.el, envC.el, h('div', { class: 'row' }, label('Idempotency-Key'), keyTok)),
        controls(deployBtn, rollbackBtn, refreshBtn, pollT.el, naiveT.el, resetBtn),
        stage(
          cols(...ENVS.map(e => envLanes[e].el)),
          h('div', { class: 'stack', style: 'margin-top:.8rem;gap:.35rem' },
            h('div', { class: 'lane-title' }, h('span', null, 'Dashboard, the read side (query-service view)')),
            readRow, readLine)
        ),
        readouts(rClock, rLast, rSeen, rNever),
        verdict.el,
        cols(ui.panel('Paths the console has screens for', pathsBox), ui.panel('Last response', respCode)),
        log.el,
        note('Times and rules are the real ones from src/mocks/db.ts and src/mocks/handlers. Only billing-api is shown. Seeded deployments are frozen, as in the console, so staging stays DEPLOYING and its rules can be tried. The Idempotency-Key is renewed when Release or Environment changes, as useIdempotentSubmit does.')
      );

      // ---- model: the same steps as tick() in db.ts
      function move(d, to, at, changes) {
        d.status = to;
        d.history.push([at, to]);
        if (to === 'FAILED') seen.add('failed');
        if (to === 'ROLLED_BACK') {
          d.rollbackOpen = false;
          d.schedule = null;
          seen.add('rollback');
        }
        changes.push([d, to, at]);
      }

      function tick(now) {
        const changes = [];
        for (const d of deps) {
          if (d.schedule && LIVE(d.status)) {
            const elapsed = now - d.schedule.start;
            if (d.schedule.failPermanently) {
              if (d.status === 'PENDING' && elapsed >= 1500) move(d, 'VALIDATING', d.schedule.start + 1500, changes);
              if (d.status === 'VALIDATING' && elapsed >= 4000) move(d, 'DEPLOYING', d.schedule.start + 4000, changes);
              if (d.status === 'DEPLOYING' && elapsed >= FAIL_AT_MS) move(d, 'FAILED', d.schedule.start + FAIL_AT_MS, changes);
            } else {
              for (const [at, state] of PHASES) {
                if (elapsed >= at && ORDER.indexOf(d.status) < ORDER.indexOf(state)) move(d, state, d.schedule.start + at, changes);
              }
            }
          }
          if (d.rollbackAt !== null && now >= d.rollbackAt + ROLLBACK_MS && d.status !== 'ROLLED_BACK' &&
              (d.status === 'HEALTHY' || d.status === 'DEGRADED' || d.naiveRollback)) {
            move(d, 'ROLLED_BACK', d.rollbackAt + ROLLBACK_MS, changes);
          }
        }
        return changes;
      }

      /** One request: tick() first, as every handler does, and log what moved. */
      function request(line) {
        const now = clock();
        const changes = tick(now);
        const byDep = new Map();
        for (const [d, to, at] of changes) {
          if (!byDep.has(d)) byDep.set(d, []);
          byDep.get(d).push(to + ' at t=' + secs(at));
        }
        for (const [d, parts] of byDep) {
          const bad = d.status === 'FAILED';
          log.add('t=' + secs(now) + ' ' + line + ': tick() moved ' + d.env + ' ' + d.version + ' to ' + parts.join(', '), bad ? 'bad' : 'busy');
          if (d.status === 'HEALTHY' && d.version.includes('-rc') && naive()) {
            log.add('2.5.0-rc1 reached HEALTHY. The real simulated backend fails it at 12 s, so the dead-letter path is never shown.', 'warn');
          }
        }
        refreshRead(now);
        return now;
      }

      function refreshRead(now) {
        const lag = naive() ? 0 : LAG_MS + (now % 900);
        const visible = deps.filter(d => naive() || d.created <= now - LAG_MS);
        const hidden = deps.length - visible.length;
        if (hidden > 0) seen.add('lag');
        const rows = ENVS.map(env => {
          const list = visible.filter(d => d.env === env).sort((a, b) => b.created - a.created);
          return [env, list.find(d => ACTIVE(d.status)) || list[0] || null];
        });
        read = { at: now, asOf: now - lag, rows, hidden, naive: naive() };
      }

      function newKey() {
        key = hexChars(8) + '-' + hexChars(4) + '-4' + hexChars(3) + '-' + hexChars(4) + '-' + hexChars(12);
        keyTok.textContent = short(key);
      }

      function problemText(status, reason, slug, title, detail, instance, cid) {
        return 'HTTP/1.1 ' + status + ' ' + reason + '\nContent-Type: application/problem+json\nX-Correlation-Id: ' + cid + '\n\n' +
          JSON.stringify({ type: 'urn:appfleet:problem:' + slug, title, status, detail, instance, correlationId: cid }, null, 2);
      }

      function answer(text, tone, code) {
        lastAnswer = text;
        lastTone = tone;
        setCode(respCode, code);
      }

      function deploy() {
        const now = request('POST /api/v1/deployments');
        const env = envC.get();
        const version = relC.get();
        const cid = 'c-' + hexChars(8);
        if (!naive()) {
          const prior = idem.get(key);
          if (prior) {
            seen.add('replay');
            answer('202 replayed', 'ok', 'HTTP/1.1 202 Accepted\nLocation: /api/v1/tasks/' + prior.taskId + '\nIdempotent-Replayed: true\nX-Correlation-Id: ' + cid + '\n\n' +
              JSON.stringify({ deploymentId: prior.uuid, taskId: prior.taskId, status: 'PENDING' }, null, 2));
            log.add('t=' + secs(now) + ' POST with Idempotency-Key ' + short(key) + ': key seen before, 202 replayed', 'ok');
            verdict.set('ok', 'Replayed: the same Idempotency-Key returns the first answer, with the same deployment id and Idempotent-Replayed: true. Nothing new was created. Change Release or Environment for a new key.');
            render();
            return;
          }
          const active = deps.find(d => d.env === env && ACTIVE(d.status));
          if (active) {
            seen.add('conflict');
            const detail = 'billing-api already has an active deployment in ' + env + ' (' + active.version + ', ' + active.status + '). Only one deployment per application and environment can be active.';
            answer('409 conflict', 'warn', problemText(409, 'Conflict', 'conflict', 'Conflict', detail, '/api/v1/deployments', cid));
            log.add('t=' + secs(now) + ' POST ' + version + ' to ' + env + ': 409 conflict, ' + active.version + ' is ' + active.status, 'warn');
            verdict.set('warn', '409 conflict: ' + detail + ' That is uq_deployment_active_per_app_env. A HEALTHY deployment counts as active (backend gap 11), so roll it back first or choose another environment.');
            render();
            return;
          }
        }
        const others = deps.filter(d => d.env === env && ACTIVE(d.status));
        const d = {
          uuid: uuid7(), env, version, status: 'PENDING', created: now,
          schedule: { start: now, failPermanently: !naive() && version.includes('-rc') },
          rollbackAt: null, rollbackOpen: false, naiveRollback: false, seeded: false,
          history: [[now, 'PENDING']], taskId: uuid7()
        };
        deps.push(d);
        if (!naive()) idem.set(key, d);
        seen.add('accepted');
        refreshRead(now);
        if (naive()) {
          answer('200 OK', 'ok', 'HTTP/1.1 200 OK\nContent-Type: application/json\n\n' + JSON.stringify({ deploymentId: d.uuid, status: 'PENDING' }, null, 2));
          log.add('t=' + secs(now) + ' POST ' + version + ' to ' + env + ': 200 OK, no rules applied', others.length ? 'bad' : 'muted');
          verdict.set(others.length ? 'bad' : 'warn', others.length
            ? '200 OK, and ' + env + ' now has ' + (others.length + 1) + ' active deployments. control-api would have answered 409 conflict, so the console\'s conflict notice never gets to run.'
            : 'Accepted with no questions asked, and the dashboard shows it at once: no lag, no asOf.');
        } else {
          answer('202 accepted', 'ok', 'HTTP/1.1 202 Accepted\nLocation: /api/v1/tasks/' + d.taskId + '\nIdempotent-Replayed: false\nX-Correlation-Id: ' + cid + '\n\n' +
            JSON.stringify({ deploymentId: d.uuid, taskId: d.taskId, status: 'PENDING' }, null, 2));
          log.add('t=' + secs(now) + ' POST ' + version + ' to ' + env + ' with key ' + short(key) + ': 202 Accepted, deployment ' + short(d.uuid), 'ok');
          verdict.set('busy', d.schedule.failPermanently
            ? 'Accepted. 2.5.0-rc1 is a release candidate whose image does not exist, so it will fail permanently at 12 s and go to the dead-letter queue.'
            : 'Accepted: PENDING now, VALIDATING at 1.5 s, DEPLOYING at 4 s, HEALTHY at 9 s. The dashboard leaves it out until it is 1.5 s old.');
        }
        render();
      }

      function rollback() {
        const now = request('POST /api/v1/deployments/{id}/rollback');
        const env = envC.get();
        const cid = 'c-' + hexChars(8);
        const list = deps.filter(d => d.env === env).sort((a, b) => b.created - a.created);
        if (!list.length) {
          log.add('Nothing in ' + env + ' to roll back. The console shows no Roll back button there.', 'muted');
          verdict.set('idle', 'Nothing is deployed in ' + env + ', so there is nothing to roll back.');
          render();
          return;
        }
        const target = list.find(d => ACTIVE(d.status)) || list[0];
        const instance = '/api/v1/deployments/' + target.uuid + '/rollback';
        if (!naive()) {
          if (target.status !== 'HEALTHY' && target.status !== 'DEGRADED') {
            seen.add('illegal');
            answer('409 illegal-transition', 'warn', problemText(409, 'Conflict', 'illegal-transition', 'Illegal state transition',
              'Cannot roll back a deployment in state ' + target.status + '.', instance, cid));
            log.add('t=' + secs(now) + ' Roll back ' + env + ' ' + target.version + ': 409 illegal-transition from ' + target.status, 'warn');
            verdict.set('warn', '409 illegal-transition: ' + target.version + ' in ' + env + ' is ' + target.status + '. The state machine allows a rollback only from HEALTHY or DEGRADED.');
            render();
            return;
          }
          if (target.rollbackOpen) {
            seen.add('twice');
            answer('409 conflict', 'warn', problemText(409, 'Conflict', 'conflict', 'Conflict', 'A rollback is already requested for this deployment.', instance, cid));
            log.add('t=' + secs(now) + ' Roll back ' + env + ' again: 409 conflict, one is already open', 'warn');
            verdict.set('warn', '409 conflict: a rollback is already requested for this deployment. It finishes 5 s after the first request.');
            render();
            return;
          }
        }
        target.rollbackAt = now;
        target.rollbackOpen = true;
        target.naiveRollback = naive();
        const taskId = uuid7();
        answer(naive() ? '200 OK' : '202 accepted', 'ok', naive()
          ? 'HTTP/1.1 200 OK\nContent-Type: application/json\n\n' + JSON.stringify({ deploymentId: target.uuid }, null, 2)
          : 'HTTP/1.1 202 Accepted\nLocation: /api/v1/tasks/' + taskId + '\nX-Correlation-Id: ' + cid + '\n\n' + JSON.stringify({ deploymentId: target.uuid, taskId }, null, 2));
        log.add('t=' + secs(now) + ' Roll back ' + env + ' ' + target.version + ' (' + target.status + '): accepted, finishes at t=' + secs(now + ROLLBACK_MS), 'ok');
        verdict.set(naive() && LIVE(target.status) ? 'bad' : 'busy', naive() && LIVE(target.status)
          ? 'Accepted a rollback of a deployment that is still ' + target.status + '. control-api would refuse with 409 illegal-transition, a notice the console never gets to show.'
          : 'Rollback accepted. ' + target.version + ' in ' + env + ' becomes ROLLED_BACK 5 s from now, and the environment is then free for a new deployment.');
        render();
      }

      // ---- views
      function toneOf(status) {
        if (LIVE(status)) return 'busy';
        if (status === 'HEALTHY') return 'ok';
        if (status === 'FAILED') return 'bad';
        if (status === 'DEGRADED') return 'warn';
        return 'idle';
      }
      function ago(ms) {
        if (ms < MIN) return secs(ms) + ' ago';
        if (ms < 2 * HOUR) return Math.round(ms / MIN) + ' min ago';
        if (ms < 2 * DAY) return Math.round(ms / HOUR) + ' h ago';
        return Math.round(ms / DAY) + ' d ago';
      }

      function renderLanes() {
        const now = clock();
        ENVS.forEach(env => {
          const lane = envLanes[env];
          AF.clear(lane.body);
          const list = deps.filter(d => d.env === env).sort((a, b) => b.created - a.created);
          const active = list.filter(d => ACTIVE(d.status)).length;
          lane.title.lastChild.textContent = active > 1 ? active + ' active: not allowed' : active === 1 ? '1 active' : 'free';
          AF.tone(lane.el, active > 1 ? 'bad' : null);
          if (!list.length) lane.body.appendChild(h('p', { class: 'small muted' }, 'Nothing deployed.'));
          list.slice(0, 3).forEach(d => {
            const when = d.seeded ? ago(now - d.created) + ', seed (frozen)' : 'requested at t=' + secs(d.created);
            const steps = d.history.slice(1).map(([at, st]) => st + ' ' + secs(at - d.created)).join(', ');
            const sub = when + (steps ? '; ' + steps : '') + (d.rollbackOpen ? '; rollback requested' : '');
            lane.body.appendChild(liveNode(d.version + ' ' + d.status, sub, toneOf(d.status)).el);
          });
        });
      }

      function renderRead() {
        AF.clear(readRow);
        if (!read) return;
        read.rows.forEach(([env, d]) => {
          readRow.appendChild(ui.token(env + ': ' + (d ? d.version + ' ' + d.status : 'not deployed'), d ? toneOf(d.status) : 'idle'));
        });
        renderBehind();
      }

      function renderBehind() {
        if (!read) return;
        const hiddenText = read.hidden ? ' ' + read.hidden + (read.hidden === 1 ? ' deployment is' : ' deployments are') + ' younger than 1.5 s and not in this view yet.' : '';
        readLine.textContent = read.naive
          ? 'No asOf: this mock answers straight from the write side, so the console\'s "Updating" state never appears.'
          : 'asOf t=' + secs(read.asOf) + ', ' + secs(Math.max(0, clock() - read.asOf)) + ' behind.' + hiddenText;
      }

      function renderPaths() {
        AF.clear(pathsBox);
        let count = 0;
        PATHS.forEach(([id, text]) => {
          const was = seen.has(id);
          const blocked = naive() && !NAIVE_REACH[id];
          if (was) count++;
          pathsBox.appendChild(wrapTok((was ? 'seen: ' : blocked ? 'unreachable: ' : 'not yet: ') + text, was ? 'ok' : blocked ? 'bad' : 'idle'));
        });
        rSeen.set(count + ' of ' + PATHS.length, count === PATHS.length ? 'ok' : null);
        const never = naive() ? PATHS.filter(([id]) => !NAIVE_REACH[id]).length : 0;
        rNever.set(never + (never ? ' of ' + PATHS.length : ''), never ? 'bad' : null);
      }

      function render() {
        renderLanes();
        renderRead();
        renderPaths();
        rLast.set(lastAnswer, lastTone);
      }

      function reset() {
        t0 = Date.now();
        deps = seed();
        idem = new Map();
        seen = new Set();
        lastPoll = 0;
        lastAnswer = '—';
        lastTone = null;
        newKey();
        log.clear();
        verdict.clear();
        setCode(respCode, 'No response yet.');
        refreshRead(0);
        render();
      }

      reset();
      ctx.interval(() => {
        const now = clock();
        rClock.set('t = ' + secs(now));
        if (pollT.get() && now - lastPoll >= POLL_MS) {
          lastPoll = now;
          request('GET (poll)');
          render();
        } else {
          renderBehind();
        }
      }, 200);
    }
  });

  // =====================================================================
  // 3. Tests at four layers (built, P1)
  // =====================================================================
  AF.register({
    id: 'ui-testing',
    group: 'quality',
    order: 3,
    title: 'Four layers of tests',
    question: 'Which test should catch which bug, and how do you keep tests from failing over changes users never see?',
    status: 'built',
    slice: 'P1',
    where: [
      'web-console/src/test/render.tsx',
      'web-console/src/features/applications/ApplicationsPage.test.tsx',
      'web-console/src/hooks/pollInterval.test.ts',
      'web-console/src/api/http.test.ts'
    ],
    idea: [
      'The console tests at four layers. Pure functions such as statusTone, deploymentPollInterval and can() get plain input and output tests. Hooks run under renderHook, as in useIdempotentSubmit.test.ts. The API client runs against MSW in Node, in http.test.ts, with server.use() swapping one handler for one test. These are fast, and a failure points straight at the broken unit.',
      'Full-app tests call renderApp(path, { role }). It renders the real route table, guards and providers in a memory router against the shared handlers, so a test sees what a user with that role sees. ApplicationsPage.test.tsx checks that a DEPLOYER sees billing-api but not search-indexer, and that a VIEWER gets no Register application link.',
      'Tests find elements the way people do: by role and accessible name, as in findByRole(\'table\', { name: \'Applications\' }), and act through user-event, which types and clicks like a person. A renamed CSS class breaks nothing. A button that loses its name, or stops being a button, fails the test, because it also fails keyboard and screen-reader users.'
    ],
    terms: [
      ['renderHook', 'Runs a hook inside a throwaway component, so a test can call it and read what it returns.'],
      ['Accessible name', 'What assistive technology calls an element: a button\'s text, a field\'s label, a table\'s aria-label.'],
      ['user-event', 'Testing Library\'s way of typing, clicking and tabbing with real browser events, in the order a person causes them.']
    ],
    tryIt: [
      'Choose a change under Change and press Run the tests: each layer reports fails or passes, and the panel shows the test that noticed.',
      'Press Run every change to fill the matrix. A wrong poll interval is caught only by the pure-function test; a broken guard only by a full-app test.',
      'Turn on Select elements by CSS class and press Run every change again: the harmless class rename now fails, and the clickable div passes.'
    ],
    breakIt: 'Tests that find elements by CSS class fail when someone renames a class for styling, and pass when the Deploy button turns into a clickable div that keyboard and screen-reader users cannot use.',
    say: 'Policies are plain functions with unit tests, hooks run under renderHook, the API client runs against MSW, and full-app tests render the real routes and guards with renderApp and query by role and accessible name, so they fail when users would notice and not when a class is renamed.',
    quiz: {
      q: 'A full-app test finds the Deploy button with getByRole(\'button\', { name: \'Deploy\' }). Someone changes the button text to Start deployment. What should happen?',
      options: [
        'Nothing: tests should never depend on visible text',
        'Switch the test to a CSS class, which is more stable',
        'Add a data-testid so that text changes stop breaking tests',
        'The test fails, and that is right: the accessible name changed for users and screen readers, so the test is updated on purpose'
      ],
      answer: 3,
      why: 'The accessible name is part of the interface people use. A failing test makes the change visible and deliberate. A class or a test id would hide it, and would also keep passing if the button stopped being a button at all.'
    },
    mount(el, ctx) {
      const LAYERS = [
        { id: 'pure', label: 'Pure functions', sub: 'statusTone, pollInterval, can' },
        { id: 'hook', label: 'Hooks', sub: 'renderHook' },
        { id: 'api', label: 'API client and MSW', sub: 'http.test.ts' },
        { id: 'app', label: 'Full app', sub: 'renderApp(path, { role })' }
      ];
      const CHANGES = [
        {
          id: 'poll', short: 'Poll interval', kind: 'bug',
          text: 'deploymentPollInterval returns 2 s for HEALTHY instead of 30 s, so every settled deployment page polls 15 times as often.',
          fails: { role: ['pure'], cls: ['pure'] },
          test: 'pollInterval.test.ts: \'polls slowly while settled, because HEALTHY and DEGRADED can still change\'',
          code: 'expect(deploymentPollInterval(\'HEALTHY\')).toBe(POLL_SETTLED_MS);\n// AssertionError: expected 2000 to be 30000',
          clsCode: null,
          why: 'Only the plain-function test looks at the number. No full-app test waits 30 s and counts requests, which is why the policy lives in a function of its own.'
        },
        {
          id: 'guard', short: 'Guard', kind: 'bug',
          text: 'The audit route asks for deployment:read instead of audit:read, so a DEPLOYER can open the audit trail.',
          fails: { role: ['app'], cls: ['app'] },
          test: 'AuditPage.test.tsx: \'is not found for a deployer\'',
          code: 'await renderApp(\'/audit\', { role: \'DEPLOYER\' });\nexpect(await screen.findByRole(\'heading\', { level: 1, name: \'Page not found\' })).toBeInTheDocument();',
          clsCode: 'await renderApp(\'/audit\', { role: \'DEPLOYER\' });\nexpect(container.querySelector(\'.notFound\')).not.toBeNull();',
          why: 'can() itself is right, so its unit tests pass. Only a test that renders the real route table with a DEPLOYER sees the audit trail open.'
        },
        {
          id: 'key', short: 'Key per click', kind: 'bug',
          text: 'useIdempotentSubmit makes a new Idempotency-Key on every render, so a double click deploys twice.',
          fails: { role: ['hook', 'app'], cls: ['hook', 'app'] },
          test: 'useIdempotentSubmit.test.ts: \'keeps one key while the inputs stay the same\', and DeployPage.test.tsx: \'replays the same request with the same key instead of deploying twice\'',
          code: 'rerender({ inputs: \'a|2.4.0|prod\' });\nexpect(result.current.idempotencyKey).toBe(first);',
          clsCode: null,
          why: 'The hook test pins the rule down in isolation; the full-app test proves the deploy screen sends the same key twice and shows Already accepted.'
        },
        {
          id: 'shape', short: 'Error shape', kind: 'bug',
          text: 'http.ts builds ApiError.type from the title instead of the type slug, so screens no longer recognise conflict.',
          fails: { role: ['api', 'app'], cls: ['api'] },
          test: 'http.test.ts: \'turns a ProblemDetail into an ApiError with the slug as type\', and DeployPage.test.tsx: \'warns before submit when prod has an active deployment, then shows the 409\'',
          code: 'expect(err).toBeInstanceOf(ApiError);\nexpect(err.type).toBe(\'conflict\');\n// AssertionError: expected \'Conflict\' to be \'conflict\'',
          clsCode: 'await user.click(container.querySelector(\'.primary\'));\nexpect(container.querySelector(\'.warning\')).not.toBeNull();\n// passes: a generic error notice has the same class',
          why: 'With classes, the full-app check finds a warning box, just the wrong one: the generic notice instead of "Not started: conflict". Only the API-client test still sees the bad slug.'
        },
        {
          id: 'label', short: 'Label changed', kind: 'visible',
          text: 'The Deploy button\'s text changes to Submit. Nothing is broken, but users and screen readers now meet a different name.',
          fails: { role: ['app'], cls: [] },
          test: 'DeployPage.test.tsx: \'deploys billing-api 2.4.0 to qa and links to its progress\'',
          code: 'await user.click(screen.getByRole(\'button\', { name: \'Deploy\' }));\n// Unable to find an accessible element with the role "button" and name "Deploy"',
          clsCode: 'await user.click(container.querySelector(\'.primary\'));\n// passes: nobody is told the name changed',
          why: 'A visible change should be a deliberate one. The failing test is updated on purpose, in the same change as the label.'
        },
        {
          id: 'class', short: 'Class renamed', kind: 'harmless',
          text: 'Button.module.css renames .primary to .solid. The button looks and works the same.',
          fails: { role: [], cls: ['app'] },
          test: 'No test notices, and none should.',
          code: '// role and name are unchanged, so every getByRole(\'button\', { name: \'Deploy\' }) still finds it',
          clsCode: 'await user.click(container.querySelector(\'.primary\'));\n// TypeError: null is not a valid target: the class is now .solid',
          why: 'Class names are styling details. Tests that depend on them fail for reasons users never see, and people learn to ignore failing tests.'
        },
        {
          id: 'div', short: 'Clickable div', kind: 'bug',
          text: 'The Deploy button becomes a <div onClick> with the same class. Mouse users can still deploy; keyboard and screen-reader users cannot.',
          fails: { role: ['app'], cls: [] },
          test: 'DeployPage.test.tsx: every getByRole(\'button\', { name: \'Deploy\' })',
          code: 'await user.click(screen.getByRole(\'button\', { name: \'Deploy\' }));\n// Unable to find an accessible element with the role "button" and name "Deploy"',
          clsCode: 'await user.click(container.querySelector(\'.primary\'));\n// passes: the div has the class and a click handler',
          why: 'A role query asks the same question a screen reader asks. npm run lint flags the div too: eslint-plugin-jsx-a11y\'s recommended rules reject a click handler on a static element.'
        }
      ];
      const REAL_BUGS = CHANGES.filter(c => c.kind === 'bug').length;

      let running = false;
      let epoch = 0;
      const results = {};   // change id -> { fails: [...], mode }
      const cells = {};     // change id -> { layer id -> token, outcome token }
      const rowEls = {};

      const log = shortLog('Test runs', 8);
      const verdict = stableVerdict();

      const changeC = ui.choice('Change', CHANGES.map(c => ({ value: c.id, label: c.short })), 'poll', () => renderDetail());
      const runBtn = ui.button('Run the tests', () => { runOne(changeC.get()); }, { variant: 'primary' });
      const allBtn = ui.button('Run every change', () => { runAll(); });
      const clsT = ui.toggle('Select elements by CSS class', false, on => {
        log.add(on ? 'Break: tests find elements with container.querySelector(\'.class\')' : 'Fixed: tests find elements by role and accessible name', on ? 'bad' : 'ok');
        clearResults();
        renderDetail();
      }, { tone: 'danger' });
      const resetBtn = ui.button('Reset', () => { epoch++; running = false; setBusy(false); clearResults(); log.clear(); verdict.clear(); }, { variant: 'quiet' });

      // ---- matrix
      const GRID = 'display:grid;grid-template-columns:minmax(8.5rem,1.2fr) repeat(4,minmax(6.5rem,1fr)) minmax(9.5rem,1.3fr);gap:.45rem .6rem;align-items:center;min-width:46rem';
      const head = h('div', { role: 'row', style: 'display:contents' },
        h('div', { role: 'columnheader', class: 'small muted' }, 'Change'),
        LAYERS.map(l => h('div', { role: 'columnheader', class: 'small' }, h('b', null, l.label), h('span', { class: 'node-sub' }, l.sub))),
        h('div', { role: 'columnheader', class: 'small muted' }, 'Outcome'));
      const grid = h('div', { role: 'table', 'aria-label': 'Which test layer notices which change', style: GRID }, head);
      CHANGES.forEach(c => {
        const row = {};
        LAYERS.forEach(l => { row[l.id] = ui.token('not run', 'idle'); });
        row.outcome = wrapTok('not run', 'idle');
        cells[c.id] = row;
        const name = h('div', { role: 'cell', class: 'small' }, h('b', null, c.short));
        rowEls[c.id] = name;
        grid.appendChild(h('div', { role: 'row', style: 'display:contents' },
          name,
          LAYERS.map(l => h('div', { role: 'cell' }, row[l.id])),
          h('div', { role: 'cell' }, row.outcome)));
      });

      const detailText = h('p', null);
      const detailTest = h('p', { class: 'small' });
      const detailCode = wrapCode('', 'The test');
      const detailWhy = h('p', { class: 'small muted' });

      const rCaught = ui.readout('Real bugs caught', '0 of 0');
      const rShip = ui.readout('Bugs that ship', '0');
      const rFalse = ui.readout('False alarms', '0');

      el.append(
        controls(changeC.el),
        controls(runBtn, allBtn, clsT.el, resetBtn),
        stage(grid),
        readouts(rCaught, rShip, rFalse),
        verdict.el,
        cols(ui.panel('The change', detailText, detailWhy), ui.panel('The test that notices', detailTest, detailCode)),
        log.el,
        note('Test names and assertions are quoted from web-console/src. The CSS-class versions are illustrative: the console has none. vitest.config.ts keeps CSS Module class names unscoped in tests, so such selectors would match plain names like .primary.')
      );

      function setBusy(b) {
        runBtn.disabled = b;
        allBtn.disabled = b;
      }

      function outcomeFor(c, fails) {
        if (c.kind === 'bug') return fails.length ? ['caught', 'ok'] : ['ships to users', 'bad'];
        if (c.kind === 'visible') return fails.length ? ['flagged: update on purpose', 'warn'] : ['nobody is told', 'warn'];
        return fails.length ? ['false alarm', 'bad'] : ['no test fails, rightly', 'ok'];
      }
      function cellTone(c, failsHere) {
        if (c.kind === 'harmless') return failsHere ? 'bad' : 'ok';
        if (c.kind === 'visible') return failsHere ? 'warn' : 'idle';
        return failsHere ? 'ok' : 'idle';
      }

      async function runOne(id, quick) {
        if (running && !quick) return;
        const own = !quick;
        if (own) { running = true; setBusy(true); }
        const ep = epoch;
        const c = CHANGES.find(x => x.id === id);
        const mode = clsT.get() ? 'cls' : 'role';
        const fails = c.fails[mode];
        const row = cells[id];
        LAYERS.forEach(l => { row[l.id].textContent = 'waiting'; AF.tone(row[l.id], 'idle'); });
        row.outcome.textContent = 'running';
        AF.tone(row.outcome, 'busy');
        for (const l of LAYERS) {
          row[l.id].textContent = 'running';
          AF.tone(row[l.id], 'busy');
          await pause(ctx, quick ? 110 : 260);
          if (!ctx.alive || ep !== epoch) return;
          const f = fails.indexOf(l.id) >= 0;
          row[l.id].textContent = f ? 'fails' : 'passes';
          AF.tone(row[l.id], cellTone(c, f));
        }
        const [text, tone] = outcomeFor(c, fails);
        row.outcome.textContent = text;
        AF.tone(row.outcome, tone);
        results[id] = { fails, mode };
        log.add(c.short + ' (' + (mode === 'cls' ? 'CSS selectors' : 'role queries') + '): ' + (fails.length ? 'fails in ' + fails.map(f => LAYERS.find(l => l.id === f).label).join(', ') : 'every layer passes') + '. ' + text, tone);
        renderScore();
        if (own) {
          verdict.set(tone, c.short + ': ' + text + '. ' + c.why);
          running = false;
          setBusy(false);
        }
      }

      async function runAll() {
        if (running) return;
        running = true;
        setBusy(true);
        const ep = epoch;
        for (const c of CHANGES) {
          await runOne(c.id, true);
          if (!ctx.alive || ep !== epoch) return;
        }
        running = false;
        setBusy(false);
        const s = score();
        verdict.set(s.ship || s.falseAlarms ? 'bad' : 'ok', clsT.get()
          ? 'With CSS selectors: ' + s.caught + ' of ' + REAL_BUGS + ' real bugs caught, ' + s.falseAlarms + ' false alarm, and the label change goes unnoticed. The clickable div ships to keyboard users while the harmless rename turns the suite red.'
          : 'With role queries: ' + s.caught + ' of ' + REAL_BUGS + ' real bugs caught, no false alarms, and the label change is flagged for a deliberate update. Each layer catches what it is closest to.');
      }

      function score() {
        let caught = 0, ship = 0, falseAlarms = 0, run = 0;
        CHANGES.forEach(c => {
          const r = results[c.id];
          if (!r) return;
          if (c.kind === 'bug') {
            run++;
            if (r.fails.length) caught++; else ship++;
          }
          if (c.kind === 'harmless' && r.fails.length) falseAlarms++;
        });
        return { caught, ship, falseAlarms, run };
      }

      function renderScore() {
        const s = score();
        rCaught.set(s.caught + ' of ' + s.run, s.run && s.caught === s.run ? 'ok' : null);
        rShip.set(s.ship, s.ship ? 'bad' : null);
        rFalse.set(s.falseAlarms, s.falseAlarms ? 'bad' : null);
      }

      function clearResults() {
        CHANGES.forEach(c => {
          delete results[c.id];
          const row = cells[c.id];
          LAYERS.forEach(l => { row[l.id].textContent = 'not run'; AF.tone(row[l.id], 'idle'); });
          row.outcome.textContent = 'not run';
          AF.tone(row.outcome, 'idle');
        });
        renderScore();
      }

      function renderDetail() {
        const c = CHANGES.find(x => x.id === changeC.get());
        const cls = clsT.get();
        CHANGES.forEach(x => { rowEls[x.id].style.textDecoration = x === c ? 'underline' : 'none'; });
        detailText.textContent = c.text;
        detailWhy.textContent = c.why;
        if (cls) {
          const f = c.fails.cls;
          detailTest.textContent = f.length
            ? 'Fails with CSS selectors in: ' + f.map(id => LAYERS.find(l => l.id === id).label).join(', ') + '.'
            : 'With CSS selectors, no full-app test notices.';
          setCode(detailCode, c.clsCode || c.code);
        } else {
          detailTest.textContent = c.test;
          setCode(detailCode, c.code);
        }
      }

      renderDetail();
      renderScore();
    }
  });

  // =====================================================================
  // 4. Types that follow the backend (in progress, P1 and P2)
  // =====================================================================
  AF.register({
    id: 'ui-types',
    group: 'quality',
    order: 4,
    title: 'Types that follow the backend',
    question: 'How does the console find out, before users do, that control-api changed the shape of a response?',
    status: 'progress',
    slice: 'P1, P2',
    where: [
      'web-console/src/api/types.ts',
      'web-console/src/api/control.ts',
      'web-console/package.json',
      'docs/design/ux/web-console-react-plan.md'
    ],
    idea: [
      'src/api/types.ts describes every response the console reads. The built control-api ones mirror the Java records field for field: ApplicationResponse, DeploymentResponse, DeploymentAccepted, TaskResponse and CursorPage. Endpoints the backend does not have yet are marked proposed, with their gap number. Each API function names its type, as in request<DeploymentResponse>, so every screen that reads a field is checked.',
      'npm run build runs the type check before anything else, so a change in types.ts lists every file that still reads the old shape, and the build stops. The weak point is the words "written by hand": if control-api changes and nobody edits types.ts, the compiler checks the screens against a shape that no longer exists.',
      'When S3.7 lands, control-api publishes an OpenAPI document, and openapi-typescript generates the types from it. Screens keep importing the same names, so nothing else changes, but the types now move when the backend moves. Until then, hybrid mode against a running control-api is the check that the hand-written ones still match.'
    ],
    terms: [
      ['Wire type', 'A TypeScript description of JSON exactly as it travels, field names and nulls included.'],
      ['OpenAPI', 'A machine-readable description of an HTTP API. control-api is to publish one in S3.7.'],
      ['openapi-typescript', 'A tool that turns an OpenAPI document into TypeScript types.'],
      ['any', 'The TypeScript type that switches checking off: every field exists and has every type.']
    ],
    tryIt: [
      'Choose Backend change: Rename environment, set Types to Generated from OpenAPI (S3.7), and read the build output: five errors in the deployment screens, ten in the simulated backend, and the build stops.',
      'Set Types to Written by hand (now): the build passes and the screen breaks, until you press Update types.ts.',
      'Try ownerTeamId may be null and New status SUPERSEDED. Read what the compiler cannot see: a SUPERSEDED deployment would still be polled every 2 s.',
      'Turn on Type responses as any: every change compiles and goes straight to the screen.'
    ],
    breakIt: 'With responses typed as any, a renamed field compiles, renders as a blank cell or as "to undefined", and nobody finds out until a user reads the page.',
    say: 'types.ts mirrors control-api\'s records field for field and every API call names its type, so the type check that runs before every build lists each screen a backend change touches; when S3.7 publishes OpenAPI, generated types replace the hand-written ones without touching the screens.',
    quiz: {
      q: 'control-api adds a deployment state SUPERSEDED and the types are regenerated. The build lists three errors and you fix them. Which problem can still reach users?',
      options: [
        'deploymentPollInterval falls through to its last line, so a SUPERSEDED deployment would be polled every 2 s for good',
        'The stepper on the deployment page, which the build flagged',
        'The simulated backend\'s status tables, which the build flagged',
        'None: once the build passes, every screen handles the new state'
      ],
      answer: 0,
      why: 'The compiler checks exhaustive Record maps and arguments narrowed to a set of states, which is why it flagged the stepper and the simulated backend. An if/else chain that ends in a plain return accepts any new value. A case in pollInterval.test.ts, or a switch that ends in a never check, would make it visible.'
    },
    mount(el, ctx) {
      const SNIP = {
        rename: {
          before: 'export interface DeploymentResponse {\n  id: Uuid;\n  applicationId: Uuid;\n  releaseId: Uuid;\n  environment: string;\n  status: DeploymentState;\n  createdAt: Instant;\n  updatedAt: Instant;\n}',
          after: 'export interface DeploymentResponse {\n  id: Uuid;\n  applicationId: Uuid;\n  releaseId: Uuid;\n  environmentName: string;   // renamed in control-api\n  status: DeploymentState;\n  createdAt: Instant;\n  updatedAt: Instant;\n}'
        },
        nullable: {
          before: 'export interface ApplicationResponse {\n  id: Uuid;\n  name: string;\n  description: string | null;\n  ownerTeamId: Uuid;\n  createdAt: Instant;\n}',
          after: 'export interface ApplicationResponse {\n  id: Uuid;\n  name: string;\n  description: string | null;\n  ownerTeamId: Uuid | null;   // may now be null\n  createdAt: Instant;\n}'
        },
        status: {
          before: 'export const DEPLOYMENT_STATES = [\'PENDING\', \'VALIDATING\', \'DEPLOYING\', \'HEALTHY\',\n  \'DEGRADED\', \'FAILED\', \'ROLLED_BACK\'] as const;',
          after: 'export const DEPLOYMENT_STATES = [\'PENDING\', \'VALIDATING\', \'DEPLOYING\', \'HEALTHY\',\n  \'DEGRADED\', \'FAILED\', \'ROLLED_BACK\', \'SUPERSEDED\'] as const;   // new state'
        }
      };
      const ASSIGN_UNDEF = 'TS2345: Argument of type \'string | null\' is not assignable to parameter of type \'string | undefined\'.';
      // Measured with tsc 6.0.3 on a copy of web-console, one change at a time (2 October 2026).
      const CHANGES = {
        rename: {
          errors: [
            ['src/features/deployments/DeploymentPage.tsx', 4, 'TS2339: Property \'environment\' does not exist on type \'DeploymentResponse\'.', 'screen'],
            ['src/features/deployments/DeploymentDetails.tsx', 1, 'TS2339: Property \'environment\' does not exist on type \'DeploymentResponse\'.', 'screen'],
            ['src/mocks/db.ts', 5, 'TS2339, TS2353: \'environment\' does not exist on type \'DbDeployment\'.', 'mock'],
            ['src/mocks/handlers/control.ts', 3, 'TS2339: Property \'environment\' does not exist on type \'DbDeployment\'.', 'mock'],
            ['src/mocks/handlers/query.ts', 2, 'TS2339: Property \'environment\' does not exist on type \'DbDeployment\'.', 'mock']
          ],
          runtime: [
            ['Deployment page title', 'Reads "billing-api 2.4.0 to undefined", and so does the browser tab.', true],
            ['Details card', 'The Environment row is blank.', true],
            ['Roll back confirmation', 'Asks "Roll back billing-api 2.4.0 in undefined?"', true]
          ]
        },
        nullable: {
          errors: [
            ['src/features/applications/ApplicationPage.tsx', 3, ASSIGN_UNDEF, 'screen'],
            ['src/features/applications/ApplicationsPage.tsx', 1, 'TS2345: Argument of type \'string | null\' is not assignable to parameter of type \'string\'.', 'screen'],
            ['src/features/deploy/DeployPage.tsx', 1, ASSIGN_UNDEF, 'screen'],
            ['src/features/deployments/DeploymentPage.tsx', 1, ASSIGN_UNDEF, 'screen'],
            ['src/mocks/db.ts', 3, 'TS2322, TS2345: Type \'string | null\' is not assignable to type \'string\'.', 'mock'],
            ['src/mocks/handlers/control.ts', 9, 'TS2345: Argument of type \'string | null\' is not assignable.', 'mock'],
            ['src/mocks/handlers/query.ts', 6, 'TS2345, TS2322: Type \'string | null\' is not assignable.', 'mock']
          ],
          runtime: [
            ['Applications list', 'The Owner team cell shows "…" for good, the placeholder for a team name that has not loaded.', true],
            ['Application, deploy and deployment pages', 'can() reads a missing team as "any team", so a DEPLOYER on Payments sees Deploy and Roll back for an application with no team. Only the server can refuse.', true]
          ]
        },
        status: {
          errors: [
            ['src/features/deployments/deploymentView.ts', 1, 'TS2345: Argument of type \'"PENDING" | "VALIDATING" | "DEPLOYING" | "HEALTHY" | "SUPERSEDED"\' is not assignable to parameter of type \'"PENDING" | "VALIDATING" | "DEPLOYING" | "HEALTHY"\'. (progressSteps: the stepper)', 'screen'],
            ['src/mocks/db.ts', 2, 'TS2741: Property \'SUPERSEDED\' is missing in type \'{ PENDING: …; … }\' but required in type \'Record<DeploymentState, …>\'.', 'mock']
          ],
          runtime: [
            ['Deployment page stepper', 'Shows no step done for a SUPERSEDED deployment.', true],
            ['Deployment page polling', 'deploymentPollInterval falls through to 2 s, so the page polls every 2 s for good. An if/else chain with a last return accepts any new value, so no compiler can see this.', false]
          ],
          fine: ['StatusChip', 'Prints SUPERSEDED in the ended tone: statusTone falls back for words it does not know.']
        }
      };

      let updated = false;
      const verdict = stableVerdict();

      const changeC = ui.choice('Backend change', [
        { value: 'none', label: 'None' },
        { value: 'rename', label: 'Rename environment' },
        { value: 'nullable', label: 'ownerTeamId may be null' },
        { value: 'status', label: 'New status SUPERSEDED' }
      ], 'none', () => { updated = false; render(); });
      const typesC = ui.choice('Types', [
        { value: 'hand', label: 'Written by hand (now)' },
        { value: 'gen', label: 'Generated from OpenAPI (S3.7)' }
      ], 'hand', () => render());
      const updateBtn = ui.button('Update types.ts', () => { updated = true; render(); });
      const anyT = ui.toggle('Type responses as any', false, () => render(), { tone: 'danger' });

      const typesCode = wrapCode('', 'types.ts');
      const buildCode = wrapCode('', 'Build output');
      const runtimeBox = h('div', { class: 'stack' });

      const rErrors = ui.readout('Type errors', 0);
      const rFiles = ui.readout('Screen files flagged', 0);
      const rBugs = ui.readout('Bugs that reach the screen', 0);

      el.append(
        controls(changeC.el),
        controls(typesC.el, updateBtn, anyT.el),
        stage(cols(
          ui.panel('src/api/types.ts', typesCode),
          ui.panel('npm run build', buildCode),
          ui.panel('At run time', runtimeBox)
        )),
        readouts(rErrors, rFiles, rBugs),
        verdict.el,
        note('The three backend changes are illustrative; none is planned, though a SUPERSEDED state is one option in backend gap 11. The error lists were measured with tsc 6.0.3 on a copy of web-console with each change applied, on 2 October 2026; line numbers are left out because the screens are still changing. The generated header is illustrative too: S3.7 has not landed.')
      );

      function render() {
        const id = changeC.get();
        const gen = typesC.get() === 'gen';
        const anyOn = anyT.get();
        const c = CHANGES[id];
        updateBtn.disabled = !c || gen || anyOn || updated;

        // types.ts as it stands
        let typesText;
        if (anyOn) {
          typesText = '// No wire types for responses. Every call is untyped:\nexport const getDeployment = (id: string) => request<any>(`/api/v1/deployments/${id}`);';
        } else if (!c) {
          typesText = '// control-api has not changed. types.ts mirrors the Java records, for example:\n' + SNIP.rename.before;
        } else if (gen) {
          typesText = '// Generated by openapi-typescript from control-api\'s OpenAPI after S3.7,\n// re-exported under the same names. Regenerated with the backend change:\n' + SNIP[id].after;
        } else if (updated) {
          typesText = '// Written by hand, updated to match control-api:\n' + SNIP[id].after;
        } else {
          typesText = '// Written by hand, still the old shape. control-api now sends something else:\n' + SNIP[id].before;
        }
        setCode(typesCode, typesText);

        AF.clear(runtimeBox);
        if (!c) {
          setCode(buildCode, '> npm run typecheck && vite build\n\ntsc: no errors\nvite build: done');
          runtimeBox.appendChild(liveNode('Every screen', 'Reads the fields control-api sends.', 'ok').el);
          rErrors.set(0); rFiles.set(0); rBugs.set(0);
          verdict.set('idle', 'No backend change yet. Choose one under Backend change.');
          return;
        }

        const current = !anyOn && (gen || updated);
        const errors = current ? c.errors : [];
        const total = errors.reduce((n, e) => n + e[1], 0);
        const screenFiles = errors.filter(e => e[3] === 'screen');
        const screenErrors = screenFiles.reduce((n, e) => n + e[1], 0);
        const mockErrors = total - screenErrors;
        if (errors.length) {
          const lines = errors.map(e => e[0] + ': ' + e[1] + (e[1] === 1 ? ' error' : ' errors') + '\n  ' + e[2]);
          setCode(buildCode, '> npm run typecheck && vite build\n\n' + lines.join('\n') + '\n\nFound ' + total + ' errors in ' + errors.length + ' files. The build stops here.');
        } else {
          setCode(buildCode, '> npm run typecheck && vite build\n\ntsc: no errors\nvite build: done\n\n' + (anyOn
            ? '// Nothing to check: the responses are any.'
            : '// Nothing to check against: types.ts still describes the old shape.'));
        }

        let reaching = 0;
        c.runtime.forEach(([where, what, catchable]) => {
          const stopped = current && catchable;
          if (!stopped) reaching++;
          runtimeBox.appendChild(liveNode(where, (stopped ? 'Stopped by the build. ' : 'Reaches users. ') + what, stopped ? 'ok' : 'bad').el);
        });
        if (c.fine) runtimeBox.appendChild(liveNode(c.fine[0], c.fine[1], 'idle').el);

        rErrors.set(total, total ? 'warn' : null);
        rFiles.set(screenFiles.length, screenFiles.length ? 'warn' : null);
        rBugs.set(reaching, reaching ? 'bad' : 'ok');

        if (anyOn) {
          verdict.set('bad', 'Nothing to check against: with responses typed as any, the build passes and the change goes straight to the screen. ' + reaching + (reaching === 1 ? ' problem reaches' : ' problems reach') + ' users.');
        } else if (!current) {
          verdict.set('bad', 'The build passes, because types.ts still describes the old shape. Mock mode even looks fine, since the simulated backend is typed with the same stale types; against the live control-api the screens break. Press Update types.ts.');
        } else if (reaching) {
          verdict.set('warn', 'The build stops with ' + total + ' errors: ' + screenErrors + ' in screen code and ' + mockErrors + ' in the simulated backend. Fix them, and one problem still gets through: deploymentPollInterval has no case for SUPERSEDED, and an if/else chain compiles with any new value.');
        } else {
          verdict.set('ok', 'The build stops with ' + total + ' errors: ' + screenErrors + ' in ' + screenFiles.length + (screenFiles.length === 1 ? ' screen file' : ' screen files') + ' and ' + mockErrors + ' in the simulated backend. Every place that reads the old shape is listed before anything ships.' +
            (gen ? ' With generated types, nobody had to notice the change first.' : ''));
        }
      }

      render();
    }
  });

  // =====================================================================
  // 5. Design tokens and one status colour (built, P1)
  // =====================================================================

  // ---------- colour maths (WCAG 2.x relative luminance and contrast) ----------
  function hexToRgb(hx) {
    const n = parseInt(hx.slice(1), 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  function rgbToHex(rgb) {
    return '#' + rgb.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('');
  }
  function hslToHex(hue, sat, light) {
    const s = sat / 100;
    const l = light / 100;
    const k = n => (n + hue / 30) % 12;
    const a = s * Math.min(l, 1 - l);
    const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
    return rgbToHex([f(0) * 255, f(8) * 255, f(4) * 255]);
  }
  function hexToHsl(hx) {
    const [r, g, b] = hexToRgb(hx).map(v => v / 255);
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l * 100];
    const d = max - min;
    const s = d / (1 - Math.abs(2 * l - 1));
    let hue;
    if (max === r) hue = 60 * (((g - b) / d) % 6);
    else if (max === g) hue = 60 * ((b - r) / d + 2);
    else hue = 60 * ((r - g) / d + 4);
    return [(hue + 360) % 360, s * 100, l * 100];
  }
  function luminance(hx) {
    const c = hexToRgb(hx).map(v => {
      const x = v / 255;
      return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  }
  function contrast(a, b) {
    const la = luminance(a);
    const lb = luminance(b);
    return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
  }

  AF.register({
    id: 'ui-tokens',
    group: 'design',
    order: 1,
    title: 'Design tokens and one status colour',
    question: 'How do you change a colour once and have every screen follow, without a status ever showing in the wrong colour?',
    status: 'built',
    slice: 'P1',
    where: [
      'web-console/src/styles/tokens.css',
      'web-console/src/lib/statusTone.ts',
      'web-console/src/components/StatusChip.tsx',
      'web-console/src/components/Button.module.css'
    ],
    idea: [
      'A design token is a named value, such as --accent or --radius-m, defined once. src/styles/tokens.css holds every colour, radius and control size from the design preview, and component CSS reads var(--accent), never a hex value. Change the token and every button, link and chip that uses it follows, because none of them knows the colour itself.',
      'CSS Modules give each component file its own class names: .primary in Button.module.css becomes a unique name at build time, so two files can both say .primary without clashing, and deleting a component deletes its styles. There is no runtime cost and no new vocabulary, which is why the console chose them over Tailwind.',
      'Status colour has a single owner. statusTone() maps every status word to one of four tones, progress, settled, attention or ended, and StatusChip is its only consumer. A word it does not know falls back to ended, and the chip always prints the word next to its colour.'
    ],
    terms: [
      ['Token', 'A named design value, defined once and read everywhere through var(--name).'],
      ['CSS Module', 'A CSS file whose class names are made unique per file at build time.'],
      ['Contrast ratio', 'WCAG\'s measure of how far apart two colours are in lightness: at least 4.5 to 1 for body text.']
    ],
    tryIt: [
      'Move Accent lightness and watch the mini console: the button, link, chip, notice and selected navigation item all change together. Read the contrast for white text on the accent.',
      'Raise the lightness until white text on the accent drops below 4.5 to 1, then lower it and watch accent links on the surface pass again. Try Surface: dark.',
      'Turn on Hard-code colours in components and change Accent hue or Attention: half the console keeps the old colours.'
    ],
    breakIt: 'With hex values copied into components, a brand or contrast fix has to find every copy. The ones it misses keep the old colour, so the same action or status shows in two colours on one screen.',
    say: 'Every colour and size is a token in tokens.css that CSS Modules read through var(), and statusTone with StatusChip is the only place a status gets a colour, so one change in one file restyles the whole console consistently.',
    quiz: {
      q: 'A designer asks for FAILED to look more urgent. Where does the change go?',
      options: [
        'In every screen that shows FAILED, as an extra class',
        'In StatusChip.tsx, as an if for FAILED',
        'In tokens.css, the --bad colours of the attention tone, or in statusTone, which decides that FAILED is attention; StatusChip and every screen follow',
        'In global.css, with a rule that matches the text FAILED'
      ],
      answer: 2,
      why: 'Screens never colour a status; they render StatusChip. The colour comes from the attention tone\'s tokens, and which words get that tone is decided in statusTone. Change the tokens and DEGRADED moves with FAILED; give FAILED a tone of its own in statusTone and only FAILED changes.'
    },
    mount(el, ctx) {
      const CONSOLE = {
        accent: '#1f4fbf', accentInk: '#163a8c', accentBg: '#eef2fc', selected: '#e7edfb', infoBorder: '#9fb4e6',
        bad: '#b2470c', badInk: '#8f3a09', badBg: '#fdf1e8', surface: '#ffffff', ink: '#1c1c1c',
        bg: '#f5f5f2', line: '#d6d6d1', okSolid: '#2b2b2b', okSolidInk: '#ffffff', ink2: '#3d3d3d', controlBorder: '#b5b5ae'
      };
      const HUES = { blue: [222, 72], teal: [187, 83], violet: [265, 55] };
      const DEFAULT_L = 43;
      const BAD = { console: '#b2470c', red: '#c62828', amber: '#e8890c' };
      const SURF = { white: '#ffffff', warm: '#f5f5f2', dark: '#2b2b2b' };

      const verdict = stableVerdict();

      const hueC = ui.choice('Accent hue', [
        { value: 'blue', label: 'blue (console)' }, { value: 'teal', label: 'teal' }, { value: 'violet', label: 'violet' }
      ], 'blue', () => render());
      const lightS = ui.slider({ label: 'Accent lightness', min: 20, max: 70, step: 1, value: DEFAULT_L, format: v => v + ' %', onInput: () => render() });
      const badC = ui.choice('Attention', [
        { value: 'console', label: '#b2470c (console)' }, { value: 'red', label: '#c62828' }, { value: 'amber', label: '#e8890c' }
      ], 'console', () => render());
      const surfC = ui.choice('Surface', [
        { value: 'white', label: 'white (console)' }, { value: 'warm', label: 'warm' }, { value: 'dark', label: 'dark' }
      ], 'white', () => render());
      const hardT = ui.toggle('Hard-code colours in components', false, () => render(), { tone: 'danger' });
      const resetBtn = ui.button('Reset', () => {
        hueC.set('blue'); lightS.set(DEFAULT_L); badC.set('console'); surfC.set('white'); hardT.set(false); render();
      }, { variant: 'quiet' });

      // ---- the mini console: every colour is var(--token), set on its root from the controls
      const span = (style, ...kids) => h('span', { style }, kids);
      const BTN = 'display:inline-flex;align-items:center;min-height:2.2rem;padding:0 .9rem;border-radius:6px;border:1px solid;font-weight:600;font-size:.88rem;';
      const CHIP = 'display:inline-flex;align-items:center;gap:.35rem;height:1.6rem;padding:0 .6rem;border-radius:.8rem;border:1px solid;font-size:.78rem;font-weight:600;';
      const dot = () => span('width:.45rem;height:.45rem;border-radius:50%;background:currentColor;display:inline-block', '');

      // name, token style, hard-coded style (console literals), tokens it depends on
      const PARTS = {
        primary: { name: 'Primary button', token: 'background:var(--accent);border-color:var(--accent);color:var(--ok-solid-ink)', hard: null, deps: ['accent'] },
        quiet: { name: 'Quiet button', token: 'background:transparent;border-color:transparent;color:var(--accent)', hard: 'background:transparent;border-color:transparent;color:' + CONSOLE.accent, deps: ['accent'] },
        danger: { name: 'Danger button', token: 'background:var(--surface);border-color:var(--bad);color:var(--bad-ink)', hard: 'background:var(--surface);border-color:' + CONSOLE.bad + ';color:' + CONSOLE.badInk, deps: ['bad'] },
        link: { name: 'Link', token: 'color:var(--accent);text-decoration:underline', hard: null, deps: ['accent'] },
        nav: { name: 'Selected navigation item', token: 'background:var(--selected);color:var(--accent-ink);font-weight:600', hard: 'background:' + CONSOLE.selected + ';color:' + CONSOLE.accentInk + ';font-weight:600', deps: ['accent'] },
        notice: { name: 'Success notice', token: 'background:var(--accent-bg);color:var(--accent-ink);border:1px solid var(--info-border)', hard: 'background:' + CONSOLE.accentBg + ';color:' + CONSOLE.accentInk + ';border:1px solid ' + CONSOLE.infoBorder, deps: ['accent'] },
        progress: { name: 'DEPLOYING chip', token: 'border-color:var(--accent);color:var(--accent);background:var(--accent-bg)', hard: null, deps: ['accent'] },
        attention: { name: 'FAILED chip', token: 'border-color:var(--bad);color:var(--bad-ink);background:var(--bad-bg)', hard: null, deps: ['bad'] }
      };
      const partEls = {};
      const preview = h('div', {
        role: 'img',
        style: 'display:flex;flex-wrap:wrap;align-items:stretch;border:1px solid var(--line);border-radius:8px;overflow:hidden;background:var(--bg);color:var(--ink);font-size:.9rem;min-width:0'
      });
      partEls.nav = span('display:block;padding:.45rem .6rem;border-radius:6px', 'Dashboard');
      const side = h('div', { style: 'flex:1 1 8.5rem;max-width:100%;background:var(--surface);border-right:1px solid var(--line);padding:.7rem .5rem;display:flex;flex-direction:column;gap:.15rem' },
        h('div', { style: 'font-weight:700;padding:0 .6rem .5rem' }, 'app', span('color:var(--accent)', 'fleet')),
        partEls.nav,
        span('display:block;padding:.45rem .6rem;color:var(--ink-2)', 'Applications'),
        span('display:block;padding:.45rem .6rem;color:var(--ink-2)', 'Fleet'));
      partEls.primary = span(BTN, 'Deploy');
      partEls.quiet = span(BTN, 'Cancel');
      partEls.danger = span(BTN, 'Roll back');
      partEls.link = span('', 'Find in audit trail');
      partEls.notice = h('div', { style: 'border-radius:6px;padding:.5rem .7rem' }, h('b', null, 'Accepted. '), 'billing-api 2.4.0 to qa is PENDING.');
      partEls.progress = span(CHIP, dot(), 'DEPLOYING');
      partEls.attention = span(CHIP, dot(), 'FAILED');
      const settled = span(CHIP + 'border-color:var(--ok-solid);background:var(--ok-solid);color:var(--ok-solid-ink)', dot(), 'HEALTHY');
      const ended = span(CHIP + 'border-style:dashed;border-color:var(--control-border);color:var(--ink-2);background:var(--surface)', dot(), 'ROLLED_BACK');
      const main = h('div', { style: 'flex:999 1 16rem;padding:.8rem;display:flex;flex-direction:column;gap:.6rem;min-width:0' },
        h('div', { style: 'display:flex;flex-wrap:wrap;gap:.5rem;align-items:center;font-weight:600;font-size:1.05rem' }, 'billing-api', partEls.progress),
        h('div', { style: 'background:var(--surface);border:1px solid var(--line);border-radius:8px;padding:.7rem;display:flex;flex-direction:column;gap:.6rem' },
          h('div', { style: 'display:flex;flex-wrap:wrap;gap:.45rem' }, partEls.primary, partEls.quiet, partEls.danger),
          h('div', { style: 'display:flex;flex-wrap:wrap;gap:.4rem' }, partEls.progress.cloneNode(true), settled, partEls.attention, ended),
          partEls.notice,
          h('div', { class: 'small' }, 'Correlation id c-7f3a91d2 ', partEls.link)));
      preview.append(side, main);
      // the clone above is decorative: keep a handle so it follows too
      const progressClone = main.children[1].children[1].firstChild;

      const tokenCode = wrapCode('', 'Tokens and component CSS');
      const rFollow = ui.readout('Elements that follow the tokens', '8 of 8');
      const rWhite = ui.readout('White on accent, primary button', '');
      const rLink = ui.readout('Accent on surface, links', '');
      const rBad = ui.readout('Attention ink on its wash, FAILED chip', '');
      const rInk = ui.readout('Ink on surface, body text', '');

      el.append(
        controls(hueC.el, lightS.el),
        controls(badC.el, surfC.el, hardT.el, resetBtn),
        stage(cols(preview, ui.panel('tokens.css and the component CSS', tokenCode))),
        readouts(rFollow, rWhite, rLink, rBad, rInk),
        verdict.el,
        note('statusTone maps PENDING, VALIDATING and DEPLOYING to progress, HEALTHY to settled, DEGRADED and FAILED to attention, and ROLLED_BACK and any unknown word to ended. Contrast is WCAG 2 relative luminance; AA asks for 4.5 to 1 for body text. tokens.css lists the ink and wash shades by hand; this preview derives them from your accent and attention colours, and keeps the console\'s exact values at the defaults.')
      );

      function tokens() {
        const hueKey = hueC.get();
        const L = lightS.get();
        const [hue, sat] = HUES[hueKey];
        const isDefault = hueKey === 'blue' && L === DEFAULT_L;
        const t = Object.assign({}, CONSOLE);
        if (!isDefault) {
          t.accent = hslToHex(hue, sat, L);
          t.accentInk = hslToHex(hue, sat, Math.max(8, L - 12));
          t.accentBg = hslToHex(hue, sat, 96);
          t.selected = hslToHex(hue, sat, 93);
          t.infoBorder = hslToHex(hue, sat * 0.6, 76);
        }
        const badKey = badC.get();
        if (badKey !== 'console') {
          const [bh, bs, bl] = hexToHsl(BAD[badKey]);
          t.bad = BAD[badKey];
          t.badInk = hslToHex(bh, bs, Math.max(8, bl - 10));
          t.badBg = hslToHex(bh, Math.min(bs, 85), 96);
        }
        t.surface = SURF[surfC.get()];
        return { t, accentChanged: !isDefault, badChanged: badKey !== 'console' };
      }

      function ratioText(r, min) {
        return r.toFixed(1) + ' : 1, ' + (r >= min ? 'passes AA' : 'fails AA');
      }

      function render() {
        const { t, accentChanged, badChanged } = tokens();
        const hard = hardT.get();
        const vars = {
          '--accent': t.accent, '--accent-ink': t.accentInk, '--accent-bg': t.accentBg, '--selected': t.selected,
          '--info-border': t.infoBorder, '--bad': t.bad, '--bad-ink': t.badInk, '--bad-bg': t.badBg,
          '--surface': t.surface, '--ink': t.ink, '--ink-2': t.ink2, '--bg': t.bg, '--line': t.line,
          '--ok-solid': t.okSolid, '--ok-solid-ink': t.okSolidInk, '--control-border': t.controlBorder
        };
        Object.keys(vars).forEach(k => preview.style.setProperty(k, vars[k]));

        let stale = [];
        Object.keys(PARTS).forEach(k => {
          const p = PARTS[k];
          const useHard = hard && p.hard;
          const base = k === 'primary' || k === 'quiet' || k === 'danger' ? BTN : (k === 'progress' || k === 'attention') ? CHIP : k === 'nav' ? 'display:block;padding:.45rem .6rem;border-radius:6px;' : k === 'notice' ? 'border-radius:6px;padding:.5rem .7rem;' : '';
          partEls[k].style.cssText = base + (useHard ? p.hard : p.token);
          if (useHard && ((p.deps[0] === 'accent' && accentChanged) || (p.deps[0] === 'bad' && badChanged))) stale.push(p.name);
        });
        progressClone.style.cssText = CHIP + PARTS.progress.token;

        const total = Object.keys(PARTS).length;
        rFollow.set((total - stale.length) + ' of ' + total, stale.length ? 'bad' : 'ok');
        preview.setAttribute('aria-label', 'Mini console preview. ' + (stale.length
          ? stale.length + ' of ' + total + ' elements still show the old colours: ' + stale.join(', ') + '.'
          : 'Every element shows the current token colours.'));

        const cWhite = contrast(t.okSolidInk, t.accent);
        const cLink = contrast(t.accent, t.surface);
        const cBad = contrast(t.badInk, t.badBg);
        const cInk = contrast(t.ink, t.surface);
        rWhite.set(ratioText(cWhite, 4.5), cWhite >= 4.5 ? 'ok' : 'bad');
        rLink.set(ratioText(cLink, 4.5), cLink >= 4.5 ? 'ok' : 'bad');
        rBad.set(ratioText(cBad, 4.5), cBad >= 4.5 ? 'ok' : 'bad');
        rInk.set(ratioText(cInk, 4.5), cInk >= 4.5 ? 'ok' : 'bad');

        setCode(tokenCode, [
          '/* tokens.css */',
          ':root {',
          '  --accent: ' + t.accent + ';',
          '  --accent-ink: ' + t.accentInk + ';',
          '  --accent-bg: ' + t.accentBg + ';',
          '  --bad: ' + t.bad + ';',
          '  --bad-ink: ' + t.badInk + ';',
          '  --bad-bg: ' + t.badBg + ';',
          '  --surface: ' + t.surface + ';',
          '}',
          '',
          '/* Button.module.css */',
          '.primary { background: var(--accent); color: var(--ok-solid-ink); }',
          hard ? '.quiet   { color: ' + CONSOLE.accent + '; }          /* hard-coded */' : '.quiet   { color: var(--accent); }',
          hard ? '.danger  { border-color: ' + CONSOLE.bad + '; color: ' + CONSOLE.badInk + '; }  /* hard-coded */' : '.danger  { border-color: var(--bad); color: var(--bad-ink); }',
          '',
          '/* StatusChip.module.css */',
          '.progress  { border-color: var(--accent); color: var(--accent); background: var(--accent-bg); }',
          '.attention { border-color: var(--bad); color: var(--bad-ink); background: var(--bad-bg); }'
        ].join('\n'));

        const fails = [];
        if (cWhite < 4.5) fails.push('white text on the accent');
        if (cLink < 4.5) fails.push('accent links on the surface');
        if (cBad < 4.5) fails.push('the FAILED chip');
        if (cInk < 4.5) fails.push('body text on the surface');
        if (stale.length) {
          verdict.set('bad', 'Two colours for one meaning: ' + stale.join(', ') + (stale.length === 1 ? ' keeps' : ' keep') + ' the old hex value while the rest follow the token. Every copy has to be found by hand.');
        } else if (fails.length) {
          verdict.set('warn', 'Every element follows the tokens, and that is how the problem shows up everywhere at once: ' + fails.join(', ') + (fails.length === 1 ? ' falls' : ' fall') + ' below 4.5 to 1.' +
            (surfC.get() === 'dark' ? ' A dark surface needs a light --ink too: tokens come in pairs.' : ''));
        } else if (hard) {
          verdict.set('warn', 'Looks identical for now, because the copied hex values match the defaults. Change Accent hue or Attention to see the copies fall behind.');
        } else {
          verdict.set('ok', 'One change in tokens.css, and every element that uses the token follows. All four text pairs pass AA.');
        }
      }

      render();
    }
  });

  // =====================================================================
  // 6. From a phone to a 2K screen (built, P1)
  // =====================================================================
  AF.register({
    id: 'ui-responsive',
    group: 'design',
    order: 2,
    title: 'From a phone to a 2K screen',
    question: 'How does one layout work on a phone, a laptop and a 2K monitor without a separate design for each?',
    status: 'built',
    slice: 'P1',
    where: [
      'web-console/src/styles/tokens.css',
      'web-console/src/components/Layout.module.css',
      'web-console/src/app/AppShell.module.css',
      'web-console/src/components/DataTable.module.css'
    ],
    idea: [
      'Every size in the console is in rem, a multiple of the root font size. tokens.css sets the root to 14px, 15px from 1800px wide (Full HD) and 16px from 2400px (2K), so the whole interface grows a step on big screens without an extra rule anywhere. Gutters and gaps use clamp(), following the window between a floor and a ceiling.',
      'There are only four breakpoints. At 760px and below the sidebar becomes a bar across the top; at 860px two-column layouts stack; 1800px and 2400px change the root font. Grid tracks use minmax() with auto-fit, so the dashboard tiles reflow by themselves. The pair layout keeps two cards stacked until 1800px, then puts them side by side.',
      'Wide tables do not squash. DataTable gives the table a minimum width, 760px for recent deployments, and scrolls it sideways inside its card, so a phone still shows every column and the page itself never scrolls sideways.'
    ],
    terms: [
      ['rem', 'A length relative to the root font size. Change the root, and every rem changes with it.'],
      ['Breakpoint', 'A window width at which a media query switches the layout.'],
      ['minmax()', 'A grid track size with a floor and a ceiling, such as minmax(14rem, 1fr).'],
      ['clamp()', 'A value that follows the window between a minimum and a maximum, such as clamp(16px, 1.6vw, 48px).']
    ],
    tryIt: [
      'Drag Window width from 360 to 2560 and watch the breakpoints: the top bar becomes a sidebar above 760, the cards pair at 1800, and the root font steps to 15 and then 16px.',
      'Stop at 1800: the cards have just paired, and the recent-deployments table, 760px at minimum, scrolls inside its card while the page does not. At 1920 it fits.',
      'Turn on Fixed pixel widths and try the Phone and 2K presets: the page overflows on a phone and leaves almost half of a 2K screen empty.'
    ],
    breakIt: 'A layout built from fixed pixel widths fits the one screen it was drawn on: on a phone the page scrolls sideways, and on a 2K monitor the content sits in a narrow column with the text at laptop size.',
    say: 'Sizes are rem on a 14, 15 or 16px root, layouts use minmax() and auto-fit grids with only four breakpoints, the pair layout goes side by side from Full HD, and wide tables scroll inside their card, so one layout serves 360 to 2560 pixels.',
    quiz: {
      q: 'At 1800px the dashboard pairs its two cards, and the recent-deployments table, 760px at minimum, no longer fits its card. What does the console do?',
      options: [
        'Shrinks the columns until the table fits',
        'Scrolls the table sideways inside its card; the page itself does not scroll',
        'Lets the whole page scroll sideways',
        'Stacks the cards again until the table fits'
      ],
      answer: 1,
      why: 'DataTable wraps the grid in a box with overflow-x: auto and gives the table a minimum width, so the columns keep a readable size and only that card scrolls. Squashed columns would break ids and versions mid-word, and a page that scrolls sideways pushes the navigation out of view.'
    },
    mount(el, ctx) {
      const VBW = 2560;
      const clamp = (min, v, max) => Math.max(min, Math.min(max, v));
      const MATRIX_MIN = 130 + 4 * 125;   // WhatRunsWhere: 130 + environments.length * 125
      const RECENT_MIN = 760;             // RecentDeployments minWidth

      /** Widths follow the console's CSS; heights are approximate, for drawing only. */
      function layout(W, fixed) {
        const L = { W, fixed };
        if (fixed) {
          L.R = 14; L.topbar = false; L.side = 260; L.padX = 24; L.contentW = 1100; L.gap = 20; L.gT = 12;
          L.pageW = L.side + 2 * L.padX + L.contentW;
          L.tileCols = 4; L.pairSide = true;
          L.colA = L.colB = (L.contentW - L.gap) / 2;
        } else {
          L.R = W >= 2400 ? 16 : W >= 1800 ? 15 : 14;
          L.topbar = W <= 760;
          L.side = L.topbar ? 0 : clamp(220, 0.12 * W, 300);
          L.padX = L.topbar ? 1.15 * L.R : clamp(16, 0.016 * W, 48);
          L.contentW = W - L.side - 2 * L.padX;
          L.gap = clamp(16, 0.011 * W, 28);
          L.gT = 0.85 * L.R;
          L.pageW = W;
          L.tileCols = Math.max(1, Math.min(4, Math.floor((L.contentW + L.gT) / (14 * L.R + L.gT))));
          L.pairSide = W >= 1800;
          if (L.pairSide) {
            L.colA = (L.contentW - L.gap) * (1 / 2.1);
            L.colB = (L.contentW - L.gap) * (1.1 / 2.1);
          } else {
            L.colA = L.colB = L.contentW;
          }
        }
        const pad = 2 * 1.3 * L.R + 2;
        L.innerA = L.colA - pad;
        L.innerB = L.colB - pad;
        L.scrollA = L.innerA < MATRIX_MIN;
        L.scrollB = L.innerB < RECENT_MIN;
        L.overflow = Math.max(0, L.pageW - W);
        L.unused = fixed ? Math.max(0, W - L.pageW) : 0;
        // heights (approximate)
        const R = L.R;
        L.barH = L.topbar ? 3.6 * R : 0;
        L.padTop = L.topbar ? 1.15 * R : 1.4 * R;
        L.topRowH = 2.85 * R;
        L.headH = 3.4 * R;
        L.tileH = 6.2 * R;
        L.tileRows = Math.ceil(4 / L.tileCols);
        L.tilesH = L.tileRows * L.tileH + (L.tileRows - 1) * L.gT;
        L.hA = 2.6 * R + 5 * 3 * R + 2.3 * R;
        L.hB = 2.6 * R + 7 * 2.6 * R + 2.3 * R;
        L.cardsH = L.pairSide ? Math.max(L.hA, L.hB) : L.hA + L.gap + L.hB;
        L.H = L.barH + L.padTop + L.topRowH + L.gap + L.headH + L.gap + L.tilesH + L.gap + L.cardsH + 3.5 * R;
        return L;
      }
      let VBH = 1000;

      const verdict = stableVerdict();

      const widthS = ui.slider({ label: 'Window width', min: 360, max: 2560, step: 10, value: 1366, format: v => v + ' px', onInput: () => render() });
      const presetC = ui.choice('Preset', [
        { value: 360, label: 'Phone 360' }, { value: 1366, label: 'Laptop 1366' }, { value: 1920, label: 'Full HD 1920' }, { value: 2560, label: '2K 2560' }
      ], 1366, v => { widthS.set(v); render(); });
      const fixedT = ui.toggle('Fixed pixel widths', false, () => render(), { tone: 'danger' });

      const svg = sv('svg', { class: 'chart', viewBox: '0 0 ' + VBW + ' ' + VBH, role: 'img', preserveAspectRatio: 'xMinYMin meet' });
      const bpRow = h('div', { class: 'row' });

      const rWin = ui.readout('Window', '');
      const rRoot = ui.readout('Root font', '');
      const rNav = ui.readout('Navigation', '');
      const rCards = ui.readout('Dashboard cards', '');
      const rTiles = ui.readout('Tile columns', '');
      const rScroll = ui.readout('Tables scrolling in their card', '');
      const rOver = ui.readout('Page overflow', '');
      const rUnused = ui.readout('Unused width', '');

      el.append(
        controls(widthS.el),
        controls(presetC.el, fixedT.el),
        stage(svg),
        bpRow,
        readouts(rWin, rRoot, rNav, rCards, rTiles, rScroll, rOver, rUnused),
        verdict.el,
        note('Drawn to scale: the frame is the window, everything inside follows the console\'s CSS (sidebar clamp(220px, 12vw, 300px), gutters, rem sizes, the pair ratio 1 to 1.1, table minimum widths 630 and 760px). Heights are approximate. The fixed layout is illustrative: a 260px sidebar and an 1100px content column, as if the design had been measured once at 1408px.')
      );

      function rect(x, y, w, hh, fill, stroke, extra) {
        const a = { x: x.toFixed(1), y: y.toFixed(1), width: Math.max(0, w).toFixed(1), height: Math.max(0, hh).toFixed(1), rx: 6,
          style: 'fill:' + fill + ';stroke:' + (stroke || 'none') + (extra || '') };
        svg.appendChild(sv('rect', a));
      }
      function text(x, y, str, size) {
        svg.appendChild(sv('text', { x: x.toFixed(1), y: y.toFixed(1), style: 'font-size:' + size + 'px' }, str));
      }

      function draw(L) {
        AF.clear(svg);
        const k = (svg.getBoundingClientRect().width || 900) / VBW;
        const fs = Math.round(12 / k);
        // the drawing is as tall as the page, plus a line for the window label
        VBH = Math.ceil(L.H + fs * 1.8);
        svg.setAttribute('viewBox', '0 0 ' + VBW + ' ' + VBH);
        const sw = ';stroke-width:' + (1.2 / k).toFixed(1);
        const W = L.W;
        const R = L.R;
        rect(0, 0, L.pageW, L.H, 'var(--white)', 'var(--line)', sw);
        // navigation
        if (L.topbar) {
          rect(0, 0, W, L.barH, 'var(--bay)', 'var(--rail)', sw);
          text(L.padX, L.barH * 0.62, 'Top bar', fs);
        } else {
          rect(0, 0, L.side, L.H, 'var(--bay)', 'var(--rail)', sw);
          for (let i = 0; i < 6; i++) rect(0.06 * L.side, 3 * R + i * 3.1 * R, 0.88 * L.side, 2.4 * R, i === 0 ? 'var(--signal-wash)' : 'var(--paper)', 'none');
          text(0.06 * L.side, 2 * R, 'Sidebar', fs);
        }
        const x0 = L.side + L.padX;
        let y = L.barH + L.padTop;
        rect(x0, y, Math.min(32 * R, L.contentW * 0.6), L.topRowH, 'var(--paper)', 'var(--line)', sw);
        y += L.topRowH + L.gap;
        rect(x0, y, Math.min(22 * R, L.contentW * 0.7), 1.9 * R, 'var(--board)', 'none');
        y += L.headH + L.gap;
        const tw = (L.contentW - (L.tileCols - 1) * L.gT) / L.tileCols;
        for (let i = 0; i < 4; i++) {
          const c = i % L.tileCols;
          const r = Math.floor(i / L.tileCols);
          rect(x0 + c * (tw + L.gT), y + r * (L.tileH + L.gT), tw, L.tileH, 'var(--paper)', 'var(--line)', sw);
        }
        if (L.tileCols >= 1) text(x0 + 0.5 * R, y + 1.6 * R, L.tileCols + (L.tileCols === 1 ? ' tile column' : ' tile columns'), fs);
        y += L.tilesH + L.gap;
        const cards = L.pairSide
          ? [[x0, y, L.colA, L.hA, L.innerA, MATRIX_MIN, L.scrollA, 'What runs where'], [x0 + L.colA + L.gap, y, L.colB, L.hB, L.innerB, RECENT_MIN, L.scrollB, 'Recent deployments']]
          : [[x0, y, L.contentW, L.hA, L.innerA, MATRIX_MIN, L.scrollA, 'What runs where'], [x0, y + L.hA + L.gap, L.contentW, L.hB, L.innerB, RECENT_MIN, L.scrollB, 'Recent deployments']];
        cards.forEach(([cx, cy, cw, chh, inner, minW, scroll, name]) => {
          rect(cx, cy, cw, chh, 'var(--white)', 'var(--rail)', sw);
          text(cx + 1.3 * R, cy + 1.9 * R, name, fs);
          const tx = cx + 1.3 * R + 1;
          const ty = cy + 2.8 * R;
          const th = chh - 5.4 * R;
          rect(tx, ty, inner, th, scroll ? 'var(--warn-wash)' : 'var(--paper)', 'none');
          if (scroll) {
            const trackY = ty + th + 0.5 * R;
            rect(tx, trackY, inner, 0.6 * R, 'var(--idle-wash)', 'none');
            rect(tx, trackY, inner * Math.min(1, inner / minW), 0.6 * R, 'var(--warn)', 'none');
            text(tx + 0.4 * R, ty + 1.6 * R, 'scrolls: ' + minW + 'px table in ' + Math.round(inner) + 'px', fs);
          } else {
            text(tx + 0.4 * R, ty + 1.6 * R, 'fits: ' + minW + 'px table in ' + Math.round(inner) + 'px', fs);
          }
        });
        // window edge and what falls outside it
        // labels for these go under the drawing, so they never sit on top of a card
        if (L.overflow > 0) {
          rect(W, 0, L.overflow, L.H, 'var(--bad-wash)', 'none', ';opacity:.8');
          text(W + 0.8 * R, L.H + fs * 1.3, 'outside the window: ' + Math.round(L.overflow) + 'px to scroll sideways', fs);
        }
        if (L.unused > 0) {
          rect(L.pageW, 0, L.unused, L.H, 'var(--idle-wash)', 'none');
          text(L.pageW + 0.8 * R, L.H + fs * 1.3, 'unused: ' + Math.round(L.unused) + 'px', fs);
        }
        svg.appendChild(sv('rect', { x: 0, y: 0, width: W, height: L.H, rx: 6, style: 'fill:none;stroke:var(--ink);stroke-width:' + (2.2 / k).toFixed(1) }));
        text(Math.max(0, Math.min(W - 8 * fs, VBW - 9 * fs)), L.H + fs * 1.3, 'window ' + W + 'px', fs);
      }

      function render() {
        const W = widthS.get();
        const fixed = fixedT.get();
        const L = layout(W, fixed);
        presetC.set(W);
        draw(L);
        svg.setAttribute('aria-label', 'Dashboard at ' + W + 'px: ' + (L.topbar ? 'top bar' : 'sidebar') + ', ' + (L.pairSide ? 'cards side by side' : 'cards stacked') + ', ' +
          L.tileCols + ' tile columns' + (L.overflow ? ', ' + Math.round(L.overflow) + 'px outside the window' : '') + '.');

        AF.clear(bpRow);
        const BPS = [
          [!fixed && W <= 760, '760 and below: sidebar becomes a top bar'],
          [!fixed && W <= 860, '860 and below: two-column layouts stack'],
          [!fixed && W >= 1800, '1800 and up: root 15px, pairs side by side'],
          [!fixed && W >= 2400, '2400 and up: root 16px']
        ];
        BPS.forEach(([on, t]) => bpRow.appendChild(wrapTok((on ? 'on: ' : 'off: ') + t, on ? 'busy' : 'idle')));

        const scrolling = (L.scrollA ? 1 : 0) + (L.scrollB ? 1 : 0);
        rWin.set(W + ' px');
        rRoot.set(L.R + ' px');
        rNav.set(L.topbar ? 'Top bar' : 'Sidebar ' + Math.round(L.side) + ' px');
        rCards.set(L.pairSide ? 'Side by side' : 'Stacked');
        rTiles.set(L.tileCols);
        rScroll.set(scrolling + ' of 2', scrolling ? 'warn' : null);
        rOver.set(Math.round(L.overflow) + ' px', L.overflow ? 'bad' : 'ok');
        rUnused.set(fixed ? Math.round(L.unused) + ' px' + (L.unused ? ', ' + Math.round(L.unused / W * 100) + ' %' : '') : 'none', L.unused ? 'bad' : null);

        if (fixed && L.overflow > 0) {
          verdict.set('bad', 'Fixed widths at ' + W + 'px: the page is ' + Math.round(L.pageW) + 'px wide, so ' + Math.round(L.overflow) + 'px sit outside the window and the whole page scrolls sideways, navigation included.');
        } else if (fixed && L.unused > W * 0.2) {
          verdict.set('bad', 'Fixed widths at ' + W + 'px: ' + Math.round(L.unused / W * 100) + ' % of the screen is empty, the text is still 14px, and both tables still scroll inside 540px cards.');
        } else if (fixed) {
          verdict.set('warn', 'Fixed widths happen to fit near ' + Math.round(L.pageW) + 'px, the one width they were measured at. Try the Phone and 2K presets.');
        } else if (L.scrollB && L.pairSide) {
          verdict.set('warn', 'Just paired: at ' + W + 'px each card is narrower, and the recent-deployments table (760px minimum) scrolls inside its card. The page itself does not scroll. Wider windows give it room.');
        } else if (L.topbar) {
          verdict.set('ok', 'Phone width: navigation is a bar across the top, tiles and cards stack, and both tables scroll inside their cards. Nothing sticks out of the window.');
        } else if (L.pairSide) {
          verdict.set('ok', 'Root ' + L.R + 'px: everything in rem has grown a step, the cards sit side by side, and both tables fit.');
        } else {
          verdict.set('ok', 'Laptop range: a ' + Math.round(L.side) + 'px sidebar, ' + L.tileCols + ' tile columns from auto-fit, and the pair layout still stacked, so each table gets the full width.');
        }
      }

      const onResize = () => render();
      window.addEventListener('resize', onResize);
      ctx.onCleanup(() => window.removeEventListener('resize', onResize));
      render();
      // the SVG has its real width once it is in the page
      ctx.timeout(render, 0);
    }
  });

  // =====================================================================
  // 7. Controls everyone can use (built, P1)
  // =====================================================================
  AF.register({
    id: 'ui-a11y',
    group: 'design',
    order: 3,
    title: 'Controls everyone can use',
    question: 'How do you build screens that work with a keyboard, with a screen reader and without relying on colour?',
    status: 'built',
    slice: 'P1',
    where: [
      'web-console/src/components/Feedback.tsx',
      'web-console/src/components/Forms.tsx',
      'web-console/src/components/StatusChip.tsx',
      'web-console/src/app/AppShell.tsx'
    ],
    idea: [
      'Assistive technology reads a page through roles, names and states, not pixels. A real button has the role button, is reached with Tab and works with Enter and Space; a div with a click handler has none of that. The console uses real buttons and links everywhere, and eslint-plugin-jsx-a11y fails the lint when someone puts a click handler on a div.',
      'Every field has a label tied to it with htmlFor, or an aria-label for search boxes. Toggle and filter buttons, and selectable rows, carry aria-pressed; NavLink marks the current page with aria-current. Notice uses role="alert" for warnings, read out at once, and role="status" for successes, read out at the next pause.',
      'StatusChip always prints the status word next to its colour, so colour is never the only signal. Focus is always visible through :focus-visible, it moves to the new page after navigation, and transitions stop when the system asks for reduced motion.'
    ],
    terms: [
      ['Accessible name', 'The text assistive technology uses for an element: a button\'s text, a field\'s label.'],
      ['Live region', 'An element whose changes are read out without moving focus. role="alert" interrupts; role="status" waits.'],
      ['aria-pressed', 'Tells assistive technology that a button is a toggle, and whether it is on.'],
      ['Tab order', 'The order keyboard focus visits controls. Only focusable elements, such as buttons, links and fields, are in it.']
    ],
    tryIt: [
      'Press Send Tab to move through the mini console, or Tab into it with your own keyboard, and read what the screen reader view announces. Reach Deploy and press Send Enter.',
      'Watch the conflict notice: it is announced at once because it has role="alert".',
      'Turn on each break switch in turn and watch one line of the screen reader view go wrong: a Deploy nobody can reach, a status that says nothing, a field with no name, an error nobody hears.',
      'With Colour-only status on, turn on View in greyscale: the status is gone.'
    ],
    breakIt: 'A clickable div cannot be reached with Tab, a colour-only status says nothing to a screen reader or to a colour-blind user, an unlabelled field is announced as just "edit text", and an error without role="alert" appears where nobody is looking.',
    say: 'The console uses real buttons and links, labels every field, marks toggles with aria-pressed and the current page with aria-current, announces notices through role="alert" and role="status", always prints the status word next to its colour and keeps focus visible, and eslint-plugin-jsx-a11y and role-based tests keep it that way.',
    quiz: {
      q: 'A deploy fails, and an error box appears under the button, styled red but without role="alert". What does a screen-reader user notice?',
      options: [
        'Nothing at that moment: the text is added silently, and they find it only if they go looking',
        'The error, read at once, because red text is always announced',
        'A beep, because the browser marks the form invalid',
        'The error, because focus moves to new content by itself'
      ],
      answer: 0,
      why: 'New content is not read unless it sits in a live region or receives focus. Notice puts warnings in role="alert", which is read at once, and successes in role="status", which waits for a pause.'
    },
    mount(el, ctx) {
      const NOTICE = 'Not started: conflict. billing-api already has an active deployment in prod (2.3.1, HEALTHY).';
      let vfocus = -1;          // index into the Tab order, for Press Tab
      let noticeShown = false;
      let announced = 0;
      let release = '2.4.0';
      const uid = 'a11y-rel-' + Math.floor(Math.random() * 1e6);

      const log = shortLog('Screen reader announcements', 8);
      const verdict = stableVerdict();

      const divT = ui.toggle('Clickable div instead of a button', false, () => render(), { tone: 'danger' });
      const colourT = ui.toggle('Colour-only status', false, () => render(), { tone: 'danger' });
      const labelT = ui.toggle('Field without a label', false, () => render(), { tone: 'danger' });
      const silentT = ui.toggle('Silent error message', false, () => render(), { tone: 'danger' });
      const greyT = ui.toggle('View in greyscale', false, () => render());
      const tabBtn = ui.button('Send Tab', () => pressTab());
      const enterBtn = ui.button('Send Enter', () => pressEnter());
      const resetBtn = ui.button('Reset', () => {
        vfocus = -1; noticeShown = false; announced = 0; release = '2.4.0';
        log.clear(); verdict.clear(); render();
      }, { variant: 'quiet' });

      const mini = h('div', { style: 'border:1px solid var(--line);border-radius:8px;padding:.9rem;background:var(--white);display:flex;flex-direction:column;gap:.75rem;min-width:0' });
      mini.addEventListener('focusin', e => {
        const items = describeAll();
        const it = items.find(x => x.el === e.target);
        if (it) log.add('Focus: ' + it.say, it.bad ? 'bad' : 'busy');
      });
      const atList = h('ol', { class: 'small', style: 'margin:0;padding-left:1.2rem;display:flex;flex-direction:column;gap:.3rem' });
      const tabList = h('ol', { class: 'small', style: 'margin:0;padding-left:1.2rem;display:flex;flex-direction:column;gap:.3rem' });

      const rReach = ui.readout('Controls reachable by keyboard', '');
      const rProblems = ui.readout('Problems for assistive technology', '');
      const rAnnounced = ui.readout('Notices announced', 0);

      el.append(
        controls(divT.el, colourT.el, labelT.el, silentT.el),
        controls(tabBtn, enterBtn, greyT.el, resetBtn),
        stage(cols(
          ui.panel('Mini console', mini),
          ui.panel('What a screen reader finds, in reading order', atList),
          ui.panel('Tab order', tabList)
        )),
        readouts(rReach, rProblems, rAnnounced),
        verdict.el,
        log.el,
        note('The screen reader view is worked out from the mini console\'s real markup: element types, label links and roles. Wording varies between screen readers; NVDA, JAWS and VoiceOver all say the role and the name. The mini console\'s field and button are real, so your own Tab key works on them too.')
      );

      let parts = {};

      function onDeploy() {
        noticeShown = true;
        render();
        if (silentT.get()) {
          log.add('(The notice appeared. No live role, so nothing was read out.)', 'muted');
        } else {
          announced++;
          rAnnounced.set(announced, 'ok');
          log.add('Alert: ' + NOTICE, 'warn');
        }
        renderVerdict();
      }

      function build() {
        AF.clear(mini);
        parts = {};
        parts.heading = h('h3', { style: 'margin:0;font-size:1rem' }, 'Deploy billing-api to prod');
        const input = h('input', {
          id: uid, type: 'text', value: release,
          style: 'min-height:2.4rem;padding:0 .6rem;border:1px solid var(--rail);border-radius:6px;background:var(--white);max-width:12rem;width:100%'
        });
        input.addEventListener('input', () => { release = input.value; renderPanels(); });
        parts.input = input;
        const fieldLabel = labelT.get() ? h('span', { class: 'small' }, 'Release') : h('label', { for: uid, class: 'small' }, 'Release');
        const field = h('div', { class: 'stack', style: 'gap:.25rem' }, fieldLabel, input);
        parts.status = colourT.get()
          ? h('span', { style: 'display:inline-block;width:.9rem;height:.9rem;border-radius:50%;background:var(--ok)' })
          : ui.token('HEALTHY', 'ok');
        const statusLine = h('div', { class: 'row' }, h('span', null, 'prod now:'), parts.status);
        parts.deploy = divT.get()
          ? h('div', { class: 'btn primary', on: { click: onDeploy } }, 'Deploy')
          : ui.button('Deploy', onDeploy, { variant: 'primary' });
        parts.notice = noticeShown
          ? h('div', { class: 'verdict is-bad', role: silentT.get() ? null : 'alert' }, NOTICE)
          : null;
        mini.append(parts.heading, field, statusLine, h('div', { class: 'row' }, parts.deploy));
        if (parts.notice) mini.appendChild(parts.notice);
        mini.style.filter = greyT.get() ? 'grayscale(1)' : 'none';
      }

      function tabOrder() {
        return Array.from(mini.querySelectorAll('input, button, a[href], select, textarea, [tabindex]'))
          .filter(e => !e.disabled && e.getAttribute('tabindex') !== '-1');
      }

      /** What a screen reader says for each part, worked out from the markup. */
      function describeAll() {
        const out = [];
        out.push({ el: parts.heading, say: 'Heading level 3, Deploy billing-api to prod', bad: false });
        const inp = parts.input;
        const named = inp.labels && inp.labels.length ? inp.labels[0].textContent : inp.getAttribute('aria-label');
        out.push(named
          ? { el: inp, say: named + ', edit text, ' + (inp.value || 'blank'), short: named + ', edit text', bad: false }
          : { el: inp, say: 'Edit text, ' + (inp.value || 'blank') + '. No name: which field is this?', short: 'Edit text, no name', bad: true });
        const statusText = parts.status.textContent.trim();
        out.push(statusText
          ? { el: parts.status, say: 'prod now: ' + statusText, bad: false }
          : { el: parts.status, say: 'prod now: (nothing: the status is only a coloured dot)', bad: true });
        out.push(parts.deploy.tagName === 'BUTTON'
          ? { el: parts.deploy, say: 'Deploy, button', short: 'Deploy, button', bad: false }
          : { el: parts.deploy, say: 'Deploy (plain text: no role, not in the Tab order, Enter does nothing)', bad: true });
        if (parts.notice) {
          const role = parts.notice.getAttribute('role');
          out.push(role === 'alert'
            ? { el: parts.notice, say: 'Alert: ' + NOTICE + ' (read out when it appeared)', bad: false }
            : { el: parts.notice, say: NOTICE + ' (plain text: it appeared silently)', bad: true });
        }
        return out;
      }

      function renderPanels() {
        const items = describeAll();
        AF.clear(atList);
        items.forEach(it => atList.appendChild(h('li', null, AF.tone(h('span', { class: 'token', style: 'white-space:normal' }, (it.bad ? 'Problem: ' : '') + it.say), it.bad ? 'bad' : null))));
        const order = tabOrder();
        AF.clear(tabList);
        order.forEach((e, i) => {
          const it = items.find(x => x.el === e);
          const t = it ? (it.short || it.say) : e.tagName.toLowerCase();
          tabList.appendChild(h('li', null, AF.tone(h('span', { class: 'token', style: 'white-space:normal' }, t), i === vfocus ? 'busy' : null)));
        });
        if (divT.get()) tabList.appendChild(h('li', null, wrapTok('Problem: Deploy is not in the Tab order', 'bad')));
        const controlsTotal = 2;
        const reachable = order.length;
        rReach.set(reachable + ' of ' + controlsTotal, reachable === controlsTotal ? 'ok' : 'bad');
        const problems = [divT.get(), colourT.get(), labelT.get(), silentT.get()].filter(Boolean).length;
        rProblems.set(problems, problems ? 'bad' : 'ok');
        // show the simulated focus ring
        order.forEach((e, i) => {
          e.style.outline = i === vfocus ? '3px solid var(--signal)' : '';
          e.style.outlineOffset = i === vfocus ? '2px' : '';
        });
      }

      function render() {
        build();
        const n = tabOrder().length;
        if (vfocus >= n) vfocus = -1;
        renderPanels();
        renderVerdict();
      }

      function pressTab() {
        const order = tabOrder();
        if (!order.length) return;
        vfocus = (vfocus + 1) % order.length;
        renderPanels();
        const it = describeAll().find(x => x.el === order[vfocus]);
        log.add('Tab: ' + (it ? it.say : 'next control'), it && it.bad ? 'bad' : 'busy');
        if (divT.get() && vfocus === order.length - 1) log.add('Tab again goes back to the field: Deploy is skipped, because a div is not focusable.', 'warn');
      }

      function pressEnter() {
        const order = tabOrder();
        const target = order[vfocus];
        if (!target) {
          log.add('Enter: nothing has focus yet. Press Tab first.', 'muted');
          return;
        }
        if (target.tagName === 'BUTTON') {
          log.add('Enter on Deploy, button: activated', 'ok');
          onDeploy();
        } else {
          log.add('Enter on the field: nothing happens. ' + (divT.get() ? 'Deploy cannot be reached, so a keyboard user cannot deploy at all.' : 'Tab on to Deploy.'), divT.get() ? 'bad' : 'muted');
          renderVerdict();
        }
      }

      function renderVerdict() {
        const broken = [];
        if (divT.get()) broken.push('Deploy is a div: Tab skips it, Enter and Space do nothing, and a screen reader calls it plain text');
        if (colourT.get()) broken.push('the status is a dot: a screen reader says nothing, and without colour it is gone' + (greyT.get() ? ', as greyscale shows' : ''));
        if (labelT.get()) broken.push('the field has no name: it is announced as "edit text"');
        if (silentT.get()) broken.push('the error has no live role: it appears where nobody is looking' + (noticeShown ? ', and it just did' : ''));
        if (broken.length) {
          verdict.set('bad', broken.length + (broken.length === 1 ? ' problem: ' : ' problems: ') + broken.join('; ') + '.');
        } else if (noticeShown) {
          verdict.set('ok', 'The conflict was read out at once because the notice has role="alert", and focus stayed where it was. Every control has a role and a name, and the status says HEALTHY in words.');
        } else {
          verdict.set('ok', 'Every control has a role and a name, both are in the Tab order, and the status says HEALTHY in words as well as colour. Press Send Tab, or press Deploy.');
        }
      }

      render();
    }
  });
})();
