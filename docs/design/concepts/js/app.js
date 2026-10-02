/*
 * app.js: pages and routing shared by every concepts site. The site file (site-*.js, loaded before the
 * lessons) sets AF.site with the walkthrough, map, roadmap, design choices and all page copy.
 * Routes: #/ (walkthrough), #/lessons[/id], #/map, #/roadmap, #/stances.
 */
(function () {
  'use strict';

  const h = AF.h;
  const C = AF.site.copy;
  const view = document.getElementById('view');
  let activeCtx = null;

  // ---------- small helpers ----------
  const lessonHref = id => '#/lessons/' + id;
  const statusMark = (status, label) => h('span', { class: 'st st-' + status }, label || AF.STATUS[status]);
  const lessonTitle = id => (AF.byId(id) ? AF.byId(id).title : id);

  const store = {
    get(key, fallback) {
      try { const v = localStorage.getItem('af-' + AF.site.id + '-' + key); return v === null ? fallback : JSON.parse(v); } catch (e) { return fallback; }
    },
    set(key, value) {
      try { localStorage.setItem('af-' + AF.site.id + '-' + key, JSON.stringify(value)); } catch (e) { /* storage unavailable */ }
    }
  };
  const solved = () => new Set(store.get('solved', []));

  function lessonChips(ids) {
    return h('div', { class: 'chips' }, ids.filter(id => AF.byId(id)).map(id => h('a', { href: lessonHref(id) }, lessonTitle(id))));
  }

  // =====================================================================
  // 1. One deployment (home)
  // =====================================================================
  const BAYS = AF.site.bays;

  const STOPS = AF.site.stops;

  // What each stop leaves behind in a component, shown as a trace on the board.
  const LEAVES = AF.site.leaves;

  function renderHome() {
    let step = store.get('stop', 0);
    if (step < 0 || step >= STOPS.length) step = 0;
    let playing = null;

    const bayEls = {};
    const traceEls = {};
    const bayRow = h('div', { class: 'bays', role: 'list', 'aria-label': C.baysLabel },
      BAYS.map(b => {
        const trace = h('div', { class: 'bay-trace' });
        const el = h('div', { class: 'bay', role: 'listitem' },
          h('div', { class: 'bay-name' }, b.name),
          h('div', { class: 'bay-role' }, b.role),
          trace);
        bayEls[b.id] = el;
        traceEls[b.id] = trace;
        return el;
      }));

    const stripState = h('span', { class: 'strip-state' });
    const strip = h('div', { class: 'strip', 'aria-hidden': 'true' },
      h('b', null, C.stripTitle), h('span', null, C.stripSub), stripState);

    const count = h('div', { class: 'stop-count' });
    const title = h('h2', { id: 'stop-title' });
    const text = h('p');
    const nowLine = h('div', { class: 'small', style: 'margin-top:.6rem' });
    const tags = h('div', { class: 'stop-tags' });
    const back = AF.ui.button('Back', () => go(step - 1));
    const next = AF.ui.button('Next stop', () => go(step + 1), { variant: 'primary' });
    const play = AF.ui.button('Play', togglePlay);
    const restart = AF.ui.button('Start over', () => { stopPlay(); go(0); }, { variant: 'quiet' });

    const stop = h('section', { class: 'stop', 'aria-labelledby': 'stop-title', 'aria-live': 'polite' },
      h('div', null, count, title, text, nowLine, tags),
      h('div', { class: 'stop-ctl' }, back, next, play, restart));

    function go(i, animate) {
      if (i < 0 || i >= STOPS.length) return;
      const prev = strip.isConnected ? strip.getBoundingClientRect() : null;
      step = i;
      store.set('stop', step);
      const s = STOPS[step];
      BAYS.forEach((b, bi) => {
        const visited = STOPS.slice(0, step + 1).some(x => x.bay === b.id);
        bayEls[b.id].classList.toggle('is-active', b.id === s.bay);
        bayEls[b.id].classList.toggle('is-visited', visited && b.id !== s.bay);
      });
      Object.keys(traceEls).forEach(k => AF.clear(traceEls[k]));
      LEAVES.slice(0, step + 1).forEach((list, li) => list.forEach(([bay, text]) =>
        traceEls[bay].appendChild(AF.ui.token(text, li === step ? 'busy' : null))));
      bayEls[s.bay].appendChild(strip);
      strip.classList.toggle('is-healthy', s.tone === 'healthy');
      strip.classList.toggle('is-failed', s.tone === 'failed');
      stripState.textContent = s.state;
      if (prev && animate !== false && !AF.reducedMotion()) {
        const last = strip.getBoundingClientRect();
        const dx = prev.left - last.left;
        const dy = prev.top - last.top;
        if (dx || dy) {
          strip.style.transition = 'none';
          strip.style.transform = 'translate(' + dx + 'px,' + dy + 'px)';
          requestAnimationFrame(() => requestAnimationFrame(() => {
            strip.style.transition = 'transform .45s cubic-bezier(.2,.7,.2,1)';
            strip.style.transform = '';
          }));
        }
      }
      count.textContent = 'Stop ' + (step + 1) + ' of ' + STOPS.length;
      title.textContent = s.title;
      text.textContent = s.text;
      AF.clear(nowLine).appendChild(statusMark(s.status, s.now));
      AF.clear(tags);
      s.tags.filter(id => AF.byId(id)).forEach(id => tags.appendChild(h('a', { href: lessonHref(id) }, 'Lesson: ' + lessonTitle(id))));
      back.disabled = step === 0;
      next.disabled = step === STOPS.length - 1;
      if (step === STOPS.length - 1) stopPlay();
    }

    function togglePlay() {
      if (playing) { stopPlay(); return; }
      if (step === STOPS.length - 1) go(0);
      play.textContent = 'Pause';
      playing = setInterval(() => go(step + 1), 3400);
    }
    function stopPlay() {
      if (playing) clearInterval(playing);
      playing = null;
      play.textContent = 'Play';
    }

    const ctx = AF.makeCtx();
    ctx.onCleanup(stopPlay);
    activeCtx = ctx;

    const tally = AF.ordered().reduce((acc, l) => { acc[l.status] = (acc[l.status] || 0) + 1; return acc; }, {});
    const total = AF.labs.length;

    view.appendChild(h('div', { class: 'wrap' },
      h('section', { class: 'hero' },
        h('div', { class: 'hero-head' },
          h('div', null,
            h('h1', { class: 'display' }, C.heroTitle),
            h('p', { class: 'lede', style: 'margin-top:1rem' },
              C.heroLede)),
          h('div', { class: 'prose' },
            h('p', null, C.heroAside))),
        h('div', { class: 'board' }, bayRow),
        h('p', { class: 'redis-note', style: 'margin-top:.4rem' }, C.stripNote),
        stop),
      h('section', { class: 'section' },
        h('h2', { class: 'h2' }, C.layersTitle),
        h('p', { class: 'lede', style: 'margin-top:.6rem' },
          total + ' lessons. Each has a simulation you can run, a switch that breaks the idea on purpose, and one question to check yourself.'),
        h('div', { class: 'legend' },
          ['built', 'progress', 'designed', 'planned'].map(s => statusMark(s, AF.STATUS[s] + ' (' + (tally[s] || 0) + ')'))),
        h('div', { class: 'layers' }, AF.GROUPS.map(g => {
          const items = AF.ordered().filter(l => l.group === g.id);
          return h('section', { class: 'layer' },
            h('h3', { class: 'h3' }, g.title),
            h('p', null, g.blurb),
            items.length
              ? h('ol', null, items.map(l => h('li', null, h('a', { href: lessonHref(l.id) }, h('span', null, l.title), statusMark(l.status)))))
              : h('p', { class: 'muted' }, 'Lessons for this layer are not loaded.'));
        })))));

    go(step, false);
  }

  // =====================================================================
  // 2. Lessons
  // =====================================================================
  let indexFilter = { q: '', status: 'all' };

  function renderLessons(id) {
    const all = AF.ordered();
    if (!all.length) {
      view.appendChild(h('div', { class: 'wrap section' }, h('h1', { class: 'h2' }, 'No lessons loaded'),
        h('p', null, 'The lesson files in js/ did not load. Check that the folder sits next to this HTML file.')));
      return;
    }
    const lesson = AF.byId(id) || all[0];
    const idx = all.indexOf(lesson);
    const done = solved();

    // index
    const list = h('div');
    function drawIndex() {
      AF.clear(list);
      const q = indexFilter.q.trim().toLowerCase();
      AF.GROUPS.forEach(g => {
        const items = all.filter(l => l.group === g.id)
          .filter(l => indexFilter.status === 'all' || l.status === indexFilter.status)
          .filter(l => !q || (l.title + ' ' + l.question).toLowerCase().includes(q));
        if (!items.length) return;
        list.appendChild(h('div', { class: 'index-group' },
          h('h3', null, g.title),
          h('ol', null, items.map(l => h('li', null,
            h('a', { href: lessonHref(l.id), 'aria-current': l === lesson ? 'page' : null },
              h('span', { class: 'num' }, String(all.indexOf(l) + 1).padStart(2, '0')),
              h('span', null, l.title, done.has(l.id) ? h('span', { class: 'muted' }, ' ✓') : null),
              h('span', { class: 'st st-' + l.status, title: AF.STATUS[l.status] }, AF.STATUS[l.status])))))));
      });
      if (!list.children.length) list.appendChild(h('p', { class: 'muted small' }, 'No lessons match.'));
    }
    const search = h('input', { type: 'search', placeholder: 'Find a lesson', 'aria-label': 'Find a lesson', value: indexFilter.q });
    search.addEventListener('input', () => { indexFilter.q = search.value; drawIndex(); });
    const statusSel = h('select', { 'aria-label': 'Show lessons by status', class: 'btn small', style: 'justify-content:flex-start' },
      [['all', 'All statuses'], ['built', 'Built'], ['progress', 'In progress'], ['designed', 'Designed, not built'], ['planned', 'Planned']]
        .map(([v, t]) => h('option', { value: v, selected: indexFilter.status === v }, t)));
    statusSel.addEventListener('change', () => { indexFilter.status = statusSel.value; drawIndex(); });
    drawIndex();

    const index = h('nav', { class: 'index', 'aria-label': 'Lessons' },
      h('div', { class: 'index-tools' }, search, statusSel,
        h('div', { class: 'small muted sans' }, done.size + ' of ' + all.length + ' checks answered')),
      list);

    // lesson body
    const group = AF.GROUPS.find(g => g.id === lesson.group);
    const simEl = h('section', { class: 'sim', 'aria-label': 'Simulation: ' + lesson.title });
    const ctx = AF.makeCtx();
    activeCtx = ctx;

    const article = h('article', { class: 'lesson' },
      h('header', null,
        h('div', { class: 'lesson-top' },
          h('span', null, 'Lesson ' + (idx + 1) + ' of ' + all.length + ', ' + group.title)),
        h('h1', { style: 'margin-top:.4rem' }, lesson.title),
        h('p', { class: 'ask' }, lesson.question)),
      h('div', { class: 'facts' },
        statusMark(lesson.status),
        h('dl', null, h('dt', null, 'Slice'), h('dd', null, lesson.slice)),
        lesson.where && lesson.where.length
          ? h('dl', null, h('dt', null, 'Where'), h('dd', null, h('ul', { class: 'where', style: 'margin:0;padding-left:1rem' },
            lesson.where.map(w => h('li', null, h('code', null, w))))))
          : null),
      h('div', { class: 'lesson-body' },
        h('div', { class: 'prose' }, lesson.idea.map(p => h('p', null, p))),
        lesson.terms && lesson.terms.length
          ? h('dl', { class: 'terms' }, lesson.terms.map(([t, d]) => [h('dt', null, t), h('dd', null, d)]))
          : null),
      lesson.tryIt && lesson.tryIt.length
        ? h('div', { class: 'try' }, h('h2', null, 'Try this'), h('ol', null, lesson.tryIt.map(s => h('li', null, s))))
        : null,
      simEl,
      h('div', { class: 'callouts' },
        lesson.breakIt ? h('div', { class: 'callout break' }, h('h2', null, 'What breaks without it'), h('p', null, lesson.breakIt)) : null,
        h('div', { class: 'callout' }, h('h2', null, 'Say it in one sentence'), h('p', { class: 'say' }, lesson.say))),
      renderQuiz(lesson),
      h('nav', { class: 'pager', 'aria-label': 'Previous and next lesson' },
        idx > 0 ? h('a', { href: lessonHref(all[idx - 1].id) }, h('small', null, 'Previous'), all[idx - 1].title) : h('span'),
        idx < all.length - 1 ? h('a', { href: lessonHref(all[idx + 1].id), style: 'text-align:right' }, h('small', null, 'Next'), all[idx + 1].title) : h('span')));

    view.appendChild(h('div', { class: 'wrap' }, h('div', { class: 'lessons' }, index, article)));

    try {
      lesson.mount(simEl, ctx);
    } catch (err) {
      console.error(err);
      simEl.appendChild(h('p', { class: 'sim-error' }, 'This simulation failed to start: ' + err.message));
    }
    const cur = index.querySelector('[aria-current="page"]');
    if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest' });
  }

  function renderQuiz(lesson) {
    const quiz = lesson.quiz;
    const why = h('div', { class: 'quiz-why', role: 'status' });
    const buttons = quiz.options.map((opt, i) => h('button', {
      type: 'button',
      on: {
        click: () => {
          buttons.forEach((b, j) => {
            b.classList.remove('right', 'wrong');
            if (j === quiz.answer) b.classList.add('right');
          });
          if (i !== quiz.answer) buttons[i].classList.add('wrong');
          why.textContent = (i === quiz.answer ? 'Right. ' : 'Not quite. ') + quiz.why;
          if (i === quiz.answer) {
            const s = solved();
            s.add(lesson.id);
            store.set('solved', Array.from(s));
          }
        }
      }
    }, opt));
    return h('section', { class: 'quiz', 'aria-labelledby': 'quiz-h' },
      h('h2', { id: 'quiz-h' }, 'Check yourself'),
      h('p', { class: 'quiz-q' }, quiz.q),
      h('div', { class: 'quiz-opts' }, buttons),
      why);
  }

  // =====================================================================
  // 3. System map
  // =====================================================================
  const MAP_NODES = AF.site.mapNodes;
  const MAP_EDGES = AF.site.mapEdges;

  function renderMap() {
    let selected = store.get('mapNode', C.mapDefault);
    if (!MAP_NODES.some(n => n.id === selected)) selected = C.mapDefault;
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', '0 0 100 100');
    svg.setAttribute('preserveAspectRatio', 'none');
    svg.setAttribute('aria-hidden', 'true');
    const pos = Object.fromEntries(MAP_NODES.map(n => [n.id, n]));
    function line(a, b, cls) {
      const l = document.createElementNS(NS, 'line');
      l.setAttribute('x1', pos[a].x); l.setAttribute('y1', pos[a].y);
      l.setAttribute('x2', pos[b].x); l.setAttribute('y2', pos[b].y);
      if (cls) l.setAttribute('class', cls);
      svg.appendChild(l);
    }
    const detail = h('section', { class: 'map-detail', 'aria-live': 'polite' });
    const nodeBtns = {};
    const mapEl = h('div', { class: 'map' }, svg, MAP_NODES.map(n => {
      const b = h('button', {
        type: 'button', class: 'map-node' + (n.kind === 'infra' ? ' infra' : ''),
        style: 'left:' + n.x + '%;top:' + n.y + '%', 'aria-pressed': 'false',
        on: { click: () => select(n.id) }
      }, n.name, h('small', null, n.sub));
      nodeBtns[n.id] = b;
      return b;
    }));

    function select(id) {
      selected = id;
      store.set('mapNode', id);
      const n = pos[id];
      while (svg.firstChild) svg.removeChild(svg.firstChild);
      MAP_EDGES.forEach(([a, b]) => line(a, b, (a === id || b === id) ? 'hot' : null));
      if (n.links) n.links.forEach(t => line(id, t, 'infra-link hot'));
      Object.keys(nodeBtns).forEach(k => nodeBtns[k].setAttribute('aria-pressed', String(k === id)));
      AF.clear(detail).append(
        h('div', null, h('h2', { class: 'h3' }, n.name), h('div', { style: 'margin-top:.3rem' }, statusMark(n.status))),
        h('p', null, n.role),
        h('dl', { class: 'kv' }, n.rows.map(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
        h('div', null, h('div', { class: 'h4', style: 'margin-bottom:.4rem' }, 'Lessons'), lessonChips(n.lessons)));
    }

    view.appendChild(h('div', { class: 'wrap section' },
      h('h1', { class: 'h2' }, C.mapTitle),
      h('p', { class: 'lede', style: 'margin-top:.6rem' }, C.mapLede),
      h('div', { class: 'map-wrap' }, mapEl, detail)));
    select(selected);
  }

  // =====================================================================
  // 4. Roadmap
  // =====================================================================
  const SLICES = AF.site.slices;

  function renderRoadmap() {
    let sel = store.get('slice', C.roadDefault);
    if (!SLICES.some(s => s.id === sel)) sel = C.roadDefault;
    const btns = {};
    const detail = h('section', { class: 'road-detail', 'aria-live': 'polite' });
    const list = h('ol', { class: 'road-list', 'aria-label': C.roadListLabel }, SLICES.map(s => {
      const built = s.items.filter(i => i[0] === 'built').length;
      const b = h('button', { type: 'button', 'aria-pressed': 'false', on: { click: () => select(s.id) } },
        h('span', { class: 'sl' }, s.id), h('span', { class: 'nm' }, s.name),
        h('span', { class: 'pr' }, built + ' of ' + s.items.length + ' built, ' + s.week));
      btns[s.id] = b;
      return h('li', null, b);
    }));
    function select(id) {
      sel = id;
      store.set('slice', id);
      const s = SLICES.find(x => x.id === id);
      Object.keys(btns).forEach(k => btns[k].setAttribute('aria-pressed', String(k === id)));
      const built = s.items.filter(i => i[0] === 'built').length;
      AF.clear(detail).append(
        h('h2', { class: 'h3' }, s.id + ': ' + s.name),
        AF.ui.bar({ label: 'Built', max: s.items.length, value: built, tone: 'ok', format: v => v + ' of ' + s.items.length }).el,
        h('ul', { class: 'road-items' }, s.items.map(([st, text, lesson]) => h('li', null,
          statusMark(st),
          h('span', null, text, lesson && AF.byId(lesson) ? [' ', h('a', { href: lessonHref(lesson) }, 'Lesson')] : null)))));
    }
    const allItems = SLICES.flatMap(s => s.items);
    const builtAll = allItems.filter(i => i[0] === 'built').length;
    view.appendChild(h('div', { class: 'wrap section' },
      h('h1', { class: 'h2' }, C.roadTitle),
      h('p', { class: 'lede', style: 'margin-top:.6rem' }, C.roadLede + ' ' + builtAll + ' of ' + allItems.length + ' items built.'),
      h('div', { class: 'road' }, list, detail)));
    select(sel);
  }

  // =====================================================================
  // 5. Design choices
  // =====================================================================
  const ACTOR_ROWS = AF.site.mappingRows;

  const REGIMES = AF.site.regimes;

  const WHY_NOT = AF.site.questions;

  function renderStances() {
    const rows = ACTOR_ROWS.map(([g, actor, appfleet, lesson]) => {
      const more = h('div', { class: 'more', hidden: true },
        C.mappingMore, appfleet, '. ', AF.byId(lesson) ? h('a', { href: lessonHref(lesson) }, 'Open the lesson') : null);
      const b = h('button', { type: 'button', 'aria-expanded': 'false' },
        h('span', { class: 'strong' }, g), h('span', null, actor), h('span', null, appfleet), more);
      b.addEventListener('click', e => {
        if (e.target.closest('a')) return;
        const open = b.getAttribute('aria-expanded') !== 'true';
        b.setAttribute('aria-expanded', String(open));
        more.hidden = !open;
      });
      return b;
    });

    const regimeOut = h('div', { class: 'stack', 'aria-live': 'polite' });
    const regimeChoice = AF.ui.choice(C.regimeLegend, Object.keys(REGIMES).map(k => ({ value: k, label: REGIMES[k].label })), C.regimeDefault, drawRegime);
    function drawRegime(k) {
      const r = REGIMES[k];
      AF.clear(regimeOut).append(
        h('div', { class: 'h3' }, r.pick),
        h('p', { class: 'prose' }, r.text),
        lessonChips(r.lessons));
    }

    view.appendChild(h('div', { class: 'wrap' },
      h('section', { class: 'section' },
        h('h1', { class: 'h2' }, C.stancesTitle),
        h('p', { class: 'lede', style: 'margin-top:.6rem' }, C.stancesLede)),
      h('section', { class: 'section' },
        h('h2', { class: 'h3' }, C.mappingTitle),
        h('p', { class: 'prose', style: 'margin-top:.4rem' }, C.mappingLede),
        h('div', { class: 'mapping' },
          h('div', { class: 'head', style: 'display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:1rem;padding:0 .8rem' },
            C.mappingHead.map(t => h('span', null, t))),
          rows)),
      h('section', { class: 'section' },
        h('h2', { class: 'h3' }, C.regimeTitle),
        h('p', { class: 'prose', style: 'margin-top:.4rem' }, C.regimeLede),
        h('div', { class: 'stack', style: 'margin-top:1rem' }, regimeChoice.el, regimeOut)),
      h('section', { class: 'section' },
        h('h2', { class: 'h3' }, C.questionsTitle),
        h('div', { class: 'qa' }, WHY_NOT.map(([q, a, lesson]) => h('details', null,
          h('summary', null, q),
          h('p', null, a, ' ', AF.byId(lesson) ? h('a', { href: lessonHref(lesson) }, 'Related lesson: ' + lessonTitle(lesson)) : null)))))));
    drawRegime(C.regimeDefault);
  }

  // =====================================================================
  // routing
  // =====================================================================
  function route() {
    if (activeCtx) { activeCtx.dispose(); activeCtx = null; }
    AF.clear(view);
    const parts = location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
    const page = parts[0] || '';
    const navTarget = page === '' ? '#/' : '#/' + page;
    document.querySelectorAll('#topnav a').forEach(a => {
      if (a.getAttribute('href') === navTarget) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
    if (page === 'lessons') renderLessons(parts[1]);
    else if (page === 'map') renderMap();
    else if (page === 'roadmap') renderRoadmap();
    else if (page === 'stances') renderStances();
    else renderHome();
    document.title = (page === 'lessons' && AF.byId(parts[1]) ? AF.byId(parts[1]).title + ' — ' : '') + C.siteTitle;
  }

  window.addEventListener('hashchange', () => {
    route();
    window.scrollTo(0, 0);
    view.focus({ preventScroll: true });
  });
  route();
})();
