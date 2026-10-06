/*
 * labs-redis.js: the Redis lessons for "How Appfleet works".
 *
 * One lesson per use of Redis in Appfleet:
 *   rd-idempotency  idempotency keys on POST /deployments      built, S3.5
 *   rd-ratelimit    per-team token bucket                      built, S3.6
 *   rd-lease        node lease with fencing tokens             planned, S5
 *   rd-heartbeat    heartbeat sorted set and fleet health      planned, S5
 *   rd-cache        cache-aside, eviction, stampede            planned, S6
 *
 * Facts come from docs/design/control-api/control-api-s3-5-idempotency.md,
 * control-api-s3-6-rate-limiting.md, docs/specs/project/04-NODE-AGENT.md,
 * docs/specs/project/05-QUERY-SERVICE.md, docs/design/node-agent/node-agent.md
 * and the code in io.appfleet.control.idempotency.
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
  const details = (summary, ...kids) => h('details', null, h('summary', { class: 'small' }, summary), kids);
  const setCode = (pre, text) => { pre.firstChild.textContent = text; };

  function hexChars(n) {
    let out = '';
    for (let i = 0; i < n; i++) out += Math.floor(Math.random() * 16).toString(16);
    return out;
  }
  const variant = () => '89ab'[Math.floor(Math.random() * 4)];
  const uuid4 = () => hexChars(8) + '-' + hexChars(4) + '-4' + hexChars(3) + '-' + variant() + hexChars(3) + '-' + hexChars(12);
  function uuid7() {
    const ts = Date.now().toString(16).padStart(12, '0');
    return ts.slice(0, 8) + '-' + ts.slice(8, 12) + '-7' + hexChars(3) + '-' + variant() + hexChars(3) + '-' + hexChars(12);
  }
  const short = id => id.slice(0, 8) + '…';
  const secs = ms => (ms / 1000).toFixed(1) + ' s';
  const group = n => String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  const pct = (a, b) => (b ? Math.round((a / b) * 100) : 0) + ' %';

  /** FNV-1a: a short stand-in for the SHA-256 fingerprint. */
  function fnv(str) {
    let x = 0x811c9dc5;
    for (let i = 0; i < str.length; i++) {
      x ^= str.charCodeAt(i);
      x = Math.imul(x, 0x01000193) >>> 0;
    }
    return x.toString(16).padStart(8, '0');
  }

  /** Seeded PRNG, so a "random" chart looks the same every time. */
  function mulberry32(seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

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

  /** A shorter log for the continuously running simulations (layout only). */
  function shortLog(labelText) {
    const lg = ui.log({ label: labelText });
    lg.el.style.maxHeight = '9rem';
    return lg;
  }

  /** A .node whose label and sub line can be updated. opts.code renders the label as code (Redis keys). */
  function liveNode(text, sub, tone, opts) {
    const o = opts || {};
    const labelEl = o.code ? h('code', { style: 'overflow-wrap:anywhere' }, text) : h('span', null, text);
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

  // =====================================================================
  // 1. Idempotency keys (built, S3.5)
  // =====================================================================
  const IDEMPOTENCY_LUA = [
    '-- claim: SET NX, or return the record that is already there',
    "if redis.call('SET', KEYS[1], ARGV[1], 'NX', 'PX', ARGV[2]) then",
    '    return nil',
    'end',
    "return redis.call('GET', KEYS[1])",
    '',
    "-- complete: only if the key still holds this request's claim",
    "if redis.call('GET', KEYS[1]) == ARGV[1] then",
    "    redis.call('SET', KEYS[1], ARGV[2], 'PX', ARGV[3])",
    '    return 1',
    'end',
    'return 0',
    '',
    '-- release: the same owner check, then delete',
    "if redis.call('GET', KEYS[1]) == ARGV[1] then",
    "    return redis.call('DEL', KEYS[1])",
    'end',
    'return 0'
  ].join('\n');

  AF.register({
    id: 'rd-idempotency',
    group: 'redis',
    order: 1,
    title: 'Idempotency keys',
    question: 'How can a client retry a POST that may already have worked without creating a second deployment?',
    status: 'built',
    slice: 'S3.5',
    where: [
      'IdempotencyExecutor, IdempotencyStore, IdempotencyRecord (io.appfleet.control.idempotency)',
      'DeploymentController.requestDeployment: the optional Idempotency-Key header',
      'IdempotencyEndpointsTest, IdempotencyRedisDownTest',
      'docs/design/control-api/control-api-s3-5-idempotency.md'
    ],
    idea: [
      'A client attaches a random key to a request that changes something. The server stores the key with the answer it gave. If the same key arrives again, the server returns the stored answer instead of doing the work twice, so a client whose first attempt timed out learns that it worked. Two copies arriving together cannot both run, because only one can claim the key.',
      'POST /api/v1/deployments takes an optional Idempotency-Key header. A Lua script claims idempotency:v1:deployments:<key> with SET NX and a 30 s TTL, or returns the record already there. Same key and body still running: 409 request-in-progress with Retry-After. Already finished: the stored 202 is replayed. Different body, detected by a SHA-256 fingerprint: 422 idempotency-key-reused.',
      'The record turns COMPLETED, with a 24 h TTL, only after the database commit, because the executor runs outside @Transactional. Errors are never stored: the claim is released, so a retry runs again. Complete and release first check an owner token, so a slow request cannot touch a newer claim. If Redis is down, a keyed request fails closed with 503.'
    ],
    terms: [
      ['Idempotent', 'Doing it twice has the same effect as doing it once.'],
      ['Fingerprint', 'A SHA-256 hash of the validated request. Same key with a different fingerprint means a different request.'],
      ['Owner token', 'A random value inside the in-progress record, so a request only completes or releases its own claim.'],
      ['Fail closed', 'When the safety check cannot run, refuse the request instead of running it unprotected.']
    ],
    tryIt: [
      'Press Send. The Redis record goes IN_PROGRESS with a 30 s TTL, then COMPLETED with the stored 202. Press Send again: the response is replayed and Postgres still has one deployment.',
      'Press New key, then Double-click send. One request runs; the copy gets 409 request-in-progress.',
      'Switch Body to release 2.4.0 and press Send with the same key: 422 idempotency-key-reused. Press New key, choose unknown application, press Send, wait for the 422 and press Send again: it runs again, because errors are not stored.',
      'Turn on Redis down and press Send: 503, nothing runs. Turn it off, choose release 2.5.0, turn on Ignore the key and press Send twice: one key, two deployments.'
    ],
    breakIt: 'Turn on Ignore the key and the server skips the claim, so every retry runs the work again and one key creates several deployments. In the real service the partial index would catch a concurrent pair while the first deployment is active, but not a late retry after it FAILED, which is the duplicate IdempotencyEndpointsTest reproduced with the executor bypassed.',
    say: 'POST /deployments takes an Idempotency-Key that one Lua script claims atomically in Redis, so a concurrent copy gets 409, a retry replays the stored 202, and the record is completed only after the database commit, failing closed with 503 when Redis is down.',
    quiz: {
      q: 'A keyed POST commits its deployment, but the write that marks the Redis record COMPLETED fails. What does Appfleet do?',
      options: [
        'Returns 202 because the deployment exists; retries get 409 until the 30 s claim expires, and after that a retry can run again',
        'Returns 503, because the idempotency guarantee could not be recorded',
        'Rolls back the deployment, so Postgres and Redis agree again',
        'Returns 202, and the in-progress claim stays forever so the key can never be reused'
      ],
      answer: 0,
      why: 'The executor runs outside the transaction, so the commit has already happened and reporting failure would be a lie. The leftover claim expires after 30 s, and then a retry executes as if the key were new. That is the documented gap: Redis and Postgres cannot commit together.'
    },
    mount(el, ctx) {
      const PREFIX = 'idempotency:v1:deployments:';
      const IN_PROGRESS_TTL = 30000;
      const COMPLETED_TTL = 24 * 3600 * 1000;
      const NET_MS = 120;      // request travel, illustrative
      const TX_MS = 1500;      // the deployment transaction, slowed down so the claim is visible
      const FAIL_MS = 500;     // unknown application: the service fails early
      const BODIES = {
        '2.5.0': { label: 'release 2.5.0', json: '{"applicationId":"<checkout>","releaseId":"<2.5.0>","environment":"prod"}' },
        '2.4.0': { label: 'release 2.4.0', json: '{"applicationId":"<checkout>","releaseId":"<2.4.0>","environment":"prod"}' },
        unknown: { label: 'unknown application', json: '{"applicationId":"<no such app>","releaseId":"<2.5.0>","environment":"prod"}' }
      };

      let epoch = 0;
      let skew = 0;
      let reqNo = 0;
      let key = uuid4();
      const now = () => Date.now() + skew;
      const records = new Map();       // Redis key -> { state, owner, fp, response, expiresAt }
      const deployments = [];          // rows in control.deployment
      const perKey = new Map();        // client key -> deployments created under it
      const views = [];
      const counts = { ran: 0, replayed: 0, refused: 0 };

      const log = ui.log({ label: 'Idempotency log' });
      const verdict = stableVerdict();

      // ---- controls
      const keyTok = ui.token('', null);
      const headerT = ui.toggle('Send Idempotency-Key header', true, () => renderKey());
      const bodyC = ui.choice('Body', [
        { value: '2.5.0', label: 'release 2.5.0' },
        { value: '2.4.0', label: 'release 2.4.0' },
        { value: 'unknown', label: 'unknown application' }
      ], '2.5.0');
      const newKeyBtn = ui.button('New key', () => {
        key = uuid4();
        renderKey();
        log.add('New Idempotency-Key ' + key, 'muted');
      }, { small: true });
      const sendBtn = ui.button('Send', () => { send(0); }, { variant: 'primary' });
      const dblBtn = ui.button('Double-click send', () => { send(0); send(40); });
      const downT = ui.toggle('Redis down', false, on => {
        log.add(on ? 'Redis is unreachable: connections are refused' : 'Redis is reachable again', on ? 'bad' : 'ok');
        renderRedis();
      });
      const ignoreT = ui.toggle('Ignore the key', false, on => {
        log.add(on ? 'Break: the controller calls the service directly and never looks at the key'
          : 'Fixed: keyed requests go through IdempotencyExecutor again', on ? 'bad' : 'ok');
      }, { tone: 'danger' });
      const resetBtn = ui.button('Reset', reset, { variant: 'quiet' });

      // ---- stage
      const reqLane = ui.lane('Client requests', 'newest first');
      const redisLane = ui.lane('Redis', 'reachable');
      const redisList = h('div', { class: 'stack' });
      const skipBtn = ui.button('Skip ahead 30 s', () => {
        skew += 30000;
        log.add('Redis clock moved 30 s forward', 'muted');
        renderRedis();
      }, { small: true });
      redisLane.body.append(redisList, h('div', { class: 'row' }, skipBtn));
      const dbLane = ui.lane('Postgres', 'control.deployment');

      const rDeps = ui.readout('Deployments in Postgres', 0);
      const rRan = ui.readout('Requests that ran the work', 0);
      const rReplayed = ui.readout('Replayed', 0);
      const rRefused = ui.readout('Refused before running', 0);
      const respCode = ui.code('No response yet.', 'Last response');

      el.append(
        controls(h('div', { class: 'row' }, label('Idempotency-Key'), keyTok, newKeyBtn), headerT.el, bodyC.el),
        controls(sendBtn, dblBtn, downT.el, ignoreT.el, resetBtn),
        stage(cols(reqLane.el, redisLane.el, dbLane.el)),
        readouts(rDeps, rRan, rReplayed, rRefused),
        verdict.el,
        cols(ui.panel('Last response', respCode), ui.panel('Log', log.el)),
        note('The deployment transaction is slowed to about 1.5 s so you can watch the claim; real requests take milliseconds. Redis TTLs count down in real time. Fingerprints are an 8-character stand-in for the SHA-256 Appfleet uses; ids in angle brackets stand for UUIDs.'),
        note('Left out on purpose: the partial index uq_deployment_active_per_app_env, which in the real service also refuses a second active deployment for the same application and environment with 409 conflict.'),
        details('The three Lua scripts in IdempotencyStore', ui.code(IDEMPOTENCY_LUA, 'Lua scripts'))
      );

      // ---- model
      function sweep() {
        const t = now();
        for (const [rk, r] of Array.from(records)) {
          if (r.expiresAt <= t) {
            records.delete(rk);
            log.add('Redis: ' + rk + ' expired (' + (r.state === 'IN_PROGRESS' ? 'in-progress claim, 30 s TTL' : 'completed record, 24 h TTL') + ')', 'muted');
          }
        }
      }

      function problemText(status, reason, slug, title, header) {
        return 'HTTP/1.1 ' + status + ' ' + reason + '\n' + (header ? header + '\n' : '') +
          'Content-Type: application/problem+json\n\n' +
          JSON.stringify({ type: 'urn:appfleet:problem:' + slug, title: title, status: status }, null, 2);
      }
      function acceptedText(resp, replayed) {
        return 'HTTP/1.1 202 Accepted\nLocation: /api/v1/tasks/' + resp.taskId +
          '\nIdempotent-Replayed: ' + replayed + '\n\n' + JSON.stringify(resp, null, 2);
      }

      function addRequest(no, k, bodyLabel) {
        const head = k ? 'key ' + short(k) : 'no key';
        const v = liveNode('#' + no + ' · ' + bodyLabel, head + ' · sending', 'busy');
        views.unshift(v);
        reqLane.body.insertBefore(v.el, reqLane.body.firstChild);
        while (views.length > 4) views.pop().el.remove();
        return { set: (status, tone) => v.set(null, head + ' · ' + status, tone) };
      }

      function finish(view, no, status, tone, httpText) {
        view.set(status, tone);
        setCode(respCode, 'Request #' + no + '\n' + httpText);
        renderCounts();
        renderRedis();
      }

      async function send(delay) {
        const ep = epoch;
        const no = ++reqNo;
        const withKey = headerT.get();
        const k = key;
        const rk = PREFIX + k;
        const bodyId = bodyC.get();
        const body = BODIES[bodyId];
        const fp = fnv(body.json);
        const view = addRequest(no, withKey ? k : null, body.label);
        if (delay) {
          await AF.sleep(ctx, delay);
          if (!ctx.alive || ep !== epoch) return;
        }
        log.add('#' + no + ' POST /api/v1/deployments, ' + (withKey ? 'Idempotency-Key ' + short(k) : 'no key') + ', ' + body.label, 'muted');
        await AF.sleep(ctx, NET_MS);
        if (!ctx.alive || ep !== epoch) return;

        const useKey = withKey && !ignoreT.get();
        if (withKey && !useKey) log.add('#' + no + ' key ignored: the executor is bypassed', 'bad');
        let claim = null;
        if (useKey) {
          if (downT.get()) {
            counts.refused++;
            log.add('#' + no + ' claim failed: RedisConnectionFailureException, mapped to 503 service-unavailable, Retry-After: 5', 'bad');
            finish(view, no, '503 service-unavailable', 'bad',
              problemText(503, 'Service Unavailable', 'service-unavailable', 'Service unavailable', 'Retry-After: 5'));
            verdict.set('warn', 'Fail closed: Redis is unreachable, so the keyed request got 503 and nothing ran. The 2 s Redis timeouts make this fast instead of hanging. A request without a key would still work.');
            return;
          }
          sweep();
          const existing = records.get(rk);
          if (!existing) {
            // running is a sim-only marker (not stored in Redis): is the request that made this claim still executing?
            claim = { state: 'IN_PROGRESS', owner: hexChars(8), fp: fp, response: null, expiresAt: now() + IN_PROGRESS_TTL, running: true };
            records.set(rk, claim);
            log.add('#' + no + ' claim: SET NX PX 30000 succeeded, owner ' + claim.owner, 'busy');
            renderRedis();
          } else if (existing.fp !== fp) {
            counts.refused++;
            log.add('#' + no + ' claim returned a record with fingerprint ' + existing.fp + ', this body is ' + fp + ': 422 idempotency-key-reused', 'warn');
            finish(view, no, '422 idempotency-key-reused', 'warn',
              problemText(422, 'Unprocessable Content', 'idempotency-key-reused', 'Idempotency key reused'));
            verdict.set('warn', 'Same key, different body: 422 idempotency-key-reused. The fingerprint is checked first, so a wrong body never gets "retry later". A different request needs a new key.');
            return;
          } else if (existing.state === 'IN_PROGRESS') {
            counts.refused++;
            log.add('#' + no + ' claim returned IN_PROGRESS with the same fingerprint: 409 request-in-progress, Retry-After: 1', 'warn');
            finish(view, no, '409 request-in-progress', 'warn',
              problemText(409, 'Conflict', 'request-in-progress', 'Request in progress', 'Retry-After: 1'));
            if (existing.running) {
              verdict.set('ok', 'Exactly one ran. The copy found the claim IN_PROGRESS and got 409 request-in-progress with Retry-After: 1. IdempotencyEndpointsTest ran this pair 10 times in fresh JVMs: one deployment every time, and the loser always got this 409.');
            } else {
              verdict.set('warn', 'Leftover claim: the request that made it has already committed, but its completion write was lost. Retries get 409 until the 30 s TTL runs out; after that, a retry runs again.');
            }
            return;
          } else {
            counts.replayed++;
            log.add('#' + no + ' claim returned COMPLETED with the same fingerprint: replay, nothing executes', 'ok');
            finish(view, no, '202 replayed', 'ok', acceptedText(existing.response, true));
            verdict.set('ok', 'Replayed: same deploymentId, taskId and Location, Idempotent-Replayed: true. Nothing ran, so there are still ' + (perKey.get(k) || 0) + ' deployment(s) for this key.');
            return;
          }
        }

        counts.ran++;
        view.set('running the transaction', 'busy');
        renderCounts();
        await AF.sleep(ctx, bodyId === 'unknown' ? FAIL_MS : TX_MS);
        if (!ctx.alive || ep !== epoch) return;
        if (claim) claim.running = false;

        if (bodyId === 'unknown') {
          log.add('#' + no + ' transaction rolled back: unknown application', 'warn');
          if (useKey) releaseClaim(no, rk, claim);
          finish(view, no, '422 unprocessable', 'warn',
            problemText(422, 'Unprocessable Content', 'unprocessable', 'Unprocessable request'));
          verdict.set('warn', useKey
            ? 'The work failed, so the claim was released and nothing was stored. Send again: it runs again and gets 422 again, not 409 and not a stored error.'
            : 'The work failed with 422 unprocessable.');
          return;
        }

        const dep = { id: uuid7(), taskId: uuid7(), release: body.label, key: withKey ? k : null, dup: false };
        let made = 0;
        if (withKey) {
          made = (perKey.get(k) || 0) + 1;
          perKey.set(k, made);
          dep.dup = made > 1;
        }
        deployments.push(dep);
        log.add('#' + no + ' commit: insert into control.deployment ' + short(dep.id), dep.dup ? 'bad' : 'ok');
        const response = { deploymentId: dep.id, taskId: dep.taskId, status: 'PENDING' };
        if (useKey) completeClaim(no, rk, claim, response);
        renderDb();
        finish(view, no, '202 accepted', dep.dup ? 'bad' : 'ok', acceptedText(response, false));
        if (dep.dup) {
          verdict.set('bad', 'Duplicate: key ' + short(k) + ' has now created ' + made + ' deployments. ' + (ignoreT.get()
            ? 'The server ignored the key, so the retry ran the work again.'
            : 'The first claim expired or was never completed, so this request ran as if the key were new: the gap between Redis and Postgres.'));
        } else if (!withKey) {
          verdict.set('warn', 'No key: the request ran and Redis was not touched. A retry or double click without a key deploys again.');
        } else if (records.get(rk) && records.get(rk).state === 'COMPLETED') {
          verdict.set('ok', 'Ran once and committed. The record is COMPLETED and replays this 202 for 24 h.');
        } else {
          verdict.set('warn', 'Committed and answered 202, but the record is not COMPLETED. Until the in-progress claim expires, retries get 409; after that, a retry runs again.');
        }
      }

      function completeClaim(no, rk, claim, response) {
        if (downT.get()) {
          log.add('#' + no + ' Could not complete idempotency record; the work is committed (Redis unreachable). The claim stays IN_PROGRESS until its TTL runs out.', 'warn');
          return;
        }
        sweep();
        if (records.get(rk) === claim) {
          records.set(rk, { state: 'COMPLETED', owner: null, fp: claim.fp, response: response, expiresAt: now() + COMPLETED_TTL });
          log.add('#' + no + ' complete: owner matched, record COMPLETED with PX 86400000', 'ok');
        } else {
          log.add('#' + no + ' Idempotency claim expired before completion; the work is committed', 'warn');
        }
      }

      function releaseClaim(no, rk, claim) {
        if (downT.get()) {
          log.add('#' + no + ' release failed: Redis unreachable. The claim stays until its 30 s TTL runs out.', 'warn');
          return;
        }
        sweep();
        if (records.get(rk) === claim) {
          records.delete(rk);
          log.add('#' + no + ' release: owner matched, key deleted, so a retry runs again', 'ok');
        } else {
          log.add('#' + no + ' release: the key no longer holds this claim, left alone', 'muted');
        }
      }

      // ---- views
      function renderKey() {
        const on = headerT.get();
        keyTok.textContent = on ? short(key) : 'not sent';
        AF.tone(keyTok, on ? null : 'idle');
      }

      function renderRedis() {
        sweep();
        const down = downT.get();
        redisLane.title.lastChild.textContent = down ? 'unreachable' : 'reachable';
        AF.clear(redisList);
        const list = Array.from(records.entries()).slice(-3).reverse();
        if (!list.length) redisList.appendChild(h('p', { class: 'small muted' }, 'No idempotency keys stored.'));
        for (const [rk, r] of list) {
          const left = Math.max(0, Math.round(r.expiresAt - now()));
          const sub = r.state === 'IN_PROGRESS'
            ? 'IN_PROGRESS · owner ' + r.owner + ' · fingerprint ' + r.fp + ' · PTTL ' + group(left) + ' ms'
            : 'COMPLETED · fingerprint ' + r.fp + ' · PTTL ' + group(left) + ' ms · stored 202 for deployment ' + short(r.response.deploymentId);
          const n = liveNode(rk, sub, down ? 'idle' : (r.state === 'IN_PROGRESS' ? 'busy' : 'ok'), { code: true });
          redisList.appendChild(n.el);
          if (r.state === 'IN_PROGRESS') {
            redisList.appendChild(ui.bar({ label: 'Claim TTL', max: IN_PROGRESS_TTL, value: left, tone: 'warn', format: v => secs(v) }).el);
          }
        }
        if (down) redisList.appendChild(h('p', { class: 'small muted' }, 'The data is still there, but control-api cannot reach it.'));
      }

      function renderDb() {
        AF.clear(dbLane.body);
        dbLane.body.appendChild(h('p', { class: 'small muted' }, deployments.length + (deployments.length === 1 ? ' row' : ' rows')));
        deployments.slice(-4).reverse().forEach(d => {
          const n = ui.node('deployment ' + short(d.id),
            d.release + ' · PENDING · ' + (d.key ? 'key ' + short(d.key) : 'no key') + (d.dup ? ' · duplicate for this key' : ''));
          AF.tone(n, d.dup ? 'bad' : null);
          dbLane.body.appendChild(n);
        });
      }

      function renderCounts() {
        const dup = deployments.some(d => d.dup);
        rDeps.set(deployments.length, dup ? 'bad' : null);
        rRan.set(counts.ran);
        rReplayed.set(counts.replayed, counts.replayed ? 'ok' : null);
        rRefused.set(counts.refused);
      }

      function reset() {
        epoch++;
        skew = 0;
        reqNo = 0;
        key = uuid4();
        records.clear();
        deployments.length = 0;
        perKey.clear();
        views.length = 0;
        AF.clear(reqLane.body);
        counts.ran = counts.replayed = counts.refused = 0;
        setCode(respCode, 'No response yet.');
        log.clear();
        verdict.clear();
        renderKey();
        renderRedis();
        renderDb();
        renderCounts();
      }

      renderKey();
      renderRedis();
      renderDb();
      renderCounts();
      ctx.interval(renderRedis, 250);
    }
  });

  // =====================================================================
  // 2. Rate limiting with a token bucket (designed, S3.6)
  // =====================================================================
  const TOKEN_BUCKET_LUA = [
    '-- KEYS[1] = bucket key; ARGV[1] = capacity (tokens); ARGV[2] = refill rate (tokens per second)',
    'local capacity = tonumber(ARGV[1])',
    'local rate = tonumber(ARGV[2])',
    '',
    "local t = redis.call('TIME')                                   -- Redis server clock: one clock for every app instance",
    'local now = tonumber(t[1]) * 1000 + math.floor(tonumber(t[2]) / 1000)',
    '',
    "local bucket = redis.call('HMGET', KEYS[1], 'tokens', 'ts')",
    'local tokens = tonumber(bucket[1]) or capacity                 -- no key: a full bucket',
    'local ts = tonumber(bucket[2]) or now',
    '',
    'tokens = math.min(capacity, tokens + (now - ts) / 1000 * rate)',
    '',
    'local allowed = 0',
    'local retry_ms = 0',
    'if tokens >= 1 then',
    '    tokens = tokens - 1',
    '    allowed = 1',
    'else',
    '    retry_ms = math.ceil((1 - tokens) / rate * 1000)',
    'end',
    '',
    "redis.call('HSET', KEYS[1], 'tokens', tostring(tokens), 'ts', now)",
    "redis.call('PEXPIRE', KEYS[1], math.ceil(capacity / rate * 1000))   -- idle long enough to be full again: drop it",
    '',
    '-- Lua numbers become Redis integers on return (fractions are truncated), so return integers only',
    'return {allowed, math.floor(tokens), retry_ms}'
  ].join('\n');

  /**
   * "Step through the Lua script": the S3.6 script evaluated line by line for inputs the learner sets,
   * with the value each line produces and why the line is written that way.
   */
  function luaWalkthrough() {
    const fmt = n => {
      if (typeof n !== 'number') return String(n);
      return Number.isInteger(n) ? String(n) : String(Math.round(n * 1000) / 1000);
    };
    const NOW_S = 1790935200;   // TIME, seconds part (illustrative)
    const NOW_US = 123456;      // TIME, microseconds part
    const NOW = NOW_S * 1000 + Math.floor(NOW_US / 1000);

    let capacity = 3;
    let rate = 1;
    let stored = 0.25;
    let ago = 400;

    const existsT = ui.toggle('Key exists in Redis', true, render);
    const capS = ui.slider({ label: 'Capacity (ARGV[1])', min: 1, max: 60, step: 1, value: capacity, format: v => v + ' tokens',
      onInput: v => { capacity = v; if (stored > capacity) { stored = capacity; storedS.set(stored); } render(); } });
    const rateC = ui.choice('Refill rate (ARGV[2])', [{ value: '0.5', label: '0.5 per s' }, { value: '1', label: '1 per s' }, { value: '2', label: '2 per s' }], '1',
      v => { rate = Number(v); render(); });
    const storedS = ui.slider({ label: 'Stored tokens', min: 0, max: 60, step: 0.25, value: stored, format: v => fmt(v),
      onInput: v => { stored = Math.min(v, capacity); render(); } });
    const agoS = ui.slider({ label: 'Last request', min: 0, max: 10000, step: 100, value: ago, format: v => v + ' ms ago',
      onInput: v => { ago = v; render(); } });

    const grid = h('div', { role: 'table', 'aria-label': 'The Lua script, one line at a time', style: 'display:grid;gap:0;min-width:760px' });
    const rStatus = ui.readout('HTTP answer', '');
    const rLeft = ui.readout('Tokens stored after', '');
    const rRetry = ui.readout('Retry-After', '');
    const rTtl = ui.readout('Key expires in', '');

    function row(code, value, why, tone) {
      // Values can be long formulas: let them wrap inside their column instead of running into the next one.
      const v = h('span', { class: 'token', style: 'white-space:normal;overflow-wrap:anywhere;display:inline-block;max-width:100%' }, value);
      if (tone) AF.tone(v, tone);
      return h('div', { role: 'row', style: 'display:grid;grid-template-columns:minmax(0,1.35fr) minmax(0,.85fr) minmax(0,1.6fr);gap:.8rem;align-items:start;padding:.55rem 0;border-bottom:1px solid var(--line)' },
        h('code', { role: 'cell', style: 'white-space:pre-wrap;font-size:.78rem' }, code),
        h('span', { role: 'cell' }, v),
        h('span', { role: 'cell', class: 'small' }, why));
    }

    function render() {
      const exists = existsT.get();
      const tsStored = NOW - ago;
      const tokens0 = exists ? stored : capacity;
      const ts = exists ? tsStored : NOW;
      const elapsed = NOW - ts;
      const refilled = Math.min(capacity, tokens0 + elapsed / 1000 * rate);
      const allowed = refilled >= 1;
      const after = allowed ? refilled - 1 : refilled;
      const retryMs = allowed ? 0 : Math.ceil((1 - refilled) / rate * 1000);
      const ttl = Math.ceil(capacity / rate * 1000);
      const retryAfter = allowed ? null : Math.max(1, Math.ceil(retryMs / 1000));

      AF.clear(grid);
      grid.append(
        h('div', { role: 'row', style: 'display:grid;grid-template-columns:minmax(0,1.35fr) minmax(0,.85fr) minmax(0,1.6fr);gap:.8rem;font-weight:700;font-size:.85rem;padding-bottom:.4rem;border-bottom:1px solid var(--rail)' },
          h('span', { role: 'columnheader' }, 'Line'), h('span', { role: 'columnheader' }, 'Value now'), h('span', { role: 'columnheader' }, 'Why')),
        row('local capacity = tonumber(ARGV[1])', fmt(capacity),
          'Arguments reach a script as strings, so tonumber converts them. Capacity is the burst: the most requests a team can send at once.'),
        row('local rate = tonumber(ARGV[2])', fmt(rate) + ' per s',
          'Tokens added per second: the sustained rate a team can keep up forever.'),
        row("local t = redis.call('TIME')", '{"' + NOW_S + '", "' + NOW_US + '"}',
          'Seconds and microseconds from the Redis server. Every app instance asks this one clock, so a fast clock on one instance cannot create tokens.'),
        row('local now = tonumber(t[1]) * 1000\n  + math.floor(tonumber(t[2]) / 1000)', fmt(NOW),
          'Milliseconds: seconds × 1000, plus microseconds ÷ 1000 rounded down. Everything below is in milliseconds.'),
        row("local bucket = redis.call('HMGET', KEYS[1],\n  'tokens', 'ts')", exists ? '{"' + fmt(stored) + '", "' + tsStored + '"}' : '{false, false}',
          exists ? 'Both fields in one call. Hash values are strings.' : 'The key does not exist (new team, or expired after being idle). Each missing field arrives in Lua as false.'),
        row('local tokens = tonumber(bucket[1])\n  or capacity', fmt(tokens0),
          exists ? 'The tokens left after the last request. Fractions are kept: 400 ms at 1 per second is 0.4 of a token.' : 'tonumber(false) is nil, so "or capacity" applies: no key means a full bucket.'),
        row('local ts = tonumber(bucket[2]) or now', fmt(ts),
          exists ? 'When the bucket was last written: ' + ago + ' ms ago.' : 'A new bucket starts now, so the next line adds nothing.'),
        row('tokens = math.min(capacity,\n  tokens + (now - ts) / 1000 * rate)',
          'min(' + fmt(capacity) + ', ' + fmt(tokens0) + ' + ' + elapsed + ' / 1000 × ' + fmt(rate) + ') = ' + fmt(refilled),
          'The lazy refill: tokens earned since the last request, worked out now instead of by a timer. The cap stops an idle team from banking more than one burst.'),
        row('if tokens >= 1 then', String(allowed), allowed ? 'At least one whole token: the request may go ahead.' : 'Less than one whole token: the request is refused.', allowed ? 'ok' : 'bad'),
        allowed
          ? row('    tokens = tokens - 1\n    allowed = 1', 'tokens = ' + fmt(after) + ', allowed = 1', 'Spend one token. Fractions stay for the next call.', 'ok')
          : row('    retry_ms = math.ceil((1 - tokens)\n      / rate * 1000)', 'ceil((1 − ' + fmt(refilled) + ') / ' + fmt(rate) + ' × 1000) = ' + retryMs,
            'Milliseconds until one whole token exists: the missing part divided by the refill rate. Rounded up, so the client never returns a moment too early.', 'bad'),
        row("redis.call('HSET', KEYS[1],\n  'tokens', tostring(tokens), 'ts', now)", 'tokens = "' + fmt(after) + '", ts = ' + NOW,
          'Written on every call, refused ones too, so the refill just worked out is not lost. tostring keeps the fraction exactly.'),
        row("redis.call('PEXPIRE', KEYS[1],\n  math.ceil(capacity / rate * 1000))", 'ceil(' + fmt(capacity) + ' / ' + fmt(rate) + ' × 1000) = ' + ttl + ' ms',
          'After this long without requests the bucket would be full again, and a missing key already means full, so Redis may delete it. Idle teams leave no keys.'),
        row('return {allowed, math.floor(tokens),\n  retry_ms}', '{' + (allowed ? 1 : 0) + ', ' + Math.floor(after) + ', ' + retryMs + '}',
          'Redis turns a returned Lua number into an integer, cutting off any fraction, so the script returns whole numbers only. The fraction stays in the hash.'),
        row('Java: Retry-After = max(1,\n  ceil(retry_ms / 1000))', allowed ? 'not sent' : retryAfter + ' s',
          'HTTP Retry-After takes whole seconds. Rounded up again, and never 0, which would invite an instant retry.', allowed ? null : 'bad')
      );
      rStatus.set(allowed ? '200' : '429 rate-limited', allowed ? 'ok' : 'bad');
      rLeft.set(fmt(after));
      rRetry.set(allowed ? 'none' : retryAfter + ' s');
      rTtl.set(fmt(ttl / 1000) + ' s');
    }

    render();
    return h('details', { open: true },
      h('summary', null, h('span', { class: 'panel-title' }, 'Step through the Lua script, one call at a time')),
      h('div', { class: 'stack', style: 'margin-top:.6rem' },
        note('Set what Redis holds before the call. Every line below shows the value it produces and why it is written that way. The clock reading is illustrative.'),
        h('div', { class: 'sim-controls' }, existsT.el, rateC.el),
        h('div', { class: 'sim-controls' }, capS.el, storedS.el, agoS.el),
        h('div', { class: 'sim-stage' }, grid),
        readouts(rStatus, rLeft, rRetry, rTtl),
        note('Why one script: Redis runs a script from start to finish with no other command in between, so two requests arriving together cannot both read the same last token and both spend it. It is also one network round trip instead of two.')));
  }

  AF.register({
    id: 'rd-ratelimit',
    group: 'redis',
    order: 2,
    title: 'Rate limiting with a token bucket',
    question: 'How do you stop one team from flooding the API, across every app instance, without turning a Redis outage into an API outage?',
    status: 'built',
    slice: 'S3.6',
    where: [
      'RateLimiter, RateLimitInterceptor, RateLimitProperties, RateLimitedException (io.appfleet.control.ratelimit)',
      'HeaderTeamResolver (temporary until S4), WebConfig (io.appfleet.control.web)',
      'src/main/resources/ratelimit/take-token.lua',
      'RateLimitEndpointsTest, IdempotencyRedisDownTest (case 9, fail open)',
      'docs/design/control-api/control-api-s3-6-rate-limiting.md',
      'ApiExceptionHandler: the S3.5 mapping of RedisConnectionFailureException to 503 that the limiter must not reach'
    ],
    idea: [
      'A token bucket holds up to N tokens and refills at a steady rate. Each request spends one; an empty bucket means 429 with Retry-After, the time until one token is back. Capacity sets the burst, the refill sets the sustained rate. Unlike a per-minute counter, it never allows a double burst across a window boundary.',
      'S3.6 keeps one bucket per caller in Redis as a hash {tokens, ts}. One Lua script reads it, refills it using Redis TIME, takes a token, writes it back and sets PEXPIRE to the time it takes to fill up. Defaults: 60 tokens, refill 1 per second. It must be atomic: in two separate calls, concurrent requests spend the same token.',
      'S3.6 first keyed the bucket on a temporary X-Team-Id header, which any client could rotate to escape the limit. Since S4.2 the key is the token\'s sub (ratelimit:v1:user:<sub>), the header is ignored, and a missing principal falls back to a shared anonymous bucket. It runs as a HandlerInterceptor, not a filter, so the 429 gets the usual problem shape. If Redis fails, the limiter fails open, and it must catch DataAccessException to do so, or S3.5\'s 503 handler turns a Redis outage into a full API outage.'
    ],
    terms: [
      ['Token bucket', 'A counter that refills at a steady rate up to a cap; each request spends one token.'],
      ['Burst', 'The capacity: how many requests can go at once after a quiet period.'],
      ['Fail open', 'When the check cannot run, let the request through.'],
      ['Lost update', 'Two writers read the same value, and the second write erases the first.']
    ],
    tryIt: [
      'Set Capacity to 3, as the planned test does, and press Burst 20: exactly 3 get 200 and 17 get 429 with Retry-After. Switch Sender to team B and press Send 1: B has its own full bucket.',
      'Press Reset, turn on Read then write in two calls and press Burst 20: all 20 get 200 from a bucket that held 3 tokens.',
      'Set Capacity back to 60, press Reset and turn on Hold 5 per second: the gauge drains, then about 1 request in 5 gets through.',
      'Turn on Redis down: requests pass with a warning. Then turn on Fail closed: every request becomes 503, a full outage.',
      'Under the simulation, in Step through the Lua script: with Stored tokens 0.25 and Last request 400 ms ago the refill reaches 0.65, so the call is refused with Retry-After 1 s. Drag Last request to 1000 ms and the same call is allowed, leaving 0.25. Turn off Key exists in Redis to see a new team start full.'
    ],
    breakIt: 'Read the bucket and write it back in two calls, and concurrent requests all read the same token count, so a burst gets through a nearly empty bucket. This was run on the real code: with a Java read-modify-write in place of the script, the concurrent-burst test (capacity 3, 10 requests together) failed 6 runs out of 6, and the last report showed all 10 answers as 200. Turn the limiter on for every test, with no team header, and 39 tests failed plus 1 error, because they all share one anonymous bucket. Let the Redis error escape the limiter, and S3.5\'s 503 handler turns a Redis outage into an outage of the whole API.',
    say: 'Rate limiting is a per-team token bucket in Redis, refilled and spent by one atomic Lua script on Redis\'s own clock and answered with 429 and Retry-After, and it fails open when Redis is down because a limiter that refuses everything is a bigger outage than the one it prevents.',
    quiz: {
      q: 'Redis becomes unreachable. Why does the rate limiter fail open while idempotency keys, on the same Redis, fail closed?',
      options: [
        'A limiter is protection, not a promise to the client: refusing every request is worse than serving unlimited, while a keyed POST asked for a duplicate guarantee the server cannot give',
        'The limiter keeps a copy of every bucket in the JVM, so it can still decide without Redis',
        'HandlerInterceptor fails open by default, so no code is needed',
        'Idempotency fails closed only because its Lua scripts are longer'
      ],
      answer: 0,
      why: 'Decision 7 of the S3.6 design. And fail-open takes code: the limiter must catch DataAccessException around its own Redis call, otherwise the exception reaches the S3.5 handler and every endpoint answers 503.'
    },
    mount(el, ctx) {
      const SCALE = 2;                                  // 1 simulated second = 500 ms
      const EPOCH = Date.UTC(2026, 9, 2, 9, 0, 0);     // what Redis TIME would report at the start
      const t0 = Date.now();
      const simNow = () => (Date.now() - t0) * SCALE;
      const TEAMS = [
        { id: 'a', label: 'team A', bucket: '0190f3a2-5c1e-7d40-8b2a-6e1f9c3d7a10' },
        { id: 'b', label: 'team B', bucket: '0190f3a2-9e47-7a1b-a3c5-2d8e4b6f0c92' },
        { id: 'anon', label: 'no principal', bucket: 'anonymous' }
      ];
      const teamById = id => TEAMS.find(tm => tm.id === id);

      let capacity = 60;
      let rate = 1;
      let reqNo = 0;
      let real = {};    // the Redis buckets the app uses
      let ideal = {};   // a correct limiter fed the same traffic, to count over-admission
      const counts = { ok: 0, limited: 0, over: 0, down: 0 };
      const hold = { ok: 0, limited: 0, down: 0, retry: 0, sent: 0, recent: [] };

      const log = ui.log({ label: 'Rate limit log' });
      const verdict = stableVerdict();

      // ---- token bucket, the same arithmetic as the Lua script
      function peek(store, id, now) {
        const b = store[id];
        if (!b || b.expiresAt <= now) return { tokens: capacity, exists: false };
        return { tokens: Math.min(capacity, b.tokens + (now - b.ts) / 1000 * rate), exists: true };
      }
      function write(store, id, tokens, now) {
        store[id] = { tokens: tokens, ts: now, expiresAt: now + Math.ceil(capacity / rate * 1000) };
      }
      function take(store, id, now) {
        let tokens = peek(store, id, now).tokens;
        let allowed = false;
        let retryMs = 0;
        if (tokens >= 1) { tokens -= 1; allowed = true; } else retryMs = Math.ceil((1 - tokens) / rate * 1000);
        write(store, id, tokens, now);
        return { allowed: allowed, remaining: Math.floor(tokens), retryMs: retryMs };
      }
      const retryAfter = ms => Math.max(1, Math.ceil(ms / 1000));

      // ---- controls
      const senderC = ui.choice('Sender', TEAMS.map(tm => ({ value: tm.id, label: tm.label })), 'a');
      const capS = ui.slider({ label: 'Capacity', min: 1, max: 100, step: 1, value: 60, format: v => v + ' tokens', onInput: v => { capacity = v; renderGauges(); } });
      const rateS = ui.slider({ label: 'Refill', min: 0.5, max: 5, step: 0.5, value: 1, format: v => v + ' per s', onInput: v => { rate = v; renderGauges(); } });
      const send1 = ui.button('Send 1', () => fire(1, false), { variant: 'primary' });
      const burst = ui.button('Burst 20', () => fire(20, false));
      const holdT = ui.toggle('Hold 5 per second', false, on => {
        hold.recent.length = 0;
        log.add(on ? 'Holding 5 requests per simulated second from ' + teamById(senderC.get()).label : 'Stopped holding', 'muted');
      });
      const downT = ui.toggle('Redis down', false, on => {
        log.add(on ? 'Redis is unreachable' : 'Redis is reachable again', on ? 'bad' : 'ok');
        renderGauges();
      });
      const closedT = ui.toggle('Fail closed', false, on => {
        log.add(on ? 'Break: the limiter no longer catches DataAccessException' : 'Fixed: the limiter catches DataAccessException and allows the request', on ? 'bad' : 'ok');
      }, { tone: 'danger' });
      const naiveT = ui.toggle('Read then write in two calls', false, on => {
        log.add(on ? 'Break: HMGET, compute in Java, then HSET, as two separate calls' : 'Fixed: one atomic Lua script per request', on ? 'bad' : 'ok');
      }, { tone: 'danger' });
      const resetBtn = ui.button('Reset', reset, { variant: 'quiet' });

      // ---- gauges
      const gauges = {};
      const gaugeBox = h('div', { class: 'stack' });
      TEAMS.forEach(tm => {
        const text = { v: '' };
        const bar = ui.bar({ label: tm.label, max: 1, value: 1, format: () => text.v });
        const keyLine = h('div', { class: 'small muted', style: 'overflow-wrap:anywhere' });
        gauges[tm.id] = { bar: bar, text: text, keyLine: keyLine };
        gaugeBox.appendChild(h('div', { class: 'stack', style: 'gap:.2rem' }, bar.el, keyLine));
      });

      const rOk = ui.readout('200 allowed', 0);
      const rLimited = ui.readout('429 rate-limited', 0);
      const rOver = ui.readout('Admitted over the limit', 0);
      const rDown = ui.readout('503 from the limiter', 0);

      el.append(
        controls(senderC.el, capS.el, rateS.el),
        controls(send1, burst, holdT.el, downT.el, closedT.el, naiveT.el, resetBtn),
        stage(gaugeBox),
        readouts(rOk, rLimited, rOver, rDown),
        verdict.el,
        log.el,
        note('Designed for S3.6, not built yet: this runs the design\'s algorithm. 1 simulated second = 500 ms. Burst 60 and refill 1 per second are the design\'s defaults. Every request is GET /api/v1/applications; team ids are illustrative. The limiter is off in the test profile, and the design\'s hand test of the script against the dev Redis allowed exactly 3 of 10 parallel calls with capacity 3.'),
        luaWalkthrough(),
        details('The whole Lua script from the S3.6 design', ui.code(TOKEN_BUCKET_LUA, 'Token bucket Lua script'))
      );

      // ---- requests
      function downVerdict() {
        if (closedT.get()) verdict.set('bad', 'Full outage: the Redis error escaped the limiter, and S3.5\'s handler turned it into 503 on every request, reads included.');
        else verdict.set('warn', 'Fail open: Redis is down, so requests pass unlimited with one warning each. Weaker protection for a while, but the API stays up.');
      }

      /** Sends n concurrent requests from the selected team. Returns { ok, limited, down, retry }. */
      function fire(n, quiet) {
        const tm = teamById(senderC.get());
        const now = simNow();
        const res = { ok: 0, limited: 0, down: 0, retry: 0 };

        if (downT.get()) {
          for (let i = 0; i < n; i++) {
            const no = ++reqNo;
            const fair = take(ideal, tm.id, now).allowed;
            if (closedT.get()) {
              res.down++; counts.down++;
              if (!quiet) log.add('#' + no + ' ' + tm.label + ': 503 service-unavailable, Retry-After: 5', 'bad');
            } else {
              res.ok++; counts.ok++;
              if (!fair) counts.over++;
              if (!quiet) log.add('#' + no + ' ' + tm.label + ': 200. Rate limiter unavailable, request allowed', 'warn');
            }
          }
          if (!quiet) downVerdict();
          renderCounts();
          return res;
        }

        if (naiveT.get() && n > 1) {
          // Every HMGET lands before any HSET: all requests see the same token count.
          const snap = peek(real, tm.id, now).tokens;
          for (let i = 0; i < n; i++) {
            const no = ++reqNo;
            const fair = take(ideal, tm.id, now).allowed;
            if (snap >= 1) {
              res.ok++; counts.ok++;
              if (!fair) counts.over++;
              log.add('#' + no + ' ' + tm.label + ': read ' + snap.toFixed(1) + ' tokens, 200, writes back ' + (snap - 1).toFixed(1), fair ? 'ok' : 'bad');
            } else {
              res.limited++; counts.limited++;
              res.retry = retryAfter(Math.ceil((1 - snap) / rate * 1000));
              log.add('#' + no + ' ' + tm.label + ': read ' + snap.toFixed(1) + ' tokens, 429 rate-limited, Retry-After: ' + res.retry, 'warn');
            }
          }
          write(real, tm.id, snap >= 1 ? snap - 1 : snap, now);   // the last HSET wins
          const fairCount = Math.min(n, Math.floor(snap));
          const over = res.ok - fairCount;
          if (over > 0) {
            verdict.set('bad', 'Over-admission: ' + res.ok + ' of ' + n + ' got 200 from a bucket holding ' + snap.toFixed(1) + ' tokens, so ' + over + ' got through that the limit should have refused. Every request read the count before any wrote it back.');
          } else if (res.ok > 1) {
            verdict.set('bad', 'Lost updates: ' + res.ok + ' requests each spent a token, but the bucket only went down by 1. The next burst will be over-admitted.');
          } else {
            verdict.set('warn', 'The bucket was empty when every request read it, so all got 429. The race only shows while tokens remain.');
          }
        } else {
          for (let i = 0; i < n; i++) {
            const no = ++reqNo;
            const fair = take(ideal, tm.id, now).allowed;
            const r = take(real, tm.id, now);
            if (r.allowed) {
              res.ok++; counts.ok++;
              if (!fair) counts.over++;
              if (!quiet) log.add('#' + no + ' ' + tm.label + ': 200 (' + r.remaining + ' left)', 'ok');
            } else {
              res.limited++; counts.limited++;
              res.retry = retryAfter(r.retryMs);
              if (!quiet) log.add('#' + no + ' ' + tm.label + ': 429 rate-limited, Retry-After: ' + res.retry, 'warn');
            }
          }
          if (!quiet) {
            if (n > 1) {
              verdict.set(res.limited ? 'warn' : 'ok', 'Burst of ' + n + ': ' + res.ok + ' got 200 and ' + res.limited + ' got 429' +
                (res.limited ? ' with Retry-After: ' + res.retry : '') + '. One atomic script per request, so no token was spent twice.');
            } else if (res.ok) {
              verdict.set('ok', 'Allowed: one token spent from ' + tm.label + '\'s bucket.');
            } else {
              verdict.set('warn', 'Bucket empty: 429 rate-limited with Retry-After: ' + res.retry + ', the seconds until one token refills, rounded up.');
            }
          }
        }
        renderCounts();
        renderGauges();
        return res;
      }

      // Hold: 5 requests per simulated second, logged as one line per simulated second.
      ctx.interval(() => {
        if (!holdT.get()) return;
        const r = fire(1, true);
        hold.ok += r.ok; hold.limited += r.limited; hold.down += r.down; hold.sent++;
        if (r.retry) hold.retry = r.retry;
        hold.recent.push(r.ok ? 1 : 0);
        if (hold.recent.length > 25) hold.recent.shift();
        if (hold.sent >= 5) {
          const tm = teamById(senderC.get());
          const parts = [];
          if (hold.ok) parts.push(hold.ok + ' × 200');
          if (hold.limited) parts.push(hold.limited + ' × 429 (Retry-After: ' + hold.retry + ')');
          if (hold.down) parts.push(hold.down + ' × 503');
          log.add('Last simulated second, ' + tm.label + ': ' + parts.join(', ') + (downT.get() && !closedT.get() ? ', limiter unavailable' : ''),
            hold.down ? 'bad' : hold.limited ? 'warn' : 'ok');
          hold.ok = hold.limited = hold.down = hold.sent = hold.retry = 0;
          if (downT.get()) {
            downVerdict();
          } else {
            const passed = hold.recent.reduce((a, b) => a + b, 0);
            verdict.set(passed === hold.recent.length ? 'ok' : 'warn', 'Holding 5 per second: ' + passed + ' of the last ' + hold.recent.length + ' requests got 200. ' +
              (rate >= 5 ? 'The refill keeps up with 5 per second, so nothing is refused.'
                : 'Once the burst is spent, the refill of ' + rate + ' per second lets about ' + rate + ' in 5 through.'));
          }
        }
      }, 100);

      // ---- views
      function renderGauges() {
        const now = simNow();
        const down = downT.get();
        TEAMS.forEach(tm => {
          const g = gauges[tm.id];
          const key = 'ratelimit:v1:user:' + tm.bucket;
          if (down) {
            g.text.v = 'unknown';
            g.bar.set(0, null);
            g.keyLine.textContent = key + ': Redis unreachable';
            return;
          }
          const v = peek(real, tm.id, now);
          const tone = v.tokens < 1 ? 'bad' : v.tokens < capacity * 0.2 ? 'warn' : 'ok';
          g.text.v = v.tokens.toFixed(1) + ' of ' + capacity + (v.tokens < 1 ? ', empty' : '');
          g.bar.set(v.tokens / capacity, tone);
          const b = real[tm.id];
          g.keyLine.textContent = key + (v.exists
            ? ': tokens ' + b.tokens.toFixed(3) + ', ts ' + (EPOCH + Math.round(b.ts)) + ', PTTL ' + group(Math.max(0, Math.ceil(b.expiresAt - now))) + ' ms'
            : ': no key, which counts as a full bucket');
        });
      }

      function renderCounts() {
        rOk.set(counts.ok);
        rLimited.set(counts.limited, counts.limited ? 'warn' : null);
        rOver.set(counts.over, counts.over ? 'bad' : null);
        rDown.set(counts.down, counts.down ? 'bad' : null);
      }

      function reset() {
        real = {};
        ideal = {};
        reqNo = 0;
        counts.ok = counts.limited = counts.over = counts.down = 0;
        hold.ok = hold.limited = hold.down = hold.sent = hold.retry = 0;
        hold.recent.length = 0;
        holdT.set(false);
        log.clear();
        verdict.clear();
        renderCounts();
        renderGauges();
      }

      renderCounts();
      renderGauges();
      ctx.interval(renderGauges, 200);
    }
  });

  // =====================================================================
  // 3. Node lease and fencing tokens (planned, S5)
  // =====================================================================
  AF.register({
    id: 'rd-lease',
    group: 'redis',
    order: 3,
    title: 'Leases and fencing tokens',
    question: 'How do you make sure two agents never drive the same node, even when one of them freezes and wakes up later?',
    status: 'planned',
    slice: 'S5',
    where: [
      'docs/specs/project/04-NODE-AGENT.md, section Node lease',
      'docs/design/node-agent/node-agent.md, section Node lease and fencing',
      'Planned: NodeLeaseService, FencingToken (io.appfleet.agent.lease)',
      'AgentProperties.LeaseProperties (ttl, renewInterval): the config shape exists, values not set yet'
    ],
    idea: [
      'A lease is a lock with an expiry. An agent claims a node with SET node:lease:{nodeId} {instanceId} NX PX {ttl} and renews it with every heartbeat. If the agent crashes, the key expires and another agent can take the node. Two agents must never drive the same node.',
      'Expiry alone is not safe. If agent A freezes in a long GC pause or a network partition, its lease expires and B takes over, but A does not know. When A wakes up, it finishes the write it was about to make. Checking the lease first does not help: the pause can fall between the check and the write.',
      'The fix is a fencing token: a number from INCR that grows with every acquire. Every status event carries it, and consumers reject any token lower than the highest they have seen. This is the opposite of merging concurrent writers as CRDTs do: control-plane state cannot be merged, so the stale writer is refused.'
    ],
    terms: [
      ['Lease', 'A lock that expires unless its holder keeps renewing it.'],
      ['Fencing token', 'A number that grows with every new lease holder; the receiving side refuses anything older than it has seen.'],
      ['Process pause', 'A GC pause, VM stall or partition that freezes a process while the world, and the lease clock, move on.'],
      ['Redlock debate', 'The argument over whether a Redis lock alone is safe. Without fencing it is not, under pauses and partitions.']
    ],
    tryIt: [
      'Watch agent A hold the lease with token 1 and send status writes while agent B fails to acquire.',
      'Press Pause agent A and wait until B takes the lease with token 2 and starts its own container.',
      'Press Resume agent A: its stale write carries token 1 and is rejected, then A finds the lease gone and steps down.',
      'Press Reset, turn on Turn off fencing tokens, and repeat: the stale write is accepted and the store names a container that no longer exists.'
    ],
    breakIt: 'Without fencing tokens, the paused agent wakes up still believing it holds the lease, and its stale write is accepted: two agents drove one node, and the store now describes a container that agent B already replaced.',
    say: 'A Redis lease with SET NX PX keeps two healthy agents off one node, but a paused agent can outlive its lease, so every write carries a fencing token from INCR and consumers reject older tokens, which is why a Redis lock alone is not safe.',
    quiz: {
      q: 'Agent A checks that it still holds the lease right before every write. Why can it still write after agent B has taken over?',
      options: [
        'A can pause between the check and the write; when it resumes, the check is stale, so only the receiver can reliably refuse the write',
        'SET NX is not atomic in Redis, so both agents can hold the key at once',
        'A renews its lease with a longer TTL than B uses',
        'It cannot: checking before every write makes fencing tokens unnecessary'
      ],
      answer: 0,
      why: 'Any check the writer makes can go stale during a pause. A fencing token moves the check to the storage side, which compares the token on the write with the highest it has seen at the moment the write arrives.'
    },
    mount(el, ctx) {
      const STEP = 250;          // simulated ms per 100 ms tick: 1 simulated second = 400 ms
      const TTL = 8000;          // illustrative lease TTL
      const RENEW = 2000;        // illustrative renewal (heartbeat) interval
      const WRITE = 1500;        // illustrative status write interval
      const RETRY = 1000;        // standby agent retries SET NX this often
      const WINDOW = 30000;      // timeline shows the last 30 simulated seconds
      const LEASE_KEY = 'node:lease:node-7';
      const TOKEN_KEY = 'node:lease:token:node-7';

      let st = null;
      const log = shortLog('Lease log');
      const verdict = stableVerdict();

      function makeAgent(name) {
        return {
          name: name, instance: 'agent-' + name.toLowerCase() + '-' + hexChars(4),
          believes: false, paused: false, token: null, container: null,
          nextRenew: 0, nextWrite: 0, nextTry: name === 'A' ? 0 : 500, blockedLogged: false, writes: 0
        };
      }
      function fresh() {
        return {
          t: 0, lease: null, seq: 0, pausedAt: 0,
          agents: { A: makeAgent('A'), B: makeAgent('B') },
          store: { lastToken: 0, container: null, writer: null, token: null },
          running: null,
          samples: [], marks: [],
          counts: { accepted: 0, rejected: 0, stale: 0 }
        };
      }
      const at = () => 't=' + (st.t / 1000).toFixed(1) + ' s';

      // ---- controls
      const pauseBtn = ui.button('Pause agent A', () => {
        const a = st.agents.A;
        if (a.paused) return;
        a.paused = true;
        st.pausedAt = st.t;
        log.add(at() + ' A: stop-the-world pause begins (GC or partition). A still believes it holds node-7.', 'warn');
        syncButtons();
        render();
      }, { variant: 'primary' });
      const resumeBtn = ui.button('Resume agent A', () => {
        const a = st.agents.A;
        if (!a.paused) return;
        a.paused = false;
        log.add(at() + ' A: resumes after ' + secs(st.t - st.pausedAt) + ' and carries on where it stopped.', 'busy');
        if (a.believes) {
          const stillMine = st.lease && st.lease.holder === a.instance;
          const nobodyElse = !st.lease && st.seq === a.token;
          write(a);                 // the write it was about to make before the pause
          a.nextWrite = st.t + WRITE;
          renew(a);                 // the overdue renewal
          if (stillMine) {
            verdict.set('ok', 'A resumed before its lease expired, so its write was legitimate and the renewal succeeded. Pause it for longer than the 8 s TTL to see the problem.');
          } else if (nobodyElse) {
            verdict.set('warn', 'A\'s lease had expired, but no other agent had taken node-7 yet, so its write was still the newest. Its renewal failed and it stepped down. Wait until agent B holds the lease before resuming.');
          }
        }
        syncButtons();
        render();
      }, { disabled: true });
      const fenceT = ui.toggle('Turn off fencing tokens', false, on => {
        log.add(on ? 'Break: the store accepts every write and ignores tokens' : 'Fixed: the store rejects tokens lower than the highest it has seen', on ? 'bad' : 'ok');
        render();
      }, { tone: 'danger' });
      const resetBtn = ui.button('Reset', () => {
        st = fresh();
        log.clear();
        verdict.clear();
        log.add('Reset: agent A and agent B start, node-7 is free', 'muted');
        syncButtons();
        render();
      }, { variant: 'quiet' });
      function syncButtons() {
        pauseBtn.disabled = st.agents.A.paused;
        resumeBtn.disabled = !st.agents.A.paused;
      }

      // ---- stage
      const laneA = ui.lane('Agent A', 'node-agent');
      const laneB = ui.lane('Agent B', 'node-agent');
      const laneR = ui.lane('Redis', 'lease');
      const laneS = ui.lane('Node state store', 'reads task.events');
      const nA = liveNode('agent A', '');
      const nB = liveNode('agent B', '');
      laneA.body.appendChild(nA.el);
      laneB.body.appendChild(nB.el);
      const nLease = liveNode(LEASE_KEY, '', null, { code: true });
      const leaseBar = ui.bar({ label: 'PTTL', max: TTL, value: 0, format: v => secs(v) });
      const nToken = liveNode(TOKEN_KEY, '', null, { code: true });
      laneR.body.append(nLease.el, leaseBar.el, nToken.el);
      const nStore = liveNode('Store says', '');
      const nReal = liveNode('node-7 really runs', '');
      laneS.body.append(nStore.el, nReal.el);

      const chart = sv('svg', { class: 'chart', style: 'max-width:44rem', viewBox: '0 0 600 128', role: 'img', 'aria-label': 'Timeline of the last 30 simulated seconds: which agent believes it holds the lease, and which one Redis says holds it.' });
      const rAcc = ui.readout('Writes accepted', 0);
      const rRej = ui.readout('Stale writes rejected', 0);
      const rStale = ui.readout('Stale writes accepted', 0);

      el.append(
        controls(pauseBtn, resumeBtn, fenceT.el, resetBtn),
        stage(cols(laneA.el, laneB.el, laneR.el, laneS.el)),
        ui.panel('Timeline', chart, note('Solid bar: the agent believes it holds the lease. Dashed bar: paused while believing it. Bottom row: the holder according to Redis. Hollow dot: accepted write. Cross: rejected write. Filled dot: stale write accepted.')),
        readouts(rAcc, rRej, rStale),
        verdict.el,
        log.el,
        note('Planned for S5, not built: this simulates the spec. 1 simulated second = 400 ms. Lease TTL 8 s, renewal every 2 s and status writes every 1.5 s are illustrative; the design does not fix them yet.')
      );

      // ---- model
      function acquire(a) {
        if (st.lease) {
          if (!a.blockedLogged) {
            log.add(at() + ' ' + a.name + ': SET ' + LEASE_KEY + ' ' + a.instance + ' NX PX ' + TTL + ' returned nil, ' + st.lease.name + ' holds it. Retrying every 1 s.', 'muted');
            a.blockedLogged = true;
          }
          return;
        }
        st.seq += 1;                                            // INCR node:lease:token:node-7
        st.lease = { holder: a.instance, name: a.name, expiresAt: st.t + TTL };
        a.believes = true;
        a.token = st.seq;
        a.container = hexChars(4);
        a.blockedLogged = false;
        a.writes = 0;
        const replaced = st.running;
        st.running = { id: a.container, by: a.name };
        a.nextRenew = st.t + RENEW;
        log.add(at() + ' ' + a.name + ': SET NX PX ' + TTL + ' OK, INCR gives token ' + st.seq + '. Starts web as container ' + a.container +
          (replaced ? ', replacing ' + replaced.id : '') + '.', 'ok');
        // The new holder reports at once, so the store learns the new token before any older writer can reach it.
        write(a);
        a.nextWrite = st.t + WRITE;
      }

      function renew(a) {
        if (st.lease && st.lease.holder === a.instance) {
          st.lease.expiresAt = st.t + TTL;
          a.nextRenew = st.t + RENEW;
          return;
        }
        log.add(at() + ' ' + a.name + ': renewal failed, ' + (st.lease ? st.lease.name + ' holds the lease' : 'the lease is gone') + '. ' + a.name + ' steps down.', 'warn');
        a.believes = false;
        a.token = null;
        a.nextTry = st.t + RETRY;
      }

      function write(a) {
        const fencing = !fenceT.get();
        const stale = a.token < st.seq;
        const accepted = fencing ? a.token >= st.store.lastToken : true;
        st.marks.push({ t: st.t, who: a.name, accepted: accepted, stale: stale });
        if (!accepted) {
          st.counts.rejected++;
          log.add(at() + ' ' + a.name + ' writes "web is container ' + a.container + '" with token ' + a.token + ': rejected, the store has seen token ' + st.store.lastToken + '.', 'ok');
          verdict.set('ok', 'Fenced: agent ' + a.name + '\'s stale write carried token ' + a.token + ', lower than ' + st.store.lastToken + ', so the store refused it. The state stays correct.');
          return;
        }
        st.store = { lastToken: Math.max(st.store.lastToken, a.token), container: a.container, writer: a.name, token: a.token };
        st.counts.accepted++;
        a.writes++;
        if (stale) {
          st.counts.stale++;
          log.add(at() + ' ' + a.name + ' writes "web is container ' + a.container + '" with token ' + a.token + ': accepted, nothing checks the token. ' +
            st.running.by + ' already replaced that container.', 'bad');
          verdict.set('bad', 'Stale writer accepted: agent ' + a.name + ' wrote with token ' + a.token + ' after agent ' + st.running.by + ' took the lease with token ' + st.seq +
            '. Two agents drove node-7, and the store describes a container that no longer exists.');
        } else if (a.writes === 1) {
          log.add(at() + ' ' + a.name + ' writes "web is container ' + a.container + '" with token ' + a.token + ': accepted. Further writes are counted below.', 'ok');
        }
      }

      function stepAgent(a) {
        if (a.paused) return;
        if (a.believes) {
          if (st.t >= a.nextWrite) { write(a); a.nextWrite = st.t + WRITE; }
          if (a.believes && st.t >= a.nextRenew) renew(a);
        } else if (st.t >= a.nextTry) {
          acquire(a);
          a.nextTry = st.t + RETRY;
        }
      }

      const agentState = a => (a.paused ? (a.believes ? 'paused' : 'none') : (a.believes ? 'hold' : 'none'));

      function tick() {
        st.t += STEP;
        if (st.lease && st.lease.expiresAt <= st.t) {
          log.add(at() + ' Redis: ' + LEASE_KEY + ' expired, no renewal for ' + TTL / 1000 + ' s', 'warn');
          st.lease = null;
        }
        stepAgent(st.agents.A);
        stepAgent(st.agents.B);
        st.samples.push({ t: st.t, A: agentState(st.agents.A), B: agentState(st.agents.B), holder: st.lease ? st.lease.name : null });
        while (st.samples.length && st.samples[0].t < st.t - WINDOW - STEP) st.samples.shift();
        while (st.marks.length && st.marks[0].t < st.t - WINDOW) st.marks.shift();
        render();
      }

      // ---- views
      function agentView(a, view) {
        let sub;
        let tone;
        if (a.paused && a.believes) {
          const mine = st.lease && st.lease.holder === a.instance;
          sub = 'paused, believes it holds node-7 with token ' + a.token + (mine ? '; the lease is still valid' : '; the lease has expired and it does not know');
          tone = mine ? 'warn' : 'bad';
        } else if (a.paused) {
          sub = 'paused';
          tone = 'idle';
        } else if (a.believes) {
          sub = 'holds node-7 with token ' + a.token + ', drives container ' + a.container;
          tone = 'ok';
        } else {
          sub = 'standby, retrying SET NX every 1 s';
          tone = 'idle';
        }
        view.set('agent ' + a.name + ' (' + a.instance + ')', sub, tone);
      }

      function render() {
        agentView(st.agents.A, nA);
        agentView(st.agents.B, nB);
        if (st.lease) {
          const left = Math.max(0, st.lease.expiresAt - st.t);
          nLease.set(null, 'value ' + st.lease.holder + ' (agent ' + st.lease.name + ')', 'busy');
          leaseBar.set(left, left < RENEW ? 'warn' : null);
        } else {
          nLease.set(null, 'no key: the node is free', 'idle');
          leaseBar.set(0, null);
        }
        nToken.set(null, 'value ' + st.seq + ' (the token of the newest holder)', null);

        const fencing = !fenceT.get();
        if (st.store.container) {
          const wrong = st.running && st.store.container !== st.running.id;
          nStore.set(null, 'web is container ' + st.store.container + ', from agent ' + st.store.writer + ' with token ' + st.store.token +
            (fencing ? '. Highest token seen: ' + st.store.lastToken : '. Tokens are not checked') +
            (wrong ? '. That container no longer exists.' : ''), wrong ? 'bad' : 'ok');
        } else {
          nStore.set(null, 'no status yet' + (fencing ? '' : '. Tokens are not checked'), 'idle');
        }
        nReal.set(null, st.running ? 'web as container ' + st.running.id + ', started by agent ' + st.running.by : 'nothing yet', st.running ? null : 'idle');

        rAcc.set(st.counts.accepted);
        rRej.set(st.counts.rejected, st.counts.rejected ? 'ok' : null);
        rStale.set(st.counts.stale, st.counts.stale ? 'bad' : null);
        drawChart();
      }

      function drawChart() {
        AF.clear(chart);
        const X0 = 78;
        const X1 = 592;
        const tMin = st.t - WINDOW;
        const x = tt => X0 + (Math.max(tt, tMin) - tMin) / WINDOW * (X1 - X0);
        const rows = [
          { key: 'A', y: 8, text: 'agent A' },
          { key: 'B', y: 38, text: 'agent B' },
          { key: 'holder', y: 68, text: 'Redis holder' }
        ];
        rows.forEach(r => {
          chart.appendChild(sv('text', { x: 0, y: r.y + 12 }, r.text));
          chart.appendChild(sv('line', { x1: X0, x2: X1, y1: r.y + 8, y2: r.y + 8, style: 'stroke:var(--line)' }));
          let start = null;
          let val = null;
          const flush = end => {
            if (val === null || val === 'none' || start === null) return;
            const x1 = x(start);
            const w = Math.max(1, x(end) - x1);
            let style;
            if (r.key === 'holder') style = 'fill:var(--idle-wash);stroke:var(--rail)';
            else if (val === 'paused') style = 'fill:var(--warn-wash);stroke:var(--warn);stroke-dasharray:4 3';
            else style = 'fill:var(--ok)';
            chart.appendChild(sv('rect', { x: x1, y: r.y, width: w, height: 16, rx: 2, style: style }));
            if (r.key === 'holder' && w > 18) {
              chart.appendChild(sv('text', { x: x1 + w / 2, y: r.y + 12, 'text-anchor': 'middle', style: 'fill:var(--ink)' }, val));
            }
          };
          for (const smp of st.samples) {
            const v = smp[r.key] === null ? 'none' : smp[r.key];
            if (v !== val) { flush(smp.t); start = smp.t; val = v; }
          }
          flush(st.t);
        });
        st.marks.forEach(m => {
          const y = (m.who === 'A' ? 8 : 38) + 8;
          const cx = x(m.t);
          if (!m.accepted) {
            chart.appendChild(sv('path', { d: 'M' + (cx - 5) + ' ' + (y - 5) + 'L' + (cx + 5) + ' ' + (y + 5) + 'M' + (cx + 5) + ' ' + (y - 5) + 'L' + (cx - 5) + ' ' + (y + 5), style: 'stroke:var(--bad);stroke-width:2.5' }));
          } else if (m.stale) {
            chart.appendChild(sv('circle', { cx: cx, cy: y, r: 6, style: 'fill:var(--bad);stroke:var(--white);stroke-width:1.5' }));
          } else {
            chart.appendChild(sv('circle', { cx: cx, cy: y, r: 3.5, style: 'fill:var(--white);stroke:var(--ink);stroke-width:1.5' }));
          }
        });
        const ay = 100;
        chart.appendChild(sv('line', { x1: X0, x2: X1, y1: ay, y2: ay, style: 'stroke:var(--rail)' }));
        [30, 20, 10, 0].forEach(sec => {
          const xx = X1 - (sec / (WINDOW / 1000)) * (X1 - X0);
          chart.appendChild(sv('text', { x: xx, y: ay + 16, 'text-anchor': sec === 0 ? 'end' : sec === 30 ? 'start' : 'middle' }, sec === 0 ? 'now' : '−' + sec + ' s'));
        });
      }

      st = fresh();
      syncButtons();
      render();
      ctx.interval(tick, 100);
    }
  });

  // =====================================================================
  // 4. Heartbeats in a sorted set (planned, S5)
  // =====================================================================
  AF.register({
    id: 'rd-heartbeat',
    group: 'redis',
    order: 4,
    title: 'Heartbeats in a sorted set',
    question: 'How does the control plane find out, cheaply and at any moment, which nodes are still alive?',
    status: 'planned',
    slice: 'S5',
    where: [
      'docs/specs/project/04-NODE-AGENT.md, section Heartbeat and registry',
      'docs/design/node-agent/node-agent.md: HeartbeatPublisher, ServiceRegistry, FleetHealthIndicator (planned)',
      'AgentProperties.HeartbeatProperties (interval, threshold): the config shape exists, values not set yet'
    ],
    idea: [
      'Each agent heartbeats by writing its node into a Redis sorted set with the current time as the score. A sorted set keeps members ordered by score, so "which nodes beat in the last N seconds" is one range query: ZRANGEBYSCORE key (now − threshold) now. It costs O(log n + m): find the start, then read the m matches.',
      'A node that stops heartbeating keeps its old score and drops out of the range once it is older than the threshold. Nothing has to be deleted, and the reader chooses the threshold. Agents also register a logical name and their endpoint in Redis, so control-api can resolve services by name.',
      'Planned for S5: a custom Spring HealthIndicator, FleetHealthIndicator, reports fleet health as the fraction of leased nodes heartbeating within the threshold, so it shows up in /actuator/health.'
    ],
    terms: [
      ['Sorted set', 'A Redis set where each member has a score and members stay ordered by it.'],
      ['ZRANGEBYSCORE', 'Returns the members whose score lies between a minimum and a maximum.'],
      ['Threshold', 'How old the last heartbeat may be before a node counts as not alive.'],
      ['HealthIndicator', 'A Spring Boot bean whose result appears in /actuator/health.']
    ],
    tryIt: [
      'Watch the clock tick and the scores in the sorted set move as each node heartbeats every 2 simulated seconds.',
      'Press Stop heartbeat on node-3 and node-5. Their scores freeze, and once older than the threshold they drop out of the ZRANGEBYSCORE result; health turns DEGRADED with 4 of 6.',
      'Drag Threshold up and down: the shaded window on the chart widens, and stopped nodes come back into the result until their scores are older again.',
      'Press Restart heartbeat on node-3: one ZADD updates its score and it is alive again.'
    ],
    breakIt: 'Set Threshold to the 2 s heartbeat interval or lower and healthy nodes flap between alive and stale between beats, so the health check reports failures that are not there.',
    say: 'Each agent ZADDs its node into a sorted set scored by heartbeat time, so "which nodes are alive" is one ZRANGEBYSCORE over the last threshold seconds, O(log n + m), and a custom HealthIndicator reports the alive fraction of leased nodes in /actuator/health.',
    quiz: {
      q: 'Why score the heartbeat sorted set by timestamp instead of keeping one key per node with a TTL?',
      options: [
        'One range query answers "who beat in the last N seconds" in O(log n + m), and the reader can pick any threshold without rewriting keys',
        'Sorted sets are written to disk and plain keys are not',
        'Keys with a TTL cannot be read by another service',
        'ZADD is the only Redis command that accepts a timestamp'
      ],
      answer: 0,
      why: 'With TTL keys the threshold is fixed into every write, and listing the live nodes means scanning the keyspace. The sorted set keeps the raw time, so one range query answers the question for any threshold.'
    },
    mount(el, ctx) {
      const STEP = 200;                               // simulated ms per 100 ms tick: 1 simulated second = 500 ms
      const INTERVAL = 2000;                          // illustrative heartbeat interval
      const RANGE = 30000;                            // chart shows the last 30 simulated seconds
      const BASE = Date.UTC(2026, 9, 2, 9, 0, 0);
      const KEY = 'node:heartbeats';
      let t = RANGE;
      let threshold = 6;
      let lastHealth = null;
      let lastFlap = null;

      const log = shortLog('Heartbeat log');
      const verdict = stableVerdict();

      const nodes = [1, 2, 3, 4, 5, 6].map(i => ({ name: 'node-' + i, beating: true, score: 0, next: 0, i: i }));
      function seed() {
        nodes.forEach(nd => {
          nd.beating = true;
          nd.score = BASE + t - nd.i * 310;
          nd.next = t + INTERVAL - nd.i * 310;
        });
      }
      const nowScore = () => BASE + t;
      const isAlive = nd => nd.score >= nowScore() - threshold * 1000 && nd.score <= nowScore();
      function beat(nd) {
        nd.score = nowScore();
        nd.next = t + INTERVAL + AF.rand(-150, 150);   // jitter is only visual variety
      }

      // ---- controls
      const thrS = ui.slider({ label: 'Threshold', min: 1, max: 20, step: 1, value: threshold, format: v => v + ' s', onInput: v => { threshold = v; render(); } });
      const resetBtn = ui.button('Reset', () => {
        t = RANGE;
        seed();
        cards.forEach(c => { c.btn.textContent = 'Stop heartbeat'; });
        lastHealth = null;
        lastFlap = null;
        log.clear();
        verdict.clear();
        render();
      }, { variant: 'quiet' });

      const cards = nodes.map(nd => {
        const view = liveNode(nd.name, '');
        const btn = ui.button('Stop heartbeat', () => {
          nd.beating = !nd.beating;
          if (nd.beating) {
            beat(nd);
            log.add(nd.name + ': heartbeat restarted, ZADD ' + KEY + ' ' + nd.score + ' ' + nd.name, 'ok');
          } else {
            log.add(nd.name + ': heartbeat stopped. Its score stays at ' + nd.score + '.', 'warn');
          }
          btn.textContent = nd.beating ? 'Stop heartbeat' : 'Restart heartbeat';
          render();
        }, { small: true });
        return { nd: nd, view: view, btn: btn, el: h('div', { class: 'stack', style: 'gap:.35rem' }, view.el, btn) };
      });
      const cardGrid = h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(9.5rem,1fr));gap:.6rem' }, cards.map(c => c.el));

      // ---- stage
      const chart = sv('svg', { class: 'chart', style: 'max-width:44rem', viewBox: '0 0 600 158', role: 'img', 'aria-label': 'Each node\'s last heartbeat on a time line, with the threshold window shaded.' });
      const zsetBox = h('div', { style: 'display:grid;grid-template-columns:auto auto minmax(0,1fr);gap:.3rem .7rem;align-items:center' });
      const cmdCode = ui.code('', 'ZRANGEBYSCORE');
      const healthCode = ui.code('', 'Health endpoint');
      const rClock = ui.readout('Clock (UTC, simulated)', '');
      const rAlive = ui.readout('In the window', '');
      const rHealth = ui.readout('Fleet health', '');
      const registry = ui.code(['HGETALL agent:registry']
        .concat(nodes.map(nd => '"agent.' + nd.name + '"  "http://agent-' + nd.i + ':8084"')).join('\n'), 'Service registry');

      el.append(
        controls(thrS.el, resetBtn),
        cardGrid,
        stage(ui.panel('Last heartbeat per node', chart,
          note('Shaded band: the ZRANGEBYSCORE window. Filled dot: score inside the window, the node counts as alive. Hollow dot: older than the threshold.'))),
        cols(ui.panel('Sorted set ' + KEY + ' (lowest score first)', zsetBox), ui.panel('The query', cmdCode), ui.panel('What /actuator/health would show', healthCode)),
        readouts(rClock, rAlive, rHealth),
        verdict.el,
        log.el,
        note('Planned for S5, not built: this simulates the spec. 1 simulated second = 500 ms. The 2 s heartbeat interval, the 6 s default threshold, the key names and the UP, DEGRADED and DOWN rule are illustrative; the design does not fix them yet. All six nodes are leased.'),
        details('The service registry, also in Redis', registry,
          note('Agents write their logical name and endpoint on boot and refresh it with the heartbeat; control-api resolves the name instead of hard-coding hosts. Names and endpoints here are illustrative.'))
      );

      // ---- views
      function render() {
        const now = nowScore();
        const min = now - threshold * 1000;
        const alive = nodes.filter(isAlive);
        const inRange = alive.slice().sort((a, b) => a.score - b.score);

        cards.forEach(c => {
          const nd = c.nd;
          const ok = isAlive(nd);
          c.view.set(null, (nd.beating ? 'beating' : 'stopped') + ', last ' + secs(now - nd.score) + ' ago, ' + (ok ? 'alive' : 'not alive'), ok ? (nd.beating ? 'ok' : 'warn') : 'bad');
        });

        AF.clear(zsetBox);
        nodes.slice().sort((a, b) => a.score - b.score).forEach(nd => {
          const ok = isAlive(nd);
          zsetBox.append(ui.token(nd.name, ok ? 'ok' : 'bad'), h('code', null, String(nd.score)), h('span', { class: 'small' }, (ok ? 'in range' : 'too old') + ', ' + secs(now - nd.score) + ' ago'));
        });

        setCode(cmdCode, 'ZRANGEBYSCORE ' + KEY + ' ' + min + ' ' + now + '\n' +
          (inRange.length ? inRange.map((nd, i) => (i + 1) + ') "' + nd.name + '"').join('\n') : '(empty array)') +
          '\n\nCost: O(log n + m), here n = 6 members, m = ' + inRange.length + ' returned.');

        const n = alive.length;
        const status = n === nodes.length ? 'UP' : n === 0 ? 'DOWN' : 'DEGRADED';
        const frac = Math.round((n / nodes.length) * 100) / 100;
        setCode(healthCode, 'GET /actuator/health/fleet\n' + JSON.stringify({
          status: status,
          details: { aliveLeasedNodes: n, leasedNodes: nodes.length, fraction: frac, thresholdSeconds: threshold }
        }, null, 2));

        rClock.set(new Date(now).toISOString().slice(11, 21));
        rAlive.set(n + ' of ' + nodes.length, n === nodes.length ? 'ok' : n === 0 ? 'bad' : 'warn');
        rHealth.set(status + ', ' + pct(n, nodes.length), status === 'UP' ? 'ok' : status === 'DOWN' ? 'bad' : 'warn');

        const flapping = threshold * 1000 <= INTERVAL;
        if (flapping !== lastFlap) {
          if (flapping) log.add('Threshold ' + threshold + ' s is not longer than the 2 s heartbeat interval: expect health to flap', 'bad');
          else if (lastFlap !== null) log.add('Threshold ' + threshold + ' s is longer than the heartbeat interval again', 'ok');
          lastFlap = flapping;
        }
        if (status !== lastHealth) {
          if (lastHealth !== null && !flapping) log.add('Fleet health changed to ' + status + ': ' + n + ' of ' + nodes.length + ' leased nodes inside the ' + threshold + ' s window', status === 'UP' ? 'ok' : status === 'DOWN' ? 'bad' : 'warn');
          lastHealth = status;
        }
        if (flapping) {
          verdict.set('bad', 'The threshold (' + threshold + ' s) is not longer than the heartbeat interval (2 s): healthy nodes fall out of the window between beats, and the health check reports failures that are not there.');
        } else if (status === 'UP') {
          verdict.set('ok', 'UP: all 6 leased nodes heartbeat within ' + threshold + ' s. One ZRANGEBYSCORE answered it.');
        } else {
          const stale = nodes.filter(nd => !isAlive(nd)).map(nd => nd.name).join(', ');
          verdict.set(status === 'DOWN' ? 'bad' : 'warn', status + ': ' + stale + (n === nodes.length - 1 ? ' is' : ' are') + ' older than ' + threshold + ' s. ' + n + ' of 6 leased nodes are alive, so fleet health reports ' + frac + '.');
        }
        drawChart();
      }

      function drawChart() {
        AF.clear(chart);
        const X0 = 56;
        const X1 = 590;
        const ROW = 18;
        const TOP = 6;
        const now = nowScore();
        const x = sc => X0 + (1 - Math.min(RANGE, Math.max(0, now - sc)) / RANGE) * (X1 - X0);
        const wx = x(now - threshold * 1000);
        chart.appendChild(sv('rect', { x: wx, y: TOP - 3, width: X1 - wx, height: nodes.length * ROW + 3, style: 'fill:var(--signal-wash);stroke:var(--signal)' }));
        nodes.forEach((nd, i) => {
          const y = TOP + i * ROW + ROW / 2;
          chart.appendChild(sv('text', { x: 0, y: y + 4 }, nd.name));
          chart.appendChild(sv('line', { x1: X0, x2: X1, y1: y, y2: y, style: 'stroke:var(--line)' }));
          const ok = isAlive(nd);
          chart.appendChild(sv('circle', {
            cx: x(nd.score), cy: y, r: 5,
            style: ok ? 'fill:var(--ok)' : 'fill:var(--white);stroke:var(--bad);stroke-width:2'
          }));
        });
        const ay = TOP + nodes.length * ROW + 8;
        chart.appendChild(sv('line', { x1: X0, x2: X1, y1: ay, y2: ay, style: 'stroke:var(--rail)' }));
        [30, 20, 10, 0].forEach(sec => {
          const xx = x(now - sec * 1000);
          chart.appendChild(sv('text', { x: xx, y: ay + 15, 'text-anchor': sec === 0 ? 'end' : sec === 30 ? 'start' : 'middle' }, sec === 0 ? 'now' : '−' + sec + ' s'));
        });
        chart.appendChild(sv('text', { x: X1, y: ay + 30, 'text-anchor': 'end' }, 'window: last ' + threshold + ' s'));
      }

      function tick() {
        t += STEP;
        nodes.forEach(nd => { if (nd.beating && t >= nd.next) beat(nd); });
        render();
      }

      seed();
      render();
      ctx.interval(tick, 100);
    }
  });

  // =====================================================================
  // 5. Caching the read side (planned, S6)
  // =====================================================================
  AF.register({
    id: 'rd-cache',
    group: 'redis',
    order: 5,
    title: 'Cache-aside, eviction and stampedes',
    question: 'How do you serve hot reads from Redis without showing stale data, and without the database falling over when a hot key expires?',
    status: 'planned',
    slice: 'S6',
    where: [
      'docs/specs/project/05-QUERY-SERVICE.md, section Caching',
      'docs/specs/SPRING-PROJECT.md, section Redis: read-model cache with invalidation on event',
      'query-service module: only QueryServiceApplication so far, no cache code yet'
    ],
    idea: [
      'Cache-aside: the reader asks Redis first; on a miss it reads the database and stores the answer with a TTL. The hard part is invalidation. When the data changes, the cached copy must go, or readers keep seeing the old value until the TTL runs out.',
      'In query-service, planned for S6, deployment_summary and fleet_view are cached this way. The projection that applies each event also evicts the keys for that aggregate id, never flushAll, and a dedicated test proves the stale value is gone. The TTL is only a backstop. Hit ratio is measured and exposed, because it is the number that justifies the cache.',
      'A hot key that expires under load causes a stampede: every concurrent reader misses and recomputes at once. Single-flight lets one reader take a short Redis lock and recompute while the others wait for its result. Jittered TTLs stop many keys that were cached together from expiring in the same second.'
    ],
    terms: [
      ['Cache-aside', 'The application reads the cache first and fills it from the database on a miss.'],
      ['Invalidation', 'Removing a cached value when the data behind it changes.'],
      ['Stampede', 'Many readers miss the same key at once and all hit the database.'],
      ['Single-flight', 'Only one caller recomputes a missing value; the rest wait for its result.']
    ],
    tryIt: [
      'Watch the dashboard reads: mostly hits. Press Update deployment: the key is evicted, one read misses and loads the new status.',
      'Turn on Skip eviction and press Update deployment: readers get stale reads until the TTL backstop expires the key.',
      'Press Expire hot key under load: with the lock, 1 of 50 readers queries Postgres. Turn on No single-flight lock and press it again: 50 queries at once.',
      'Turn on Same TTL for every key: 40 keys cached together all expire in the same half second instead of spreading out.'
    ],
    breakIt: 'Skip eviction and every reader sees the old status until the TTL backstop expires the key. Drop the single-flight lock and one expired hot key sends every concurrent reader to the database at once.',
    say: 'query-service caches read models cache-aside in Redis, evicts by aggregate id as the projection applies each event so the TTL is only a backstop, and stops stampedes on hot keys with a short single-flight lock and jittered TTLs, with the hit ratio exposed as a metric.',
    quiz: {
      q: 'A hot key expires and 50 requests miss it at the same moment. What does single-flight change?',
      options: [
        'One request takes a short lock and recomputes; the others wait and then read its result, so the database sees one query instead of 50',
        'The key never expires, so there is nothing to recompute',
        'The 50 requests are queued and their 50 queries run one at a time',
        'The 49 requests that lose the lock get an empty response'
      ],
      answer: 0,
      why: 'The lock does not reduce how many readers arrive; it reduces how many recompute. A longer TTL only postpones the stampede, and running 50 identical queries in a queue still runs 50.'
    },
    mount(el, ctx) {
      const STEP = 1000 / 3;                 // simulated ms per 100 ms tick: 1 simulated second = 300 ms
      const TTL = 20000;                     // illustrative backstop TTL
      const READ_EVERY = 1500;               // each of 3 dashboard readers, simulated ms
      const N = 50;                          // concurrent readers in the stampede
      const QUERY_MS = 900;                  // illustrative recompute time, real ms
      const POLL_MS = 100;                   // waiting readers re-check the cache
      const DEP = '0199a3f0-6c2e-7b41-9d07-4a1e2f8c5b33';
      const SUM_KEY = 'query:deployment_summary:' + DEP;
      const SUM_SHORT = 'query:deployment_summary:' + short(DEP);
      const HOT_KEY = 'query:fleet_view';
      const LOCK_KEY = 'query:lock:fleet_view';
      const NEXT = { PENDING: 'VALIDATING', VALIDATING: 'DEPLOYING', DEPLOYING: 'HEALTHY', HEALTHY: 'DEGRADED', DEGRADED: 'HEALTHY' };

      let t = 0;
      let row = 'PENDING';
      let cache = null;                      // { value, expiresAt }
      let afterEvict = false;
      let staleRun = 0;
      const stats = { hits: 0, misses: 0, stale: 0, db: 0 };
      const readers = [0, 500, 1000].map((off, i) => ({ name: 'reader ' + (i + 1), next: off }));
      const strip = [];
      let run = 0;
      let running = false;
      const last = { lock: null, noLock: null };

      const log = shortLog('Cache log');
      const verdict = stableVerdict();

      // ---- controls
      const updBtn = ui.button('Update deployment', () => {
        const from = row;
        row = NEXT[row];
        log.add('Event on deployment.events: ' + from + ' to ' + row + '. The projection updates the deployment_summary row.', 'busy');
        if (!skipT.get()) {
          if (cache) log.add('DEL ' + SUM_KEY + ' (evict by aggregate id)', 'ok');
          cache = null;
          afterEvict = true;
          staleRun = 0;
        } else {
          log.add('Eviction skipped: the cached copy still says ' + (cache ? cache.value : 'nothing'), 'bad');
          afterEvict = false;
          staleRun = 0;
        }
        renderSummary();
      }, { variant: 'primary' });
      const skipT = ui.toggle('Skip eviction', false, on => {
        log.add(on ? 'Break: the projection updates rows but never evicts' : 'Fixed: the projection evicts by aggregate id', on ? 'bad' : 'ok');
      }, { tone: 'danger' });
      const expBtn = ui.button('Expire hot key under load', () => { stampede(); }, { variant: 'primary' });
      const noLockT = ui.toggle('No single-flight lock', false, on => {
        log.add(on ? 'Break: every reader that misses recomputes fleet_view' : 'Fixed: one reader recomputes under ' + LOCK_KEY, on ? 'bad' : 'ok');
      }, { tone: 'danger' });
      const sameTtlT = ui.toggle('Same TTL for every key', false, () => { drawJitter(true); }, { tone: 'danger' });
      const resetBtn = ui.button('Reset', reset, { variant: 'quiet' });

      // ---- invalidation panel
      const nRow = liveNode('Postgres: deployment_summary row', '');
      const nCache = liveNode(SUM_KEY, '', null, { code: true });
      const ttlBar = ui.bar({ label: 'TTL backstop', max: TTL, value: 0, format: v => secs(v) });
      const stripBox = h('div', { class: 'row', style: 'gap:.3rem' });
      const panelA = ui.panel('Invalidation: 3 dashboard readers', nRow, nCache, ttlBar, label('Last 16 reads, newest last'), stripBox);

      // ---- stampede panel
      const tokens = Array.from({ length: N }, () => ui.token('', 'idle'));
      const tokenBox = h('div', { class: 'row', style: 'gap:.25rem' }, tokens);
      const nHot = liveNode(HOT_KEY, 'cached', 'ok', { code: true });
      const nLock = liveNode(LOCK_KEY, 'no key', 'idle', { code: true });
      const barNoLock = ui.bar({ label: 'Without lock', max: N, value: 0, format: v => (last.noLock === null ? 'not run' : v + ' queries') });
      const barLock = ui.bar({ label: 'With lock', max: N, value: 0, format: v => (last.lock === null ? 'not run' : v + ' queries') });
      const jitterChart = sv('svg', { class: 'chart', style: 'max-width:26rem', viewBox: '0 0 320 120', role: 'img', 'aria-label': '' });
      const panelB = ui.panel('Stampede: ' + N + ' readers when the hot key expires', nHot, nLock, tokenBox,
        label('Postgres queries in the last run'), barNoLock.el, barLock.el,
        label('40 keys cached at the same moment: when do they expire?'), jitterChart);

      const rRatio = ui.readout('Hit ratio (dashboard)', '');
      const rStale = ui.readout('Stale reads served', 0);
      const rDb = ui.readout('Postgres reads (dashboard)', 0);
      const rRunQ = ui.readout('Queries in last stampede', '');
      const rPeak = ui.readout('Peak expiries per half second', '');

      el.append(
        controls(label('Invalidation'), updBtn, skipT.el),
        controls(label('Stampede'), expBtn, noLockT.el, sameTtlT.el, resetBtn),
        stage(cols(panelA, panelB)),
        readouts(rRatio, rStale, rDb, rRunQ, rPeak),
        verdict.el,
        log.el,
        note('Planned for S6, not built: this simulates the spec. 1 simulated second = 300 ms for the dashboard reads. The 20 s TTL, the 900 ms recompute, the plus or minus 10 % jitter and the key names are illustrative.')
      );

      // ---- invalidation model
      function pushStrip(text, tone) {
        strip.push(ui.token(text, tone));
        if (strip.length > 16) strip.shift();
        AF.clear(stripBox);
        strip.forEach(tk => stripBox.appendChild(tk));
      }

      function read(r) {
        if (cache) {
          stats.hits++;
          const stale = cache.value !== row;
          if (stale) {
            stats.stale++;
            staleRun++;
            if (staleRun === 1) {
              verdict.set('bad', 'Stale read: ' + r.name + ' got ' + cache.value + ' from the cache, but the row says ' + row + '. Only the TTL backstop will fix it, in ' + secs(cache.expiresAt - t) + '.');
              log.add(r.name + ': stale read, cached ' + cache.value + ' while the row says ' + row, 'bad');
            }
          }
          pushStrip(stale ? 'stale' : 'hit', stale ? 'bad' : 'ok');
        } else {
          stats.misses++;
          stats.db++;
          cache = { value: row, expiresAt: t + TTL };
          pushStrip('miss', 'busy');
          log.add(r.name + ': miss. Read the row from Postgres, SET ' + SUM_SHORT + ' with a ' + TTL / 1000 + ' s TTL', 'muted');
          if (staleRun > 0) {
            verdict.set('warn', 'The TTL backstop finally expired the key after ' + staleRun + ' stale reads; this miss loaded ' + row + '.');
            staleRun = 0;
          } else if (afterEvict) {
            verdict.set('ok', 'Evicted on the event: one miss, and the reader loaded ' + row + '. No stale read.');
          }
          afterEvict = false;
        }
        renderSummary();
      }

      function tick() {
        t += STEP;
        if (cache && cache.expiresAt <= t) {
          log.add('TTL backstop expired ' + SUM_SHORT + (cache.value !== row ? ' while it was stale' : ''), cache.value !== row ? 'warn' : 'muted');
          cache = null;
        }
        readers.forEach(r => {
          if (t >= r.next) {
            read(r);
            r.next += READ_EVERY;
          }
        });
        renderSummary();
      }

      function renderSummary() {
        nRow.set(null, 'status ' + row, null);
        if (cache) {
          const stale = cache.value !== row;
          nCache.set(null, 'cached status ' + cache.value + (stale ? ', stale: the row says ' + row : ', matches the row'), stale ? 'bad' : 'ok');
          ttlBar.set(Math.max(0, cache.expiresAt - t), stale ? 'bad' : null);
        } else {
          nCache.set(null, 'no key: the next read misses', 'idle');
          ttlBar.set(0, null);
        }
        const total = stats.hits + stats.misses;
        rRatio.set(total ? pct(stats.hits, total) : '—', total && stats.hits / total >= 0.8 ? 'ok' : null);
        rStale.set(stats.stale, stats.stale ? 'bad' : null);
        rDb.set(stats.db);
      }

      // ---- stampede model
      function setTok(i, text, tone) {
        tokens[i].textContent = text;
        AF.tone(tokens[i], tone);
      }

      async function stampede() {
        if (running) return;
        running = true;
        expBtn.disabled = true;
        const my = ++run;
        const single = !noLockT.get();
        const live = () => ctx.alive && my === run;
        let present = false;
        let lockHeld = false;
        let queries = 0;
        let inFlight = 0;
        let peak = 0;
        let hits = 0;
        for (let i = 0; i < N; i++) setTok(i, 'r' + String(i + 1).padStart(2, '0'), 'idle');
        nHot.set(null, 'expired: every GET misses', 'bad');
        log.add('The hot key ' + HOT_KEY + ' expires while ' + N + ' readers arrive', 'warn');

        async function reader(i) {
          await AF.sleep(ctx, ctx.reducedMotion ? 0 : i * 3);   // arrivals spread over 150 ms
          if (!live()) return;
          if (present) { hits++; setTok(i, 'hit', 'ok'); return; }
          if (single) {
            if (!lockHeld) {
              lockHeld = true;                                  // SET query:lock:fleet_view <id> NX PX 2000
              nLock.set(null, 'held by r' + String(i + 1).padStart(2, '0') + ', PX 2000', 'busy');
              log.add('r' + String(i + 1).padStart(2, '0') + ': SET ' + LOCK_KEY + ' NX PX 2000 OK, recomputes fleet_view', 'busy');
              queries++; inFlight++; peak = Math.max(peak, inFlight);
              setTok(i, 'db', 'warn');
              nHot.set(null, 'recomputing under the lock', 'busy');
              await AF.sleep(ctx, QUERY_MS);
              if (!live()) return;
              inFlight--;
              present = true;
              lockHeld = false;
              nLock.set(null, 'no key: released with DEL', 'idle');
              nHot.set(null, 'cached again', 'ok');
              log.add('SET ' + HOT_KEY + ' with a jittered TTL, then DEL ' + LOCK_KEY, 'ok');
              return;
            }
            setTok(i, 'wait', 'busy');
            while (!present) {
              await AF.sleep(ctx, POLL_MS);
              if (!live()) return;
            }
            hits++;
            setTok(i, 'hit', 'ok');
            return;
          }
          queries++; inFlight++; peak = Math.max(peak, inFlight);
          setTok(i, 'db', 'bad');
          nHot.set(null, 'expired: ' + inFlight + ' readers recomputing at once', 'bad');
          await AF.sleep(ctx, QUERY_MS);
          if (!live()) return;
          inFlight--;
          present = true;
          nHot.set(null, 'cached again (written ' + queries + ' times)', 'ok');
        }

        const all = [];
        for (let i = 0; i < N; i++) all.push(reader(i));
        await Promise.all(all);
        if (!live()) return;

        if (single) last.lock = queries; else last.noLock = queries;
        barLock.set(last.lock || 0, last.lock === null ? null : 'ok');
        barNoLock.set(last.noLock || 0, last.noLock === null ? null : 'bad');
        rRunQ.set(queries + ' of ' + N, queries > 1 ? 'bad' : 'ok');
        if (single) {
          log.add('Single-flight: 1 Postgres query, ' + hits + ' readers served from the cache', 'ok');
          verdict.set('ok', 'Single-flight: one reader took ' + LOCK_KEY + ' and recomputed; ' + hits + ' waited and read its result. 1 query instead of ' + N + '.');
        } else {
          log.add('Stampede: ' + queries + ' Postgres queries for the same view, ' + peak + ' at once', 'bad');
          verdict.set('bad', 'Stampede: all ' + queries + ' readers missed and ran the same query, ' + peak + ' at the same time. Under real load that spike is what takes the database down.');
        }
        running = false;
        expBtn.disabled = false;
      }

      // ---- jitter chart
      function drawJitter(announce) {
        const same = sameTtlT.get();
        const rnd = mulberry32(7);
        const ttls = [];
        for (let i = 0; i < 40; i++) ttls.push(same ? 20 : 20 * (0.9 + 0.2 * rnd()));
        const B0 = 18;
        const W = 0.5;
        const counts = new Array(8).fill(0);
        ttls.forEach(v => { counts[Math.min(7, Math.max(0, Math.floor((v - B0) / W)))]++; });
        const peak = Math.max.apply(null, counts);

        AF.clear(jitterChart);
        const X0 = 28;
        const X1 = 316;
        const Y0 = 96;
        const Y1 = 8;
        const bw = (X1 - X0) / counts.length;
        jitterChart.appendChild(sv('line', { x1: X0, x2: X1, y1: Y0, y2: Y0, style: 'stroke:var(--rail)' }));
        jitterChart.appendChild(sv('text', { x: 0, y: Y1 + 8 }, '40'));
        jitterChart.appendChild(sv('text', { x: 0, y: Y0 }, '0'));
        counts.forEach((c, i) => {
          const hgt = (c / 40) * (Y0 - Y1);
          if (c) {
            jitterChart.appendChild(sv('rect', { x: X0 + i * bw + 2, y: Y0 - hgt, width: bw - 4, height: hgt, style: same ? 'fill:var(--bad)' : 'fill:var(--ok)' }));
            jitterChart.appendChild(sv('text', { x: X0 + i * bw + bw / 2, y: Y0 - hgt - 3, 'text-anchor': 'middle' }, String(c)));
          }
        });
        [18, 20, 22].forEach(sec => {
          jitterChart.appendChild(sv('text', { x: X0 + ((sec - B0) / W) * bw, y: Y0 + 16, 'text-anchor': sec === 18 ? 'start' : sec === 22 ? 'end' : 'middle' }, sec + ' s'));
        });
        jitterChart.setAttribute('aria-label', same
          ? 'All 40 keys expire at 20 s, in the same half second.'
          : '40 keys with jittered TTLs expire between 18 and 22 s, at most ' + peak + ' in one half second.');
        rPeak.set(peak + ' of 40', same ? 'bad' : 'ok');
        if (announce) {
          if (same) verdict.set('bad', 'Same TTL: all 40 keys cached together expire in the same half second, so their misses arrive together, a stampede across keys.');
          else verdict.set('ok', 'Jittered TTLs (20 s plus or minus 10 %): the same 40 expiries spread over 4 s, at most ' + peak + ' in any half second.');
        }
      }

      function reset() {
        run++;
        running = false;
        expBtn.disabled = false;
        t = 0;
        row = 'PENDING';
        cache = null;
        afterEvict = false;
        staleRun = 0;
        stats.hits = stats.misses = stats.stale = stats.db = 0;
        readers.forEach((r, i) => { r.next = i * 500; });
        strip.length = 0;
        AF.clear(stripBox);
        last.lock = null;
        last.noLock = null;
        barLock.set(0, null);
        barNoLock.set(0, null);
        tokens.forEach((tk, i) => { tk.textContent = 'r' + String(i + 1).padStart(2, '0'); AF.tone(tk, 'idle'); });
        nHot.set(null, 'cached', 'ok');
        nLock.set(null, 'no key', 'idle');
        rRunQ.set('—');
        log.clear();
        verdict.clear();
        drawJitter(false);
        renderSummary();
      }

      tokens.forEach((tk, i) => { tk.textContent = 'r' + String(i + 1).padStart(2, '0'); });
      rRunQ.set('—');
      drawJitter(false);
      renderSummary();
      ctx.interval(tick, 100);
    }
  });
})();
