/*
 * core.js: shared helpers and the lesson registry for "How Appfleet works".
 *
 * Every lesson file (labs-*.js) calls AF.register({...}) once per lesson.
 * app.js renders the pages and calls lesson.mount(el, ctx) when a lesson opens,
 * then ctx.dispose() when it closes, so timers never leak between lessons.
 *
 * Rules for lesson code:
 *   - Build DOM with AF.h and AF.ui.*; never innerHTML.
 *   - Schedule time only through ctx.timeout / ctx.interval / AF.sleep(ctx, ms).
 *   - Use the CSS atoms from appfleet-concepts.html (.sim-stage, .lane, .node, .token, tones .is-ok ...).
 */
(function () {
  'use strict';

  const AF = (window.AF = {});

  AF.GROUPS = [
    { id: 'postgres', title: 'Postgres and JPA', blurb: 'The write model: one source of truth, and the database guarding it.' },
    { id: 'redis', title: 'Redis', blurb: 'Not just a cache: keys that stop duplicates, buckets, leases, fast reads.' },
    { id: 'kafka', title: 'Kafka', blurb: 'Moving work between services without losing it or doing it twice.' },
    { id: 'spring', title: 'Spring', blurb: 'What the framework does for you, and where it quietly does not.' },
    { id: 'security', title: 'Security', blurb: 'Who you are, and what you may do to which object.' },
    { id: 'architecture', title: 'Architecture', blurb: 'Why the system is split this way, and how it behaves under load and failure.' }
  ];

  AF.STATUS = {
    built: 'Built',
    progress: 'In progress',
    designed: 'Designed, not built',
    planned: 'Planned'
  };

  // ---------- registry ----------
  AF.labs = [];
  const REQUIRED = ['id', 'group', 'order', 'title', 'question', 'status', 'slice', 'idea', 'say', 'quiz', 'mount'];

  AF.register = function (def) {
    const missing = REQUIRED.filter(k => def[k] === undefined);
    if (missing.length) {
      console.error('AF.register: lesson "' + (def.id || '?') + '" is missing ' + missing.join(', '));
      return;
    }
    if (!AF.GROUPS.some(g => g.id === def.group)) {
      console.error('AF.register: unknown group "' + def.group + '" in ' + def.id);
      return;
    }
    if (!AF.STATUS[def.status]) {
      console.error('AF.register: unknown status "' + def.status + '" in ' + def.id);
      return;
    }
    if (AF.labs.some(l => l.id === def.id)) {
      console.error('AF.register: duplicate id ' + def.id);
      return;
    }
    AF.labs.push(def);
  };

  AF.ordered = function () {
    const gi = id => AF.GROUPS.findIndex(g => g.id === id);
    return AF.labs.slice().sort((a, b) => gi(a.group) - gi(b.group) || a.order - b.order);
  };

  AF.byId = id => AF.labs.find(l => l.id === id);

  // ---------- DOM ----------
  /**
   * AF.h('button', { class: 'btn', text: 'Go', on: { click: fn }, 'aria-pressed': 'false' }, child, [children], 'text')
   * props: class, text, on, style (object or string), dataset, any attribute. null/false/undefined attributes are skipped.
   */
  AF.h = function (tag, props, ...kids) {
    const el = document.createElement(tag);
    if (props) {
      for (const k of Object.keys(props)) {
        const v = props[k];
        if (v === null || v === undefined || v === false) continue;
        if (k === 'class') el.className = v;
        else if (k === 'text') el.textContent = v;
        else if (k === 'on') for (const ev of Object.keys(v)) el.addEventListener(ev, v[ev]);
        else if (k === 'style') {
          if (typeof v === 'string') el.style.cssText = v;
          else Object.assign(el.style, v);
        } else if (k === 'dataset') Object.assign(el.dataset, v);
        else if (v === true) el.setAttribute(k, '');
        else el.setAttribute(k, String(v));
      }
    }
    append(el, kids);
    return el;
  };

  function append(el, kids) {
    for (const k of kids) {
      if (k === null || k === undefined || k === false) continue;
      if (Array.isArray(k)) append(el, k);
      else if (k instanceof Node) el.appendChild(k);
      else el.appendChild(document.createTextNode(String(k)));
    }
  }

  AF.clear = el => { while (el.firstChild) el.removeChild(el.firstChild); return el; };

  const TONES = ['is-ok', 'is-bad', 'is-busy', 'is-warn', 'is-idle'];
  /** Set one tone class ('ok' | 'bad' | 'busy' | 'warn' | 'idle' | null) on an element. */
  AF.tone = function (el, tone) {
    TONES.forEach(t => el.classList.remove(t));
    if (tone) el.classList.add('is-' + tone);
    return el;
  };

  AF.reducedMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  /** Promise that resolves after ms, but only while the lesson is open. */
  AF.sleep = (ctx, ms) => new Promise(resolve => ctx.timeout(resolve, ms));

  AF.rand = (min, max) => min + Math.random() * (max - min);
  AF.pick = arr => arr[Math.floor(Math.random() * arr.length)];

  // ---------- lesson context ----------
  AF.makeCtx = function () {
    const cleanups = [];
    let alive = true;
    return {
      get alive() { return alive; },
      timeout(fn, ms) {
        const id = setTimeout(() => { if (alive) fn(); }, ms);
        cleanups.push(() => clearTimeout(id));
        return id;
      },
      interval(fn, ms) {
        const id = setInterval(() => { if (alive) fn(); }, ms);
        cleanups.push(() => clearInterval(id));
        return id;
      },
      onCleanup(fn) { cleanups.push(fn); },
      reducedMotion: AF.reducedMotion(),
      dispose() {
        alive = false;
        cleanups.splice(0).forEach(f => { try { f(); } catch (e) { /* ignore */ } });
      }
    };
  };

  // ---------- UI components ----------
  const h = AF.h;
  let uid = 0;
  const nextId = p => (p || 'af') + '-' + (++uid);

  AF.ui = {
    /** Button. opts: { variant: 'primary' | 'danger' | 'quiet', small, disabled, title, ariaLabel } */
    button(label, onClick, opts) {
      const o = opts || {};
      const cls = ['btn', o.variant, o.small ? 'small' : null].filter(Boolean).join(' ');
      return h('button', { type: 'button', class: cls, disabled: !!o.disabled, title: o.title, 'aria-label': o.ariaLabel, on: { click: onClick } }, label);
    },

    /** On/off switch. opts.tone 'danger' paints the on state orange (use for "break it" switches). Returns { el, get, set }. */
    toggle(label, initial, onChange, opts) {
      const o = opts || {};
      let on = !!initial;
      const el = h('button', { type: 'button', class: 'toggle' + (o.tone === 'danger' ? ' danger' : ''), 'aria-pressed': String(on) },
        h('span', { class: 'knob', 'aria-hidden': 'true' }), h('span', null, label));
      el.addEventListener('click', () => { api.set(!on); if (onChange) onChange(on); });
      const api = {
        el,
        get: () => on,
        set(v) { on = !!v; el.setAttribute('aria-pressed', String(on)); }
      };
      return api;
    },

    /** Segmented single choice. options: [{ value, label }]. Returns { el, get, set }. */
    choice(legend, options, initial, onChange) {
      let value = initial;
      const btns = options.map(opt => h('button', {
        type: 'button', 'aria-pressed': String(opt.value === value),
        on: { click: () => { api.set(opt.value); if (onChange) onChange(value); } }
      }, opt.label));
      const el = h('fieldset', { class: 'choice' }, h('legend', null, legend), btns);
      const api = {
        el,
        get: () => value,
        set(v) {
          value = v;
          options.forEach((opt, i) => btns[i].setAttribute('aria-pressed', String(opt.value === v)));
        }
      };
      return api;
    },

    /** Range slider. o: { label, min, max, step, value, onInput, format }. Returns { el, get, set }. */
    slider(o) {
      const id = nextId('sl');
      const fmt = o.format || (v => String(v));
      const input = h('input', { type: 'range', id, min: o.min, max: o.max, step: o.step || 1, value: o.value });
      const out = h('output', { for: id }, fmt(Number(o.value)));
      input.addEventListener('input', () => {
        const v = Number(input.value);
        out.textContent = fmt(v);
        if (o.onInput) o.onInput(v);
      });
      const el = h('div', { class: 'slider' }, h('label', { for: id }, o.label), input, out);
      return {
        el,
        get: () => Number(input.value),
        set(v) { input.value = v; out.textContent = fmt(Number(v)); }
      };
    },

    /** Dark event log, newest at the bottom, announced politely. Returns { el, add(text, tone), clear() }. */
    log(o) {
      const max = (o && o.max) || 60;
      const el = h('ol', { class: 'log', 'aria-live': 'polite', 'aria-label': (o && o.label) || 'Event log' });
      return {
        el,
        add(text, tone) {
          el.appendChild(h('li', { class: tone ? 't-' + tone : null }, text));
          while (el.children.length > max) el.removeChild(el.firstChild);
          el.scrollTop = el.scrollHeight;
        },
        clear() { AF.clear(el); }
      };
    },

    /** Label + big value. Returns { el, set(value, tone) }. */
    readout(label, value) {
      const b = h('b', null, value === undefined ? '—' : String(value));
      const el = h('div', { class: 'readout' }, h('span', null, label), b);
      return { el, set(v, tone) { b.textContent = String(v); AF.tone(b, tone || null); } };
    },

    /** Outcome line. Returns { el, set(tone, text), clear() }. */
    verdict() {
      const el = h('div', { class: 'verdict', role: 'status' });
      return {
        el,
        set(tone, text) { el.textContent = text; AF.tone(el, tone); },
        clear() { el.textContent = ''; AF.tone(el, null); }
      };
    },

    /** Horizontal bar. o: { label, max, value, tone, format }. Returns { el, set(value, tone) }. */
    bar(o) {
      const fmt = o.format || (v => String(v));
      const fill = h('div', { class: 'bar-fill' });
      const out = h('output', null, '');
      const el = h('div', { class: 'bar' }, h('span', null, o.label), h('div', { class: 'bar-track' }, fill), out);
      const api = {
        el,
        set(v, tone) {
          const pct = Math.max(0, Math.min(100, (v / o.max) * 100));
          fill.style.width = pct + '%';
          out.textContent = fmt(v);
          AF.tone(fill, tone || o.tone || null);
        }
      };
      api.set(o.value || 0, o.tone);
      return api;
    },

    /** Code or SQL block. */
    code(text, label) {
      return h('pre', { class: 'code', 'aria-label': label || 'Code' }, h('code', null, text));
    },

    /** Titled group inside a simulation. */
    panel(title, ...kids) {
      return h('div', { class: 'panel' }, h('div', { class: 'panel-title' }, title), kids);
    },

    /** A box for a service, worker, agent or row. Returns the element; colour it with AF.tone(el, ...). */
    node(label, sub) {
      return h('div', { class: 'node' }, label, sub ? h('span', { class: 'node-sub' }, sub) : null);
    },

    /** A small chip for a message, request, row or token. */
    token(text, tone) {
      return AF.tone(h('span', { class: 'token' }, text), tone || null);
    },

    /** Column with a title, for lanes such as partitions, workers or bays. Returns { el, body, title }. */
    lane(title, aside) {
      const t = h('div', { class: 'lane-title' }, h('span', null, title), aside ? h('span', { class: 'muted' }, aside) : null);
      const body = h('div', { class: 'stack' });
      return { el: h('div', { class: 'lane' }, t, body), body, title: t };
    }
  };
})();
