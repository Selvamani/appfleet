/*
 * labs-ui-data.js: the server-state and API lessons for "How the Appfleet console works"
 * (appfleet-ui-concepts.html).
 *
 *   ui-query-cache        query keys, one shared cache, staleTime, refetch on focus   built, P1
 *   ui-polling            polling that follows the deployment state machine          built, P1
 *   ui-invalidation       invalidate after a write; asOf and "Updating"             built, P1
 *   ui-cursor             cursor lists with Load older                               built, P1
 *   ui-retry              which failures are retried, and never a mutation          built, P1
 *   ui-fetch-wrapper      http.ts, the only call to fetch                            built, P1
 *   ui-problem            ProblemDetail slugs and their treatment                    built, P1
 *   ui-idempotent-submit  one Idempotency-Key per submission                         built, P1
 *   ui-202                202 Accepted, then poll                                    built, P1
 *   ui-proxy              hybrid mode: MSW passthrough and the dev proxy table       in progress, P2 and P6
 *
 * Facts come from web-console/src (api/http.ts, api/keys.ts, api/control.ts, app/queryClient.ts,
 * hooks/*, lib/errorText.ts, components/Feedback.tsx, mocks/*), web-console/proxy.config.ts,
 * control-api's ApiExceptionHandler and CorrelationIdFilter, and
 * docs/design/ux/web-console-react-plan.md §4.2 and §8.
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
  const wrapToken = (text, tone) => {
    const t = ui.token(text, tone);
    t.style.whiteSpace = 'normal';
    t.style.overflowWrap = 'anywhere';
    return t;
  };

  /** Every lesson here runs on the same scale: 1 simulated second = 250 ms of real time. */
  const SIM_MS = 250;
  const TICK_MS = 50;
  const TICK_SIM = TICK_MS * 1000 / SIM_MS;   // 200 simulated ms per clock tick
  const simSleep = (ctx, simMs) => AF.sleep(ctx, simMs * SIM_MS / 1000);
  const sec = ms => (ms / 1000).toFixed(1) + ' s';
  const stamp = ms => 't=' + (ms / 1000).toFixed(1) + ' s';

  function hexChars(n) {
    let out = '';
    for (let i = 0; i < n; i++) out += Math.floor(Math.random() * 16).toString(16);
    return out;
  }
  const variant = () => '89ab'[Math.floor(Math.random() * 4)];
  const uuid4 = () => hexChars(8) + '-' + hexChars(4) + '-4' + hexChars(3) + '-' + variant() + hexChars(3) + '-' + hexChars(12);
  const short = id => id.slice(0, 8) + '…';

  const DEP_ID = '0192f3a1-7c2e-7a40-9b1d-4e6f8a2c5d01';
  const APP_ID = '0192f3a1-5b7c-7d20-8e4f-1a2b3c4d5e6f';
  const TASK_ID = '0192f3a1-7c2e-7a41-8c3d-5f7a9b1c3e02';

  /** Tone for a deployment state, grouped as in src/lib/statusTone.ts. The word is always printed too. */
  function stateTone(s) {
    if (s === 'PENDING' || s === 'VALIDATING' || s === 'DEPLOYING') return 'busy';
    if (s === 'HEALTHY') return 'ok';
    if (s === 'DEGRADED') return 'warn';
    if (s === 'FAILED') return 'bad';
    return 'idle';
  }

  /** deploymentPollInterval from src/hooks/pollInterval.ts, as written there. */
  const POLL_LIVE_MS = 2000;
  const POLL_SETTLED_MS = 30000;
  function deploymentPollInterval(status, rollbackPending) {
    if (status === undefined) return POLL_LIVE_MS;
    if (status === 'FAILED' || status === 'ROLLED_BACK') return false;
    if (rollbackPending) return POLL_LIVE_MS;
    if (status === 'HEALTHY' || status === 'DEGRADED') return POLL_SETTLED_MS;
    return POLL_LIVE_MS;
  }

  /** The state in effect at ms, from a list of { at, status } sorted by time. */
  function stateAt(list, ms) {
    let s = list[0].status;
    for (const x of list) if (x.at <= ms) s = x.status;
    return s;
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
      clear() { if (last === '') return; last = ''; v.clear(); }
    };
  }

  /** A shorter log for the continuously running simulations (layout only). */
  function shortLog(labelText) {
    const lg = ui.log({ label: labelText });
    lg.el.style.maxHeight = '9rem';
    return lg;
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

  const BAND = {
    busy: 'fill:var(--signal-wash);stroke:var(--signal)',
    ok: 'fill:var(--ok-wash);stroke:var(--ok)',
    bad: 'fill:var(--bad-wash);stroke:var(--bad)',
    warn: 'fill:var(--warn-wash);stroke:var(--warn)',
    idle: 'fill:var(--idle-wash);stroke:var(--idle)'
  };
  const STROKE = { busy: 'var(--signal)', ok: 'var(--ok)', bad: 'var(--bad)', warn: 'var(--warn)', idle: 'var(--idle)' };

  /**
   * Draws a time chart into svg: one band row per entry in spec.rows, then a row of request ticks
   * with optional dashed spans (hidden tab, held connection), then a time axis.
   * spec: { from, to (simulated ms), rows: [{ label, segs: [{ from, to, text, tone }] }],
   *         ticks: [{ at, tone }], spans: [{ from, to, text, tone }], ticksLabel }
   */
  function drawTimeline(svg, spec) {
    AF.clear(svg);
    const X0 = 64;
    const X1 = 630;
    const ROW = 18;
    const GAP = 6;
    const span = Math.max(1, spec.to - spec.from);
    const X = ms => X0 + (Math.max(spec.from, Math.min(spec.to, ms)) - spec.from) / span * (X1 - X0);
    const fits = (text, w) => text && w > text.length * 6.2 + 6;
    let y = 2;
    for (const r of spec.rows) {
      svg.appendChild(sv('text', { x: 0, y: y + 13 }, r.label));
      svg.appendChild(sv('rect', { x: X0, y, width: X1 - X0, height: ROW, style: 'fill:var(--white);stroke:var(--line)' }));
      for (const sg of r.segs) {
        if (sg.to <= spec.from || sg.from >= spec.to || sg.to <= sg.from) continue;
        const a = X(sg.from);
        const w = Math.max(1.5, X(sg.to) - a);
        svg.appendChild(sv('rect', { x: a, y, width: w, height: ROW, style: BAND[sg.tone] || BAND.idle }));
        if (fits(sg.text, w)) svg.appendChild(sv('text', { x: a + 3, y: y + 13, style: 'fill:var(--ink)' }, sg.text));
      }
      y += ROW + GAP;
    }
    svg.appendChild(sv('text', { x: 0, y: y + 13 }, spec.ticksLabel || 'Requests'));
    svg.appendChild(sv('line', { x1: X0, x2: X1, y1: y + ROW / 2, y2: y + ROW / 2, style: 'stroke:var(--line)' }));
    for (const sp of spec.spans || []) {
      if (sp.to <= spec.from || sp.from >= spec.to || sp.to <= sp.from) continue;
      const a = X(sp.from);
      const w = Math.max(1.5, X(sp.to) - a);
      svg.appendChild(sv('rect', { x: a, y, width: w, height: ROW, style: (BAND[sp.tone] || BAND.idle) + ';stroke-dasharray:3 2' }));
      if (fits(sp.text, w)) svg.appendChild(sv('text', { x: a + 3, y: y + 13, style: 'fill:var(--ink)' }, sp.text));
    }
    for (const tk of spec.ticks || []) {
      if (tk.at < spec.from || tk.at > spec.to) continue;
      const x = X(tk.at);
      svg.appendChild(sv('line', { x1: x, x2: x, y1: y + 1, y2: y + ROW - 1, style: 'stroke-width:2;stroke:' + (STROKE[tk.tone] || STROKE.busy) }));
    }
    y += ROW + GAP;
    svg.appendChild(sv('line', { x1: X0, x2: X1, y1: y, y2: y, style: 'stroke:var(--rail)' }));
    const step = span > 40000 ? 10000 : 5000;
    for (let s = Math.ceil(spec.from / step) * step; s <= spec.to; s += step) {
      const x = X(s);
      svg.appendChild(sv('line', { x1: x, x2: x, y1: y, y2: y + 4, style: 'stroke:var(--rail)' }));
      const anchor = x < X0 + 8 ? 'start' : x > X1 - 12 ? 'end' : 'middle';
      svg.appendChild(sv('text', { x, y: y + 16, 'text-anchor': anchor }, (s / 1000) + ' s'));
    }
    svg.setAttribute('viewBox', '0 0 640 ' + (y + 22));
  }

  const DEPLOY_OK = [[0, 'PENDING'], [1500, 'VALIDATING'], [4000, 'DEPLOYING'], [9000, 'HEALTHY']];
  const DEPLOY_FAIL = [[0, 'PENDING'], [1500, 'VALIDATING'], [4000, 'DEPLOYING'], [12000, 'FAILED']];
  const asTransitions = rows => rows.map(r => ({ at: r[0], status: r[1] }));

  const PARTIAL_INDEX_NOTE = 'Left out on purpose: control-api\'s partial unique index uq_deployment_active_per_app_env. In the real service a second copy that arrives while the first deployment is still active gets 409 conflict, an error about your own deployment; once the first has FAILED, a second one does get created.';

  // =====================================================================
  // 1. Query keys and one shared cache (built, P1)
  // =====================================================================
  AF.register({
    id: 'ui-query-cache',
    group: 'server-state',
    order: 1,
    title: 'One cache, shared by query key',
    question: 'How can two parts of a screen show the same deployment without fetching it twice or disagreeing?',
    status: 'built',
    slice: 'P1',
    where: [
      'web-console/src/api/keys.ts',
      'web-console/src/app/queryClient.ts',
      'web-console/src/hooks/useDeployment.ts'
    ],
    idea: [
      'TanStack Query keeps one cache for the whole app. Each entry is found by its query key, an array such as [\'control\', \'deployment\', id]. Every component that asks for the same key reads the same entry, and if a request for that key is already in flight, it joins that request instead of sending another. That is deduplication.',
      'staleTime says how long an answer counts as fresh. A fresh answer is served from the cache with no request. A stale one is still shown at once, but the next trigger, a component mounting or the window regaining focus, refetches it in the background. Stale means "check again when asked", not "fetch now".',
      'In the console every key comes from qk in src/api/keys.ts, following [service, resource, ...params], and createQueryClient() in src/app/queryClient.ts sets staleTime to 5 s. useDeployment(id) reads qk.deployment(id), so every widget on a page that shows that deployment shares one request and one answer.'
    ],
    terms: [
      ['Query key', 'The array that names one cached answer, such as [\'control\', \'deployment\', id]. Same key, same entry.'],
      ['Deduplication', 'Components asking for one key while its request is in flight share that request.'],
      ['staleTime', 'How long an answer counts as fresh. Fresh answers are served without a request.'],
      ['Refetch on focus', 'When the window regains focus, stale answers on screen are fetched again in the background.']
    ],
    tryIt: [
      'Press Wait 5 s, then Mount widget B. The cached answer is 5 s old and so stale: B shows it at once, one background request refreshes it, and both widgets change together.',
      'Press Unmount widget B, then Mount widget B again straight away: the answer is fresh, so there is no request.',
      'Press Reload the page: both widgets mount together and share one request. Set staleTime to 0 s and press Focus the window: now every focus refetches.',
      'Turn on Fetch in each component (the page reloads), press Wait 5 s, then Mount widget B: B shows DEPLOYING while A still shows PENDING.'
    ],
    breakIt: 'Fetch in each component with useEffect and useState, and every component sends its own request and keeps its own copy. Two widgets on one screen then show two different states of the same deployment, and nothing brings them back together.',
    say: 'Server data lives in one TanStack Query cache under keys like [\'control\', \'deployment\', id], so every component asking for that key shares one request and one answer, and a staleTime of 5 s decides when a mount or a window focus checks the server again.',
    quiz: {
      q: 'The cached deployment is 8 s old and staleTime is 5 s. Nothing mounts, nothing is focused and there is no polling. What happens?',
      options: [
        'TanStack Query refetches it at once, because it is stale',
        'Nothing yet: the stale answer stays on screen and is refetched only when a trigger such as a mount, a focus or an invalidation comes',
        'The entry is deleted from the cache, so the next reader shows a loading state',
        'The screen shows an error until the answer is refetched'
      ],
      answer: 1,
      why: 'Stale means "check again next time someone asks", not "fetch now". Only mounting, window focus, reconnecting, a refetchInterval or an invalidation starts the background request. Removing an entry is a separate timer, gcTime, that runs only once nothing uses it.'
    },
    mount(el, ctx) {
      const RTT = 500;
      const KEY = "['control', 'deployment', '" + short(DEP_ID) + "']";
      const PATH = 'GET /api/v1/deployments/' + short(DEP_ID);
      const SCHEDULE = asTransitions(DEPLOY_OK);
      const serverAt = ms => stateAt(SCHEDULE, ms);

      let t = 0;
      let epoch = 0;
      let busy = false;
      let reqNo = 0;
      let staleTime = 5000;
      let bMounted = false;
      let cache = null;            // the shared entry: { status, updatedAt, req }
      let fetching = false;
      const copies = { A: null, B: null };   // broken mode: each widget's own useState copy
      const net = [];                         // recent requests, newest first

      const log = shortLog('Cache log');
      const verdict = stableVerdict();

      const mountBtn = ui.button('Mount widget B', () => run(toggleB), { variant: 'primary' });
      const focusBtn = ui.button('Focus the window', () => run(focus));
      const waitBtn = ui.button('Wait 5 s', () => run(wait));
      const reloadBtn = ui.button('Reload the page', () => run(reload));
      const staleS = ui.slider({
        label: 'staleTime', min: 0, max: 30, step: 1, value: 5, format: v => v + ' s',
        onInput: v => { staleTime = v * 1000; render(); }
      });
      const brokenT = ui.toggle('Fetch in each component', false, on => {
        log.add(on ? 'Break: each widget fetches in its own useEffect and keeps the answer in its own useState. The page reloads.'
          : 'Fixed: both widgets call useDeployment(id) and read one cache entry. The page reloads.', on ? 'bad' : 'ok');
        restart();
      }, { tone: 'danger' });
      const resetBtn = ui.button('Reset', () => { log.clear(); restart(); }, { variant: 'quiet' });
      const broken = () => brokenT.get();

      const screenLane = ui.lane('Screen', 'one deployment');
      const wA = liveNode('Widget A: loading', '', 'idle');
      const wB = liveNode('Widget B: not mounted', '', 'idle');
      screenLane.body.append(wA.el, wB.el);
      const cacheLane = ui.lane('Query cache', 'TanStack Query');
      const cacheCode = ui.code('', 'Cache entry');
      cacheLane.body.append(cacheCode);
      const serverLane = ui.lane('control-api', 'deployment ' + short(DEP_ID));
      const srv = liveNode('', '', null);
      const netBox = h('div', { class: 'stack', style: 'gap:.3rem;align-items:flex-start' });
      serverLane.body.append(srv.el, netBox);

      const rClock = ui.readout('Clock', '0.0 s');
      const rReq = ui.readout('Requests sent', 0);
      const rAgree = ui.readout('Widgets agree', '—');
      const rFresh = ui.readout('Cached answer', '—');

      el.append(
        controls(mountBtn, focusBtn, waitBtn, reloadBtn),
        controls(staleS.el, brokenT.el, resetBtn),
        stage(cols(screenLane.el, cacheLane.el, serverLane.el)),
        readouts(rClock, rReq, rAgree, rFresh),
        verdict.el,
        log.el,
        note('Illustrative timings: each request takes 0.5 simulated s, and the deployment changes state at 1.5, 4 and 9 s, as new deployments do in the simulated backend (src/mocks/db.ts). Time moves only while a request is in flight or you press Wait 5 s. 1 simulated second = 250 ms.')
      );

      // ---- model
      const age = () => (cache ? t - cache.updatedAt : Infinity);
      const isStale = () => !cache || age() >= staleTime;
      const shownA = () => (broken() ? (copies.A ? copies.A.status : null) : (cache ? cache.status : null));
      const shownB = () => (!bMounted ? null : broken() ? (copies.B ? copies.B.status : null) : (cache ? cache.status : null));

      /** Moves the clock forward in 100 ms steps; returns false if the lesson closed or restarted. */
      async function advance(ms, ep) {
        const end = t + ms;
        if (ctx.reducedMotion) {
          await AF.sleep(ctx, 0);
          if (!ctx.alive || ep !== epoch) return false;
          t = end;
          render();
          return true;
        }
        while (t < end) {
          await AF.sleep(ctx, 25);
          if (!ctx.alive || ep !== epoch) return false;
          t = Math.min(end, t + 100);
          render();
        }
        return true;
      }

      /** Sends one GET per entry in who, all at the same moment. Returns the requests, or null if aborted. */
      async function fetchMany(ep, who, reason) {
        const items = who.map(w => {
          const no = ++reqNo;
          const item = { no, status: null };
          net.unshift(item);
          log.add(stamp(t) + ' #' + no + ' ' + PATH + ' (' + reason + (who.length > 1 ? ', widget ' + w : '') + ')', 'busy');
          return item;
        });
        while (net.length > 4) net.pop();
        const sentAt = t;
        render();
        if (!(await advance(RTT, ep))) return null;
        const status = serverAt(sentAt + RTT / 2);
        items.forEach(it => {
          it.status = status;
          log.add(stamp(t) + ' #' + it.no + ' answered ' + status, 'muted');
        });
        return items;
      }

      async function refetchShared(ep, reason) {
        fetching = true;
        const items = await fetchMany(ep, ['cache'], reason);
        if (!items) return false;
        fetching = false;
        cache = { status: items[0].status, updatedAt: t, req: items[0].no };
        render();
        return true;
      }

      async function fetchCopy(ep, who, reason) {
        const items = await fetchMany(ep, [who], reason);
        if (!items) return false;
        copies[who] = { status: items[0].status, at: t, req: items[0].no };
        render();
        return true;
      }

      function brokenVerdict(prefix) {
        const a = copies.A;
        const b = bMounted ? copies.B : null;
        if (a && b && a.status !== b.status) {
          verdict.set('bad', prefix + ' Widget A shows ' + a.status + ' from ' + stamp(a.at) + ', widget B shows ' + b.status + ' from ' + stamp(b.at) + ': one deployment, two answers on one screen.');
        } else if (a && b) {
          verdict.set('warn', prefix + ' Both widgets show ' + b.status + ' only because the deployment did not change between their requests. ' + reqNo + ' requests so far.');
        } else if (a) {
          verdict.set('warn', prefix + ' Widget A shows ' + a.status + ' from ' + stamp(a.at) + ' while the server says ' + serverAt(t) + '.');
        }
      }

      // ---- actions
      async function initial(ep) {
        if (broken()) {
          if (!(await fetchCopy(ep, 'A', 'widget A mounted, its own fetch'))) return;
          verdict.set('busy', 'Widget A fetched the deployment and keeps the answer in its own state.');
        } else {
          if (!(await refetchShared(ep, 'widget A mounted, nothing cached'))) return;
          verdict.set('busy', 'Widget A fetched the deployment once. The answer is cached under ' + KEY + '.');
        }
      }

      async function toggleB(ep) {
        if (bMounted) {
          bMounted = false;
          copies.B = null;
          log.add(stamp(t) + ' widget B unmounted', 'muted');
          render();
          verdict.set('busy', broken() ? 'Widget B unmounted, and its own copy went with it.'
            : 'Widget B unmounted. The answer stays in the cache, so mounting B again while it is fresh costs nothing.');
          return;
        }
        bMounted = true;
        if (broken()) {
          render();
          if (!(await fetchCopy(ep, 'B', 'widget B mounted, its own fetch'))) return;
          brokenVerdict('Widget B sent its own request.');
          return;
        }
        const a = age();
        if (!isStale()) {
          log.add(stamp(t) + ' widget B mounted: the cached answer is fresh, no request', 'ok');
          render();
          verdict.set('ok', 'Fresh answer (' + sec(a) + ' old, staleTime ' + sec(staleTime) + '): widget B read it from the cache. No request, and both widgets show ' + cache.status + '.');
          return;
        }
        const before = cache ? cache.status : 'nothing';
        render();
        if (!(await refetchShared(ep, 'widget B mounted, the cached answer is ' + sec(a) + ' old'))) return;
        verdict.set('ok', 'The cached answer was ' + sec(a) + ' old, so it was stale: widget B showed ' + before + ' at once, and one background request refreshed the entry. Both widgets now show ' + cache.status + '.');
      }

      async function focus(ep) {
        log.add(stamp(t) + ' the window regains focus', 'muted');
        if (broken()) {
          brokenVerdict('Focus did nothing: a fetch inside useEffect runs on mount only.');
          return;
        }
        if (!isStale()) {
          verdict.set('ok', 'Focus found the answer fresh (' + sec(age()) + ' old, staleTime ' + sec(staleTime) + '), so nothing was sent.');
          return;
        }
        const a = age();
        if (!(await refetchShared(ep, 'window focus, the answer is ' + sec(a) + ' old'))) return;
        verdict.set('ok', 'Focus refetched the stale answer once' + (bMounted ? ' for both widgets' : '') + ': one request, and the screen now shows ' + cache.status + '.');
      }

      async function wait(ep) {
        log.add(stamp(t) + ' waiting 5 simulated seconds', 'muted');
        if (!(await advance(5000, ep))) return;
        if (broken()) {
          brokenVerdict('Five seconds passed and nothing was sent.');
          return;
        }
        verdict.set('busy', 'Five seconds passed and nothing was sent. The answer is ' + sec(age()) + ' old, so it is ' +
          (isStale() ? 'stale: the next mount or focus will check the server.' : 'still fresh.') + ' The server now says ' + serverAt(t) + '.');
      }

      async function reload(ep) {
        cache = null;
        copies.A = null;
        copies.B = null;
        bMounted = true;
        log.add(stamp(t) + ' page reloaded: a new QueryClient with an empty cache; widgets A and B mount together', 'muted');
        if (broken()) {
          render();
          const items = await fetchMany(ep, ['A', 'B'], 'mounted');
          if (!items) return;
          copies.A = { status: items[0].status, at: t, req: items[0].no };
          copies.B = { status: items[1].status, at: t, req: items[1].no };
          render();
          verdict.set('bad', 'Two requests for one deployment: each component fetched its own copy. They agree only because both requests left at the same moment.');
          return;
        }
        if (!(await refetchShared(ep, 'widgets A and B mounted together, one request for both'))) return;
        verdict.set('ok', 'Both widgets asked for the same key while its request was in flight, so they shared it: one request, one answer.');
      }

      function run(fn) {
        if (busy) return;
        busy = true;
        const ep = epoch;
        sync();
        Promise.resolve(fn(ep)).then(() => {
          if (!ctx.alive || ep !== epoch) return;
          busy = false;
          render();
        });
      }

      function restart() {
        epoch++;
        busy = false;
        t = 0;
        reqNo = 0;
        cache = null;
        fetching = false;
        bMounted = false;
        copies.A = null;
        copies.B = null;
        net.length = 0;
        verdict.clear();
        render();
        run(initial);
      }

      // ---- view
      const copyLine = c => (c ? "{ status: '" + c.status + "' }, " + stamp(c.at) + ' (#' + c.req + ')' : 'loading');

      function cacheText() {
        if (!cache) return 'key      ' + KEY + '\ndata     none yet\nfetch    ' + (fetching ? 'fetching' : 'idle');
        return [
          'key      ' + KEY,
          "data     { status: '" + cache.status + "' }",
          'updated  ' + stamp(cache.updatedAt) + ' (answer #' + cache.req + ')',
          'age      ' + sec(age()) + ', staleTime ' + sec(staleTime) + ': ' + (isStale() ? 'stale' : 'fresh'),
          'readers  ' + (bMounted ? '2 (widget A, widget B)' : '1 (widget A)'),
          'fetch    ' + (fetching ? 'fetching' : 'idle')
        ].join('\n');
      }

      function sync() {
        [mountBtn, focusBtn, waitBtn, reloadBtn].forEach(b => { b.disabled = busy; });
        mountBtn.textContent = bMounted ? 'Unmount widget B' : 'Mount widget B';
      }

      function render() {
        const sA = shownA();
        const sB = shownB();
        if (broken()) {
          const a = copies.A;
          const b = copies.B;
          wA.set('Widget A: ' + (a ? a.status : 'loading'), a ? 'own useState copy from ' + stamp(a.at) + ' (#' + a.req + ')' : 'fetching its own copy', a ? stateTone(a.status) : 'idle');
          if (!bMounted) wB.set('Widget B: not mounted', 'press Mount widget B', 'idle');
          else wB.set('Widget B: ' + (b ? b.status : 'loading'), b ? 'own useState copy from ' + stamp(b.at) + ' (#' + b.req + ')' : 'fetching its own copy', b ? stateTone(b.status) : 'idle');
          setCode(cacheCode, ['Not used. Each widget keeps', 'its own useState copy:', '',
            'widget A  ' + copyLine(copies.A),
            'widget B  ' + (bMounted ? copyLine(copies.B) : 'not mounted')].join('\n'));
        } else {
          const sub = cache ? 'useDeployment(id): answer #' + cache.req + ' from ' + stamp(cache.updatedAt) + (fetching ? ', refreshing' : '') : 'fetching';
          wA.set('Widget A: ' + (sA || 'loading'), sub, sA ? stateTone(sA) : 'idle');
          if (!bMounted) wB.set('Widget B: not mounted', 'press Mount widget B', 'idle');
          else wB.set('Widget B: ' + (sB || 'loading'), sub, sB ? stateTone(sB) : 'idle');
          setCode(cacheCode, cacheText());
        }
        const now = serverAt(t);
        srv.set('Server says ' + now, 'state changes at 1.5, 4 and 9 s', stateTone(now));
        AF.clear(netBox);
        if (!net.length) netBox.appendChild(label('No requests yet.'));
        net.forEach(it => netBox.appendChild(ui.token('#' + it.no + ' GET …/' + short(DEP_ID) + (it.status ? ' · ' + it.status : ' · in flight'), it.status ? null : 'busy')));
        rClock.set(sec(t));
        rReq.set(reqNo);
        if (!bMounted) rAgree.set('B not mounted', null);
        else if (!sA || !sB) rAgree.set('—', null);
        else if (sA === sB) rAgree.set('Yes', 'ok');
        else rAgree.set('No', 'bad');
        if (broken()) rFresh.set('Not used', null);
        else if (!cache) rFresh.set('—', null);
        else if (isStale()) rFresh.set('Stale, ' + sec(age()), 'warn');
        else rFresh.set('Fresh, ' + sec(age()), 'ok');
        sync();
      }

      restart();
    }
  });

  // =====================================================================
  // 2. Polling by state (built, P1)
  // =====================================================================
  AF.register({
    id: 'ui-polling',
    group: 'server-state',
    order: 2,
    title: 'Polling that follows the state machine',
    question: 'How often should the screen ask about a deployment, and when should it stop asking?',
    status: 'built',
    slice: 'P1',
    where: [
      'web-console/src/hooks/pollInterval.ts',
      'web-console/src/hooks/useDeployment.ts',
      'web-console/src/features/deployments/deploymentView.ts'
    ],
    idea: [
      'Nothing pushes deployment changes to the browser, so the screen asks. How often is a trade-off: ask rarely and the screen lags behind; ask often and you load the server for nothing. The right answer depends on the state: a deployment in flight changes within seconds, a HEALTHY one rarely, and a FAILED one never again.',
      'deploymentPollInterval(status, rollbackPending) in src/hooks/pollInterval.ts returns 2 s while the deployment is PENDING, VALIDATING or DEPLOYING or a rollback is waiting, 30 s while it is HEALTHY or DEGRADED, and false, meaning stop, at FAILED or ROLLED_BACK, which the state machine never leaves.',
      'useDeployment passes it to useQuery as a refetchInterval function, so the interval is worked out again after every answer. TanStack Query skips the interval while the tab is hidden and refetches a stale answer as soon as the tab is shown again. liveLabel() in deploymentView.ts prints the same policy in the page header.'
    ],
    terms: [
      ['refetchInterval', 'How often a query refetches by itself. As a function it can change with the data; false stops it.'],
      ['Final state', 'FAILED or ROLLED_BACK: the deployment state machine has no transition out of them.'],
      ['Hidden tab', 'TanStack Query does not poll there by default (refetchIntervalInBackground is false).']
    ],
    tryIt: [
      'Watch Succeeds: a request every 2 s through PENDING, VALIDATING and DEPLOYING, then every 30 s once the screen shows HEALTHY.',
      'When the screen shows HEALTHY, press Request rollback: polling goes back to every 2 s until ROLLED_BACK, then stops.',
      'Choose Fails, turn on Hide the tab for a few seconds, then turn it off: no requests while hidden, one as soon as the tab is shown. After FAILED there are none.',
      'Press Start again with Poll every second, forever, then with Never poll, and compare Requests sent and Seconds behind.'
    ],
    breakIt: 'Poll on a fixed short timer and the browser keeps asking about a deployment that FAILED minutes ago, in every open tab. Never poll and the screen stays at PENDING while the deployment moves on, until someone reloads the page.',
    say: 'useDeployment polls through a refetchInterval function, deploymentPollInterval, that returns 2 s while work is in flight or a rollback waits, 30 s while HEALTHY or DEGRADED and false at FAILED or ROLLED_BACK, and TanStack Query pauses it while the tab is hidden.',
    quiz: {
      q: 'Why is a HEALTHY deployment still polled every 30 s instead of not at all?',
      options: [
        'TanStack Query cannot stop polling once it has started',
        'control-api needs a request every 30 s to keep the deployment alive',
        'HEALTHY can still change: it can turn DEGRADED or be rolled back, so only FAILED and ROLLED_BACK are safe to stop at',
        'Polling is what refreshes the access token'
      ],
      answer: 2,
      why: 'deploymentPollInterval returns false only for the two final states of the state machine. HEALTHY and DEGRADED can still move, just rarely, so a 30 s interval keeps the screen honest at a fifteenth of the in-flight rate.'
    },
    mount(el, ctx) {
      const RTT = 200;
      const STALE = 5000;
      const WINDOW = 60000;
      const END = 150000;
      const ROLLBACK_MS = 5000;
      const FINAL = s => s === 'FAILED' || s === 'ROLLED_BACK';

      let st = null;
      const log = shortLog('Polling log');
      const verdict = stableVerdict();

      const scenC = ui.choice('Deployment', [{ value: 'ok', label: 'Succeeds' }, { value: 'fail', label: 'Fails' }], 'ok', () => restart());
      const restartBtn = ui.button('Start again', () => restart(), { variant: 'primary' });
      const rollbackBtn = ui.button('Request rollback', requestRollback);
      const rbNote = label('');
      const hideT = ui.toggle('Hide the tab', false, on => setHidden(on));
      const foreverT = ui.toggle('Poll every second, forever', false, on => {
        if (on) neverT.set(false);
        log.add(stamp(st.t) + (on ? ' Break: setInterval(fetch, 1000), whatever the state, hidden or not' : ' Fixed: refetchInterval follows deploymentPollInterval again'), on ? 'bad' : 'ok');
        reschedule();
      }, { tone: 'danger' });
      const neverT = ui.toggle('Never poll', false, on => {
        if (on) foreverT.set(false);
        log.add(stamp(st.t) + (on ? ' Break: no refetchInterval, so only the first request' : ' Fixed: refetchInterval follows deploymentPollInterval again'), on ? 'bad' : 'ok');
        reschedule();
      }, { tone: 'danger' });

      const chart = sv('svg', {
        class: 'chart', viewBox: '0 0 640 100', role: 'img', style: 'min-width:34rem;max-width:56rem',
        'aria-label': 'Timeline of the last 60 simulated seconds: what the server says, what the screen shows, and a tick for each request. Dashed spans mark a hidden tab.'
      });

      const rClock = ui.readout('Clock', '0.0 s');
      const rReq = ui.readout('Requests sent', 0);
      const rShown = ui.readout('Screen shows', '—');
      const rServer = ui.readout('Server says', '—');
      const rBehind = ui.readout('Seconds behind', '0.0 s');
      const rWorst = ui.readout('Worst so far', '0.0 s');
      const rAfter = ui.readout('Sent after the end', 0);
      const rIv = ui.readout('Polling', '—');

      el.append(
        controls(scenC.el, restartBtn, h('span', { class: 'row', style: 'gap:.4rem' }, rollbackBtn, rbNote), hideT.el),
        controls(foreverT.el, neverT.el),
        stage(chart),
        readouts(rClock, rReq, rShown, rServer, rBehind, rWorst, rAfter, rIv),
        verdict.el,
        log.el,
        note('State times follow the simulated backend: VALIDATING at 1.5 s, DEPLOYING at 4 s, then HEALTHY at 9 s or FAILED at 12 s, and ROLLED_BACK 5 s after a rollback. Each request takes 0.2 simulated s (illustrative). Ticks: blue-green while polling, amber while the tab is hidden, orange after the screen already showed a final state. 1 simulated second = 250 ms; the run stops at 150 s.')
      );

      function fresh() {
        const hidden = hideT.get();
        return {
          t: 0,
          transitions: asTransitions(scenC.get() === 'ok' ? DEPLOY_OK : DEPLOY_FAIL),
          shown: undefined, shownServerAt: 0, screen: [],
          rollbackPending: false,
          inflight: null, nextPoll: 0, lastAnswerAt: null, lastIv: null,
          hidden, hiddenFrom: hidden ? 0 : null, hiddenSpans: [],
          ticks: [], requests: 0, afterEnd: 0, worst: 0, endSeenAt: null, stopped: false
        };
      }
      const serverAt = ms => stateAt(st.transitions, ms);

      function interval() {
        if (neverT.get()) return false;
        if (foreverT.get()) return 1000;
        return deploymentPollInterval(st.shown, st.rollbackPending);
      }

      function send(atMs, why) {
        st.requests++;
        const late = st.endSeenAt !== null;
        if (late) st.afterEnd++;
        st.ticks.push({ at: atMs, tone: late ? 'bad' : st.hidden ? 'warn' : 'busy' });
        if (st.ticks.length > 400) st.ticks.shift();
        st.inflight = { no: st.requests, sentAt: atMs, doneAt: atMs + RTT };
        st.nextPoll = null;
        log.add(stamp(atMs) + ' #' + st.requests + ' GET /api/v1/deployments/' + short(DEP_ID) + ' (' + why + ')', late ? 'bad' : 'busy');
      }

      function nextEvent() {
        let e = null;
        if (st.inflight) e = { kind: 'answer', at: st.inflight.doneAt };
        else if (st.nextPoll !== null) e = { kind: 'poll', at: st.nextPoll };
        return e && e.at <= st.t ? e : null;
      }

      function handle(e) {
        if (e.kind === 'poll') {
          const iv = interval();
          if (st.hidden && !foreverT.get() && st.requests > 0) {
            st.nextPoll = iv === false ? null : e.at + iv;   // the interval ticks, but skips the fetch
            return;
          }
          send(e.at, st.requests === 0 ? 'the page opens' : 'poll');
          return;
        }
        const f = st.inflight;
        st.inflight = null;
        const status = serverAt(f.sentAt + RTT / 2);
        st.lastAnswerAt = e.at;
        st.shownServerAt = f.sentAt + RTT / 2;
        const changed = status !== st.shown;
        if (changed) {
          st.shown = status;
          st.screen.push({ at: e.at, status });
        }
        if (FINAL(status) && st.endSeenAt === null) st.endSeenAt = e.at;
        const iv = interval();
        // setInterval fires on its own beat; refetchInterval counts from the last answer.
        st.nextPoll = iv === false ? null : (foreverT.get() ? f.sentAt : e.at) + iv;
        if (changed || iv !== st.lastIv) {
          log.add(stamp(e.at) + ' #' + f.no + ' answered ' + status + ': ' + (iv === false ? 'polling stops' : 'next request in ' + iv / 1000 + ' s'), FINAL(status) ? 'ok' : 'muted');
        }
        st.lastIv = iv;
      }

      function reschedule() {
        if (!st || st.inflight || st.requests === 0) return;
        const iv = interval();
        st.nextPoll = iv === false ? null : st.t + iv;
        render();
      }

      function setHidden(on) {
        if (!st) return;
        if (on) {
          st.hidden = true;
          st.hiddenFrom = st.t;
          log.add(stamp(st.t) + ' tab hidden', 'muted');
        } else {
          if (st.hiddenFrom !== null) st.hiddenSpans.push({ from: st.hiddenFrom, to: st.t });
          st.hidden = false;
          st.hiddenFrom = null;
          const age = st.lastAnswerAt === null ? Infinity : st.t - st.lastAnswerAt;
          log.add(stamp(st.t) + ' tab shown: the answer is ' + (age === Infinity ? 'missing' : sec(age) + ' old') + (age >= STALE ? ', so it refetches on focus' : ', fresh, no refetch'), 'muted');
          if (!st.inflight && age >= STALE && !st.stopped) send(st.t, 'window focus');
        }
        render();
      }

      function requestRollback() {
        if (!st || st.rollbackPending || !(st.shown === 'HEALTHY' || st.shown === 'DEGRADED')) return;
        const now = serverAt(st.t);
        if (now !== 'HEALTHY' && now !== 'DEGRADED') {
          log.add(stamp(st.t) + ' 409 illegal-transition: Cannot roll back a deployment in state ' + now + '.', 'warn');
          return;
        }
        st.transitions.push({ at: st.t + ROLLBACK_MS, status: 'ROLLED_BACK' });
        st.rollbackPending = true;
        log.add(stamp(st.t) + ' POST /api/v1/deployments/' + short(DEP_ID) + '/rollback: 202 Accepted. rollbackPending is true, so the interval drops to 2 s', 'busy');
        reschedule();
      }

      function behind() {
        if (st.shown === undefined) return 0;
        const tr = st.transitions.find(x => x.at > st.shownServerAt && x.at <= st.t);
        return tr ? st.t - tr.at : 0;
      }

      function judge() {
        const srv = serverAt(st.t);
        if (st.shown === undefined) { verdict.set('busy', 'The page opens and fetches the deployment.'); return; }
        if (neverT.get()) {
          if (st.shown !== srv) verdict.set('bad', 'Never polling: the screen still says ' + st.shown + ' while the server has moved on to ' + srv + '. Seconds behind keeps growing; only a reload or a window focus would fix it.');
          else verdict.set('warn', 'Never polling: the screen shows ' + st.shown + ' only because nothing has changed since its one request. The next change will not show.');
          return;
        }
        if (foreverT.get()) {
          verdict.set('bad', 'Polling every second, forever: it never slows down, keeps going while the tab is hidden, and does not stop at FAILED or ROLLED_BACK. Watch Requests sent and Sent after the end.');
          return;
        }
        if (st.hidden) { verdict.set('busy', 'Tab hidden: polling is paused, so no requests. Showing the tab refetches at once if the answer is more than 5 s old.'); return; }
        if (FINAL(st.shown)) { verdict.set('ok', st.shown + ' is final: polling stopped after ' + st.requests + ' requests, and the screen was never more than ' + sec(st.worst) + ' behind.'); return; }
        if (st.rollbackPending) { verdict.set('busy', 'Rollback requested: back to every 2 s until the server reports ROLLED_BACK.'); return; }
        if (st.shown === 'HEALTHY' || st.shown === 'DEGRADED') { verdict.set('ok', st.shown + ': polling slows to every 30 s. It can still turn DEGRADED or be rolled back, so it does not stop.'); return; }
        verdict.set('busy', 'Work in flight: polling every 2 s, so the screen is at most about 2 s behind.');
      }

      function render() {
        if (!st) return;
        const from = Math.max(0, st.t - WINDOW);
        const to = from + WINDOW;
        const segs = [];
        st.transitions.forEach((x, i) => {
          if (x.at > st.t) return;
          const next = st.transitions[i + 1];
          const end = next && next.at <= st.t ? next.at : st.t;
          segs.push({ from: x.at, to: end, text: x.status, tone: stateTone(x.status) });
        });
        const scr = [{ from: 0, to: st.screen.length ? st.screen[0].at : st.t, text: 'loading', tone: 'idle' }];
        st.screen.forEach((x, i) => {
          const end = i + 1 < st.screen.length ? st.screen[i + 1].at : st.t;
          scr.push({ from: x.at, to: end, text: x.status, tone: stateTone(x.status) });
        });
        const spans = st.hiddenSpans.map(s => ({ from: s.from, to: s.to, text: 'hidden', tone: 'idle' }));
        if (st.hidden) spans.push({ from: st.hiddenFrom, to: st.t, text: 'hidden', tone: 'idle' });
        drawTimeline(chart, { from, to, rows: [{ label: 'Server', segs }, { label: 'Screen', segs: scr }], ticks: st.ticks, spans });

        const srv = serverAt(st.t);
        const b = behind();
        rClock.set(sec(st.t));
        rReq.set(st.requests);
        rShown.set(st.shown || 'loading', st.shown ? stateTone(st.shown) : null);
        rServer.set(srv, stateTone(srv));
        rBehind.set(sec(b), b > 3000 ? 'bad' : b > 0 ? 'warn' : 'ok');
        rWorst.set(sec(st.worst), st.worst > 3000 ? 'bad' : null);
        rAfter.set(st.afterEnd, st.afterEnd ? 'bad' : null);
        const iv = interval();
        if (st.hidden && !foreverT.get()) rIv.set('Paused, hidden', 'warn');
        else if (iv === false) rIv.set(st.requests ? 'Stopped' : 'First request only', neverT.get() ? 'bad' : null);
        else rIv.set('Every ' + iv / 1000 + ' s', foreverT.get() ? 'bad' : null);

        let reason = null;
        if (st.rollbackPending) reason = 'A rollback is already requested.';
        else if (st.shown === undefined || st.shown === 'PENDING' || st.shown === 'VALIDATING' || st.shown === 'DEPLOYING') reason = 'Available once the deployment is HEALTHY or DEGRADED.';
        else if (FINAL(st.shown)) reason = 'Not available from a final state.';
        rollbackBtn.disabled = reason !== null || st.stopped;
        rbNote.textContent = reason || '';
        judge();
      }

      function restart() {
        st = fresh();
        log.clear();
        verdict.clear();
        log.add('t=0.0 s DeploymentPage opens for a deployment that was just accepted', 'muted');
        render();
      }

      ctx.interval(() => {
        if (!st || st.stopped) return;
        st.t = Math.min(END, st.t + TICK_SIM);
        let e;
        let guard = 0;
        while ((e = nextEvent()) && guard++ < 100) handle(e);
        const b = behind();
        if (b > st.worst) st.worst = b;
        if (st.t >= END) {
          st.stopped = true;
          log.add(stamp(st.t) + ' The run stops here. Press Start again to repeat it.', 'muted');
        }
        render();
      }, TICK_MS);

      restart();
    }
  });

  // =====================================================================
  // 3. Invalidation and read-your-writes (built, P1)
  // =====================================================================
  AF.register({
    id: 'ui-invalidation',
    group: 'server-state',
    order: 3,
    title: 'Invalidate what a write changes',
    question: 'After you deploy, how does every screen that lists deployments learn about it, without passing off old data as current?',
    status: 'built',
    slice: 'P1',
    where: [
      'web-console/src/api/keys.ts',
      'web-console/src/components/Feedback.tsx',
      'web-console/src/features/applications/EnvironmentCard.tsx',
      'web-console/src/features/applications/shared.ts'
    ],
    idea: [
      'A cached answer stays until something says it is out of date. After a write, the mutation calls invalidateQueries with the keys the write changed: matching entries are marked stale, those on screen refetch at once, the rest when next shown. Because keys follow [service, resource, ...params], one prefix such as READ_SIDE, [\'query\'], matches every read-side view.',
      'Reads from query-service come from a projection built from control-api\'s events, so they trail the write. The simulated backend makes that lag about 1.5 s. A refetch right after the write can therefore come back without your change, and every such answer carries asOf, the moment the view is current to.',
      'Freshness in src/components/Feedback.tsx compares asOf with waitingFor, the time of your own write, and says "Updating: your change is not in this view yet" until asOf passes it. The rollback mutation in EnvironmentCard.tsx invalidates READ_SIDE, qk.deployment(id) and qk.deploymentTasks(id); readModelPoll in shared.ts then polls the read side every 2 s for 30 s.'
    ],
    terms: [
      ['Invalidation', 'Marking cached answers out of date so they are fetched again: at once if on screen, else when next shown.'],
      ['Read model', 'A view built from events by query-service: fast to read, a little behind the writes.'],
      ['asOf', 'The moment a read-side answer is current to.'],
      ['Read your writes', 'Seeing your own change straight after making it, or being told it is on its way.']
    ],
    tryIt: [
      'Press Deploy. The History card refetches at once but says Updating; about 2 s later your row appears and the card shows asOf again.',
      'Set Projection lag to 5 s and press Deploy: Updating stays for several polls, and the row still arrives.',
      'Turn on Hide asOf and press Deploy: for a moment the list comes back without your row, and nothing explains why.',
      'Turn off Hide asOf, turn on Do not invalidate (the page reloads) and press Deploy: the card keeps the old list and claims to be current until its next 30 s poll. Open the page again within 5 s of its last fetch: still no request.'
    ],
    breakIt: 'Skip the invalidation and the list keeps showing the world before your write until its next poll, or until it is stale and something remounts it. Drop asOf and a read that has not caught up looks exactly like a write that was lost.',
    say: 'A mutation invalidates exactly the keys it changes, READ_SIDE for every query-service view, and because the read model lags the write, Freshness shows Updating until asOf passes your own write instead of passing off the old list as current.',
    quiz: {
      q: 'You deploy, the History card refetches at once, and the answer does not contain your deployment. What is the right reading?',
      options: [
        'The read model has not caught up yet: asOf is older than your write, so the card should say Updating and keep polling',
        'The deployment failed, because a successful one would be in the list',
        'The invalidation did not run, so the refetch returned the cached answer',
        'The query key is wrong, so the card fetched another list'
      ],
      answer: 0,
      why: 'control-api accepted the write; query-service learns about it from events a moment later. The refetch was real, it just reached a view whose asOf is earlier than your write. Comparing asOf with the time of your write is how the screen tells "not yet" from "never".'
    },
    mount(el, ctx) {
      const RTT = 200;
      const STALE = 5000;
      const WRITE_WINDOW = 30000;
      const BASE = Date.UTC(2026, 9, 2, 10, 0, 0);
      const wall = ms => new Date(BASE + ms).toISOString().slice(11, 19);
      const APP = "'" + short(APP_ID) + "'";
      const NEXT = ['2.4.0 to qa', '2.4.0 to staging', '2.4.1 to qa', '2.4.1 to staging', '2.5.0 to qa'];
      const MAIN = "['query', 'application-history', " + APP + ']';
      const KEYS = [
        { key: "['identity', 'me']", read: false, active: true },
        { key: "['control', 'application', " + APP + ']', read: false, active: true },
        { key: MAIN, read: true, active: true },
        { key: "['query', 'dashboard', 'overview']", read: true, active: false },
        { key: "['query', 'dashboard', 'where', 'all']", read: true, active: false }
      ];
      const KEY_TEXT = {
        cached: ['cached', null],
        untouched: ['untouched by this write', null],
        refetching: ['invalidated, refetching now (on screen)', 'busy'],
        refetched: ['invalidated and refetched', 'ok'],
        stale: ['invalidated, refetches when next shown', 'warn']
      };

      let st = null;
      const sigs = {};
      const log = shortLog('Read-your-writes log');
      const verdict = stableVerdict();

      const deployBtn = ui.button('Deploy', deploy, { variant: 'primary' });
      const reopenBtn = ui.button('Open the page again', reopen);
      const lagS = ui.slider({
        label: 'Projection lag', min: 0.5, max: 5, step: 0.5, value: 1.5, format: v => v.toFixed(1) + ' s',
        onInput: v => { if (st) st.lag = v * 1000; render(); }
      });
      const noInvT = ui.toggle('Do not invalidate', false, on => {
        restart();
        log.add(on ? 'Break: the mutation\'s onSuccess does nothing: no invalidateQueries, no lastWriteAt. The page reloaded.'
          : 'Fixed: onSuccess records lastWriteAt and invalidates READ_SIDE. The page reloaded.', on ? 'bad' : 'ok');
      }, { tone: 'danger' });
      const hideT = ui.toggle('Hide asOf', false, on => {
        log.add(on ? 'Break: the card no longer renders Freshness' : 'Fixed: the card shows Freshness again', on ? 'bad' : 'ok');
        render();
      }, { tone: 'danger' });
      const resetBtn = ui.button('Reset', () => restart(), { variant: 'quiet' });

      const writeLane = ui.lane('control-api', 'write side');
      const writeList = h('div', { class: 'stack', style: 'gap:.35rem' });
      writeLane.body.append(writeList);
      const readLane = ui.lane('query-service', 'projection');
      const projNode = liveNode('', '', null);
      const readList = h('div', { class: 'stack', style: 'gap:.35rem' });
      readLane.body.append(projNode.el, readList);
      const consoleLane = ui.lane('Console: History card', 'cache');
      const pill = wrapToken('', null);
      const fetchLine = label('');
      const cardList = h('div', { class: 'stack', style: 'gap:.35rem' });
      consoleLane.body.append(h('div', null, pill), fetchLine, cardList);
      const keyBox = h('div', { class: 'row', style: 'gap:.35rem' });

      const rReq = ui.readout('Requests sent', 0);
      const rRow = ui.readout('Your deployment on screen', '—');
      const rTook = ui.readout('From 202 to on screen', '—');
      const rLag = ui.readout('Projection lag', '1.5 s');

      el.append(
        controls(deployBtn, reopenBtn, lagS.el),
        controls(noInvT.el, hideT.el, resetBtn),
        stage(cols(writeLane.el, readLane.el, consoleLane.el)),
        ui.panel('Cache keys after the last write', keyBox),
        readouts(rReq, rRow, rTook, rLag),
        verdict.el,
        log.el,
        note('Illustrative: requests take 0.2 simulated s. The simulated backend lags about 1.5 s (src/mocks/handlers/query.ts); the slider stretches it. The card polls by readModelPoll: every 2 s for 30 s after your own write, every 30 s otherwise. Times are UTC. 1 simulated second = 250 ms.')
      );

      function fresh() {
        const rows = [
          { n: 1, label: 'billing-api 2.3.0 to prod', createdAt: -1800000 },
          { n: 2, label: 'billing-api 2.3.1 to staging', createdAt: -600000 },
          { n: 3, label: 'billing-api 2.3.1 to qa', createdAt: -240000 }
        ];
        const lag = lagS.get() * 1000;
        const keyState = {};
        KEYS.forEach(k => { keyState[k.key] = 'cached'; });
        return {
          t: 0, lag, rows, nextN: 4,
          cache: { ids: rows.map(r => r.n), asOf: -lag, updatedAt: 0 },
          inflight: null, nextPoll: 30000, post: null,
          lastWriteAt: null, mine: null, requests: 1, keyState
        };
      }

      const pollMs = now => (st.lastWriteAt !== null && now - st.lastWriteAt < WRITE_WINDOW ? 2000 : 30000);

      function fetchList(atMs, why) {
        st.requests++;
        st.inflight = { no: st.requests, sentAt: atMs, doneAt: atMs + RTT };
        st.nextPoll = null;
        log.add(stamp(atMs) + ' #' + st.requests + ' GET /api/v1/applications/' + short(APP_ID) + '/history (' + why + ')', 'busy');
      }

      function answer(atMs) {
        const f = st.inflight;
        st.inflight = null;
        const asOf = f.sentAt + RTT / 2 - st.lag;
        const ids = st.rows.filter(r => r.createdAt <= asOf).map(r => r.n);
        st.cache = { ids, asOf, updatedAt: atMs };
        if (st.keyState[MAIN] === 'refetching') st.keyState[MAIN] = 'refetched';
        const mineIn = st.mine && ids.includes(st.mine.n);
        if (mineIn && st.mine.shownAt === null) st.mine.shownAt = atMs;
        const iv = pollMs(atMs);
        st.nextPoll = atMs + iv;
        log.add(stamp(atMs) + ' #' + f.no + ' answered ' + ids.length + ' rows, asOf ' + wall(asOf) +
          (st.mine ? (mineIn ? ', your deployment is in it' : ', your deployment is not in it yet') : '') + '; next poll in ' + iv / 1000 + ' s', mineIn ? 'ok' : 'muted');
      }

      function deploy() {
        if (!st || st.post) return;
        const text = 'billing-api ' + NEXT[(st.nextN - 4) % NEXT.length];
        st.post = { sentAt: st.t, doneAt: st.t + RTT, n: st.nextN++, label: text };
        log.add(stamp(st.t) + ' POST /api/v1/deployments: ' + text, 'busy');
        render();
      }

      function accepted(atMs) {
        const p = st.post;
        st.post = null;
        st.rows.push({ n: p.n, label: p.label, createdAt: p.sentAt + RTT / 2 });
        st.mine = { n: p.n, label: p.label, acceptedAt: atMs, shownAt: null };
        log.add(stamp(atMs) + ' 202 Accepted: control-api committed #' + p.n + ' ' + p.label, 'ok');
        if (noInvT.get()) {
          KEYS.forEach(k => { st.keyState[k.key] = 'untouched'; });
          log.add(stamp(atMs) + ' onSuccess: nothing. The card keeps its old list', 'bad');
          return;
        }
        st.lastWriteAt = atMs;
        KEYS.forEach(k => { st.keyState[k.key] = !k.read ? 'untouched' : k.active ? 'refetching' : 'stale'; });
        log.add(stamp(atMs) + " onSuccess: lastWriteAt set; invalidateQueries({ queryKey: ['query'] }) marks every read-side key stale", 'ok');
        st.inflight = null;   // an invalidation cancels a running fetch and starts again
        fetchList(atMs, 'invalidated');
      }

      function reopen() {
        if (!st) return;
        const age = st.t - st.cache.updatedAt;
        if (st.inflight) {
          log.add(stamp(st.t) + ' page opened again: a request is already in flight, so it is shared', 'muted');
          return;
        }
        if (age < STALE) {
          log.add(stamp(st.t) + ' page opened again: the cached list is ' + sec(age) + ' old, under the 5 s staleTime, so no request', 'muted');
          return;
        }
        fetchList(st.t, 'page opened again, the cached list is ' + sec(age) + ' old');
        render();
      }

      function nextEvent() {
        const c = [];
        if (st.post) c.push({ kind: 'post', at: st.post.doneAt });
        if (st.inflight) c.push({ kind: 'answer', at: st.inflight.doneAt });
        else if (st.nextPoll !== null) c.push({ kind: 'poll', at: st.nextPoll });
        c.sort((a, b) => a.at - b.at);
        return c.length && c[0].at <= st.t ? c[0] : null;
      }

      function handle(e) {
        if (e.kind === 'post') accepted(e.at);
        else if (e.kind === 'answer') answer(e.at);
        else fetchList(e.at, 'poll, every ' + pollMs(e.at) / 1000 + ' s');
      }

      function freshness() {
        if (hideT.get()) return { text: '(no asOf on this card)', tone: 'idle' };
        const c = st.cache;
        if (st.lastWriteAt !== null && c.asOf < st.lastWriteAt) return { text: 'Updating: your change is not in this view yet', tone: 'warn' };
        return { text: 'asOf ' + wall(c.asOf) + ' UTC, ' + sec(st.t - c.asOf) + ' behind', tone: null };
      }

      function rowState() {
        if (!st.mine) return ['No write yet', null];
        if (st.cache.ids.includes(st.mine.n)) return ['Shown', 'ok'];
        if (hideT.get()) return ['Missing, no hint', 'bad'];
        if (st.lastWriteAt !== null && st.cache.asOf < st.lastWriteAt) return ['Updating', 'warn'];
        return ['Missing, looks current', 'bad'];
      }

      function judge() {
        const m = st.mine;
        if (!m) { verdict.clear(); return; }
        if (st.cache.ids.includes(m.n)) {
          verdict.set('ok', '#' + m.n + ' appeared ' + sec(m.shownAt - m.acceptedAt) + ' after the 202' + (st.lastWriteAt === null
            ? ', at the card\'s next 30 s poll. Until then the card claimed to be current.'
            : '. Until then the card said Updating instead of passing off the old list as current.'));
          return;
        }
        const s = rowState()[0];
        if (s === 'Updating') {
          verdict.set('warn', 'Accepted. The card refetched at once, but the projection is ' + sec(st.lag) + ' behind, so the answer does not have your deployment yet. The card says Updating and polls every 2 s until asOf passes your write.');
        } else if (s === 'Missing, no hint') {
          verdict.set('bad', 'control-api accepted #' + m.n + ', but the list does not show it and nothing says the list is behind. To the user it looks lost.');
        } else {
          verdict.set('bad', 'No invalidation: the card keeps the list it had before your write and shows asOf as if it were current. It will not ask again until its next 30 s poll, or until the page is opened again after the 5 s staleTime.');
        }
      }

      function once(name, sig, fn) {
        if (sigs[name] === sig) return;
        sigs[name] = sig;
        fn();
      }

      function rowNode(r, sub) {
        const mine = st.mine && st.mine.n === r.n;
        return AF.tone(ui.node('#' + r.n + ' ' + r.label + (mine ? ' (yours)' : ''), sub), mine ? 'ok' : null);
      }

      function render() {
        if (!st) return;
        const asOfNow = st.t - st.lag;
        const mineN = st.mine ? st.mine.n : 0;
        once('w', st.rows.length + '|' + mineN, () => {
          AF.clear(writeList);
          st.rows.slice().reverse().slice(0, 4).forEach(r => writeList.appendChild(rowNode(r, r.createdAt < 0 ? 'committed earlier' : 'committed ' + wall(r.createdAt))));
        });
        projNode.set('asOf ' + wall(asOfNow) + ' UTC', sec(st.lag) + ' behind control-api', null);
        const vis = st.rows.filter(r => r.createdAt <= asOfNow);
        once('r', vis.map(r => r.n).join(',') + '|' + mineN, () => {
          AF.clear(readList);
          vis.slice().reverse().slice(0, 4).forEach(r => readList.appendChild(rowNode(r, 'in the view')));
        });
        const f = freshness();
        pill.textContent = f.text;
        AF.tone(pill, f.tone);
        fetchLine.textContent = st.inflight ? 'Fetching…' : 'Next poll in ' + sec(Math.max(0, st.nextPoll - st.t)) + '; polling every ' + pollMs(st.t) / 1000 + ' s now';
        once('c', st.cache.ids.join(',') + '|' + mineN, () => {
          AF.clear(cardList);
          st.cache.ids.slice().reverse().slice(0, 4).forEach(n => {
            const r = st.rows.find(x => x.n === n);
            cardList.appendChild(rowNode(r, 'on screen'));
          });
        });
        once('k', JSON.stringify(st.keyState), () => {
          AF.clear(keyBox);
          KEYS.forEach(k => {
            const kt = KEY_TEXT[st.keyState[k.key]];
            keyBox.appendChild(wrapToken(k.key + ' · ' + kt[0], kt[1]));
          });
        });
        const rs = rowState();
        rReq.set(st.requests);
        rRow.set(rs[0], rs[1]);
        rTook.set(st.mine && st.mine.shownAt !== null ? sec(st.mine.shownAt - st.mine.acceptedAt) : '—', null);
        rLag.set(sec(st.lag));
        deployBtn.disabled = !!st.post;
        judge();
      }

      function restart() {
        st = fresh();
        Object.keys(sigs).forEach(k => { delete sigs[k]; });
        log.clear();
        verdict.clear();
        log.add('t=0.0 s the application page shows its History card, fetched at t=0, asOf ' + wall(st.cache.asOf) + ' UTC', 'muted');
        render();
      }

      ctx.interval(() => {
        if (!st) return;
        st.t += TICK_SIM;
        let e;
        let guard = 0;
        while ((e = nextEvent()) && guard++ < 50) handle(e);
        render();
      }, TICK_MS);

      restart();
    }
  });

  // =====================================================================
  // 4. Cursor lists (built, P1)
  // =====================================================================
  AF.register({
    id: 'ui-cursor',
    group: 'server-state',
    order: 4,
    title: 'Cursor lists with Load older',
    question: 'How do you page through a list that keeps growing at the top without repeating or skipping rows?',
    status: 'built',
    slice: 'P1',
    where: [
      'web-console/src/hooks/useCursorList.ts',
      'web-console/src/mocks/respond.ts',
      'web-console/src/features/audit/AuditPage.tsx',
      'control-api/src/main/java/io/appfleet/control/web/CursorCodec.java'
    ],
    idea: [
      'Offset paging asks for "rows 11 to 20". If a row arrives at the top in between, every row moves down one place, so row 11 is now one you have already seen; if a row above you leaves, one you never saw slips past. A cursor asks for "the rows after this one" instead, so changes above it do not move it.',
      'The server ends each page with nextCursor, the last row\'s id as base64url (CursorCodec in control-api, page() in the mock), or null when there is nothing more. Ids are time-ordered UUIDv7s, so "after this id" is a cheap index range: control-api\'s findByIdGreaterThanOrderByIdAsc is exactly that.',
      'useCursorList wraps useInfiniteQuery: getNextPageParam returns last.nextCursor, and Load older fetches the next page on demand. The console never shows page numbers (plan §8.6), and new rows appear when the list refetches from the top.'
    ],
    terms: [
      ['Offset paging', 'Skip N rows, take the next page. Breaks when rows are added or removed above.'],
      ['Keyset cursor', 'Continue after a given key. Stable while rows are added or removed elsewhere.'],
      ['nextCursor', 'The opaque token the server sends for the next page; null at the end.']
    ],
    tryIt: [
      'Press New row arrives twice, then Load older: page 2 starts right after the last row you saw. No repeats.',
      'Turn on Page by offset (the list reloads), press New row arrives, then Load older: one row now shows twice.',
      'Still by offset, press A row above leaves, then Load older: a row is never shown, and Never shown counts it.'
    ],
    breakIt: 'Page by offset and every insert at the top repeats a row on the next page, while every removal above skips one. Someone reading the audit trail would read one event twice or miss one, and nothing on screen would say so.',
    say: 'Lists use keyset cursors: the server returns nextCursor, the base64url of the last id, and useCursorList on useInfiniteQuery asks for the rows after it with Load older, so rows arriving at the top never shift the pages already loaded.',
    quiz: {
      q: 'Page 1 shows rows 40 to 31, newest first. Two new rows arrive at the top. With offset paging, what does Load older (offset 10) return?',
      options: [
        'Rows 30 to 21, as expected',
        'Rows 42 to 33',
        'An error, because the offset is no longer valid',
        'Rows 32 to 23, so rows 32 and 31 appear twice'
      ],
      answer: 3,
      why: 'Rows 42 and 41 now take places 1 and 2, so place 11 holds row 32. A cursor naming row 31 would have returned 30 to 21 whatever happened above it.'
    },
    mount(el, ctx) {
      const PAGE = 10;
      const ACTIONS = ['DEPLOYMENT_REQUESTED', 'RELEASE_REGISTERED', 'ROLLBACK_REQUESTED', 'TEAM_MEMBER_ADDED', 'LOGIN_FAILED'];
      const idOf = n => '0192f3a1-' + (0x1000 + n).toString(16) + '-7000-8000-' + n.toString(16).padStart(12, '0');
      const cursorOf = n => btoa(idOf(n)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const shortCursor = c => c.slice(0, 16) + '…';

      let server = [];   // row numbers, newest first
      let pages = [];    // [{ head, rows }]
      let next = null;   // cursor mode: the row number the next cursor names, or null at the end
      let requests = 0;
      let nextN = 41;

      const log = ui.log({ label: 'Paging log' });
      log.el.style.maxHeight = '9rem';
      const verdict = stableVerdict();

      const loadBtn = ui.button('Load older', loadOlder, { variant: 'primary' });
      const newBtn = ui.button('New row arrives', newRow);
      const removeBtn = ui.button('A row above leaves', removeAbove);
      const offsetT = ui.toggle('Page by offset', false, on => {
        log.add(on ? 'Break: Load older asks for ?offset=N. The list reloads from the top.' : 'Fixed: Load older asks for ?cursor=nextCursor. The list reloads from the top.', on ? 'bad' : 'ok');
        verdict.clear();
        loadFirst();
        render();
      }, { tone: 'danger' });
      const resetBtn = ui.button('Reset', reset, { variant: 'quiet' });

      const serverLane = ui.lane('query-service: audit events', 'newest first');
      const serverBox = h('div', { class: 'row', style: 'gap:.3rem' });
      serverLane.body.append(serverBox);
      const screenLane = ui.lane('Console: audit list', 'useCursorList');
      const screenBox = h('div', { class: 'stack', style: 'gap:.5rem' });
      screenLane.body.append(screenBox);
      const reqCode = ui.code('', 'Last request');

      const rRows = ui.readout('Rows on screen', 0);
      const rDup = ui.readout('Shown twice', 0);
      const rSkip = ui.readout('Never shown', 0);
      const rReq = ui.readout('Requests', 0);
      const rServer = ui.readout('Rows on the server', 0);

      el.append(
        controls(loadBtn, newBtn, removeBtn),
        controls(offsetT.el, resetBtn),
        stage(cols(serverLane.el, screenLane.el)),
        readouts(rRows, rDup, rSkip, rReq, rServer),
        verdict.el,
        cols(ui.panel('Last request', reqCode), ui.panel('Log', log.el)),
        note('Page size 10. Rows are numbered for reading; their ids are time-ordered like UUIDv7, so a larger number is newer. A row "leaves" when it stops matching the list, for example a filter (illustrative). Dashed rows on the server are not loaded yet. The console never pages by offset: plan §8.6 keeps the offset endpoint for the benchmark only.')
      );

      const byOffset = () => offsetT.get();
      const loadedCount = () => pages.reduce((a, p) => a + p.rows.length, 0);

      function setReq(query, rows, nextCursor) {
        const items = rows.length ? '#' + rows[0] + ' … #' + rows[rows.length - 1] : 'none';
        setCode(reqCode, query + '\n\n{ "items": [' + items + ']' + (byOffset() ? ' }' : ',\n  "nextCursor": ' + (nextCursor ? '"' + nextCursor + '"' : 'null') + ' }'));
      }

      function loadFirst() {
        const rows = server.slice(0, PAGE);
        requests++;
        if (byOffset()) {
          pages = [{ head: 'Page 1 · offset=0', rows }];
          next = null;
          setReq('GET /api/v1/audit?offset=0&limit=10', rows, null);
          log.add('Page 1: offset=0, rows #' + rows[0] + ' to #' + rows[rows.length - 1], 'muted');
        } else {
          const more = server.length > PAGE;
          pages = [{ head: 'Page 1 · no cursor', rows }];
          next = more ? rows[rows.length - 1] : null;
          setReq('GET /api/v1/audit?limit=10', rows, more ? cursorOf(next) : null);
          log.add('Page 1: rows #' + rows[0] + ' to #' + rows[rows.length - 1] + ', nextCursor names #' + next, 'muted');
        }
      }

      function stats() {
        const shown = pages.flatMap(p => p.rows);
        const counts = new Map();
        shown.forEach(n => counts.set(n, (counts.get(n) || 0) + 1));
        let dup = 0;
        const dupList = [];
        counts.forEach((c, n) => { if (c > 1) { dup += c - 1; dupList.push(n); } });
        const max = shown.length ? Math.max(...shown) : 0;
        const min = shown.length ? Math.min(...shown) : 0;
        const skipped = server.filter(n => n <= max && n >= min && !counts.has(n));
        return { counts, dup, dupList, skipped, max, min, distinct: counts.size };
      }

      function loadOlder() {
        const before = stats();
        if (byOffset()) {
          const off = loadedCount();
          if (off >= server.length) return;
          const rows = server.slice(off, off + PAGE);
          requests++;
          pages.push({ head: 'Page ' + (pages.length + 1) + ' · offset=' + off, rows });
          setReq('GET /api/v1/audit?offset=' + off + '&limit=10', rows, null);
          const after = stats();
          const newDups = after.dupList.filter(n => !before.dupList.includes(n));
          const newSkips = after.skipped.filter(n => !before.skipped.includes(n));
          log.add('Page ' + pages.length + ': offset=' + off + ', rows #' + rows[0] + ' to #' + rows[rows.length - 1], newDups.length || newSkips.length ? 'bad' : 'muted');
          if (newDups.length) {
            verdict.set('bad', 'Rows arrived above since the last page, so offset ' + off + ' now points higher up the list: ' + newDups.map(n => '#' + n).join(' and ') + (newDups.length > 1 ? ' are' : ' is') + ' on screen twice.');
          } else if (newSkips.length) {
            verdict.set('bad', 'A row left above since the last page, so offset ' + off + ' now points further down: ' + newSkips.map(n => '#' + n).join(' and ') + (newSkips.length > 1 ? ' were' : ' was') + ' never shown.');
          } else {
            verdict.set('warn', 'Offset ' + off + ' lined up this time only because nothing changed above since the last page.');
          }
        } else {
          if (next === null) return;
          const c = cursorOf(next);
          const older = server.filter(n => n < next);
          const rows = older.slice(0, PAGE);
          const more = older.length > PAGE;
          const after = next;
          requests++;
          pages.push({ head: 'Page ' + (pages.length + 1) + ' · cursor ' + shortCursor(c), rows });
          next = more ? rows[rows.length - 1] : null;
          setReq('GET /api/v1/audit?cursor=' + shortCursor(c) + '&limit=10', rows, next !== null ? cursorOf(next) : null);
          log.add('Page ' + pages.length + ': the rows after #' + after + ', #' + rows[0] + ' to #' + rows[rows.length - 1], 'ok');
          verdict.set('ok', 'Page ' + pages.length + ' continued after #' + after + ', the row the cursor names, whatever happened above it: no repeats and no gaps.' +
            (next === null ? ' nextCursor is null, so that was the last page.' : ''));
        }
        render();
      }

      function newRow() {
        const n = nextN++;
        server.unshift(n);
        log.add('#' + n + ' ' + ACTIONS[n % ACTIONS.length] + ' arrived at the top. Every row below it moved down one place.', 'busy');
        verdict.set(byOffset() ? 'warn' : 'busy', byOffset()
          ? 'Row #' + n + ' pushed every offset down by one. The next Load older will repeat a row you have already seen.'
          : 'Row #' + n + ' is on the server, above the list. The cursor still names #' + (next === null ? 'nothing' : next) + ', so Load older is unaffected; new rows show when the list refetches from the top.');
        render();
      }

      function removeAbove() {
        const s = stats();
        const onScreen = server.filter(n => s.counts.has(n));
        const target = onScreen[2] !== undefined ? onScreen[2] : server[2];
        if (target === undefined) return;
        server = server.filter(n => n !== target);
        log.add('#' + target + ' left the list (it no longer matches, illustrative). Every row below it moved up one place.', 'busy');
        verdict.set(byOffset() ? 'warn' : 'busy', byOffset()
          ? 'Every offset after #' + target + ' moved up by one. The next Load older will skip a row.'
          : '#' + target + ' is gone from the server but stays on screen until the list refetches. The cursor names #' + (next === null ? 'nothing' : next) + ', so the next page is unaffected.');
        render();
      }

      function render() {
        const s = stats();
        AF.clear(serverBox);
        server.forEach(n => {
          const c = s.counts.get(n) || 0;
          let text = '#' + n;
          let tone = 'idle';
          if (c > 1) { text += ' ×' + c; tone = 'bad'; }
          else if (s.skipped.includes(n)) { text += ' never shown'; tone = 'bad'; }
          else if (c === 1) tone = 'ok';
          else if (n > s.max) { text += ' new'; tone = 'busy'; }
          serverBox.appendChild(ui.token(text, tone));
        });
        AF.clear(screenBox);
        const seen = new Set();
        const onServer = new Set(server);
        pages.forEach(p => {
          const row = h('div', { class: 'row', style: 'gap:.3rem' });
          p.rows.forEach(n => {
            let text = '#' + n;
            let tone = 'ok';
            if (seen.has(n)) { text += ' again'; tone = 'bad'; }
            else if (!onServer.has(n)) { text += ' left'; tone = 'warn'; }
            seen.add(n);
            row.appendChild(ui.token(text, tone));
          });
          screenBox.appendChild(h('div', { class: 'stack', style: 'gap:.25rem' }, label(p.head), row));
        });
        rRows.set(loadedCount());
        rDup.set(s.dup, s.dup ? 'bad' : 'ok');
        rSkip.set(s.skipped.length, s.skipped.length ? 'bad' : 'ok');
        rReq.set(requests);
        rServer.set(server.length);
        loadBtn.disabled = byOffset() ? loadedCount() >= server.length : next === null;
      }

      function reset() {
        server = [];
        for (let n = 40; n >= 1; n--) server.push(n);
        nextN = 41;
        requests = 0;
        log.clear();
        verdict.clear();
        loadFirst();
        render();
      }

      reset();
    }
  });

  // =====================================================================
  // 5. Retry policy (built, P1)
  // =====================================================================
  AF.register({
    id: 'ui-retry',
    group: 'server-state',
    order: 5,
    title: 'Retry only what can succeed',
    question: 'When a request fails, which failures should the console try again by itself, and which never?',
    status: 'built',
    slice: 'P1',
    where: [
      'web-console/src/app/queryClient.ts',
      'web-console/src/api/http.ts',
      'web-console/src/hooks/useIdempotentSubmit.ts'
    ],
    idea: [
      'A retry helps only when the next attempt can get a different answer. A dropped connection or a 503 may clear up in a second; a 404 or a 400 will be the same every time, so retrying it only makes the user wait. Retrying a write is riskier still: the first attempt may have worked even though its answer never arrived.',
      'createQueryClient() in src/app/queryClient.ts retries queries at most twice, and only on network errors (status 0) and 5xx other than 501, which means "not built". TanStack Query waits 1 s, then 2 s, between attempts. Every 4xx is shown at once.',
      'Mutations have retry: false. A failed POST shows its error with Try again, and the resubmit goes through useIdempotentSubmit with the same Idempotency-Key, so if the first attempt did reach control-api, the server replays its 202 instead of deploying again.'
    ],
    terms: [
      ['Transient error', 'One that may not happen on the next attempt: a dropped connection, a 503.'],
      ['Backoff', 'Waiting longer between successive retries: 1 s, then 2 s, then 4 s.'],
      ['At-least-once', 'What blind retries of a write give you: the work may run more than once.']
    ],
    tryIt: [
      'Choose 503, twice and press Send request: two retries, then 200, and no error on screen.',
      'Choose 404 and press Send request: one attempt and a Not found notice.',
      'Choose POST deployment and Network drop, press Send request, then Try again: one deployment, and the second answer is a replay.',
      'Turn on Retry everything three times and repeat the 404 read and the dropped POST: four attempts for the 404, two deployments for the POST.'
    ],
    breakIt: 'Retry everything and a 404 is asked four times, with 7 s of backoff in between, for the same answer, while a POST whose answer was lost runs again without a key: two deployments from one click.',
    say: 'Queries retry twice with backoff, and only on network errors and 5xx other than 501, while mutations never retry automatically; a resubmit goes through useIdempotentSubmit with the same Idempotency-Key, so a lost 202 is replayed instead of deploying twice.',
    quiz: {
      q: 'A POST /deployments gets no answer: the connection dropped. Why does the console not retry it automatically, as it would a GET?',
      options: [
        'Browsers refuse to send the same POST twice',
        'The first attempt may have created the deployment; only a resubmit with the same Idempotency-Key is safe, and that goes through useIdempotentSubmit',
        'TanStack Query has no retry option for mutations',
        'control-api rejects any second POST within 5 s'
      ],
      answer: 1,
      why: 'A lost answer does not mean lost work. TanStack Query can retry mutations, but createQueryClient() sets retry: false for them on purpose; the resubmit carries the same key, so control-api replays the stored 202 if the first attempt got through.'
    },
    mount(el, ctx) {
      const RTT = 300;
      const SLOW = 4000;
      const MODE_TEXT = {
        healthy: 'Answers every request.',
        503: 'Answers 503 with Retry-After: 5 to the first two requests, then normally.',
        404: 'Answers 404 not-found every time.',
        drop: 'Handles the first request, but its answer is lost on the way back; then normal.',
        slow: 'Answers after 4 simulated s.'
      };

      let epoch = 0;
      let running = false;
      let scen = null;
      let last = null;      // { ok, retryable, title, body }
      let countdown = 0;
      let clockMs = 0;

      const log = shortLog('Retry log');
      const verdict = stableVerdict();

      const typeC = ui.choice('Request', [{ value: 'read', label: 'Read a deployment' }, { value: 'post', label: 'POST deployment' }], 'read', () => newScenario());
      const modeC = ui.choice('Server', [
        { value: 'healthy', label: 'Healthy' },
        { value: '503', label: '503, twice' },
        { value: '404', label: '404' },
        { value: 'drop', label: 'Network drop' },
        { value: 'slow', label: 'Slow, then OK' }
      ], 'healthy', () => newScenario());
      const sendBtn = ui.button('Send request', () => submit(false), { variant: 'primary' });
      const againBtn = ui.button('Try again', () => submit(true), { disabled: true });
      const breakT = ui.toggle('Retry everything three times', false, on => {
        log.add(on ? 'Break: retry: 3 for queries and mutations, whatever the error, and the POST is sent without a key'
          : 'Fixed: queries retry only transient errors, twice; mutations never retry by themselves', on ? 'bad' : 'ok');
        newScenario();
      }, { tone: 'danger' });
      const resetBtn = ui.button('Reset', () => { log.clear(); log.add('Pick a request and a server, then press Send request.', 'muted'); newScenario(); }, { variant: 'quiet' });

      const attemptsLane = ui.lane('Attempts', 'one submission');
      const attemptsRow = h('div', { class: 'row', style: 'gap:.35rem' });
      attemptsLane.body.append(attemptsRow);
      const screenNode = liveNode('Screen: nothing sent yet', '', 'idle');
      attemptsLane.body.append(screenNode.el);
      const serverLane = ui.lane('control-api', 'simulated');
      const serverNode = liveNode('', '', null);
      const keyLine = label('');
      const depBox = h('div', { class: 'row', style: 'gap:.35rem' });
      serverLane.body.append(serverNode.el, keyLine, depBox);

      const rAttempts = ui.readout('Attempts', 0);
      const rWasted = ui.readout('Wasted retries', 0);
      const rCreated = ui.readout('Deployments created', 0);
      const rTime = ui.readout('Time to the answer', '—');

      el.append(
        controls(typeC.el, modeC.el),
        controls(sendBtn, againBtn, breakT.el, resetBtn),
        stage(cols(attemptsLane.el, serverLane.el)),
        readouts(rAttempts, rWasted, rCreated, rTime),
        verdict.el,
        log.el,
        note('Backoff is TanStack Query\'s default: 1 s, 2 s, then 4 s. Requests take 0.3 simulated s and the slow one 4 s (illustrative). 1 simulated second = 250 ms. ' + PARTIAL_INDEX_NOTE)
      );

      function serve(isPost, key) {
        scen.calls++;
        const n = scen.calls;
        const mode = modeC.get();
        const latency = mode === 'slow' ? SLOW : RTT;
        if (mode === '404') return { status: 404, latency };
        if (mode === '503' && n <= 2) return { status: 503, retryAfter: 5, latency };
        let created = false;
        let replayed = false;
        if (isPost) {
          if (key && scen.store.has(key)) replayed = true;
          else {
            scen.created++;
            created = true;
            if (key) scen.store.set(key, scen.created);
          }
        }
        const lost = mode === 'drop' && n === 1;
        return { status: lost ? 0 : (isPost ? 202 : 200), created, replayed, lost, latency };
      }

      function shouldRetry(failures, status, isPost, brk) {
        if (brk) return failures < 3;
        if (isPost) return false;
        const transient = status === 0 || (status >= 500 && status !== 501);
        return transient && failures < 2;
      }

      const STATUS_TEXT = { 0: 'no answer (status 0)', 200: '200 OK', 202: '202 Accepted', 404: '404 Not Found', 503: '503 Service Unavailable' };

      function describe(status) {
        if (status === 0) return { title: 'Cannot reach the server', body: 'The request did not reach the server. Check your connection, then try again.', retryable: true };
        if (status === 503) return { title: 'A service is unavailable', body: 'A required backing service is unavailable. Retry later.', retryable: true };
        return { title: 'Not found', body: 'It does not exist, or you do not have access to it.', retryable: false };
      }

      async function submit(again) {
        if (running) return;
        if (again && (!last || last.ok || !last.retryable || countdown > 0)) return;
        if (!again) {
          newScenario();
          AF.clear(attemptsRow);
        }
        running = true;
        const ep = epoch;
        sync();
        const isPost = typeC.get() === 'post';
        const brk = breakT.get();
        const mode = modeC.get();
        if (!again) scen.key = isPost && !brk ? uuid4() : null;
        const key = brk ? null : scen.key;
        const path = isPost ? 'POST /api/v1/deployments' : 'GET /api/v1/deployments/' + short(DEP_ID);
        if (again) {
          attemptsRow.appendChild(ui.token('Try again', 'idle'));
          log.add(stamp(clockMs) + ' You press Try again' + (isPost ? (key ? ', same Idempotency-Key ' + short(key) : ', no key') : ''), 'muted');
        }
        const t0 = clockMs;
        let failures = 0;
        let wastedNow = 0;
        let attemptsNow = 0;
        let res;
        for (;;) {
          res = serve(isPost, key);
          const no = ++scen.attemptNo;
          attemptsNow++;
          const tok = ui.token('#' + no + ' sending', 'busy');
          attemptsRow.appendChild(tok);
          log.add(stamp(clockMs) + ' #' + no + ' ' + path + (isPost ? (key ? ', Idempotency-Key ' + short(key) : ', no key') : ''), 'busy');
          renderServer();
          await simSleep(ctx, res.latency);
          if (!ctx.alive || ep !== epoch) return;
          clockMs += res.latency;
          const okNow = res.status === 200 || res.status === 202;
          tok.textContent = '#' + no + ' ' + (res.replayed ? '202 replayed' : STATUS_TEXT[res.status]);
          AF.tone(tok, okNow ? 'ok' : 'bad');
          log.add(stamp(clockMs) + ' #' + no + ' ' + (res.lost ? 'control-api handled it, but the answer was lost: ApiError type network' :
            res.replayed ? '202 replayed, Idempotent-Replayed: true' : STATUS_TEXT[res.status] + (res.retryAfter ? ', Retry-After: ' + res.retryAfter : '')), okNow ? 'ok' : 'bad');
          if (okNow) break;
          if (!shouldRetry(failures, res.status, isPost, brk)) break;
          const transient = res.status === 0 || (res.status >= 500 && res.status !== 501);
          if (!transient) wastedNow++;
          const d = Math.min(1000 * Math.pow(2, failures), 30000);
          failures++;
          attemptsRow.appendChild(ui.token('wait ' + d / 1000 + ' s', 'idle'));
          log.add(stamp(clockMs) + ' retry ' + failures + ' after ' + d / 1000 + ' s' + (transient ? '' : ': this error will not change'), transient ? 'muted' : 'warn');
          await simSleep(ctx, d);
          if (!ctx.alive || ep !== epoch) return;
          clockMs += d;
        }
        scen.attempts += attemptsNow;
        scen.wasted += wastedNow;
        const ok = res.status === 200 || res.status === 202;
        if (ok) {
          last = { ok: true };
          if (isPost) screenNode.set('Screen: Accepted, PENDING', res.replayed ? 'the replayed 202 names the first deployment' : 'deployment #' + scen.created + ', Follow progress', 'ok');
          else screenNode.set('Screen: deployment DEPLOYING', 'loaded after ' + sec(clockMs - t0), 'ok');
        } else {
          const d = describe(res.status);
          last = { ok: false, retryable: d.retryable };
          screenNode.set('Screen: ' + d.title, d.body, d.retryable ? 'warn' : 'bad');
          if (res.status === 503 && res.retryAfter) countdown = res.retryAfter;
        }
        rTime.set(sec(clockMs - t0));
        running = false;
        renderServer();
        sync();
        judge({ isPost, mode, brk, ok, again, replayed: !!res.replayed, attempts: attemptsNow, wasted: wastedNow, took: clockMs - t0, created: scen.created, total: scen.attemptNo });
      }

      function judge(c) {
        if (!c.isPost) {
          if (c.mode === '404') {
            if (c.brk) verdict.set('bad', c.attempts + ' attempts and ' + c.wasted + ' wasted retries: a 404 comes back the same every time, and the user waited ' + sec(c.took) + ' for it.');
            else verdict.set('ok', 'One attempt. A 404 is an answer, not a glitch, so it is not retried: the screen says Not found at once.');
          } else if (c.mode === '503') {
            verdict.set('ok', 'Two 503s, retried after 1 s and then 2 s; the third attempt got 200. The screen showed loading, never an error.' + (c.brk ? ' Retrying a 5xx is right in both settings.' : ''));
          } else if (c.mode === 'drop') {
            verdict.set('ok', 'The connection dropped (status 0, ApiError type network), and one retry after 1 s got the data. A read changes nothing, so retrying it is safe.');
          } else if (c.mode === 'slow') {
            verdict.set('ok', 'Slow is not failed: one attempt that took 4 s, and no retry. The screen showed loading meanwhile.');
          } else {
            verdict.set('ok', 'One attempt, 200. Nothing to retry.');
          }
          return;
        }
        if (c.created > 1) {
          verdict.set('bad', c.created + ' deployments from one submission: ' + (c.mode === 'drop' && !c.again
            ? 'the first attempt was created, its 202 was lost, and the automatic retry, with no key, created another.'
            : 'every attempt without a key is a new request to control-api.'));
          return;
        }
        if (c.brk) {
          if (c.mode === '404') verdict.set('bad', c.attempts + ' attempts at a POST that could never succeed, ' + c.wasted + ' of them wasted.');
          else if (c.mode === '503') verdict.set('warn', c.attempts + ' attempts, retried automatically with no key, and one deployment. It went well only because a 503 here meant nothing ran; after a lost answer the client cannot know that.');
          else verdict.set('ok', 'One attempt: nothing failed, so the retry setting made no difference this time.');
          return;
        }
        if (!c.ok) {
          if (c.mode === '503') verdict.set('warn', 'Attempt ' + c.total + ': 503 with Retry-After: 5. Mutations never retry by themselves: the notice counts down, then Try again resends the same Idempotency-Key.');
          else if (c.mode === 'drop') verdict.set('warn', 'control-api created the deployment, but the 202 was lost on the way back. The screen says Cannot reach the server and offers Try again.');
          else verdict.set('ok', 'One attempt and a Not found notice. Mutations never retry on their own, and this one could not succeed anyway.');
          return;
        }
        if (c.replayed) verdict.set('ok', 'Try again sent the same Idempotency-Key, so control-api replayed the first 202 (Idempotent-Replayed: true). Still one deployment.');
        else if (c.again) verdict.set('ok', 'Accepted on Try again, with the same key: one deployment.');
        else if (c.mode === 'slow') verdict.set('ok', 'One attempt, accepted after 4 s. Nothing failed, so nothing was retried.');
        else verdict.set('ok', '202 Accepted on the first attempt: one deployment.');
      }

      function renderServer() {
        const isPost = typeC.get() === 'post';
        serverNode.set('Server: ' + modeC.el.querySelector('[aria-pressed="true"]').textContent, MODE_TEXT[modeC.get()], null);
        if (!isPost) keyLine.textContent = 'A read changes nothing on the server.';
        else if (breakT.get()) keyLine.textContent = 'No Idempotency-Key sent.';
        else keyLine.textContent = scen.key ? 'Idempotency-Key ' + short(scen.key) + (scen.store.has(scen.key) ? ', stored with its 202' : '') : 'A key is made when you press Send request.';
        AF.clear(depBox);
        for (let i = 1; i <= scen.created; i++) depBox.appendChild(ui.token('deployment #' + i + (i > 1 ? ' duplicate' : ''), i > 1 ? 'bad' : 'ok'));
        if (isPost && !scen.created) depBox.appendChild(label('No deployments yet.'));
        rAttempts.set(scen.attempts);
        rWasted.set(scen.wasted, scen.wasted ? 'bad' : null);
        rCreated.set(isPost ? scen.created : '—', scen.created > 1 ? 'bad' : null);
      }

      function sync() {
        sendBtn.disabled = running;
        const canAgain = !running && last && !last.ok && last.retryable;
        againBtn.disabled = !canAgain || countdown > 0;
        againBtn.textContent = canAgain && countdown > 0 ? 'Try again in ' + countdown + ' s' : 'Try again';
      }

      function newScenario() {
        epoch++;
        running = false;
        scen = { calls: 0, attemptNo: 0, created: 0, store: new Map(), key: null, attempts: 0, wasted: 0 };
        last = null;
        countdown = 0;
        clockMs = 0;
        AF.clear(attemptsRow);
        attemptsRow.appendChild(label('Press Send request.'));
        screenNode.set('Screen: nothing sent yet', '', 'idle');
        rTime.set('—');
        verdict.clear();
        renderServer();
        sync();
      }

      ctx.interval(() => {
        if (countdown > 0) {
          countdown--;
          sync();
        }
      }, SIM_MS);

      log.add('Pick a request and a server, then press Send request.', 'muted');
      newScenario();
    }
  });

  // =====================================================================
  // 6. The fetch wrapper (built, P1)
  // =====================================================================
  AF.register({
    id: 'ui-fetch-wrapper',
    group: 'api',
    order: 1,
    title: 'One fetch wrapper',
    question: 'How do you make sure every request carries the right headers and every failure arrives in one readable shape?',
    status: 'built',
    slice: 'P1',
    where: [
      'web-console/src/api/http.ts',
      'web-console/src/api/control.ts',
      'web-console/src/components/Feedback.tsx',
      'control-api/src/main/java/io/appfleet/control/web/CorrelationIdFilter.java'
    ],
    idea: [
      'If every screen called fetch itself, each would have to remember the same rules: headers, the base URL, JSON, and what a failed request looks like. Put one function in front of fetch and every request goes through it, so the rules hold everywhere and no screen can forget one.',
      'requestRaw in src/api/http.ts is the only call to fetch in the console. It sends a fresh X-Correlation-Id on every request and keeps the value the server echoes, adds Idempotency-Key when given, builds an absolute URL and sends JSON. request() returns just the data; api/control.ts and the other per-service files are thin wrappers around the two.',
      'A request that never reaches the server becomes ApiError with type network and status 0. Any non-2xx becomes ApiError with the ProblemDetail slug, or a slug derived from the status when the body is not JSON. ErrorNotice in Feedback.tsx shows the correlation id with Copy and Find in audit trail.'
    ],
    terms: [
      ['Correlation id', 'A random id sent with a request and logged by every service that handles it, so one search finds every step.'],
      ['ApiError', 'The one error type screens receive: status, type (the slug), title, detail, correlationId, errors, retryAfter.'],
      ['Echo', 'control-api\'s CorrelationIdFilter returns the id in the response, or makes one up when none was sent.']
    ],
    tryIt: [
      'Pick Deploy 2.4.0 to qa: the request has X-Correlation-Id and Idempotency-Key, and the screen gets the body plus the Location header.',
      'Pick Roll back while DEPLOYING: a 409 becomes ApiError illegal-transition, and the notice links the correlation id to the audit trail.',
      'Pick Load while offline, then Malformed URL: both still arrive as ApiError, network and malformed-request.',
      'Turn on Call fetch directly in the screen and pick each action again. Press Send to repeat one with a new id.'
    ],
    breakIt: 'Call fetch in the screen and the request goes out without a correlation id, a 409 is read as success, and an offline or HTML answer reaches the user as TypeError: Failed to fetch or a JSON SyntaxError, with no audit link to follow.',
    say: 'requestRaw in http.ts is the only call to fetch: it sends a fresh X-Correlation-Id on every request, adds the Idempotency-Key when given, and turns every failure, network or non-2xx, into one ApiError carrying the ProblemDetail slug and the correlation id.',
    quiz: {
      q: 'The server sends an HTML error page with status 400 instead of a ProblemDetail. What does the screen get from http.ts?',
      options: [
        'A SyntaxError from parsing the HTML as JSON',
        'The HTML as data, because the server did answer',
        'ApiError with type malformed-request, derived from the status, carrying the correlation id that was sent',
        'Nothing: the request is retried until a JSON answer arrives'
      ],
      answer: 2,
      why: 'toApiError() parses the body only when Content-Type says JSON. Otherwise slugForStatus(400) gives malformed-request, and with no X-Correlation-Id header in the answer, the id the wrapper sent is kept.'
    },
    mount(el, ctx) {
      const ORIGIN = 'http://localhost:5173';
      const BODY = '{"applicationId":"' + short(APP_ID) + '","releaseId":"0192f3a1-6a9b…","environment":"qa"}';
      const ACTIONS = {
        load: { method: 'GET', path: '/api/v1/deployments/' + short(DEP_ID) },
        deploy: { method: 'POST', path: '/api/v1/deployments', body: BODY, key: true },
        rollback: { method: 'POST', path: '/api/v1/deployments/' + short(DEP_ID) + '/rollback' },
        offline: { method: 'GET', path: '/api/v1/deployments/' + short(DEP_ID), offline: true },
        html: { method: 'GET', path: '/api/v1/deployments/%zz' }
      };
      let requests = 0;

      const actionC = ui.choice('Screen action', [
        { value: 'load', label: 'Load deployment' },
        { value: 'deploy', label: 'Deploy 2.4.0 to qa' },
        { value: 'rollback', label: 'Roll back while DEPLOYING' },
        { value: 'offline', label: 'Load while offline' },
        { value: 'html', label: 'Malformed URL' }
      ], 'deploy', () => send());
      const sendBtn = ui.button('Send', () => send(), { variant: 'primary' });
      const directT = ui.toggle('Call fetch directly in the screen', false, () => send(), { tone: 'danger' });

      const screenCode = ui.code('', 'Screen code');
      const reqCode = ui.code('', 'Request leaving the browser');
      const resCode = ui.code('', 'Response');
      const logCode = ui.code('', 'control-api log');
      const resultCode = ui.code('', 'What the screen receives');
      const noticeTitle = h('b', null, '');
      const noticeBody = h('span', { class: 'node-sub' }, '');
      const noticeCid = h('div', { class: 'row', style: 'gap:.4rem;margin-top:.35rem' });
      const notice = h('div', { class: 'node' }, noticeTitle, noticeBody, noticeCid);

      const rCid = ui.readout('X-Correlation-Id', '—');
      const rGot = ui.readout('Screen receives', '—');
      const rAudit = ui.readout('Audit link', '—');
      const rReq = ui.readout('Requests', 0);
      const verdict = stableVerdict();

      el.append(
        controls(actionC.el),
        controls(sendBtn, directT.el),
        stage(cols(ui.panel('Screen code', screenCode), ui.panel('Request leaving the browser', reqCode))),
        cols(ui.panel('Response', resCode, logCode), ui.panel('What the screen receives', resultCode, notice)),
        readouts(rCid, rGot, rAudit, rReq),
        verdict.el,
        note('Ids are random on every send; deployment and task ids are shortened here. http://localhost:5173 is the Vite dev server. Tomcat\'s HTML page is shortened; it answers before control-api\'s filters run, so that answer carries no correlation id.')
      );

      function send() {
        const a = actionC.get();
        const A = ACTIONS[a];
        const direct = directT.get();
        const cid = uuid4();
        const serverCid = uuid4();
        const key = uuid4();
        requests++;

        // 1. the code in the screen
        let screen;
        if (!direct) {
          screen = {
            load: 'const deployment = await getDeployment(id);\n// api/control.ts: request(`/api/v1/deployments/${id}`)',
            deploy: 'const { idempotencyKey } = useIdempotentSubmit(inputsKey);\nconst result = await requestDeployment(body, idempotencyKey);',
            rollback: 'await requestRollback(id);\n// api/control.ts: request(`…/${id}/rollback`, { method: \'POST\' })',
            offline: 'const deployment = await getDeployment(id);',
            html: 'const deployment = await getDeployment(idFromUrl);\n// idFromUrl came from a pasted link: \'%zz\''
          }[a];
        } else {
          screen = {
            load: 'const res = await fetch(\'/api/v1/deployments/\' + id);\nconst deployment = await res.json();',
            deploy: 'const res = await fetch(\'/api/v1/deployments\', {\n  method: \'POST\',\n  headers: { \'Content-Type\': \'application/json\' },\n  body: JSON.stringify(body),\n});\nconst result = await res.json();',
            rollback: 'const res = await fetch(\'/api/v1/deployments/\' + id + \'/rollback\',\n  { method: \'POST\' });\nconst result = await res.json();',
            offline: 'const res = await fetch(\'/api/v1/deployments/\' + id);\nconst deployment = await res.json();',
            html: 'const res = await fetch(\'/api/v1/deployments/\' + idFromUrl);\nconst deployment = await res.json();'
          }[a];
        }
        setCode(screenCode, screen);

        // 2. the request
        const lines = [];
        if (!direct) {
          lines.push(A.method + ' ' + ORIGIN + A.path, 'Accept: application/json, application/problem+json', 'X-Correlation-Id: ' + cid);
          if (A.body) lines.push('Content-Type: application/json');
          if (A.key) lines.push('Idempotency-Key: ' + key);
        } else {
          lines.push(A.method + ' ' + A.path, '# relative URL: fine in the browser, throws in Node tests');
          if (A.body) lines.push('Content-Type: application/json');
          lines.push('# no X-Correlation-Id' + (A.key ? ', no Idempotency-Key' : ''));
        }
        if (A.body) lines.push('', A.body);
        setCode(reqCode, lines.join('\n'));

        // 3. the response and the server log
        const echo = direct ? serverCid : cid;
        let res;
        let logLine;
        if (A.offline) {
          res = '(no response: the request never left the machine)';
          logLine = '(nothing: the request never arrived)';
        } else if (a === 'html') {
          res = 'HTTP/1.1 400 Bad Request\nContent-Type: text/html;charset=utf-8\n\n<!doctype html><html lang="en"><head><title>HTTP Status 400 – Bad Request</title>…';
          logLine = '(no line with a correlation id: Tomcat rejected the URL before any filter ran)';
        } else if (a === 'rollback') {
          res = 'HTTP/1.1 409 Conflict\nContent-Type: application/problem+json\nX-Correlation-Id: ' + echo + '\n\n' + JSON.stringify({
            type: 'urn:appfleet:problem:illegal-transition', title: 'Illegal state transition', status: 409,
            detail: 'Cannot roll back a deployment in state DEPLOYING.', correlationId: echo
          }, null, 2);
          logLine = '[correlationId=' + echo + '] POST …/' + short(DEP_ID) + '/rollback 409';
        } else if (a === 'deploy') {
          res = 'HTTP/1.1 202 Accepted\nContent-Type: application/json\nX-Correlation-Id: ' + echo + '\nLocation: /api/v1/tasks/' + short(TASK_ID) +
            '\nIdempotent-Replayed: false\n\n{"deploymentId":"' + short(DEP_ID) + '","taskId":"' + short(TASK_ID) + '","status":"PENDING"}';
          logLine = '[correlationId=' + echo + '] POST /api/v1/deployments 202';
        } else {
          res = 'HTTP/1.1 200 OK\nContent-Type: application/json\nX-Correlation-Id: ' + echo + '\n\n{"id":"' + short(DEP_ID) + '","environment":"qa","status":"DEPLOYING",…}';
          logLine = '[correlationId=' + echo + '] GET /api/v1/deployments/' + short(DEP_ID) + ' 200';
        }
        setCode(resCode, res);
        setCode(logCode, 'control-api log\n' + logLine + (direct && !A.offline && a !== 'html' ? '\n# this id was made up by CorrelationIdFilter; the screen never reads it' : ''));

        // 4. what the screen receives, and the notice
        let result;
        let got;
        let audit;
        let n = null;          // notice: [title, body, tone, cidShown]
        let tone;
        let text;
        if (!direct) {
          if (a === 'load') {
            result = 'getDeployment() resolves to\n{ id: \'' + short(DEP_ID) + '\', environment: \'qa\', status: \'DEPLOYING\', … }';
            got = ['Data', 'ok'];
            audit = ['Not needed', null];
            n = ['Deployment DEPLOYING', 'Loaded.', 'ok', false];
            tone = 'ok';
            text = 'One request, one fresh X-Correlation-Id, and plain data back. The screen never touched fetch.';
          } else if (a === 'deploy') {
            result = 'requestDeployment() resolves to\n{\n  accepted: { deploymentId: \'' + short(DEP_ID) + '\', taskId: \'' + short(TASK_ID) + '\', status: \'PENDING\' },\n  location: \'/api/v1/tasks/' + short(TASK_ID) + '\',\n  replayed: false\n}';
            got = ['Data and headers', 'ok'];
            audit = ['Not needed', null];
            n = ['Accepted: PENDING', 'Follow progress.', 'ok', false];
            tone = 'ok';
            text = 'The wrapper added X-Correlation-Id and the Idempotency-Key, and requestDeployment() handed back the body plus the Location and Idempotent-Replayed headers.';
          } else if (a === 'rollback') {
            result = 'requestRollback() throws\nApiError {\n  status: 409,\n  type: \'illegal-transition\',\n  title: \'Illegal state transition\',\n  detail: \'Cannot roll back a deployment in state DEPLOYING.\',\n  correlationId: \'' + cid + '\',\n  retryAfter: null\n}';
            got = ['ApiError illegal-transition', 'ok'];
            audit = ['Shown', 'ok'];
            n = ['Not possible in the current state', 'Cannot roll back a deployment in state DEPLOYING. Refresh to see the current state.', 'warn', true];
            tone = 'ok';
            text = 'A 409 became ApiError with type illegal-transition, so the notice offers Refresh and links the correlation id to the audit trail.';
          } else if (a === 'offline') {
            result = 'getDeployment() throws\nApiError {\n  status: 0,\n  type: \'network\',\n  title: \'Cannot reach the server\',\n  detail: \'The request did not reach the server. Check your connection, then try again.\',\n  correlationId: \'' + cid + '\'\n}';
            got = ['ApiError network', 'ok'];
            audit = ['Shown', 'ok'];
            n = ['Cannot reach the server', 'The request did not reach the server. Check your connection, then try again.', 'warn', true];
            tone = 'ok';
            text = 'No response at all still arrives as ApiError, type network, status 0, carrying the correlation id that was sent.';
          } else {
            result = 'getDeployment() throws\nApiError {\n  status: 400,\n  type: \'malformed-request\',\n  title: \'Bad Request\',\n  detail: \'The server answered 400 without an error body.\',\n  correlationId: \'' + cid + '\'\n}';
            got = ['ApiError malformed-request', 'ok'];
            audit = ['Shown', 'ok'];
            n = ['The request could not be understood', 'This is a fault in the console, not in your input. Report it with the correlation id below.', 'warn', true];
            tone = 'ok';
            text = 'No ProblemDetail, so http.ts derived the slug from the status: malformed-request. The correlation id is the one it sent, since Tomcat answered before control-api\'s filter.';
          }
        } else if (a === 'load') {
          result = '{ id: \'' + short(DEP_ID) + '\', environment: \'qa\', status: \'DEPLOYING\', … }';
          got = ['Data', null];
          audit = ['Nothing to link', 'bad'];
          n = ['Deployment DEPLOYING', 'Loaded.', 'ok', false];
          tone = 'warn';
          text = 'It worked, but the request carried no correlation id: control-api made one up and the screen never read it, so nobody can find this request in the logs from the screen.';
        } else if (a === 'deploy') {
          result = '{ deploymentId: \'' + short(DEP_ID) + '\', taskId: \'' + short(TASK_ID) + '\', status: \'PENDING\' }\n// Location and Idempotent-Replayed are never read';
          got = ['Data, no headers', 'warn'];
          audit = ['Nothing to link', 'bad'];
          n = ['Accepted: PENDING', 'Follow progress.', 'ok', false];
          tone = 'bad';
          text = 'Accepted, but without an Idempotency-Key: a double click or a retry would deploy twice. The Location header was ignored too.';
        } else if (a === 'rollback') {
          result = '{ type: \'urn:appfleet:problem:illegal-transition\',\n  title: \'Illegal state transition\', status: 409, … }\n// read as success: res.ok was never checked';
          got = ['Problem read as data', 'bad'];
          audit = ['Missing', 'bad'];
          n = ['Rollback requested', 'Task undefined.', 'ok', false];
          tone = 'bad';
          text = 'The 409 body was read as if it were the answer: the screen says Rollback requested, task undefined. Nothing was rolled back.';
        } else if (a === 'offline') {
          result = 'TypeError: Failed to fetch';
          got = ['TypeError', 'bad'];
          audit = ['Missing', 'bad'];
          n = ['Something went wrong', 'TypeError: Failed to fetch', 'bad', false];
          tone = 'bad';
          text = 'The user sees TypeError: Failed to fetch, with no correlation id and no audit link.';
        } else {
          result = 'SyntaxError: Unexpected token \'<\', "<!doctype "... is not valid JSON';
          got = ['SyntaxError', 'bad'];
          audit = ['Missing', 'bad'];
          n = ['Something went wrong', 'SyntaxError: Unexpected token \'<\', "<!doctype "... is not valid JSON', 'bad', false];
          tone = 'bad';
          text = 'Parsing HTML as JSON threw a SyntaxError, and that is what the user sees. No slug, no correlation id.';
        }
        setCode(resultCode, result);
        noticeTitle.textContent = n[0];
        noticeBody.textContent = n[1];
        AF.tone(notice, n[2]);
        AF.clear(noticeCid);
        if (n[3]) noticeCid.append(ui.token('Correlation id ' + short(cid)), label('Copy · Find in audit trail'));
        rCid.set(direct ? 'Not sent' : 'Sent, fresh', direct ? 'bad' : 'ok');
        rGot.set(got[0], got[1]);
        rAudit.set(audit[0], audit[1]);
        rReq.set(requests);
        verdict.set(tone, text);
      }

      send();
    }
  });

  // =====================================================================
  // 7. ProblemDetail and the slug (built, P1)
  // =====================================================================
  AF.register({
    id: 'ui-problem',
    group: 'api',
    order: 2,
    title: 'One error shape, switched on its slug',
    question: 'How does the screen decide what to show for an error without depending on the wording of the message?',
    status: 'built',
    slice: 'P1',
    where: [
      'web-console/src/lib/errorText.ts',
      'web-console/src/components/Feedback.tsx',
      'web-console/src/features/deployments/RollbackOutcome.tsx',
      'control-api/src/main/java/io/appfleet/control/web/ApiExceptionHandler.java'
    ],
    idea: [
      'Every Appfleet service answers errors as an RFC 7807 ProblemDetail: type urn:appfleet:problem:<slug>, title, status, detail, correlationId, and errors for field problems. The slug is a contract meant for code; the detail is prose meant for people, and may be reworded in any release.',
      'http.ts strips the prefix, so ApiError.type is the slug. describeError() in src/lib/errorText.ts gives each slug one treatment: validation-failed maps errors[] onto fields; conflict, illegal-transition and concurrent-modification offer Refresh; request-in-progress, rate-limited and service-unavailable wait for Retry-After; not-implemented marks a hybrid-mode gap.',
      'ErrorNotice in Feedback.tsx renders that description, counts Retry-After down with useCountdown before enabling Try again, and always shows the correlation id with Copy and Find in audit trail. A screen that needs more checks the slug itself: RollbackOutcome.tsx uses error.is(\'conflict\', \'illegal-transition\', \'concurrent-modification\').'
    ],
    terms: [
      ['ProblemDetail', 'The RFC 7807 error body every Appfleet service returns.'],
      ['Slug', 'The last part of type, such as conflict: stable, and meant for code.'],
      ['Retry-After', 'A response header with the seconds to wait before trying again.']
    ],
    tryIt: [
      'Pick several server answers and compare the notices: Refresh for the 409s, a countdown for request-in-progress, rate-limited and service-unavailable, marked fields for validation-failed.',
      'Turn on Server rewords its message: titles and actions stay the same; only body text that quotes the detail changes.',
      'Turn on Switch on the message text: everything still works until Server rewords its message is also on, and then every answer falls back to Something went wrong.'
    ],
    breakIt: 'Switch on the message text and the screen works only until someone rewords a sentence in the backend: then a conflict loses its Refresh, a 503 loses its countdown and field errors stop landing on fields, with no compiler or test to warn you.',
    say: 'Every error is a ProblemDetail whose type ends in a slug, and the console switches on ApiError.type through describeError, never on the detail text, so a reworded message changes what the user reads but not what the screen does.',
    quiz: {
      q: 'control-api rewrites the detail of its 409 conflict as a clearer sentence. What changes in the console?',
      options: [
        'Only the body text of the notice; its title, the Refresh action and the correlation id line stay, because the screen switches on the slug',
        'Nothing at all, because the console never shows the detail',
        'The notice falls back to Something went wrong until the console is updated',
        'The request is retried, because the error is no longer recognised'
      ],
      answer: 0,
      why: 'describeError shows the detail as the body for conflict, so the new sentence appears, but the treatment is chosen by error.type. Only code that matched on the old wording would break.'
    },
    mount(el, ctx) {
      const ANSWERS = [
        { slug: 'validation-failed', status: 400, reason: 'Bad Request', title: 'Validation failed', detail: 'One or more fields are invalid.', reworded: 'Check the highlighted fields and send again.', phrase: 'fields are invalid',
          errors: [{ field: 'environment', message: 'must not be blank' }, { field: 'releaseId', message: 'must not be null' }] },
        { slug: 'malformed-request', status: 400, reason: 'Bad Request', title: 'Bad Request', detail: 'Failed to read request', reworded: 'The request body could not be parsed.', phrase: 'Failed to read request' },
        { slug: 'unprocessable', status: 422, reason: 'Unprocessable Content', title: 'Unprocessable request', detail: 'Release 0192f3a1… does not belong to application billing-api.', reworded: 'billing-api has no release with id 0192f3a1….', phrase: 'does not belong to' },
        { slug: 'not-found', status: 404, reason: 'Not Found', title: 'Not found', detail: 'Deployment 0192f3a1… not found.', reworded: 'No deployment with id 0192f3a1… exists.', phrase: 'not found' },
        { slug: 'forbidden', status: 403, reason: 'Forbidden', title: 'Forbidden', detail: 'Deploying billing-api needs DEPLOYER on Payments.', reworded: 'You need the DEPLOYER role on Payments to deploy billing-api.', phrase: 'needs DEPLOYER' },
        { slug: 'illegal-transition', status: 409, reason: 'Conflict', title: 'Illegal state transition', detail: 'Cannot roll back a deployment in state DEPLOYING.', reworded: 'A deployment in state DEPLOYING cannot be rolled back yet.', phrase: 'Cannot roll back' },
        { slug: 'conflict', status: 409, reason: 'Conflict', title: 'Conflict', detail: 'billing-api already has an active deployment in qa (2.3.1, HEALTHY). Only one deployment per application and environment can be active.', reworded: 'Only one active deployment per application and environment: billing-api 2.3.1 is still active in qa.', phrase: 'already has an active deployment' },
        { slug: 'concurrent-modification', status: 409, reason: 'Conflict', title: 'Concurrent modification', detail: 'The resource was changed by another request. Re-read it and retry if still appropriate.', reworded: 'Another request updated this resource first. Read it again before retrying.', phrase: 'changed by another request' },
        { slug: 'request-in-progress', status: 409, reason: 'Conflict', title: 'Request in progress', detail: 'A request with this Idempotency-Key is still being processed. Retry shortly to get its result.', reworded: 'Your earlier request with this key has not finished yet.', phrase: 'still being processed', retryAfter: 1 },
        { slug: 'idempotency-key-reused', status: 422, reason: 'Unprocessable Content', title: 'Idempotency key reused', detail: 'This Idempotency-Key was already used with a different request body. Use a new key for a different request.', reworded: 'That key belongs to a different request. Send this one with a new key.', phrase: 'already used with a different request body' },
        { slug: 'rate-limited', status: 429, reason: 'Too Many Requests', title: 'Too many requests', detail: 'Rate limit exceeded for team Payments.', reworded: 'Payments has used its request allowance for now.', phrase: 'Rate limit exceeded', retryAfter: 12 },
        { slug: 'service-unavailable', status: 503, reason: 'Service Unavailable', title: 'Service unavailable', detail: 'A required backing service is unavailable. Retry later.', reworded: 'Redis cannot be reached right now. Retry later.', phrase: 'backing service is unavailable', retryAfter: 5 },
        { slug: 'not-implemented', status: 501, reason: 'Not Implemented', title: 'Not implemented', detail: 'GET /api/v1/environments (gap 2) is not built yet. See docs/design/ux/web-console-react-plan.md §10.1.', reworded: 'control-api has no GET /api/v1/environments yet (gap 2).', phrase: 'is not built yet' }
      ];
      const bySlug = s => ANSWERS.find(a => a.slug === s);
      const TREAT = {
        'validation-failed': ['Mark the fields, focus the first', 'fields'],
        'malformed-request': ['Generic notice; report it with the id', null],
        unprocessable: ['Inline warning with the detail', null],
        'not-found': ['Not found page, or an inline notice', null],
        forbidden: ['Not allowed notice', null],
        'illegal-transition': ['Warning with Refresh', 'refresh'],
        conflict: ['Warning with Refresh', 'refresh'],
        'concurrent-modification': ['Warning with Refresh', 'refresh'],
        'request-in-progress': ['Retry once after Retry-After, same key', 'auto'],
        'idempotency-key-reused': ['New key, then submit again', 'renew'],
        'rate-limited': ['Disable submit, count down', 'rate'],
        'service-unavailable': ['Try again after Retry-After', 'retry'],
        'not-implemented': ['Not built yet notice', null]
      };

      let left = 0;
      let current = null;   // { a, matched, d, cid }
      let actionDone = false;
      const verdict = stableVerdict();
      // What the last notice action did: one polite status line instead of a log.
      const actionNote = h('p', { class: 'small muted', 'aria-live': 'polite' }, '');
      const log = {
        add: text => { actionNote.textContent = text; },
        clear: () => { actionNote.textContent = ''; }
      };

      const answerC = ui.choice('Server answer', ANSWERS.map(a => ({ value: a.slug, label: a.status + ' ' + a.slug })), 'conflict', () => show());
      const rewordT = ui.toggle('Server rewords its message', false, () => show());
      const textT = ui.toggle('Switch on the message text', false, () => show(), { tone: 'danger' });

      const resCode = ui.code('', 'Response');
      const errCode = ui.code('', 'ApiError');
      const screenCode = ui.code('', 'Screen code');
      const noticeTitle = h('b', null, '');
      const noticeBody = h('span', { class: 'node-sub', style: 'white-space:pre-line' }, '');
      const fieldsBox = h('div', { class: 'stack', style: 'gap:.3rem;margin-top:.4rem' });
      const actionsBox = h('div', { class: 'row', style: 'gap:.4rem;margin-top:.4rem' });
      const cidBox = h('div', { class: 'row', style: 'gap:.4rem;margin-top:.35rem' });
      const notice = h('div', { class: 'node' }, noticeTitle, noticeBody, fieldsBox, actionsBox, cidBox);

      const rType = ui.readout('ApiError.type', '—');
      const rTreat = ui.readout('Treatment', '—');
      const rRetry = ui.readout('Retry in', '—');
      const rCid = ui.readout('Correlation id', '—');

      el.append(
        controls(answerC.el),
        controls(rewordT.el, textT.el),
        stage(cols(ui.panel('Response', resCode), ui.panel('ApiError', errCode), ui.panel('What the console shows', notice, actionNote))),
        readouts(rType, rTreat, rRetry, rCid),
        verdict.el,
        details('The screen code that chooses the treatment', screenCode),
        note('Titles and details follow ApiExceptionHandler and the mock. forbidden (S4) is not built in control-api yet. rate-limited is built (S3.6), but its text here and the 12 s Retry-After are illustrative: the real answer has no team name and Retry-After is 1 s with the defaults. Countdowns: 1 simulated second = 250 ms.')
      );

      function describe(a, detail) {
        switch (a.slug) {
          case 'validation-failed': return { title: 'Some fields need fixing', body: a.errors.map(e => e.field + ': ' + e.message).join(' ') };
          case 'malformed-request': return { title: 'The request could not be understood', body: 'This is a fault in the console, not in your input. Report it with the correlation id below.' };
          case 'unprocessable': return { title: 'The request was refused', body: detail };
          case 'not-found': return { title: 'Not found', body: 'It does not exist, or you do not have access to it.' };
          case 'forbidden': return { title: 'Not allowed', body: detail };
          case 'illegal-transition': return { title: 'Not possible in the current state', body: detail + ' Refresh to see the current state.' };
          case 'concurrent-modification': return { title: 'Someone else changed this first', body: 'Refresh to see their change, then decide again.' };
          case 'conflict': return { title: 'Conflicts with the current state', body: detail };
          case 'request-in-progress': return { title: 'Still working on your earlier request', body: 'The same request is being processed. Its result will show shortly.' };
          case 'idempotency-key-reused': return { title: 'The request changed while it was being sent', body: 'Submit again; the console will send it as a new request.' };
          case 'rate-limited': return { title: 'Too many requests', body: 'Your team has used its request allowance for the moment.' };
          case 'service-unavailable': return { title: 'A service is unavailable', body: detail };
          default: return { title: 'Not built yet', body: detail };
        }
      }

      function show() {
        const a = bySlug(answerC.get());
        const detail = rewordT.get() ? a.reworded : a.detail;
        const cid = 'c-' + hexChars(8);
        const byText = textT.get();
        const matched = !byText || detail.includes(a.phrase);
        const d = matched ? describe(a, detail) : { title: 'Something went wrong', body: detail };
        const action = matched ? TREAT[a.slug][1] : null;
        current = { a, d, action, cid, matched };
        left = matched && a.retryAfter ? a.retryAfter : 0;
        actionDone = false;
        log.clear();

        const body = { type: 'urn:appfleet:problem:' + a.slug, title: a.title, status: a.status, detail, instance: '/api/v1/deployments', correlationId: cid };
        if (a.errors) body.errors = a.errors;
        setCode(resCode, 'HTTP/1.1 ' + a.status + ' ' + a.reason + '\nContent-Type: application/problem+json\nX-Correlation-Id: ' + cid +
          (a.retryAfter ? '\nRetry-After: ' + a.retryAfter : '') + '\n\n' + JSON.stringify(body, null, 2));
        setCode(errCode, 'ApiError {\n  status: ' + a.status + ',\n  type: \'' + a.slug + '\',\n  title: \'' + a.title + '\',\n  detail: \'' + detail + '\',\n  correlationId: \'' + cid + '\',\n  retryAfter: ' + (a.retryAfter || 'null') +
          (a.errors ? ',\n  errors: [' + a.errors.map(e => '{ field: \'' + e.field + '\', … }').join(', ') + ']' : '') + '\n}');
        if (byText) {
          setCode(screenCode, ['// The screen, switching on the message text',
            'const m = error.message;',
            "if (m.includes('already has an active deployment')) showRefresh();",
            "else if (m.includes('Cannot roll back')) showRefresh();",
            "else if (m.includes('backing service is unavailable')) showRetry();",
            '// … one line per sentence the backend happens to use',
            'else showGeneric();',
            '',
            "// For this answer: m.includes('" + a.phrase + "') is " + detail.includes(a.phrase)].join('\n'));
        } else {
          setCode(screenCode, ['// lib/errorText.ts: one treatment per slug',
            'switch (error.type) {',
            "  case 'validation-failed': …        // fields",
            "  case 'conflict': …                 // Refresh",
            "  case 'service-unavailable': …      // Retry-After",
            '  …',
            '}',
            '',
            "// For this answer: error.type is '" + a.slug + "'"].join('\n'));
        }

        noticeTitle.textContent = d.title;
        noticeBody.textContent = d.body;
        AF.tone(notice, 'warn');
        AF.clear(fieldsBox);
        if (matched && a.slug === 'validation-failed') {
          a.errors.forEach((e, i) => {
            const f = liveNode((e.field === 'environment' ? 'Environment' : 'Release') + (i === 0 ? ' (focused)' : ''), 'Error: ' + e.message, 'bad');
            fieldsBox.appendChild(f.el);
          });
        }
        AF.clear(cidBox);
        if (matched) cidBox.append(ui.token('Correlation id ' + cid), label('Copy · Find in audit trail'));
        renderActions();

        rType.set(a.slug);
        rTreat.set(matched ? TREAT[a.slug][0] : 'None matched: generic error', matched ? null : 'bad');
        rCid.set(matched ? 'Shown' : 'Missing', matched ? 'ok' : 'bad');
        if (!byText) {
          verdict.set('ok', 'Switched on type = ' + a.slug + ': the title, actions and countdown come from the slug.' + (rewordT.get() ? ' The server reworded its message, and only the body text that quotes it changed.' : ' Rewording the message would change only body text that quotes it.'));
        } else if (matched) {
          verdict.set('warn', 'Matched the text "' + a.phrase + '". It works today, but only while the server keeps these exact words.');
        } else {
          verdict.set('bad', 'The server reworded its message, so no text rule matched: a generic error with no ' + (TREAT[a.slug][1] === 'refresh' ? 'Refresh' : TREAT[a.slug][1] === 'fields' ? 'marked fields' : TREAT[a.slug][1] ? 'countdown or retry' : 'specific treatment') + ' and no correlation id. Nothing failed at build time.');
        }
      }

      function actionButton(text, disabled, onClick) {
        return ui.button(text, onClick, { small: true, disabled });
      }

      function renderActions() {
        if (!current) return;
        AF.clear(actionsBox);
        const a = current.a;
        const act = current.action;
        if (act === 'refresh') {
          actionsBox.appendChild(actionButton('Refresh', false, () => log.add('Refresh: the resource is refetched; the screen shows its current state', 'ok')));
        } else if (act === 'retry') {
          actionsBox.appendChild(actionButton(left > 0 ? 'Try again in ' + left + ' s' : 'Try again', left > 0, () => log.add('Try again: the same request is sent once more', 'ok')));
        } else if (act === 'rate') {
          actionsBox.appendChild(actionButton(left > 0 ? 'Deploy in ' + left + ' s' : 'Deploy', left > 0, () => log.add('Deploy: submitted again after the wait', 'ok')));
        } else if (act === 'renew') {
          actionsBox.appendChild(actionButton('Submit again', false, () => log.add('renew(): new Idempotency-Key ' + short(uuid4()) + ', then the form is submitted as a new request', 'ok')));
        } else if (act === 'auto') {
          actionsBox.appendChild(label(left > 0 ? 'Retrying with the same Idempotency-Key in ' + left + ' s' : 'Retried once with the same key: the stored 202 was replayed.'));
          if (left === 0 && !actionDone) {
            actionDone = true;
            log.add('Retried once after Retry-After: 1 with the same Idempotency-Key: 202, Idempotent-Replayed: true', 'ok');
          }
        }
        rRetry.set(a.retryAfter && current.matched ? (left > 0 ? left + ' s' : 'Now') : '—', a.retryAfter && current.matched ? (left > 0 ? 'warn' : 'ok') : null);
      }

      ctx.interval(() => {
        if (left > 0) {
          left--;
          renderActions();
        }
      }, SIM_MS);

      show();
    }
  });

  // =====================================================================
  // 8. One Idempotency-Key per submission (built, P1)
  // =====================================================================
  AF.register({
    id: 'ui-idempotent-submit',
    group: 'api',
    order: 3,
    title: 'One key per submission',
    question: 'How does a double click, or a retry after a timeout, avoid creating a second deployment?',
    status: 'built',
    slice: 'P1',
    where: [
      'web-console/src/hooks/useIdempotentSubmit.ts',
      'web-console/src/features/deploy/DeployPage.tsx',
      'web-console/src/mocks/handlers/control.ts',
      'control-api/src/main/java/io/appfleet/control/idempotency/IdempotencyExecutor.java'
    ],
    idea: [
      'An Idempotency-Key names one logical submission. The client sends it with the POST; the server stores it with its answer and gives the same answer to any repeat, so the work runs once however many copies arrive. The key must stay the same for repeats, and change for a genuinely new request.',
      'useIdempotentSubmit(inputsKey) holds one key per set of inputs. Same inputs, same key, so a double click or a retry carries it; change the release or the environment and the hook makes a new one. After 422 idempotency-key-reused, renew() starts a fresh key.',
      'control-api (S3.5) claims the key in Redis: a copy that arrives while the first is still running gets 409 request-in-progress with Retry-After: 1, and one that arrives later gets the first 202 replayed with Idempotent-Replayed: true. The mock in src/mocks/handlers/control.ts replays and checks the fingerprint the same way.'
    ],
    terms: [
      ['Idempotency-Key', 'A random token naming one submission. Repeats with the same key get the same answer.'],
      ['Fingerprint', 'What the server stores with the key to spot a different body under the same key.'],
      ['Replay', 'Returning the stored answer instead of running the work again.']
    ],
    tryIt: [
      'Press Deploy, then Deploy again: the second answer is a replay, and there is still one deployment.',
      'Press Change environment, then Double-click Deploy: the copy gets 409 request-in-progress, the console retries it once after 1 s, and gets the replayed 202.',
      'Press Change environment, then Time out and retry: the first 202 is lost, and the retry is answered with a replay.',
      'Turn on New key on every click, press Change environment, then Double-click Deploy: two deployments.'
    ],
    breakIt: 'Make a new key on every click and the server cannot tell a double click or a retry from a new request: one submission becomes two deployments, which is exactly what the key was meant to prevent.',
    say: 'useIdempotentSubmit keeps one Idempotency-Key per set of form inputs, so a double click or a retry after a timeout carries the same key and control-api answers 409 request-in-progress or replays the first 202, while changing an input starts a new key.',
    quiz: {
      q: 'Why does useIdempotentSubmit make a new key when you change the environment, instead of keeping one key for the whole form?',
      options: [
        'Redis keys expire when the form changes',
        'Keys are only valid for one environment in control-api',
        'To make each request look new to the rate limiter',
        'A different environment is a different request; under the old key control-api would refuse it with 422 idempotency-key-reused, because the fingerprint no longer matches'
      ],
      answer: 3,
      why: 'The key names a submission, not a form. Same key, different body is a client bug the server catches with the fingerprint; the hook avoids it by deriving the key from the inputs, and renew() recovers if it happens anyway.'
    },
    mount(el, ctx) {
      const WORK = 1000;
      const GAP = 150;
      const RELEASE = '2.4.0';

      let epoch = 0;
      let running = false;
      let st = null;

      const log = shortLog('Submission log');
      const verdict = stableVerdict();

      const deployBtn = ui.button('Deploy', () => act('deploy', ep => submitOnce(ep, clickKey(), st.env)), { variant: 'primary' });
      const dblBtn = ui.button('Double-click Deploy', () => act('double', doubleClick));
      const timeoutBtn = ui.button('Time out and retry', () => act('timeout', timeoutRetry));
      const envBtn = ui.button('Change environment', changeEnv);
      const reuseBtn = ui.button('Reuse the key for other inputs', () => act('reuse', ep => submitOnce(ep, st.key, other(st.env))), { variant: 'quiet', small: true });
      const latS = ui.slider({ label: 'Network latency', min: 0.1, max: 2, step: 0.1, value: 0.5, format: v => v.toFixed(1) + ' s each way' });
      const breakT = ui.toggle('New key on every click', false, on => {
        log.add(on ? 'Break: every click calls randomKey(), whatever the inputs' : 'Fixed: the key comes from useIdempotentSubmit(inputsKey)', on ? 'bad' : 'ok');
        render();
      }, { tone: 'danger' });
      const resetBtn = ui.button('Reset', reset, { variant: 'quiet' });

      const formLane = ui.lane('Browser: deploy form', 'useIdempotentSubmit');
      const formNode = liveNode('', '', null);
      const keyTok = wrapToken('', null);
      const noticeNode = liveNode('No submission yet', '', 'idle');
      const reqList = h('div', { class: 'stack', style: 'gap:.35rem' });
      formLane.body.append(formNode.el, h('div', null, keyTok), noticeNode.el, reqList);
      const keysLane = ui.lane('control-api: stored keys', 'Redis');
      const keysList = h('div', { class: 'stack', style: 'gap:.35rem' });
      keysLane.body.append(keysList);
      const depLane = ui.lane('control-api: deployments', 'Postgres');
      const depList = h('div', { class: 'stack', style: 'gap:.35rem' });
      depLane.body.append(depList);

      const rSent = ui.readout('Requests sent', 0);
      const rCreated = ui.readout('Deployments created', 0);
      const rReplayed = ui.readout('Replayed by the server', 0);
      const rKeys = ui.readout('Keys used', 1);

      el.append(
        controls(deployBtn, dblBtn, timeoutBtn, envBtn, reuseBtn),
        controls(latS.el, breakT.el, resetBtn),
        stage(cols(formLane.el, keysLane.el, depLane.el)),
        readouts(rSent, rCreated, rReplayed, rKeys),
        verdict.el,
        log.el,
        note('Illustrative: the server needs 1 simulated s from claim to commit, and a double click is 0.15 s apart. The server follows control-api S3.5: a key is IN_PROGRESS until the commit, then COMPLETED with the stored 202. 1 simulated second = 250 ms. ' + PARTIAL_INDEX_NOTE)
      );

      const other = env => (env === 'qa' ? 'staging' : 'qa');
      const inputsKey = env => 'billing-api|' + RELEASE + '|' + env;
      const latency = () => Math.round(latS.get() * 1000);

      function fresh() {
        return { env: 'qa', hookInputs: inputsKey('qa'), key: uuid4(), keysUsed: 1, store: new Map(), deployments: [], reqNo: 0, sent: 0, replayed: 0, views: [], lastRes: null };
      }

      /** useIdempotentSubmit: the key follows the inputs. */
      function hookKey() {
        const ik = inputsKey(st.env);
        if (st.hookInputs !== ik) {
          st.hookInputs = ik;
          st.key = uuid4();
          st.keysUsed++;
        }
        return st.key;
      }

      function clickKey() {
        if (breakT.get()) {
          st.keysUsed++;
          return uuid4();
        }
        return hookKey();
      }

      function renew() {
        st.key = uuid4();
        st.keysUsed++;
        log.add('renew(): new key ' + short(st.key), 'ok');
      }

      async function hop(ms, ep) {
        await simSleep(ctx, ms);
        return ctx.alive && ep === epoch;
      }

      function addView(no, key, env) {
        const head = '#' + no + ' · key ' + short(key) + ' · ' + env;
        const v = liveNode(head, 'travelling', 'busy');
        st.views.unshift(v);
        reqList.insertBefore(v.el, reqList.firstChild);
        while (st.views.length > 4) st.views.pop().el.remove();
        return v;
      }

      function arrive(key, env) {
        const rec = st.store.get(key);
        if (rec) {
          if (rec.env !== env) return { status: 422 };
          if (rec.state === 'IN_PROGRESS') return { status: 409 };
          st.replayed++;
          return { status: 202, replayed: true, dep: rec.dep };
        }
        st.store.set(key, { state: 'IN_PROGRESS', env, dep: null });
        return { claim: true };
      }

      function commit(key, env) {
        const dep = { id: '0192f3a1-' + hexChars(4) + '-7' + hexChars(3) + '-8' + hexChars(3) + '-' + hexChars(12), env, key };
        st.deployments.push(dep);
        const rec = st.store.get(key);
        rec.state = 'COMPLETED';
        rec.dep = dep;
        return { status: 202, replayed: false, dep };
      }

      /** One request: travel, server, travel back. Returns the answer the browser sees, or null if aborted. */
      async function exchange(ep, key, env, lose) {
        const no = ++st.reqNo;
        st.sent++;
        const v = addView(no, key, env);
        log.add('#' + no + ' POST /api/v1/deployments, Idempotency-Key ' + short(key) + ', ' + RELEASE + ' to ' + env, 'busy');
        render();
        if (!(await hop(latency(), ep))) return null;
        let res = arrive(key, env);
        if (res.claim) {
          v.set(null, 'claimed: IN_PROGRESS, the server is working', 'busy');
          render();
          if (!(await hop(WORK, ep))) return null;
          res = commit(key, env);
          log.add('#' + no + ' committed deployment ' + short(res.dep.id) + '; key COMPLETED with this 202', 'ok');
        } else if (res.status === 409) {
          log.add('#' + no + ' key is IN_PROGRESS: 409 request-in-progress, Retry-After: 1', 'warn');
        } else if (res.status === 422) {
          log.add('#' + no + ' key stored for another environment: 422 idempotency-key-reused', 'warn');
        } else {
          log.add('#' + no + ' key is COMPLETED: replaying the stored 202', 'ok');
        }
        render();
        if (lose) {
          v.set(null, '202 lost on the way back', 'bad');
          if (!(await hop(latency(), ep))) return null;
          v.set(null, 'network error: Cannot reach the server', 'bad');
          log.add('#' + no + ' the connection dropped before the answer arrived: ApiError type network', 'bad');
          return { status: 0 };
        }
        v.set(null, 'answer travelling back', 'busy');
        if (!(await hop(latency(), ep))) return null;
        if (res.status === 202) v.set(null, (res.replayed ? '202 replayed, Idempotent-Replayed: true' : '202 Accepted') + ' · deployment ' + short(res.dep.id), 'ok');
        else if (res.status === 409) v.set(null, '409 request-in-progress, Retry-After: 1', 'warn');
        else v.set(null, '422 idempotency-key-reused', 'warn');
        return res;
      }

      /** What the console does with one submission, including the one automatic retry after 409. */
      async function submitOnce(ep, key, env, lose) {
        let res = await exchange(ep, key, env, lose);
        if (!res) return null;
        if (res.status === 409) {
          noticeNode.set('Still working on your earlier request', 'The same request is being processed. Its result will show shortly.', 'warn');
          if (!(await hop(1000, ep))) return null;
          log.add('Retry once after Retry-After: 1, with the same key', 'busy');
          res = await exchange(ep, key, env, false);
          if (!res) return null;
        }
        if (res.status === 202) noticeNode.set('Accepted: PENDING', 'Deployment ' + short(res.dep.id) + (res.replayed ? ' (replayed answer)' : '') + '. Follow progress.', 'ok');
        else if (res.status === 0) noticeNode.set('Cannot reach the server', 'The request did not reach the server. Check your connection, then try again.', 'bad');
        else if (res.status === 422) {
          renew();
          noticeNode.set('The request changed while it was being sent', 'Submit again; the console will send it as a new request.', 'warn');
        }
        st.lastRes = res;
        render();
        return res;
      }

      async function doubleClick(ep) {
        const p1 = submitOnce(ep, clickKey(), st.env);
        if (!(await hop(GAP, ep))) return;
        const p2 = submitOnce(ep, clickKey(), st.env);
        await Promise.all([p1, p2]);
      }

      async function timeoutRetry(ep) {
        const r = await submitOnce(ep, clickKey(), st.env, true);
        if (!r) return;
        if (!(await hop(500, ep))) return;
        log.add('You press Deploy again', 'muted');
        await submitOnce(ep, clickKey(), st.env);
      }

      function changeEnv() {
        if (running) return;
        st.env = other(st.env);
        const k = hookKey();
        log.add('Environment changed to ' + st.env + (breakT.get() ? ': the next click makes its own key anyway' : ': new inputs, new key ' + short(k)), 'muted');
        verdict.set('busy', breakT.get()
          ? 'With a new key on every click, the environment makes no difference to the key: every click is a new request anyway.'
          : 'New inputs, new key ' + short(st.key) + ': ' + RELEASE + ' to ' + st.env + ' is a different request, so it must not get the other environment\'s answer back.');
        render();
      }

      async function act(name, fn) {
        if (running) return;
        if (name === 'reuse' && !st.store.has(st.key)) return;
        running = true;
        const ep = epoch;
        const before = st.deployments.length;
        render();
        await fn(ep);
        if (!ctx.alive || ep !== epoch) return;
        running = false;
        render();
        judge(name, st.deployments.length - before);
      }

      function judge(name, created) {
        const sameEnv = st.deployments.filter(d => d.env === st.env).length;
        const brk = breakT.get();
        if (name === 'reuse') {
          verdict.set('warn', '422 idempotency-key-reused: the key was stored with another environment. The console called renew(), so the next Deploy goes out with a new key.');
        } else if (name === 'double') {
          if (created >= 2) verdict.set('bad', created + ' deployments from one double click: each click carried its own key, so control-api saw different requests.');
          else if (created === 1) verdict.set('ok', 'Two clicks, one key, one deployment. The copy arrived while the first was IN_PROGRESS and got 409 request-in-progress; the console retried it once after Retry-After: 1 and got the replayed 202.');
          else verdict.set('ok', 'Both clicks carried a key that was already COMPLETED, so both got the stored 202. No new deployment.');
        } else if (name === 'timeout') {
          if (created >= 2) verdict.set('bad', 'The first attempt committed and its 202 was lost; the retry had a new key, so control-api deployed again. ' + created + ' deployments.');
          else if (created === 1) verdict.set('ok', 'The first attempt committed, but its 202 was lost. The retry carried the same key, so control-api replayed the stored 202. One deployment.');
          else verdict.set('ok', 'Both attempts were replays: this submission had already been accepted.');
        } else if (created === 1 && sameEnv > 1) {
          if (brk) verdict.set('bad', 'Another deployment of ' + RELEASE + ' to ' + st.env + ': this click had a new key, so control-api could not tell it from a new request. ' + sameEnv + ' deployments to ' + st.env + ' now.');
          else verdict.set('warn', 'The inputs changed and changed back, so this is a new submission with a new key, and a second deployment to ' + st.env + '. That is what the form asked for.');
        } else if (created === 1) {
          verdict.set('ok', 'Accepted: one new deployment. control-api stored the key with this request\'s fingerprint, so repeating this submission replays the answer.');
        } else if (st.lastRes && st.lastRes.replayed) {
          verdict.set('ok', 'Same inputs, same key: control-api replayed the stored 202 (Idempotent-Replayed: true) instead of deploying again. "It will not deploy twice" holds.');
        }
      }

      function render() {
        formNode.set('billing-api ' + RELEASE + ' to ' + st.env, 'inputsKey ' + inputsKey(st.env), null);
        keyTok.textContent = breakT.get() ? 'Idempotency-Key: a new one on every click' : 'Idempotency-Key ' + short(st.key);
        AF.tone(keyTok, breakT.get() ? 'bad' : null);
        AF.clear(keysList);
        const recs = Array.from(st.store.entries()).slice(-4).reverse();
        if (!recs.length) keysList.appendChild(label('No keys stored.'));
        recs.forEach(([k, r]) => {
          const n = liveNode('idempotency:v1:deployments:' + short(k),
            r.state + ' · fingerprint ' + RELEASE + ' to ' + r.env + (r.dep ? ' · 202 for ' + short(r.dep.id) : ''), r.state === 'IN_PROGRESS' ? 'busy' : 'ok');
          n.el.style.overflowWrap = 'anywhere';
          keysList.appendChild(n.el);
        });
        AF.clear(depList);
        if (!st.deployments.length) depList.appendChild(label('No deployments.'));
        const seen = {};
        st.deployments.forEach(d => {
          seen[d.env] = (seen[d.env] || 0) + 1;
          d.dup = seen[d.env] > 1;
        });
        st.deployments.slice(-4).reverse().forEach(d => {
          depList.appendChild(AF.tone(ui.node('deployment ' + short(d.id), RELEASE + ' to ' + d.env + ' · key ' + short(d.key) + (d.dup ? ' · another one for ' + d.env : '')), d.dup ? 'bad' : 'ok'));
        });
        rSent.set(st.sent);
        rCreated.set(st.deployments.length, st.deployments.some(d => d.dup) ? 'bad' : null);
        rReplayed.set(st.replayed, st.replayed ? 'ok' : null);
        rKeys.set(st.keysUsed);
        [deployBtn, dblBtn, timeoutBtn, envBtn].forEach(b => { b.disabled = running; });
        reuseBtn.disabled = running || !st.store.has(st.key);
      }

      function reset() {
        epoch++;
        running = false;
        st = fresh();
        AF.clear(reqList);
        log.clear();
        log.add('Form ready: billing-api 2.4.0 to qa, key ' + short(st.key) + '. Press Deploy.', 'muted');
        verdict.clear();
        noticeNode.set('No submission yet', '', 'idle');
        render();
      }

      reset();
    }
  });

  // =====================================================================
  // 9. 202 Accepted, then poll (built, P1)
  // =====================================================================
  AF.register({
    id: 'ui-202',
    group: 'api',
    order: 4,
    title: '202 Accepted, then poll',
    question: 'A deployment takes seconds to minutes. What should the Deploy button wait for?',
    status: 'built',
    slice: 'P1',
    where: [
      'web-console/src/api/control.ts',
      'web-console/src/hooks/useDeployment.ts',
      'web-console/src/features/deployments/deploymentView.ts',
      'docs/specs/project/06-BUSINESS-REQUIREMENTS.md'
    ],
    idea: [
      'Holding a request open until long work finishes ties up a connection and a server thread, and runs into timeouts in browsers and proxies. After a timeout the user cannot tell whether it worked, and the obvious next step, trying again, may start the work twice or be refused.',
      'control-api answers POST /deployments at once with 202 Accepted, Location: /api/v1/tasks/{id} and the body { deploymentId, taskId, status: PENDING }. NFR-2 asks for that answer within 500 ms at p99. requestDeployment() in src/api/control.ts returns the body plus the Location and Idempotent-Replayed headers.',
      'The console shows PENDING, the status the server actually gave, and offers Follow progress. The deployment page polls with useDeployment by state. It never shows HEALTHY early: 202 means accepted, not done, and a release candidate can still fail.'
    ],
    terms: [
      ['202 Accepted', 'The request is valid and taken on; the outcome comes later.'],
      ['Location header', 'Where to look for progress: here the task, /api/v1/tasks/{id}.'],
      ['Optimistic update', 'Showing the expected result before the server confirms it. Fine for a like button, wrong for a deployment.']
    ],
    tryIt: [
      'Choose Wait for the deployment and press Deploy: the request is held, the browser gives up at 5 s, and the retry gets 409 conflict against your own deployment.',
      'Choose 202 then poll and press Deploy: the answer arrives in 0.1 s, and the screen follows each state within about 2 s.',
      'Choose 2.5.0-rc1, turn on Show HEALTHY optimistically and press Deploy: the screen says HEALTHY for half a minute while the deployment has FAILED.'
    ],
    breakIt: 'Show HEALTHY when the 202 arrives and the screen lies until the next poll, and because HEALTHY is polled only every 30 s, a release that fails at 12 s is shown as healthy for half a minute.',
    say: 'POST /deployments answers 202 Accepted with a Location within 500 ms, the console shows the PENDING it was given and follows progress by polling the deployment by state, and it never shows HEALTHY before the server says so.',
    quiz: {
      q: 'With Show HEALTHY optimistically, why does a failure stay hidden for about 30 s rather than until the next 2 s poll?',
      options: [
        'TanStack Query never refetches data set with setQueryData',
        'The 202 response is cached for 30 s',
        'The poll interval comes from the cached status: HEALTHY means a 30 s interval, so the first real check comes half a minute later',
        'control-api delays failures until the next poll'
      ],
      answer: 2,
      why: 'useDeployment works out refetchInterval from the data in the cache. The optimistic HEALTHY made deploymentPollInterval return 30 s, so the lie also slowed down the check that would have exposed it.'
    },
    mount(el, ctx) {
      const RTT = 100;
      const TIMEOUT = 5000;
      const RETRY_AT = 6000;
      const FOLLOW_AT = 500;
      const ENDS = { sync: 15000, async: 36000 };

      let st = null;
      const log = shortLog('Deployment log');
      const verdict = stableVerdict();

      const designC = ui.choice('Design', [{ value: 'sync', label: 'Wait for the deployment' }, { value: 'async', label: '202 then poll' }], 'async', () => idle());
      const releaseC = ui.choice('Release', [{ value: '2.4.0', label: '2.4.0' }, { value: '2.5.0-rc1', label: '2.5.0-rc1' }], '2.4.0', () => idle());
      const deployBtn = ui.button('Deploy', start, { variant: 'primary' });
      const optT = ui.toggle('Show HEALTHY optimistically', false, on => {
        idle();
        log.add(on ? 'Break: on 202, setQueryData(qk.deployment(id), { status: HEALTHY }). Press Deploy.' : 'Fixed: the screen shows the PENDING the 202 carried. Press Deploy.', on ? 'bad' : 'ok');
      }, { tone: 'danger' });

      const chart = sv('svg', {
        class: 'chart', viewBox: '0 0 640 100', role: 'img', style: 'min-width:34rem;max-width:56rem',
        'aria-label': 'Timeline of one deployment: what control-api says, what the screen shows, and each request. A dashed span marks a held connection.'
      });

      const rFirst = ui.readout('First answer after', '—');
      const rHeld = ui.readout('Server held the request', '—');
      const rShown = ui.readout('Screen shows', '—');
      const rServer = ui.readout('Server says', '—');
      const rWrong = ui.readout('Screen showed a wrong state for', '—');

      el.append(
        controls(designC.el, releaseC.el),
        controls(deployBtn, optT.el),
        stage(chart),
        readouts(rFirst, rHeld, rShown, rServer, rWrong),
        verdict.el,
        log.el,
        note('Wait for the deployment is a design control-api does not use; it is here for comparison. The 5 s browser timeout, the retry at 6 s and the 0.1 s answer are illustrative; state times come from the simulated backend, where release candidates fail at 12 s. 1 simulated second = 250 ms.')
      );

      function serverAt(ms) { return stateAt(st.transitions, ms); }

      function schedule(atMs, fn) {
        st.queue.push({ at: atMs, fn });
        st.queue.sort((a, b) => a.at - b.at);
      }

      function setScreen(atMs, text, tone, status) {
        st.screen.push({ at: atMs, text, tone, status: status || null });
      }

      function screenNow() { return st.screen.length ? st.screen[st.screen.length - 1] : null; }

      /** Time the screen showed a deployment state other than the server's, up to ms. */
      function wrongTime(upTo) {
        const pts = new Set([0, upTo]);
        st.transitions.forEach(x => { if (x.at < upTo) pts.add(x.at); });
        st.screen.forEach(x => { if (x.at < upTo) pts.add(x.at); });
        const sorted = Array.from(pts).sort((a, b) => a - b);
        let total = 0;
        for (let i = 0; i + 1 < sorted.length; i++) {
          const mid = (sorted[i] + sorted[i + 1]) / 2;
          let shown = null;
          st.screen.forEach(x => { if (x.at <= mid) shown = x.status; });
          if (shown && shown !== serverAt(mid)) total += sorted[i + 1] - sorted[i];
        }
        return total;
      }

      function planPoll(fromMs) {
        const iv = deploymentPollInterval(st.shown, false);
        if (iv === false) {
          log.add(stamp(fromMs) + ' ' + st.shown + ' is final: polling stops', 'ok');
          return;
        }
        schedule(fromMs + iv, poll);
      }

      function poll(atMs) {
        st.ticks.push({ at: atMs, tone: 'busy' });
        schedule(atMs + RTT, at2 => {
          const s = serverAt(atMs + RTT / 2);
          if (s !== st.shown) {
            st.shown = s;
            setScreen(at2, s, stateTone(s), s);
          }
          const iv = deploymentPollInterval(s, false);
          log.add(stamp(at2) + ' GET /api/v1/deployments/' + short(DEP_ID) + ': ' + s + (iv === false ? '' : ', next in ' + iv / 1000 + ' s'), s === 'FAILED' ? 'bad' : 'muted');
          planPoll(at2);
        });
      }

      function start() {
        const design = designC.get();
        const release = releaseC.get();
        st = {
          design, release, optimistic: optT.get(), t: 0, end: ENDS[design],
          transitions: asTransitions(release === '2.4.0' ? DEPLOY_OK : DEPLOY_FAIL),
          screen: [], ticks: [{ at: 0, tone: 'busy' }], queue: [],
          shown: null, firstAnswer: null, timedOut: false, conflict: false, running: true
        };
        const finalAt = st.transitions[st.transitions.length - 1].at;
        const finalState = st.transitions[st.transitions.length - 1].status;
        log.clear();
        verdict.clear();
        if (design === 'sync') {
          setScreen(0, 'waiting', 'busy');
          log.add('t=0.0 s POST /api/v1/deployments: the browser waits for the deployment to finish', 'busy');
          schedule(TIMEOUT, a => {
            st.timedOut = true;
            setScreen(a, 'timed out', 'bad');
            log.add(stamp(a) + ' The browser gives up after 5 s: "Request timed out". Did it deploy?', 'bad');
          });
          schedule(RETRY_AT, a => {
            st.ticks.push({ at: a, tone: 'warn' });
            log.add(stamp(a) + ' You press Deploy again', 'muted');
            schedule(a + RTT, a2 => {
              st.conflict = true;
              setScreen(a2, '409 conflict', 'bad');
              log.add(stamp(a2) + ' 409 conflict: billing-api already has an active deployment in qa (' + release + ', ' + serverAt(a2 - RTT / 2) + ')', 'bad');
            });
          });
          schedule(finalAt, a => {
            log.add(stamp(a) + ' The first request finally has its answer, ' + finalState + ', but the browser closed that connection at 5 s: nobody receives it.', 'warn');
          });
        } else {
          setScreen(0, 'sending', 'idle');
          log.add('t=0.0 s POST /api/v1/deployments', 'busy');
          schedule(RTT, a => {
            st.firstAnswer = a;
            log.add(stamp(a) + ' 202 Accepted. Location: /api/v1/tasks/' + short(TASK_ID) + ', body status PENDING', 'ok');
            if (st.optimistic) {
              st.shown = 'HEALTHY';
              setScreen(a, 'HEALTHY', 'ok', 'HEALTHY');
              log.add(stamp(a) + ' Optimistic: the screen shows HEALTHY before the server has done anything', 'bad');
            } else {
              st.shown = 'PENDING';
              setScreen(a, 'PENDING', 'busy', 'PENDING');
            }
            log.add(stamp(a) + ' The screen offers Follow progress', 'muted');
          });
          schedule(FOLLOW_AT, a => {
            log.add(stamp(a) + ' You open Follow progress: the deployment page reads the cached answer, 0.4 s old and fresh, so no request yet', 'muted');
            planPoll(a);
          });
        }
        render();
      }

      function idle() {
        st = null;
        log.clear();
        log.add('Choose a design and a release, then press Deploy.', 'muted');
        verdict.clear();
        AF.clear(chart);
        drawTimeline(chart, { from: 0, to: ENDS[designC.get()], rows: [{ label: 'Server', segs: [] }, { label: 'Screen', segs: [] }], ticks: [], spans: [] });
        rFirst.set('—');
        rHeld.set('—');
        rShown.set('—');
        rServer.set('—');
        rWrong.set('—');
      }

      function judge() {
        const finalState = st.transitions[st.transitions.length - 1].status;
        const done = !st.running;
        if (st.design === 'sync') {
          if (st.conflict) verdict.set('bad', 'Waiting for the deployment: the request was held 5 s and timed out, and the retry got 409 conflict against your own deployment, which went on to ' + finalState + ' with nobody listening. NFR-2 asks for the accepted answer within 500 ms at p99.');
          else if (st.timedOut) verdict.set('warn', 'Timed out after 5 s. The user cannot tell whether anything was deployed.');
          else verdict.set('busy', 'The request is held open while the deployment runs. The browser waits with a spinner.');
          return;
        }
        const wrong = wrongTime(st.t);
        if (!done) {
          if (st.optimistic) verdict.set('warn', 'The screen says HEALTHY, but the server has only accepted the request. HEALTHY also sets the poll interval to 30 s.');
          else verdict.set('busy', 'Accepted in 0.1 s. The screen shows PENDING, the status the server gave, and polls every 2 s while work is in flight.');
          return;
        }
        if (st.optimistic && finalState === 'FAILED') {
          verdict.set('bad', 'The screen said HEALTHY for ' + sec(wrong) + ' while the deployment had FAILED at 12 s: HEALTHY set the poll interval to 30 s, so the truth arrived late.');
        } else if (st.optimistic) {
          verdict.set('warn', 'The screen said HEALTHY from 0.1 s, ' + sec(wrong) + ' before it was true. It turned out right only by luck.');
        } else {
          verdict.set('ok', 'Accepted in 0.1 s, then polled by state: the screen followed PENDING, VALIDATING, DEPLOYING and ' + finalState +
            (finalState === 'FAILED' ? ', then stopped polling' : ', then slowed to every 30 s') + '. It lagged ' + sec(wrong) + ' in total, each change waiting for the next 2 s poll.');
        }
      }

      function render() {
        if (!st) return;
        const segs = [];
        st.transitions.forEach((x, i) => {
          if (x.at > st.t) return;
          const next = st.transitions[i + 1];
          segs.push({ from: x.at, to: next && next.at <= st.t ? next.at : st.t, text: x.status, tone: stateTone(x.status) });
        });
        const scr = st.screen.map((x, i) => ({ from: x.at, to: i + 1 < st.screen.length ? st.screen[i + 1].at : st.t, text: x.text, tone: x.tone }));
        const spans = [];
        if (st.design === 'sync') spans.push({ from: 0, to: Math.min(st.t, TIMEOUT), text: 'connection held', tone: 'busy' });
        drawTimeline(chart, { from: 0, to: st.end, rows: [{ label: 'Server', segs }, { label: 'Screen', segs: scr }], ticks: st.ticks, spans });

        const finalAt = st.transitions[st.transitions.length - 1].at;
        if (st.design === 'sync') {
          rFirst.set(st.timedOut ? 'None: timed out at 5.0 s' : 'Waiting, ' + sec(st.t), st.timedOut ? 'bad' : 'warn');
          rHeld.set(sec(Math.min(st.t, finalAt)), st.t > 500 ? 'bad' : null);
          rWrong.set('Never showed a state', null);
        } else {
          rFirst.set(st.firstAnswer !== null ? sec(st.firstAnswer) : '…', st.firstAnswer !== null ? 'ok' : null);
          rHeld.set(st.firstAnswer !== null ? sec(st.firstAnswer) : '…', 'ok');
          const w = wrongTime(st.t);
          rWrong.set(sec(w), w > 5000 ? 'bad' : w > 0 ? 'warn' : 'ok');
        }
        const sc = screenNow();
        rShown.set(sc ? sc.text : '—', sc ? sc.tone : null);
        const s = serverAt(st.t);
        rServer.set(s, stateTone(s));
        judge();
      }

      ctx.interval(() => {
        if (!st || !st.running) return;
        st.t = Math.min(st.end, st.t + TICK_SIM);
        let guard = 0;
        while (st.queue.length && st.queue[0].at <= st.t && guard++ < 50) {
          const e = st.queue.shift();
          e.fn(e.at);
        }
        if (st.t >= st.end) {
          st.running = false;
          log.add(stamp(st.t) + ' End of the run. Press Deploy to run it again.', 'muted');
        }
        render();
      }, TICK_MS);

      idle();
    }
  });

  // =====================================================================
  // 10. Hybrid mode and the dev proxy (in progress, P2 and P6)
  // =====================================================================
  AF.register({
    id: 'ui-proxy',
    group: 'api',
    order: 5,
    title: 'Hybrid mode and the dev proxy',
    question: 'In hybrid mode, how does each request reach the service that owns it, when two services share a path prefix?',
    status: 'progress',
    slice: 'P2, P6',
    where: [
      'web-console/proxy.config.ts',
      'web-console/proxy.config.test.ts',
      'web-console/src/mocks/handlers/control.ts',
      'web-console/vite.config.ts'
    ],
    idea: [
      'In hybrid mode MSW still runs in the browser. For a control-api endpoint that is built it calls passthrough(), so the request goes on to the Vite dev server; for one control-api does not have yet it answers 501 not-implemented; services that do not exist yet are still simulated.',
      'The dev server forwards by path with ROUTES from proxy.config.ts: control-api on 8081, identity 8082, task 8083, node-agent 8084, query 8085. Vite tries the keys in order; a key that starts with ^ is a regular expression, any other is a prefix.',
      'query-service owns /api/v1/applications/{id}/history and /api/v1/deployments/{id}/timeline, which sit under control-api prefixes, so two regex rules come first. proxy.config.test.ts checks both through serviceFor(). In docker compose (P6, planned) nginx will serve the build and apply the same table.'
    ],
    terms: [
      ['passthrough()', 'MSW\'s way of letting a request go on to the real network.'],
      ['Reverse proxy', 'A server that forwards each request to a backend chosen by its path.'],
      ['Prefix rule', 'Matches every path that starts with the key, so order decides between overlapping prefixes.']
    ],
    tryIt: [
      'Choose All services live (planned), then press history: rule 1, a regex, sends it to query-service on 8085.',
      'Turn on Drop the regex rules and press history again: the /api/v1/applications prefix wins, and control-api answers 404.',
      'Choose Hybrid today and press history: MSW answers 501 itself, so the broken table goes unnoticed, which is why the unit test exists.',
      'Type your own path, for example /api/v1/audit/logins, and watch which rule matches.'
    ],
    breakIt: 'Drop the regex rules and the prefix /api/v1/applications catches the history read, so control-api answers 404 for a page query-service could serve. In hybrid mode today nobody would notice, because MSW still answers that path itself.',
    say: 'In hybrid mode MSW passes built control-api calls through to the Vite dev proxy, which routes by path with the ROUTES table in proxy.config.ts, regex rules first for the two query-service paths under control-api prefixes, and nginx will apply the same table in docker compose.',
    quiz: {
      q: 'Why are the two regex rules at the top of ROUTES instead of next to the other query-service rules?',
      options: [
        'Regular expressions are faster when they come first',
        'The proxy tries rules in order, and the /api/v1/applications and /api/v1/deployments prefixes would otherwise match the history and timeline paths first',
        'Vite reads only the first two keys as regular expressions',
        'query-service is the most important service'
      ],
      answer: 1,
      why: 'Order is the whole mechanism: Vite tries keys in insertion order and stops at the first match. proxy.config.test.ts pins both paths to query-service and the rest of those prefixes to control-api.'
    },
    mount(el, ctx) {
      // Copied from web-console/proxy.config.ts.
      const SERVICES = { control: 8081, identity: 8082, task: 8083, agent: 8084, query: 8085 };
      const NAMES = { control: 'control-api', identity: 'identity-service', task: 'task-service', agent: 'node-agent', query: 'query-service' };
      const ROUTES = [
        ['^/api/v1/applications/[^/]+/history', 'query'],
        ['^/api/v1/deployments/[^/]+/timeline', 'query'],
        ['/api/v1/dashboard', 'query'],
        ['/api/v1/fleet', 'query'],
        ['/admin/projections', 'query'],
        ['/api/v1/audit/logins', 'identity'],
        ['/api/v1/audit', 'query'],
        ['/api/v1/applications', 'control'],
        ['/api/v1/deployments', 'control'],
        ['/api/v1/tasks', 'control'],
        ['/api/v1/catalogue', 'control'],
        ['/api/v1/environments', 'control'],
        ['/api/v1/auth', 'identity'],
        ['/api/v1/users', 'identity'],
        ['/api/v1/teams', 'identity'],
        ['/api/v1/roles', 'identity'],
        ['/api/v1/service-accounts', 'identity'],
        ['/api/v1/sessions', 'agent'],
        ['/api/v1/nodes', 'agent'],
        ['/api/v1/dlq', 'task']
      ];
      // The MSW handlers in src/mocks/handlers, with what each does in hybrid mode:
      // pass = passthrough() to the dev proxy, gap = 501 not-implemented, mock = simulated answer.
      const MSW = [
        ['GET', '/api/v1/users/me', 'mock', 'identity'], ['GET', '/api/v1/teams', 'mock', 'identity'], ['GET', '/api/v1/users', 'mock', 'identity'],
        ['GET', '/api/v1/users/:id', 'mock', 'identity'], ['POST', '/api/v1/teams/:id/members', 'mock', 'identity'],
        ['POST', '/api/v1/users/:id/deactivate', 'mock', 'identity'], ['GET', '/api/v1/service-accounts', 'mock', 'identity'],
        ['POST', '/api/v1/service-accounts/:id/rotate', 'mock', 'identity'], ['GET', '/api/v1/audit/logins', 'mock', 'identity'],
        ['GET', '/api/v1/dashboard/overview', 'gap', 'query'], ['GET', '/api/v1/dashboard/deployments', 'gap', 'query'],
        ['GET', '/api/v1/dashboard/where', 'gap', 'query'], ['GET', '/api/v1/applications/:id/history', 'gap', 'query'],
        ['GET', '/api/v1/deployments/:id/timeline', 'gap', 'query'], ['GET', '/api/v1/fleet', 'mock', 'query'],
        ['GET', '/admin/projections', 'mock', 'query'], ['POST', '/admin/projections/:name/rebuild', 'mock', 'query'],
        ['GET', '/api/v1/audit', 'mock', 'query'], ['GET', '/api/v1/audit/correlation/:cid', 'mock', 'query'],
        ['GET', '/api/v1/applications', 'pass', 'control'], ['POST', '/api/v1/applications', 'pass', 'control'],
        ['GET', '/api/v1/applications/:id', 'pass', 'control'], ['GET', '/api/v1/applications/:id/releases', 'gap', 'control'],
        ['POST', '/api/v1/applications/:id/releases', 'pass', 'control'], ['GET', '/api/v1/applications/:id/releases/:rid', 'pass', 'control'],
        ['GET', '/api/v1/environments', 'gap', 'control'], ['POST', '/api/v1/deployments', 'pass', 'control'],
        ['GET', '/api/v1/deployments/:id', 'pass', 'control'], ['POST', '/api/v1/deployments/:id/rollback', 'pass', 'control'],
        ['GET', '/api/v1/deployments/:id/tasks', 'pass', 'control'], ['GET', '/api/v1/tasks/:id', 'pass', 'control'],
        ['GET', '/api/v1/catalogue/images', 'gap', 'control'],
        ['GET', '/api/v1/sessions', 'mock', 'agent'], ['POST', '/api/v1/sessions', 'mock', 'agent'], ['GET', '/api/v1/sessions/:id', 'mock', 'agent'],
        ['POST', '/api/v1/nodes/:id/drain', 'mock', 'agent'],
        ['GET', '/api/v1/dlq', 'mock', 'task'], ['POST', '/api/v1/dlq/:taskId/replay', 'mock', 'task'], ['POST', '/api/v1/dlq/stuck/:taskId/reclaim', 'mock', 'task']
      ].map(([method, pattern, kind, svc]) => ({ method, pattern, kind, svc, re: new RegExp('^' + pattern.replace(/:[A-Za-z]+/g, '[^/]+') + '$') }));
      const ID = '0192f3a1-0000-7000-8000-000000000001';
      const EXAMPLES = [
        ['history', 'GET', '/api/v1/applications/' + ID + '/history'],
        ['timeline', 'GET', '/api/v1/deployments/' + ID + '/timeline'],
        ['one deployment', 'GET', '/api/v1/deployments/' + ID],
        ['tasks', 'GET', '/api/v1/deployments/abc/tasks?cursor=x'],
        ['deploy', 'POST', '/api/v1/deployments'],
        ['sign-in audit', 'GET', '/api/v1/audit/logins'],
        ['audit', 'GET', '/api/v1/audit?cid=c-1'],
        ['dashboard', 'GET', '/api/v1/dashboard/deployments'],
        ['users/me', 'GET', '/api/v1/users/me'],
        ['DLQ replay', 'POST', '/api/v1/dlq/abc/replay'],
        ['unknown path', 'GET', '/unknown']
      ];

      const verdict = stableVerdict();
      const modeC = ui.choice('Mode', [{ value: 'hybrid', label: 'Hybrid today' }, { value: 'live', label: 'All services live (planned)' }], 'hybrid', () => route());
      const methodC = ui.choice('Method', [{ value: 'GET', label: 'GET' }, { value: 'POST', label: 'POST' }], 'GET', () => route());
      const inputId = 'proxy-path-' + hexChars(6);
      const input = h('input', {
        type: 'text', id: inputId, value: '/api/v1/deployments/' + ID, spellcheck: 'false', autocomplete: 'off',
        style: 'font-family:var(--mono);font-size:.85rem;min-height:2.4rem;padding:0 .6rem;border:1px solid var(--line);border-radius:6px;background:var(--white);width:100%;max-width:42rem;min-width:0',
        on: { input: () => route() }
      });
      const pathRow = h('div', { class: 'row', style: 'flex-wrap:nowrap;width:100%;max-width:48rem' },
        h('label', { for: inputId, class: 'small', style: 'font-weight:600;color:var(--muted)' }, 'Path'), input);
      const examples = h('div', { class: 'row', style: 'gap:.35rem' }, label('Examples'),
        EXAMPLES.map(([text, method, path]) => ui.button(text, () => {
          input.value = path;
          methodC.set(method);
          route();
        }, { small: true, variant: 'quiet' })));
      const breakT = ui.toggle('Drop the regex rules', false, () => route(), { tone: 'danger' });

      const mswNode = liveNode('', '', null);
      const proxyNode = liveNode('', '', null);
      const answerNode = liveNode('', '', null);
      const rulesBox = h('div', { class: 'row', style: 'gap:.3rem' });

      const rMsw = ui.readout('MSW', '—');
      const rRule = ui.readout('Proxy rule', '—');
      const rTo = ui.readout('Goes to', '—');
      const rAnswer = ui.readout('Answer', '—');

      el.append(
        controls(modeC.el, methodC.el, breakT.el),
        controls(pathRow),
        controls(examples),
        stage(cols(
          ui.panel('1. MSW in the browser', mswNode.el),
          ui.panel('2. Vite dev proxy', proxyNode.el),
          ui.panel('3. Answer', answerNode.el)
        ), h('div', { style: 'margin-top:.8rem' }, ui.panel('ROUTES in proxy.config.ts, tried in order', rulesBox))),
        readouts(rMsw, rRule, rTo, rAnswer),
        verdict.el,
        note('ROUTES is copied from proxy.config.ts and matched as serviceFor() does: a key starting with ^ is a regular expression, any other a prefix, both tested against the path with its query string. Hybrid today: only control-api runs, on port 8081; MSW simulates the rest. nginx (P6, planned) will apply the same table in docker compose.')
      );

      const isRegex = key => key.startsWith('^');
      const matches = (key, path) => (isRegex(key) ? new RegExp(key).test(path) : path.startsWith(key));

      function route() {
        const path = input.value.trim() || '/';
        const pathname = path.split('?')[0];
        const method = methodC.get();
        const live = modeC.get() === 'live';
        const brk = breakT.get();

        // 1. MSW (hybrid only)
        const handler = live ? null : MSW.find(m => m.method === method && m.re.test(pathname)) || null;
        const reaches = live || !handler || handler.kind === 'pass';
        // 2. the proxy table, tried in order
        let hitIndex = -1;
        ROUTES.forEach((r, i) => {
          if (hitIndex >= 0 || (brk && isRegex(r[0]))) return;
          if (matches(r[0], path)) hitIndex = i;
        });
        const hit = hitIndex >= 0 ? ROUTES[hitIndex] : null;
        const regexPath = ROUTES.slice(0, 2).some(r => matches(r[0], path));

        if (live) {
          mswNode.set('Not in the way', 'With every service live, requests go straight to the proxy.', 'idle');
          rMsw.set('Not used');
        } else if (!handler) {
          mswNode.set('No handler', 'MSW lets an unknown request through to the network.', 'warn');
          rMsw.set('No handler', 'warn');
        } else if (handler.kind === 'pass') {
          mswNode.set('passthrough()', method + ' ' + handler.pattern + ' is built in control-api, so MSW lets it through.', 'ok');
          rMsw.set('passthrough()', 'ok');
        } else if (handler.kind === 'gap') {
          mswNode.set('Answers 501', method + ' ' + handler.pattern + ' is not built in ' + NAMES[handler.svc] + ' yet.', 'warn');
          rMsw.set('Answers 501', 'warn');
        } else {
          mswNode.set('Answers itself', method + ' ' + handler.pattern + ': ' + NAMES[handler.svc] + ' is simulated in the browser.', 'busy');
          rMsw.set('Simulated answer', 'busy');
        }

        AF.clear(rulesBox);
        ROUTES.forEach((r, i) => {
          const text = (i + 1) + '. ' + r[0] + ' · ' + NAMES[r[1]];
          let tone = null;
          let suffix = '';
          if (brk && isRegex(r[0])) { tone = 'bad'; suffix = ' · dropped'; }
          else if (i === hitIndex) { tone = reaches ? 'ok' : 'busy'; suffix = reaches ? ' · match' : ' · would match'; }
          else if (hitIndex >= 0 && i > hitIndex) tone = 'idle';
          rulesBox.appendChild(wrapToken(text + suffix, tone));
        });

        if (hit) {
          proxyNode.set((reaches ? 'Rule ' : 'Not reached; rule ') + (hitIndex + 1) + (reaches ? ' matches' : ' would match'),
            r0(hit) + ' sends it to ' + NAMES[hit[1]] + ' on :' + SERVICES[hit[1]], reaches ? 'ok' : 'idle');
          rRule.set('#' + (hitIndex + 1) + (isRegex(hit[0]) ? ' regex' : ' prefix'), reaches ? null : 'idle');
          rTo.set(reaches ? NAMES[hit[1]] + ' :' + SERVICES[hit[1]] : 'Not reached', reaches ? null : 'idle');
        } else {
          proxyNode.set(reaches ? 'No rule matches' : 'Not reached; no rule would match', 'Vite has nowhere to forward it.', reaches ? 'bad' : 'idle');
          rRule.set('None', reaches ? 'bad' : 'idle');
          rTo.set(reaches ? 'Vite itself' : 'Not reached', reaches ? 'bad' : 'idle');
        }

        // 3. the answer
        let ans;
        let tone;
        if (!reaches) {
          ans = handler.kind === 'gap' ? '501 not-implemented from MSW' : '200 from the simulated ' + NAMES[handler.svc];
          tone = handler.kind === 'gap' ? 'warn' : 'busy';
        } else if (!hit) {
          ans = '404 from the Vite dev server';
          tone = 'bad';
        } else if (!live && hit[1] !== 'control') {
          ans = 'Connection refused: nothing runs on :' + SERVICES[hit[1]] + ' yet';
          tone = 'bad';
        } else {
          const owns = MSW.some(m => m.svc === hit[1] && (live || m.kind === 'pass') && m.method === method && m.re.test(pathname));
          ans = owns ? NAMES[hit[1]] + ' answers' : '404 not-found from ' + NAMES[hit[1]];
          tone = owns ? 'ok' : 'bad';
        }
        answerNode.set(ans, reaches ? (hit ? 'from :' + SERVICES[hit[1]] : 'the dev server itself') : 'the request never left the browser', tone);
        rAnswer.set(ans.split(':')[0], tone);

        // verdict
        if (!reaches && regexPath) {
          verdict.set('warn', brk
            ? 'Today MSW answers this path itself with 501, so the proxy never sees it and the dropped rule goes unnoticed. Once query-service is live it would reach control-api and get 404; proxy.config.test.ts fails now instead.'
            : 'Today MSW answers this path itself with 501 not-implemented, because query-service is not built. Once it is, MSW will let it through, and rules 1 and 2 must already be right: proxy.config.test.ts checks them now.');
        } else if (!reaches && handler.kind === 'gap') {
          verdict.set('busy', '501 not-implemented from MSW: ' + NAMES[handler.svc] + ' does not have this endpoint yet, so hybrid mode says so instead of mixing simulated data into live data.');
        } else if (!reaches) {
          verdict.set('busy', 'MSW answers from the simulated backend: ' + NAMES[handler.svc] + ' does not run yet, so the request never leaves the browser.');
        } else if (!hit) {
          verdict.set('bad', (live ? 'No rule matches' : 'No MSW handler and no proxy rule') + ', so the Vite dev server answers 404 itself.');
        } else if (brk && regexPath) {
          verdict.set('bad', 'Without the regex rules, the prefix ' + hit[0] + ' matched first and sent the request to ' + NAMES[hit[1]] + ', which has no such endpoint: 404 not-found.');
        } else if (!live && hit[1] !== 'control') {
          verdict.set('bad', 'Rule ' + (hitIndex + 1) + ' sends it to ' + NAMES[hit[1]] + ' on :' + SERVICES[hit[1]] + ', which does not run in hybrid mode yet.');
        } else if (isRegex(hit[0])) {
          verdict.set('ok', 'Rule ' + (hitIndex + 1) + ', a regex, matched before the ' + (hitIndex === 0 ? '/api/v1/applications' : '/api/v1/deployments') + ' prefix could: ' + NAMES[hit[1]] + ' on :' + SERVICES[hit[1]] + ' answers.');
        } else {
          verdict.set(tone === 'ok' ? 'ok' : 'bad', (live ? '' : handler ? 'MSW let this built control-api call through. ' : 'MSW has no handler for it, so it goes to the network. ') + 'Rule ' + (hitIndex + 1) + ' (' + hit[0] + ') sends it to ' + NAMES[hit[1]] + ' on :' + SERVICES[hit[1]] +
            (tone === 'ok' ? ', which answers.' : ', which has no such endpoint: 404.'));
        }
      }

      function r0(rule) { return (isRegex(rule[0]) ? 'The regex ' : 'The prefix ') + rule[0]; }

      route();
    }
  });
})();
