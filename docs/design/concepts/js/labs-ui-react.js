/*
 * labs-ui-react.js: the React and routing lessons for "How the Appfleet console works"
 * (appfleet-ui-concepts.html).
 *
 *   ui-components  shared components and screens, StatusChip and statusTone   built, P1
 *   ui-state       where state lives, derived state, reset on input change     built, P1
 *   ui-effects     effects, cleanup and StrictMode                              built, P1
 *   ui-keys        list keys and the state that hangs off them                  built, P1
 *   ui-forms       controlled inputs and server validation errors               built, P1, P2
 *   ui-router      data router, layout route and lazy screens                   built, P1
 *   ui-guards      permission gating that answers not found                     built, P1, P3
 *   ui-url-state   filters in search params, push and replace                   built, P1
 *   ui-focus       focus, title and announcements after navigation              built, P1
 *
 * React cannot run on this page, so each simulation models in plain JavaScript what React and
 * React Router do. Facts come from web-console/src; each lesson's `where` names the files.
 */
(function () {
  'use strict';

  const h = AF.h;
  const ui = AF.ui;

  // ---------- small helpers ----------
  const controls = (...kids) => h('div', { class: 'sim-controls' }, kids);
  const stage = (...kids) => h('div', { class: 'sim-stage' }, kids);
  const cols = (...kids) => h('div', { class: 'sim-cols' }, kids);
  const readouts = (...items) => h('div', { class: 'readouts' }, items.map(r => r.el));
  const note = text => h('p', { class: 'small muted' }, text);
  const label = text => h('span', { class: 'small muted' }, text);
  const details = (summary, ...kids) => h('details', null, h('summary', { class: 'small' }, summary), kids);
  const setCode = (pre, text) => { pre.firstChild.textContent = text; };
  const WRAP = 'white-space:normal;overflow-wrap:anywhere;text-align:left';
  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));

  function hexChars(n) {
    let out = '';
    for (let i = 0; i < n; i++) out += Math.floor(Math.random() * 16).toString(16);
    return out;
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

  /** A log with a lower height, for simulations that show other panels too (layout only). */
  function shortLog(labelText, maxHeight) {
    const lg = ui.log({ label: labelText });
    lg.el.style.maxHeight = maxHeight || '10rem';
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

  /** A token that wraps, for addresses and payloads that are longer than a narrow column. */
  function wrapToken(text, tone) {
    const t = ui.token(text, tone);
    t.style.cssText = WRAP;
    return t;
  }

  /** Enables or disables every button of a ui.choice. */
  function choiceDisabled(choice, off) {
    choice.el.querySelectorAll('button').forEach(b => { b.disabled = !!off; });
  }

  // =====================================================================
  // 1. Shared components and screens
  // =====================================================================
  AF.register({
    id: 'ui-components',
    group: 'react',
    order: 1,
    title: 'Shared components and screens',
    question: 'How do a dozen screens show a status the same way without each one deciding how it looks?',
    status: 'built',
    slice: 'P1',
    where: [
      'web-console/src/components/StatusChip.tsx',
      'web-console/src/lib/statusTone.ts',
      'web-console/src/components/DataTable.tsx',
      'web-console/src/components/Button.tsx'
    ],
    idea: [
      'A React component is a function that takes props and returns what to show. A screen is built by composing components: nesting them and passing data down. When a decision such as "which colour means trouble" lives inside one shared component, every screen that uses it gets the decision for free, and changing it means editing one file.',
      'The console keeps two kinds of code apart. src/components holds the shared pieces: Button; ButtonLink, a link styled as a button that stays an <a> because it navigates; DataTable, whose columns each carry a render function for their cells; and StatusChip. src/features holds one folder per screen, and a screen composes those pieces instead of styling its own.',
      'StatusChip is the only caller of statusTone(), the one table that maps a status word to a tone: progress, settled, attention or ended. Tables show a status with a column such as render: r => <StatusChip status={r.status} />. The chip always prints the word as well, so colour is never the only signal.'
    ],
    terms: [
      ['Component', 'A function that takes props and returns what to show. React calls it again when its inputs change.'],
      ['Composition', 'Building a screen by nesting small components and passing them data, instead of copying markup.'],
      ['Render function', 'A function passed as a prop, here a column\'s render, that the table calls once for each row.']
    ],
    tryIt: [
      'Set Attention tone to Amber: DEGRADED on the dashboard, FAILED in the application history and DENIED in the audit trail all change after one edit.',
      'Set Status words to Sentence case: every chip now reads Degraded, Rolled back, Accepted.',
      'Turn on Each screen colours its own status, keep Editing in on Dashboard and set Attention tone to Orange: only the dashboard changes, and Screens out of step shows 2.',
      'Switch Editing in to Application history, then Audit trail, and set Orange in each: three edits for one change.'
    ],
    breakIt: 'When each screen picks its own colours, one change has to be made in every screen, and any screen that is missed shows the same kind of status differently, so a problem looks urgent on one page and calm on the next.',
    say: 'Screens in src/features compose shared pieces from src/components, and StatusChip is the only place a status gets a colour, through statusTone(), so a status looks the same on every screen and changing its look is a one-file edit.',
    quiz: {
      q: 'The API starts sending a new status, QUARANTINED, that nobody has added to statusTone(). What does the console show?',
      options: [
        'Nothing: StatusChip throws for an unknown status and the error page shows instead',
        'A chip with the word QUARANTINED in the neutral ended tone on every screen, until one line in statusTone.ts gives it a tone',
        'A different colour on each screen, depending on which screen renders it first',
        'An empty chip, because the word comes from statusTone()'
      ],
      answer: 1,
      why: 'statusTone() falls back to ended for any word it does not know, and StatusChip prints the word itself. Every screen goes through the same function, so they all agree, and giving the status its own tone is a one-line change.'
    },
    mount(el, ctx) {
      const STATUS_TONE = {
        DEPLOYING: 'progress', HEALTHY: 'settled', DEGRADED: 'attention', FAILED: 'attention',
        ROLLED_BACK: 'ended', ACCEPTED: 'settled', DENIED: 'attention', SUCCESS: 'settled'
      };
      const SCREENS = [
        {
          id: 'dashboard', title: 'Dashboard', file: 'features/dashboard/RecentDeployments.tsx', v: 'r', field: 'r.status',
          column: "{ key: 'state', header: 'State', width: 'minmax(118px, 1fr)',\n  render: r => <StatusChip status={r.status} /> }",
          rows: [['billing-api 2.4.0 to staging', 'DEPLOYING'], ['ledger-worker 0.18.2 in prod', 'DEGRADED'], ['checkout-web 5.11.4 to staging', 'HEALTHY']]
        },
        {
          id: 'history', title: 'Application history', file: 'features/applications/HistoryCard.tsx', v: 'd', field: 'd.status',
          column: "{ key: 'state', header: 'State', width: 'minmax(120px, 1.1fr)',\n  render: d => <StatusChip status={d.status} /> }",
          rows: [['billing-api 2.5.0-rc1 to qa', 'FAILED'], ['billing-api 2.4.0 to staging', 'DEPLOYING'], ['billing-api 2.3.0 to prod', 'ROLLED_BACK']]
        },
        {
          id: 'audit', title: 'Audit trail', file: 'features/audit/AuditPage.tsx', v: 'r', field: 'r.outcome',
          column: "{ key: 'outcome', header: 'Outcome', width: 'minmax(96px, 0.8fr)',\n  render: r => <StatusChip status={r.outcome} /> }",
          rows: [['DEPLOYMENT_REQUESTED by you', 'ACCEPTED'], ['DEPLOYMENT_REQUESTED by m.okafor', 'DENIED'], ['GRANT_REVOKED by admin.t', 'SUCCESS']]
        }
      ];
      const COLOUR = { bad: 'orange', warn: 'amber' };
      const sentenceCase = s => { const t = s.toLowerCase().replace(/_/g, ' '); return t.charAt(0).toUpperCase() + t.slice(1); };
      const wordOf = (status, rule) => (rule.words === 'sentence' ? sentenceCase(status) : status);
      const same = (a, b) => a.attention === b.attention && a.words === b.words;
      const byId = id => SCREENS.find(s => s.id === id);
      function toneOf(status, rule) {
        const t = STATUS_TONE[status] || 'ended';
        if (t === 'progress') return 'busy';
        if (t === 'settled') return 'ok';
        if (t === 'attention') return rule.attention;
        return 'idle';
      }

      let intended = null;   // your latest choices
      let shared = null;     // the rule inside StatusChip and statusTone
      let own = null;        // per-screen copies, while the break is on
      let edits = 0;
      let brokenEdits = 0;

      const log = shortLog('Edit log');
      const verdict = stableVerdict();

      // ---- controls
      const attentionC = ui.choice('Attention tone', [{ value: 'bad', label: 'Orange' }, { value: 'warn', label: 'Amber' }], 'bad', v => change('attention', v));
      const wordsC = ui.choice('Status words', [{ value: 'upper', label: 'As sent' }, { value: 'sentence', label: 'Sentence case' }], 'upper', v => change('words', v));
      const editingC = ui.choice('Editing in', SCREENS.map(s => ({ value: s.id, label: s.title })), 'dashboard', () => {
        if (breakT.get()) log.add('You open ' + byId(editingC.get()).file + '; its own rules show in the controls above', 'muted');
        syncChoices();
        render();
      });
      const breakT = ui.toggle('Each screen colours its own status', false, on => {
        if (on) {
          own = {};
          SCREENS.forEach(s => { own[s.id] = Object.assign({}, shared); });
          brokenEdits = 0;
          log.add('Break: each screen gets its own copy of the colour and word rules, copied from today\'s StatusChip', 'bad');
        } else {
          shared = Object.assign({}, intended);
          own = null;
          log.add('Fixed: every screen renders StatusChip again. One rule, set to your latest choices', 'ok');
        }
        syncChoices();
        render();
      }, { tone: 'danger' });
      const resetBtn = ui.button('Reset', reset, { variant: 'quiet' });

      // ---- stage
      const views = SCREENS.map(s => {
        const lane = ui.lane(s.title, 'uses StatusChip');
        return { s, lane, aside: lane.title.lastChild };
      });
      const rPlaces = ui.readout('Places that style a status', 1);
      const rEdits = ui.readout('Edits made', 0);
      const rOut = ui.readout('Screens out of step', 0);
      const codeBox = ui.code('', 'Code in the file you are editing');

      el.append(
        controls(attentionC.el, wordsC.el),
        controls(editingC.el, breakT.el, resetBtn),
        stage(cols(...views.map(v => v.lane.el))),
        readouts(rPlaces, rEdits, rOut),
        verdict.el,
        cols(ui.panel('Code in the file you are editing', codeBox), ui.panel('Log', log.el)),
        note('Illustrative rows. The tone names (progress, settled, attention, ended) come from statusTone.ts; this page draws them with its own colours.')
      );

      // ---- model
      function change(prop, v) {
        const broken = breakT.get();
        const s = byId(editingC.get());
        const target = broken ? own[s.id] : shared;
        if (target[prop] === v) return;
        target[prop] = v;
        intended[prop] = v;
        edits++;
        if (broken) brokenEdits++;
        const what = prop === 'attention' ? 'attention tone is now ' + COLOUR[v] : (v === 'sentence' ? 'words in sentence case' : 'words as sent');
        if (broken) {
          log.add('Edit ' + edits + ': ' + s.file + ', ' + what + '. Only ' + s.title + ' changes.', 'warn');
        } else {
          log.add('Edit ' + edits + ': components/' + (prop === 'attention' ? 'StatusChip.module.css' : 'StatusChip.tsx') + ', ' + what +
            '. All 3 screens pick it up on their next render.', 'ok');
        }
        render();
      }

      function syncChoices() {
        const rule = breakT.get() ? own[editingC.get()] : shared;
        attentionC.set(rule.attention);
        wordsC.set(rule.words);
      }

      function codeFor(s) {
        if (!breakT.get()) {
          return '// ' + s.file + '\n' + s.column + '\n\n' +
            '// components/StatusChip.tsx: the only caller of statusTone()\n' +
            '// attention tone: ' + COLOUR[shared.attention] + ' (set once, in StatusChip.module.css)\n' +
            '<span className={cx(s.chip, s[statusTone(status)])}>{' + (shared.words === 'sentence' ? 'sentenceCase(label ?? status)' : 'label ?? status') + '}</span>';
        }
        const rule = own[s.id];
        return '// ' + s.file + ': this screen\'s own copy of the rules\n' +
          "const ATTENTION = '" + COLOUR[rule.attention] + "';\n" +
          'const word = (st: string) => ' + (rule.words === 'sentence' ? 'sentenceCase(st)' : 'st') + ';\n' +
          s.column.replace('<StatusChip status={' + s.field + '} />', '<span className={toneFor(' + s.field + ', ATTENTION)}>{word(' + s.field + ')}</span>');
      }

      // ---- view
      function render() {
        const broken = breakT.get();
        const editing = editingC.get();
        const behind = [];
        views.forEach(v => {
          const rule = broken ? own[v.s.id] : shared;
          const out = broken && !same(rule, intended);
          if (out) behind.push(v.s.title);
          v.aside.textContent = broken ? (editing === v.s.id ? 'own rules, editing' : 'own rules') : 'uses StatusChip';
          AF.clear(v.lane.body);
          v.s.rows.forEach(([name, status]) => {
            v.lane.body.appendChild(h('div', { class: 'node row', style: 'justify-content:space-between;gap:.4rem' },
              h('span', null, name), ui.token(wordOf(status, rule), toneOf(status, rule))));
          });
          v.lane.body.appendChild(out
            ? wrapToken('Out of step with your latest change', 'bad')
            : wrapToken(broken ? 'Matches your latest change' : 'Follows StatusChip', 'ok'));
        });
        rPlaces.set(broken ? 3 : 1, broken ? 'warn' : 'ok');
        rEdits.set(edits);
        rOut.set(behind.length, behind.length ? 'bad' : 'ok');
        setCode(codeBox, codeFor(byId(editing)));
        if (!broken) {
          verdict.set('ok', edits
            ? 'One edit in a shared file, and all three screens changed together. Every chip still prints its word.'
            : 'All three screens show statuses through StatusChip, so the same tone always looks the same.');
        } else if (behind.length) {
          verdict.set('bad', behind.join(' and ') + (behind.length === 1 ? ' is' : ' are') +
            ' out of step: the same kind of status now looks different depending on the page. Fixing it means repeating the edit in each screen.');
        } else {
          verdict.set('warn', brokenEdits
            ? 'Consistent again, after ' + plural(brokenEdits, 'edit') + ' spread over the screens. A shared chip needs one, and the next change needs all of them again.'
            : 'Each screen now has its own copy of the rules. They agree only until the next change.');
        }
      }

      function reset() {
        intended = { attention: 'bad', words: 'upper' };
        shared = Object.assign({}, intended);
        own = null;
        if (breakT.get()) {
          own = {};
          SCREENS.forEach(s => { own[s.id] = Object.assign({}, shared); });
        }
        edits = 0;
        brokenEdits = 0;
        editingC.set('dashboard');
        syncChoices();
        log.clear();
        verdict.clear();
        render();
      }

      reset();
    }
  });

  // =====================================================================
  // 2. Where state lives, and derived state
  // =====================================================================
  AF.register({
    id: 'ui-state',
    group: 'react',
    order: 2,
    title: 'Where state lives',
    question: 'Where should each piece of a screen\'s state live, and what should not be stored at all?',
    status: 'built',
    slice: 'P1',
    where: [
      'web-console/src/features/deploy/DeployPage.tsx',
      'web-console/src/hooks/useIdempotentSubmit.ts',
      'web-console/src/mocks/devRole.ts'
    ],
    idea: [
      'State is anything that can change while a screen is open, and each piece has one right home. Text being typed lives in the component, with useState. Choices that decide what the screen shows live in the address, so links and Back work. Data the server owns lives in the query cache. A per-person setting that should survive a reload, like the development role switch, lives in browser storage.',
      'Anything that follows from other state is derived: compute it during render instead of storing it. DeployPage builds its review line, "billing-api 2.4.0 to qa. Replaces 2.3.1.", from the release and environment in the address and the what-runs-where query, on every render. Stored in its own state, it would have to be updated on every path that changes an input, and the first forgotten path leaves it wrong.',
      'Some stored state must reset when an input changes. useIdempotentSubmit keeps one Idempotency-Key per submission. During render it compares the stored inputsKey with the current one and, when they differ, calls setState with a new key. React then throws that render away and runs the component again before painting, so the screen never shows new inputs with the old key.'
    ],
    terms: [
      ['Derived state', 'A value computed from other state during render. It cannot disagree with its inputs, because it is never stored.'],
      ['Search params', 'The ?release=…&env=… part of the address. React Router\'s useSearchParams reads and writes it like state.'],
      ['Single source of truth', 'Each fact is stored in one place; everything else reads it or computes from it.']
    ],
    tryIt: [
      'Pick Release 2.5.0-rc1, then Environment staging: the address, the review line and the Idempotency-Key follow each change, and Renders counts the extra render each new key costs.',
      'Turn on Store the review line in state and press Follow a link to ?env=prod: the address and the request say prod, while the review line still says staging.',
      'Pick Environment qa in the form, so the stored line is right again, then press A colleague deploys here: qa now runs 2.4.0, but the stored line still says Replaces 2.3.1.',
      'Turn the switch off: the line is computed during render again and is right after every path.'
    ],
    breakIt: 'Store the review line in its own state and it only changes where someone remembered to update it. A link or a refetch changes the inputs without touching it, so the screen asks you to confirm a deployment it is not going to make.',
    say: 'Each piece of state gets one home (component, address, query cache or storage), and anything that follows from it, like the deploy review line, is computed during render instead of stored, so it cannot disagree with its inputs.',
    quiz: {
      q: 'useIdempotentSubmit calls setState during render when inputsKey changes. Why not renew the key in an effect after render?',
      options: [
        'Effects are not allowed to call setState',
        'An effect would renew the key twice for every click',
        'An effect runs after the screen is painted, so for one render the new inputs would show with the old key, and a fast submit could send it',
        'Calling setState during render skips React entirely, which is faster'
      ],
      answer: 2,
      why: 'Effects run after commit. setState during render makes React discard that render and run the component again before painting, so the new inputs and the new key always appear together. It cannot loop, because it only fires when inputsKey actually changed.'
    },
    mount(el, ctx) {
      const RELEASES = ['2.3.1', '2.4.0', '2.5.0-rc1'];
      const ENVS = ['dev', 'qa', 'staging', 'prod'];
      const START_RUNNING = { dev: '2.4.0', qa: '2.3.1', staging: '2.3.1', prod: '2.3.1' };
      const FIRST = { release: '2.4.0', env: 'qa' };

      let running = null;      // the what-runs-where query, as cached
      let url = null;          // { release, env }: the search params
      let stored = null;      // the review line in useState, while the break is on
      let keyState = null;     // useIdempotentSubmit's own state
      let renders = 0;
      let wrongRenders = 0;
      let lastPath = '';

      const log = shortLog('Render log');
      const verdict = stableVerdict();

      const address = u => '/applications/<billing-api>/deploy?release=<' + u.release + '>&env=' + u.env;
      const inputsKeyOf = u => '<billing-api>|<' + u.release + '>|' + u.env;
      /** The same wording as replaces() in DeployPage.tsx. */
      function reviewOf(u) {
        const now = running[u.env];
        const tail = !now ? 'Replaces nothing.'
          : now === u.release ? u.env + ' already runs ' + u.release + '; deploying again runs the same release again.'
            : 'Replaces ' + now + '.';
        return 'Review: billing-api ' + u.release + ' to ' + u.env + '. ' + tail;
      }

      // ---- controls
      const releaseC = ui.choice('Release', RELEASES.map(r => ({ value: r, label: r })), FIRST.release, v => pick({ release: v }));
      const envC = ui.choice('Environment', ENVS.map(e => ({ value: e, label: e })), FIRST.env, v => pick({ env: v }));
      const linkBtn = ui.button('Follow a link to ?env=prod', followLink);
      const colleagueBtn = ui.button('A colleague deploys here', colleague);
      const storeT = ui.toggle('Store the review line in state', false, on => {
        if (on) {
          stored = reviewOf(url);
          log.add('Break: const [review, setReview] = useState(() => reviewOf(...)), and the release and environment handlers call setReview', 'bad');
        } else {
          stored = null;
          log.add('Fixed: the review line is computed during render again', 'ok');
        }
        lastPath = 'toggle';
        render();
      }, { tone: 'danger' });
      const resetBtn = ui.button('Reset', reset, { variant: 'quiet' });

      // ---- stage
      const addrTok = wrapToken('', null);
      const reviewNode = liveNode('', '', null);
      const sendNode = liveNode('', '', null);
      const formLane = ui.lane('Deploy form', 'DeployForm');
      formLane.body.append(
        h('div', { class: 'stack', style: 'gap:.25rem' }, label('Address'), addrTok),
        reviewNode.el,
        sendNode.el
      );

      const homeReview = liveNode('Review line', '', null);
      const homesLane = ui.lane('Where each piece lives', null);
      homesLane.body.append(
        ui.node('Release and environment', 'The address: ?release= and ?env=, read with useSearchParams'),
        ui.node('What runs where', 'The query cache, refetched from the server'),
        ui.node('Idempotency-Key', 'Component state: useState inside useIdempotentSubmit'),
        homeReview.el,
        ui.node('Preview-as role', 'Browser storage: localStorage, in mocks/devRole.ts')
      );

      const serverLane = ui.lane('What runs where', 'query cache');
      const rRenders = ui.readout('Renders', 0);
      const rWrong = ui.readout('Renders with a wrong review', 0);
      const rMatch = ui.readout('Review matches the request', 'Yes');

      el.append(
        controls(releaseC.el, envC.el),
        controls(linkBtn, colleagueBtn, storeT.el, resetBtn),
        stage(cols(formLane.el, homesLane.el, serverLane.el)),
        readouts(rRenders, rWrong, rMatch),
        verdict.el,
        log.el,
        note('Ids in angle brackets stand for UUIDs. In DeployPage the release and environment choices replace the current history entry; a link pushes a new one. Either way only the search params change, so React Router keeps DeployForm mounted and its state with it.')
      );

      // ---- paths that change the inputs
      function pick(change) {
        const next = Object.assign({}, url, change);
        if (next.release === url.release && next.env === url.env) return;
        url = next;
        lastPath = 'form';
        log.add('Form: setParams(…, { replace: true }) writes ' + (change.release ? 'release=<' + next.release + '>' : 'env=' + next.env) +
          (storeT.get() ? '; the same handler calls setReview' : ''), 'muted');
        if (storeT.get()) stored = reviewOf(url);
        render();
      }

      function followLink() {
        if (url.env === 'prod') {
          log.add('The address already has env=prod. Pick another environment first.', 'muted');
          return;
        }
        url = Object.assign({}, url, { env: 'prod' });
        lastPath = 'link';
        log.add('A <Link> to the same screen with ?env=prod: the router pushes the new address. Only the search params changed, so DeployForm stays mounted and no form handler runs.', 'muted');
        render();
      }

      function colleague() {
        const env = url.env;
        const cur = running[env];
        const next = RELEASES[Math.min(RELEASES.indexOf(cur) + 1, RELEASES.length - 1)];
        if (next === cur) {
          log.add(env + ' already runs the newest release, ' + cur + '.', 'muted');
          return;
        }
        running = Object.assign({}, running, { [env]: next });
        lastPath = 'server';
        log.add('Polling refetches what runs where: ' + env + ' now runs ' + next + '. The component re-renders with the new data; no form handler runs.', 'muted');
        render();
      }

      // ---- one simulated React render of DeployForm
      function render() {
        releaseC.set(url.release);
        envC.set(url.env);
        renders++;
        const ik = inputsKeyOf(url);
        if (keyState.inputsKey !== ik) {
          const was = keyState.inputsKey;
          keyState = { inputsKey: ik, key: hexChars(8) };
          renders++;
          log.add('Render ' + (renders - 1) + ': useIdempotentSubmit sees inputsKey ' + ik + ' (was ' + was +
            ') and calls setState with a new key. React discards this render and runs the component again, render ' + renders + ', before painting.', 'busy');
        }
        const computed = reviewOf(url);
        const broken = storeT.get();
        const shown = broken ? stored : computed;
        const wrong = shown !== computed;
        if (wrong) wrongRenders++;

        addrTok.textContent = address(url);
        reviewNode.set(shown,
          broken ? (wrong ? 'Stored in useState. The inputs say: ' + computed : 'Stored in useState, updated by the form handlers') : 'Computed during render',
          wrong ? 'bad' : 'ok');
        sendNode.set('Deploy would send',
          'POST /api/v1/deployments: release <' + url.release + '>, environment ' + url.env + ', Idempotency-Key ' + keyState.key + '…', null);
        homeReview.set(null, broken ? 'Component state: a copy in useState that can go stale' : 'Nowhere: computed during render', broken ? 'bad' : 'ok');

        AF.clear(serverLane.body);
        ENVS.forEach(env => {
          const n = ui.node(env + ': ' + running[env], 'HEALTHY' + (env === url.env ? ' · chosen' : ''));
          AF.tone(n, env === url.env ? 'busy' : null);
          serverLane.body.appendChild(n);
        });

        rRenders.set(renders);
        rWrong.set(wrongRenders, wrongRenders ? 'bad' : 'ok');
        rMatch.set(wrong ? 'No' : 'Yes', wrong ? 'bad' : 'ok');

        if (!broken) {
          verdict.set('ok', 'Computed: the review line is worked out from the address and the query cache on every render, so it always matches what Deploy would send.');
        } else if (wrong) {
          verdict.set('bad', lastPath === 'server'
            ? 'Stale: the review line still says "' + shown + '", but ' + url.env + ' now runs ' + running[url.env] + '. The refetch changed the data without touching the stored copy.'
            : 'Stale: the review line says "' + shown + '", but Deploy would send ' + url.release + ' to ' + url.env + '. The link changed the address without running the form handler that updates the stored copy.');
        } else {
          verdict.set('warn', 'Right for now, because every change so far came through a form handler that also calls setReview. Try Follow a link to ?env=prod or A colleague deploys here.');
        }
      }

      function reset() {
        running = Object.assign({}, START_RUNNING);
        url = Object.assign({}, FIRST);
        stored = storeT.get() ? reviewOf(url) : null;
        keyState = { inputsKey: inputsKeyOf(url), key: hexChars(8) };
        renders = 0;
        wrongRenders = 0;
        lastPath = '';
        log.clear();
        verdict.clear();
        render();
      }

      reset();
    }
  });

  // =====================================================================
  // 3. Effects and cleanup
  // =====================================================================
  const COUNTDOWN_CODE = [
    '// components/Feedback.tsx',
    'export function useCountdown(seconds: number | null): number {',
    '  const [left, setLeft] = useState(seconds ?? 0);',
    '  useEffect(() => {',
    '    setLeft(seconds ?? 0);',
    '    if (!seconds) return;',
    '    const id = setInterval(() => setLeft(v => (v > 0 ? v - 1 : 0)), 1000);',
    '    return () => clearInterval(id);',
    '  }, [seconds]);',
    '  return left;',
    '}'
  ].join('\n');

  AF.register({
    id: 'ui-effects',
    group: 'react',
    order: 3,
    title: 'Effects and cleanup',
    question: 'How do you start a timer from a component without leaving it running after the component is gone?',
    status: 'built',
    slice: 'P1',
    where: [
      'web-console/src/components/Feedback.tsx',
      'web-console/src/main.tsx',
      'web-console/src/app/AppShell.tsx'
    ],
    idea: [
      'Rendering should only describe the screen. Work that reaches outside React, such as starting a timer, moving focus or subscribing to something, goes in useEffect, which runs after React has put the render on screen. An effect can return a cleanup function. React calls it before it runs the effect again for new inputs, and when the component unmounts.',
      'src/main.tsx wraps the app in StrictMode. In development it mounts every component, unmounts it and mounts it again straight away. A correct effect does not mind: its cleanup undoes the first run. An effect without cleanup now runs twice and leaves its first timer behind, so the bug shows up on your machine instead of after many navigations in production. Production builds mount once.',
      'useCountdown in src/components/Feedback.tsx counts down Retry-After seconds with setInterval and returns () => clearInterval(id). ErrorNotice uses it to disable Try again until the wait is over. AppShell uses an effect too: when location.pathname changes, it moves focus to <main> and scrolls to the top, because that touches the DOM after the new screen is rendered.'
    ],
    terms: [
      ['Effect', 'Code React runs after a render is on screen, to keep something outside React in step.'],
      ['Cleanup', 'The function an effect returns. React runs it before the next run of the effect and on unmount.'],
      ['StrictMode', 'A development-only wrapper that, among other checks, mounts, unmounts and remounts components to expose missing cleanup.']
    ],
    tryIt: [
      'Press Mount: the notice counts down from 10, one second per tick, with one active timer, although StrictMode ran the effect twice.',
      'Press Unmount: Active timers drops to 0. Press Change Retry-After and Mount again: it counts from 6.',
      'Turn on Forget the cleanup, press Unmount, then Mount: StrictMode leaves two timers on one countdown, so it drops two seconds per tick.',
      'Press Unmount and Mount a few more times: Active timers keeps growing, and Ticks for unmounted components counts timers firing for nothing.'
    ],
    breakIt: 'Without cleanup, every mount starts another interval that never stops. The countdown runs too fast while two timers share it, and timers for unmounted components keep firing until the tab is closed.',
    say: 'Effects run after render and return a cleanup that React calls before the next run and on unmount; useCountdown clears its interval there, and StrictMode in development mounts everything twice so a missing cleanup shows up at once.',
    quiz: {
      q: 'In development a countdown drops two seconds per tick, but in the production build it is correct. What is the most likely cause?',
      options: [
        'The effect starts an interval but returns no cleanup, and StrictMode\'s extra mount in development leaves a second interval running',
        'Production builds run timers at half speed to save battery',
        'setInterval is less accurate in development because the dev server is slower',
        'useState batches two updates into one only in production'
      ],
      answer: 0,
      why: 'StrictMode only acts in development. It mounts, unmounts and remounts, so an effect without cleanup runs twice and leaves two intervals on one state. A production build mounts once, which hides the leak until the component mounts again after a navigation.'
    },
    mount(el, ctx) {
      const FIRST = 10;
      const SECOND = 6;

      let seconds = FIRST;     // the prop: Retry-After from the last 429
      let inst = null;         // the mounted notice: { no, left, mounted, cleanup, cleanupNo }
      let instNo = 0;
      let timerNo = 0;
      let timers = [];         // { no, inst, active, id }
      let wasted = 0;

      const log = shortLog('Effect log', '12rem');
      const verdict = stableVerdict();

      // ---- controls
      const mountBtn = ui.button('Mount', doMount, { variant: 'primary' });
      const unmountBtn = ui.button('Unmount', doUnmount, { disabled: true });
      const changeBtn = ui.button('Change Retry-After', doChange);
      const strictT = ui.toggle('StrictMode (development)', true, on => {
        log.add(on ? 'StrictMode on: the next mount runs mount, unmount, mount' : 'StrictMode off, as in a production build: the next mount runs once', 'muted');
      });
      const forgetT = ui.toggle('Forget the cleanup', false, on => {
        log.add(on ? 'Break: the effect no longer returns () => clearInterval(id). This applies from the next time the effect runs.'
          : 'Fixed: the effect returns its cleanup again, from the next time it runs. Timers that already leaked keep running.', on ? 'bad' : 'ok');
        setCode(codeBox, on ? COUNTDOWN_CODE.replace('    return () => clearInterval(id);\n', '    // no cleanup returned\n') : COUNTDOWN_CODE);
      }, { tone: 'danger' });
      const resetBtn = ui.button('Reset', reset, { variant: 'quiet' });

      // ---- stage
      const noticeNode = liveNode('', '', null);
      const compLane = ui.lane('Component', 'RetryNotice');
      compLane.body.append(noticeNode.el);
      const timersLane = ui.lane('setInterval timers', 'newest first');
      const timerList = h('div', { class: 'stack', style: 'gap:.3rem' });
      timersLane.body.append(timerList);

      const rMounted = ui.readout('Mounted', 'No');
      const rActive = ui.readout('Active timers', 0);
      const rSpeed = ui.readout('Seconds counted per tick', 0);
      const rWasted = ui.readout('Ticks for unmounted components', 0);
      const codeBox = ui.code(COUNTDOWN_CODE, 'useCountdown');

      el.append(
        controls(mountBtn, unmountBtn, changeBtn),
        controls(strictT.el, forgetT.el, resetBtn),
        stage(cols(compLane.el, timersLane.el)),
        readouts(rMounted, rActive, rSpeed, rWasted),
        verdict.el,
        cols(ui.panel('Log', log.el), ui.panel('useCountdown', codeBox)),
        note('The notice stands for ErrorNotice after a 429 with Retry-After. Ticks are real seconds. React 18 and later ignore setState on an unmounted component without a warning, so a leaked timer fails silently.')
      );

      // ---- React's side
      function runEffect(i) {
        i.left = seconds;                                   // setLeft(seconds ?? 0)
        const t = { no: ++timerNo, inst: i, active: true, id: null };
        t.id = ctx.interval(() => tick(t), 1000);
        timers.push(t);
        if (forgetT.get()) {
          i.cleanup = null;
          log.add('  effect: setLeft(' + seconds + '), setInterval #' + t.no + ', returns nothing', 'bad');
        } else {
          i.cleanup = () => { clearInterval(t.id); t.active = false; };
          i.cleanupNo = t.no;
          log.add('  effect: setLeft(' + seconds + '), setInterval #' + t.no + ', returns () => clearInterval(#' + t.no + ')', 'ok');
        }
      }

      function runCleanup(i) {
        if (i.cleanup) {
          const n = i.cleanupNo;
          i.cleanup();
          i.cleanup = null;
          log.add('  cleanup: clearInterval(#' + n + ')', 'ok');
        } else {
          const live = timers.filter(t => t.active && t.inst === i).map(t => '#' + t.no);
          log.add('  no cleanup to run: ' + (live.length ? live.join(', ') + (live.length === 1 ? ' keeps' : ' keep') + ' running' : 'nothing was started'), 'bad');
        }
      }

      function tick(t) {
        if (!t.active) return;
        if (t.inst.mounted) t.inst.left = t.inst.left > 0 ? t.inst.left - 1 : 0;
        else wasted++;
        render();
      }

      // ---- actions
      function doMount() {
        if (inst) return;
        inst = { no: ++instNo, left: seconds, mounted: true, cleanup: null, cleanupNo: 0 };
        log.add('Mount RetryNotice #' + inst.no + ' with useCountdown(' + seconds + '): render, commit, then the effect', 'busy');
        runEffect(inst);
        if (strictT.get()) {
          log.add('StrictMode (development): unmount and mount again straight away, keeping the state', 'muted');
          runCleanup(inst);
          runEffect(inst);
        }
        render();
      }

      function doUnmount() {
        if (!inst) return;
        log.add('Unmount RetryNotice #' + inst.no + ': React runs the cleanup', 'busy');
        runCleanup(inst);
        inst.mounted = false;
        const left = timers.filter(t => t.active && t.inst === inst).length;
        if (left) log.add('  ' + plural(left, 'interval') + ' still running for a component that is gone', 'bad');
        inst = null;
        render();
      }

      function doChange() {
        const before = seconds;
        seconds = seconds === FIRST ? SECOND : FIRST;
        if (!inst) {
          log.add('Retry-After is now ' + seconds + ' s. It applies at the next mount.', 'muted');
          render();
          return;
        }
        log.add('A new 429 says Retry-After: ' + seconds + '. The dependency [seconds] changed from ' + before + ' to ' + seconds +
          ', so React runs the cleanup for the old value, then the effect again', 'busy');
        runCleanup(inst);
        runEffect(inst);
        render();
      }

      // ---- view
      function render() {
        const active = timers.filter(t => t.active);
        const onMounted = inst ? active.filter(t => t.inst === inst) : [];
        const leaked = active.filter(t => !t.inst.mounted);

        if (inst) {
          noticeNode.set('ErrorNotice: 429 rate-limited',
            inst.left > 0 ? 'Try again in ' + inst.left + ' s (button disabled) · useCountdown(' + seconds + ')' : 'Try again (button enabled) · useCountdown(' + seconds + ')',
            onMounted.length > 1 ? 'bad' : inst.left > 0 ? 'warn' : 'ok');
        } else {
          noticeNode.set('Nothing mounted', 'Press Mount to show the notice. Retry-After is ' + seconds + ' s.', 'idle');
        }

        AF.clear(timerList);
        const firstOnMounted = onMounted.length ? onMounted[0].no : 0;
        timers.slice(-8).reverse().forEach(t => {
          let text;
          let tone;
          if (!t.active) { text = 'cleared'; tone = 'idle'; } else if (!t.inst.mounted) { text = 'leaked: its component is gone'; tone = 'bad'; } else if (t.no === firstOnMounted) { text = 'running'; tone = 'busy'; } else { text = 'running, a second timer on the same countdown'; tone = 'bad'; }
          timerList.appendChild(wrapToken('#' + t.no + ' · notice #' + t.inst.no + ' · ' + text, tone));
        });
        if (timers.length > 8) timerList.appendChild(label('and ' + (timers.length - 8) + ' older'));
        if (!timers.length) timerList.appendChild(label('No timers yet.'));

        rMounted.set(inst ? 'Yes' : 'No');
        rActive.set(active.length, leaked.length || onMounted.length > 1 ? 'bad' : null);
        rSpeed.set(onMounted.length, onMounted.length > 1 ? 'bad' : null);
        rWasted.set(wasted, wasted ? 'bad' : null);
        mountBtn.disabled = !!inst;
        unmountBtn.disabled = !inst;

        if (leaked.length) {
          verdict.set('bad', plural(leaked.length, 'timer') + ' still fire every second for components that are gone, and nothing will clear them until the tab closes.' +
            (onMounted.length > 1 ? ' The mounted notice also has ' + onMounted.length + ' timers, so it counts ' + onMounted.length + ' seconds per tick.' : ''));
        } else if (onMounted.length > 1) {
          verdict.set('bad', onMounted.length + ' timers drive one countdown, so it drops ' + onMounted.length + ' seconds per tick. The first effect run was never cleaned up before the next one started.');
        } else if (inst) {
          verdict.set('ok', 'One notice, one timer.' + (strictT.get() || timers.length > 1 ? ' Every earlier run of the effect was cleaned up before the next one started.' : ''));
        } else if (timers.length) {
          verdict.set('ok', 'Unmounted, and every interval was cleared. Nothing keeps running.');
        } else {
          verdict.clear();
        }
      }

      function reset() {
        timers.forEach(t => clearInterval(t.id));
        timers = [];
        inst = null;
        instNo = 0;
        timerNo = 0;
        wasted = 0;
        seconds = FIRST;
        log.clear();
        verdict.clear();
        render();
      }

      render();
    }
  });

  // =====================================================================
  // 4. List keys
  // =====================================================================
  AF.register({
    id: 'ui-keys',
    group: 'react',
    order: 4,
    title: 'List keys',
    question: 'When a list changes, how does React know which row is which, so an open confirmation stays on the right item?',
    status: 'built',
    slice: 'P1',
    where: [
      'web-console/src/features/sessions/SessionList.tsx',
      'web-console/src/components/DataTable.tsx',
      'web-console/src/components/InlineConfirm.tsx'
    ],
    idea: [
      'When React renders a list again, it matches each new element to an old one by its key. A match keeps the component instance, and with it any local state: an open confirmation, a half-typed value, focus. A key that is new mounts a fresh component; a key that disappeared unmounts one, and its state is gone.',
      'If the key is the array index, the key describes a position, not an item. Remove the first row or sort the list and every item moves to a new position, but the state stays where it was. An open "End this session?" question now sits next to a different session, and confirming it ends that one.',
      'The console keys rows by id. SessionList renders each row with key={session.sessionId}, and the row\'s End control keeps its confirming state inside it. DataTable takes rowKey and uses it as the React key, so screens pass rowKey={a => a.id}. Ids come from the server and never change, so state follows the item whatever happens to the order.'
    ],
    terms: [
      ['Key', 'A string React uses to match list items between renders. Unique among siblings and stable for the item\'s lifetime.'],
      ['Component instance', 'What React keeps between renders for one element: its state, refs and effects.'],
      ['Reconciliation', 'React comparing a new render with the previous one to decide what to keep, change, add or remove.']
    ],
    tryIt: [
      'Press Open confirm on row 2: the question opens on Python data notebook, in instance B.',
      'Press Remove first row: the question moves with Python data notebook, now row 1, still in instance B.',
      'Press Reset, turn on Use the index as key, press Open confirm on row 2, then Remove first row: instance B keeps the open question but now renders Java IDE (JDK 21).',
      'Press End session in that row: the wrong session ends. Try Sort by name as well.'
    ],
    breakIt: 'With the index as key, local state belongs to a position. After a row is removed or the list is sorted, an open confirmation sits next to a different session, and End session ends one the user never chose.',
    say: 'React matches list items by key and keeps each instance\'s state with its key, so the console keys every row by its server id, as SessionList and DataTable\'s rowKey do; an index key ties state to a position, and an open confirmation lands on the wrong item when the list changes.',
    quiz: {
      q: 'Which list can safely use the array index as its key?',
      options: [
        'A list of sessions sorted newest first, because the sort order never changes',
        'Any list whose items have no id field',
        'A list with inline confirmations, as long as only one can be open at a time',
        'A list that never reorders, inserts or removes items, and whose rows hold no state of their own'
      ],
      answer: 3,
      why: 'An index key only goes wrong when items change position while instances hold state. A fixed list of plain rows never moves items, so position and identity agree. Sessions sorted newest first shift down every time a new one starts at the top.'
    },
    mount(el, ctx) {
      const SESSIONS = [
        { id: '0192f3a7', name: 'SQL workbench', started: 'started 5 min ago' },
        { id: '0192f2c1', name: 'Python data notebook', started: 'started 20 min ago' },
        { id: '0192f0d4', name: 'Java IDE (JDK 21)', started: 'started 50 min ago' },
        { id: '0192ef58', name: 'Design suite', started: 'started 1 h 10 min ago' }
      ];
      const LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
      const nameOf = id => (SESSIONS.find(s => s.id === id) || { name: id }).name;

      let items = [];
      let instances = new Map();   // key -> { letter, open, meantId }
      let letterNo = 0;
      let mistakes = 0;
      let lastEnd = null;          // { tone, text } after End session

      const log = shortLog('Reconciliation log', '11rem');
      const verdict = stableVerdict();

      const keyOf = (item, i) => (indexT.get() ? String(i) : item.id);
      const nextLetter = () => { const n = letterNo++; return LETTERS[n % 26] + (n >= 26 ? String(Math.floor(n / 26)) : ''); };

      // ---- controls
      const openBtn = ui.button('Open confirm on row 2', () => openRow(1), { variant: 'primary' });
      const removeBtn = ui.button('Remove first row', removeFirst);
      const sortBtn = ui.button('Sort by name', sortByName);
      const indexT = ui.toggle('Use the index as key', false, on => {
        instances = new Map();
        letterNo = 0;
        lastEnd = null;
        log.add('Keys switched to ' + (on ? 'the array index' : 'session ids') + '. Every key changed, so React unmounted every row and mounted fresh ones: all local state starts closed.', on ? 'bad' : 'ok');
        render(true);
      }, { tone: 'danger' });
      const resetBtn = ui.button('Reset', reset, { variant: 'quiet' });

      // ---- stage
      const listLane = ui.lane('Your tool sessions', 'SessionList');
      const instLane = ui.lane('What React keeps', 'key and instance');
      const rKeys = ui.readout('Keys', 'session id');
      const rOpen = ui.readout('Question open on', 'none');
      const rMeant = ui.readout('You opened it for', 'none');
      const rMistakes = ui.readout('Sessions ended by mistake', 0);

      el.append(
        controls(openBtn, removeBtn, sortBtn, indexT.el, resetBtn),
        stage(cols(listLane.el, instLane.el)),
        readouts(rKeys, rOpen, rMeant, rMistakes),
        verdict.el,
        log.el,
        note('Illustrative sessions. "You opened it for" is the simulation keeping score; the real screen cannot know it, which is the problem.')
      );

      // ---- reconciliation
      function reconcile(quiet) {
        const keys = items.map((it, i) => keyOf(it, i));
        Array.from(instances.keys()).forEach(k => {
          if (keys.includes(k)) return;
          const ins = instances.get(k);
          instances.delete(k);
          if (!quiet) log.add('Key ' + k + ' is gone: React unmounts instance ' + ins.letter + (ins.open ? ', and its open question with it' : ''), 'muted');
        });
        keys.forEach(k => {
          if (instances.has(k)) return;
          const ins = { letter: nextLetter(), open: false, meantId: null };
          instances.set(k, ins);
          if (!quiet) log.add('New key ' + k + ': React mounts instance ' + ins.letter, 'muted');
        });
      }

      function openRow(i) {
        if (!items[i]) {
          log.add('There is no row ' + (i + 1) + '. Press Reset to bring the sessions back.', 'muted');
          return;
        }
        const ins = instances.get(keyOf(items[i], i));
        ins.open = true;
        ins.meantId = items[i].id;
        lastEnd = null;
        log.add('End on row ' + (i + 1) + ': instance ' + ins.letter + ' sets confirming = true, for ' + items[i].name, 'busy');
        render();
      }

      function cancelRow(i) {
        const ins = instances.get(keyOf(items[i], i));
        ins.open = false;
        ins.meantId = null;
        log.add('Cancel on row ' + (i + 1) + ': instance ' + ins.letter + ' closes its question', 'muted');
        render();
      }

      function endRow(i) {
        const it = items[i];
        const ins = instances.get(keyOf(it, i));
        const meant = ins.meantId;
        ins.open = false;
        ins.meantId = null;
        items.splice(i, 1);
        if (meant === it.id) {
          lastEnd = { tone: 'ok', text: 'Ended ' + it.name + ', the session you chose.' };
          log.add('End session: DELETE session ' + it.id + '. ' + it.name + ' ended, as intended.', 'ok');
        } else {
          mistakes++;
          lastEnd = { tone: 'bad', text: 'Ended ' + it.name + ', but you opened the question for ' + nameOf(meant) + '. The prompt named the session it was rendering, and the click went to it.' };
          log.add('End session: DELETE session ' + it.id + '. ' + it.name + ' ended, but the question was opened for ' + nameOf(meant) + '.', 'bad');
        }
        render();
      }

      function removeFirst() {
        if (!items.length) return;
        const gone = items.shift();
        lastEnd = null;
        log.add('The list refetches: ' + gone.name + ' ended elsewhere after 30 minutes idle, so row 1 disappears and every row below moves up', 'busy');
        render();
      }

      function sortByName() {
        const before = items.map(i => i.id).join();
        items.sort((a, b) => a.name.localeCompare(b.name));
        if (items.map(i => i.id).join() === before) {
          log.add('Already sorted by name.', 'muted');
          return;
        }
        lastEnd = null;
        log.add('Sort by name: the same sessions, in new positions', 'busy');
        render();
      }

      // ---- view
      function render(quiet) {
        reconcile(quiet);
        AF.clear(listLane.body);
        AF.clear(instLane.body);
        let openOn = null;
        let meantFor = null;
        let wrong = null;
        items.forEach((it, i) => {
          const k = keyOf(it, i);
          const ins = instances.get(k);
          const bad = ins.open && ins.meantId !== it.id;
          if (ins.open) {
            openOn = it.name;
            meantFor = nameOf(ins.meantId);
            if (bad) wrong = { has: it.name, meant: meantFor, letter: ins.letter };
          }
          const actions = ins.open
            ? h('div', { class: 'row', style: 'gap:.4rem', role: 'group', 'aria-label': 'End ' + it.name + '?' },
              h('span', { style: 'font-weight:600' }, 'End ' + it.name + '?'),
              ui.button('End session', () => endRow(i), { variant: 'danger', small: true }),
              ui.button('Cancel', () => cancelRow(i), { small: true, ariaLabel: 'Cancel ending ' + it.name }))
            : h('div', { class: 'row' }, ui.button('End', () => openRow(i), { small: true, ariaLabel: 'End ' + it.name }));
          const row = h('div', { class: 'node stack', style: 'gap:.35rem' },
            h('div', { class: 'row', style: 'justify-content:space-between;gap:.4rem' }, h('span', null, it.name), ui.token('RUNNING', 'ok')),
            h('span', { class: 'node-sub' }, 'Row ' + (i + 1) + ' · ' + it.started + ' · key ' + k + ' · instance ' + ins.letter),
            actions,
            bad ? wrapToken('You opened this question for ' + nameOf(ins.meantId), 'bad') : null);
          AF.tone(row, bad ? 'bad' : ins.open ? 'busy' : null);
          listLane.body.appendChild(row);

          const n = ui.node('key ' + k + ' · instance ' + ins.letter,
            (ins.open ? 'confirming = true' : 'confirming = false') + ' · renders ' + it.name);
          AF.tone(n, bad ? 'bad' : ins.open ? 'busy' : null);
          instLane.body.appendChild(n);
        });
        if (!items.length) listLane.body.appendChild(label('No sessions left. Press Reset.'));

        rKeys.set(indexT.get() ? 'array index' : 'session id', indexT.get() ? 'bad' : 'ok');
        rOpen.set(openOn || 'none', wrong ? 'bad' : null);
        rMeant.set(meantFor || 'none');
        rMistakes.set(mistakes, mistakes ? 'bad' : null);
        openBtn.disabled = items.length < 2;
        removeBtn.disabled = !items.length;
        sortBtn.disabled = items.length < 2;

        if (wrong) {
          verdict.set('bad', 'The question you opened for ' + wrong.meant + ' now asks about ' + wrong.has + '. Instance ' + wrong.letter +
            ' kept its state at its position, and the item at that position changed. End session would end ' + wrong.has + '.');
        } else if (openOn && indexT.get()) {
          verdict.set('warn', 'The question is on ' + openOn + ', the session you chose, but only until the list changes: its state is tied to row ' +
            (items.findIndex(it => it.name === openOn) + 1) + '. Try Remove first row or Sort by name.');
        } else if (openOn) {
          verdict.set('ok', 'The question stays with ' + openOn + ' wherever it moves, because its key is the session id.');
        } else if (lastEnd) {
          verdict.set(lastEnd.tone, lastEnd.text);
        } else {
          verdict.clear();
        }
      }

      function reset() {
        items = SESSIONS.slice();
        instances = new Map();
        letterNo = 0;
        mistakes = 0;
        lastEnd = null;
        log.clear();
        verdict.clear();
        render(true);
      }

      reset();
    }
  });

  // =====================================================================
  // 5. Forms and server errors
  // =====================================================================
  AF.register({
    id: 'ui-forms',
    group: 'react',
    order: 5,
    title: 'Forms and server errors',
    question: 'When the server rejects a form, how does the user find out which field is wrong and get straight to it?',
    status: 'built',
    slice: 'P1, P2',
    where: [
      'web-console/src/components/Forms.tsx',
      'web-console/src/features/applications/RegisterReleaseForm.tsx',
      'web-console/src/features/applications/shared.ts',
      'web-console/src/mocks/handlers/control.ts'
    ],
    idea: [
      'In a controlled input, React state holds the value and the input shows it; every keystroke goes through setState, so the form always knows what it will send. The console still treats the server as the authority: the browser checks almost nothing itself, and control-api\'s validation decides what is valid. The simulated backend copies those rules.',
      'A 400 validation-failed ProblemDetail carries errors[], each with a field name and a message. fieldErrorsOf turns that into one message per field. TextField, given error, sets aria-invalid and points aria-describedby at the hint and the message, so a screen reader reads them with the field. useFocusFirstInvalid then moves focus to the first invalid field.',
      'While the request is pending, the submit button is disabled and marked aria-busy, so a double click sends one request. RegisterReleaseForm follows this pattern, and shows a 409 conflict for a version that already exists on the version field too.'
    ],
    terms: [
      ['Controlled input', 'An input whose value comes from React state and changes only through setState.'],
      ['aria-invalid', 'Tells assistive technology that the field\'s value was rejected.'],
      ['aria-describedby', 'Links a field to the elements that describe it, here the hint and the error, so they are read with the field.']
    ],
    tryIt: [
      'Press Register release with the values as they are: the server answers 400, each field gets its own message, and focus lands on Version.',
      'Turn on Show errors only as a banner and press Register release again: one message at the top, no field marked, focus stays on the button, and Found the field says No.',
      'Turn the banner off, set Version to 2.4.0 and Checksum to valid, and register: 409 conflict, shown on the version field. Set Version to 2.5.0 and press Double-click register: the second click lands on a disabled button.',
      'Press Reset, turn on Leave the button enabled while pending, set Version to 2.5.0 and Checksum to valid, and press Double-click register: two requests, and the second gets 409.'
    ],
    breakIt: 'With errors only in a banner, the user reads "must match sha256:[0-9a-f]{64}" and has to guess which field it means. Nothing is marked invalid and focus stays on the button, so a screen-reader user has to hunt for the problem.',
    say: 'The console keeps inputs controlled, lets the server decide what is valid, maps each validation-failed error onto its field with aria-invalid and aria-describedby, moves focus to the first invalid field, and disables submit while the request is pending.',
    quiz: {
      q: 'The server rejects a form with errors on version and checksum. Where should focus go?',
      options: [
        'Nowhere: moving focus without the user asking is confusing',
        'To the first invalid field, which then announces its label, its invalid state and its message together',
        'To a banner at the top that lists both messages',
        'To the checksum field, because its error was listed last'
      ],
      answer: 1,
      why: 'Focus on the first field marked aria-invalid puts the user where the fix is, and aria-describedby makes the screen reader read the message with the field. A banner alone says that something is wrong, not where.'
    },
    mount(el, ctx) {
      const HEX = '9f2c7b1d4e8a0365c2f1b9d7e4a60c38' + '58d1f2e7a9b04c6d3e5f718293a4e41a';
      const VERSION_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]*$/;
      const CHECKSUM_RE = /^sha256:[0-9a-f]{64}$/;
      const PENDING_MS = 900;
      const MSG_VERSION = 'must match "[A-Za-z0-9][A-Za-z0-9._+-]*" and be at most 64 characters';
      const MSG_CHECKSUM = 'must match "sha256:[0-9a-f]{64}"';
      const SEED = ['2.2.7', '2.3.0', '2.3.1', '2.4.0', '2.5.0-rc1'];
      const FIELDS = {
        version: { label: 'Version', hint: 'Letters, digits and . _ + -, starting with a letter or digit. Up to 64 characters.' },
        checksum: { label: 'Checksum', hint: 'sha256: followed by 64 lowercase hex characters.' }
      };
      const ORDER = ['version', 'checksum'];
      const sentence = m => { const t = m.trim(); const s = t.charAt(0).toUpperCase() + t.slice(1); return /[.!?]$/.test(s) ? s : s + '.'; };
      const shortSum = v => (v.length > 24 ? v.slice(0, 13) + '…' + v.slice(-4) : v);

      let registered = null;
      let pending = 0;
      let sent = 0;
      let overlaps = 0;       // requests sent while another was pending
      let fieldErr = {};
      let banner = null;      // { tone, text }
      let focus = 'none';     // 'version' | 'checksum' | 'button' | 'none'
      let found = '—';
      let epoch = 0;

      const log = shortLog('Requests');
      const srLog = shortLog('Screen reader');
      const verdict = stableVerdict();

      // ---- controls
      const versionC = ui.choice('Version', [
        { value: '2.5.0', label: '2.5.0' }, { value: '2.4.0', label: '2.4.0' }, { value: 'v 2.5', label: 'v 2.5' }, { value: '', label: 'empty' }
      ], 'v 2.5', v => typed('version', v));
      const checksumC = ui.choice('Checksum', [
        { value: 'sha256:' + HEX, label: 'valid' }, { value: 'sha256:' + HEX.toUpperCase(), label: 'uppercase hex' },
        { value: 'sha256:9f2c', label: 'too short' }, { value: '', label: 'empty' }
      ], 'sha256:9f2c', v => typed('checksum', v));
      const submitBtn = ui.button('Register release', () => submit(), { variant: 'primary' });
      const dblBtn = ui.button('Double-click register', () => {
        if (submitBtn.disabled) return;
        submit();
        const ep = epoch;
        ctx.timeout(() => { if (ep === epoch) submit(); }, 40);
      });
      const bannerT = ui.toggle('Show errors only as a banner', false, on => {
        log.add(on ? 'Break: the form shows the ProblemDetail in one banner and never maps errors[] onto fields' : 'Fixed: errors[] are mapped onto their fields again', on ? 'bad' : 'ok');
      }, { tone: 'danger' });
      const enabledT = ui.toggle('Leave the button enabled while pending', false, on => {
        log.add(on ? 'Break: the submit button stays enabled while the request is pending' : 'Fixed: the submit button is disabled and aria-busy while pending', on ? 'bad' : 'ok');
        render();
      }, { tone: 'danger' });
      const resetBtn = ui.button('Reset', reset, { variant: 'quiet' });

      // ---- the form as rendered
      function fieldView(name) {
        const f = FIELDS[name];
        const box = h('span', { class: 'token', style: WRAP + ';min-width:9rem' });
        const focusTag = h('span', { class: 'small', style: 'font-weight:600' });
        const err = h('p', { class: 'small', style: 'margin:0;color:var(--bad-ink);font-weight:600' });
        const attrs = h('code', { style: 'overflow-wrap:anywhere' });
        const el2 = h('div', { class: 'node stack', style: 'gap:.3rem' },
          h('span', null, f.label),
          h('div', { class: 'row', style: 'gap:.5rem' }, box, focusTag),
          h('span', { class: 'node-sub' }, f.hint),
          err,
          h('span', { class: 'node-sub' }, attrs));
        return { el: el2, box, focusTag, err, attrs };
      }
      const fv = { version: fieldView('version'), checksum: fieldView('checksum') };
      const bannerNode = liveNode('', '', null);
      const buttonNode = liveNode('Register release', '', null);
      const formLane = ui.lane('Register a release', 'billing-api');
      formLane.body.append(bannerNode.el, cols(fv.version.el, fv.checksum.el), buttonNode.el);

      const rSent = ui.readout('Requests sent', 0);
      const rInvalid = ui.readout('Fields marked invalid', 0);
      const rFocus = ui.readout('Focus on', 'nothing');
      const rFound = ui.readout('Found the field', '—');
      const respCode = ui.code('No response yet.', 'Last response');

      el.append(
        controls(versionC.el, checksumC.el),
        controls(submitBtn, dblBtn, bannerT.el, enabledT.el, resetBtn),
        stage(formLane.el),
        readouts(rSent, rInvalid, rFocus, rFound),
        verdict.el,
        cols(ui.panel('Last response', respCode), ui.panel('Requests', log.el), ui.panel('Screen reader hears', srLog.el)),
        note('The server wait is set to about 0.9 s so the pending state is visible. The rules and messages are the simulated backend\'s, which copies control-api. The artifact reference field is left out.')
      );

      // ---- input
      function typed(name, v) {
        focus = name;
        log.add('Typing in ' + FIELDS[name].label + ': set' + FIELDS[name].label + '("' + shortSum(v) + '"). The input shows the new state; earlier errors stay until the next submit.', 'muted');
        render();
      }

      function submit() {
        if (pending > 0 && !enabledT.get()) {
          log.add('Second click: Register release is disabled while the request is pending, so nothing happens', 'ok');
          return;
        }
        const body = { version: versionC.get().trim(), checksum: checksumC.get().trim() };
        const no = ++sent;
        const overlap = pending > 0;
        if (overlap) overlaps++;
        pending++;
        focus = 'button';
        log.add('#' + no + ' POST /api/v1/applications/<billing-api>/releases {"version":"' + body.version + '","checksum":"' + shortSum(body.checksum) + '"}', 'busy');
        render();
        const ep = epoch;
        AF.sleep(ctx, PENDING_MS).then(() => {
          if (!ctx.alive || ep !== epoch) return;
          pending--;
          answer(no, body, overlap);
          render();
        });
      }

      // ---- the simulated backend, with the rules of mocks/handlers/control.ts
      function answer(no, body, overlap) {
        const errors = [];
        if (!body.version || body.version.length > 64 || !VERSION_RE.test(body.version)) errors.push({ field: 'version', message: MSG_VERSION });
        if (!body.checksum || !CHECKSUM_RE.test(body.checksum)) errors.push({ field: 'checksum', message: MSG_CHECKSUM });
        fieldErr = {};
        banner = null;
        if (errors.length) {
          setCode(respCode, 'HTTP/1.1 400 Bad Request\nContent-Type: application/problem+json\n\n' + JSON.stringify({
            type: 'urn:appfleet:problem:validation-failed', title: 'Validation failed', status: 400,
            detail: 'One or more fields are invalid.', errors: errors
          }, null, 2));
          log.add('#' + no + ' 400 validation-failed, errors on ' + errors.map(e => e.field).join(' and '), 'warn');
          showErrors(errors.map(e => ({ field: e.field, text: sentence(e.message) })), 'Validation failed. One or more fields are invalid. ' + errors.map(e => e.message).join('; ') + '.', overlap);
          return;
        }
        if (registered.has(body.version)) {
          const detail = 'Release ' + body.version + ' already exists for billing-api. Releases cannot be changed once registered.';
          setCode(respCode, 'HTTP/1.1 409 Conflict\nContent-Type: application/problem+json\n\n' + JSON.stringify({
            type: 'urn:appfleet:problem:conflict', title: 'Conflict', status: 409, detail: detail
          }, null, 2));
          log.add('#' + no + ' 409 conflict: ' + body.version + ' exists', 'warn');
          showErrors([{ field: 'version', text: detail }], 'Conflict. ' + detail, overlap);
          return;
        }
        registered.add(body.version);
        setCode(respCode, 'HTTP/1.1 201 Created\nLocation: /api/v1/applications/<billing-api>/releases/<' + body.version + '>\n\n' +
          JSON.stringify({ version: body.version, checksum: shortSum(body.checksum) }, null, 2));
        log.add('#' + no + ' 201 created: release ' + body.version, 'ok');
        banner = { tone: 'ok', text: 'Release ' + body.version + ' registered.' };
        found = '—';
        srLog.add('Status: "Release ' + body.version + ' registered."', 'ok');
        if (pending > 0) {
          verdict.set('warn', 'Registered ' + body.version + '. Another request from the same form is still in flight; watch its answer.');
        } else {
          verdict.set('ok', 'Registered ' + body.version + '.' + (enabledT.get() ? '' : ' The button was disabled while the request was pending, so one click sent one request.'));
        }
      }

      function showErrors(list, bannerText, overlap) {
        if (bannerT.get()) {
          banner = { tone: 'bad', text: bannerText };
          focus = 'button';
          found = 'No';
          srLog.add('Alert: "' + bannerText + '"', 'warn');
          srLog.add('Focus is still on: Register release, button', 'muted');
          verdict.set('bad', 'One banner, no field marked. The message does not say which field it means, and focus stays on the button, so the user has to find the problem.');
          return;
        }
        list.forEach(e => { if (!(e.field in fieldErr)) fieldErr[e.field] = e.text; });
        focus = ORDER.find(f => fieldErr[f]);
        found = 'Yes: ' + FIELDS[focus].label;
        const f = FIELDS[focus];
        srLog.add(f.label + ', edit text, invalid entry. ' + f.hint + ' ' + fieldErr[focus], 'ok');
        const conflict = list.length === 1 && /already exists/.test(list[0].text);
        if (conflict && overlap) {
          verdict.set('bad', 'Two requests for one intent: the first registered the release, the second got 409 conflict, and the form now reports an error for a release that exists.');
        } else {
          verdict.set('ok', (conflict ? '409 conflict, shown on the version field. ' : '') + 'Focus moved to ' + f.label +
            ', which is marked aria-invalid and reads its hint and message.' + (Object.keys(fieldErr).length > 1 ? ' The other invalid field is marked too.' : ''));
        }
      }

      // ---- view
      function render() {
        ORDER.forEach(name => {
          const v = name === 'version' ? versionC.get() : checksumC.get();
          const view = fv[name];
          const err = fieldErr[name];
          view.box.textContent = v ? shortSum(v) : 'empty';
          AF.tone(view.box, err ? 'bad' : null);
          view.focusTag.textContent = focus === name ? 'has focus' : '';
          view.err.textContent = err ? 'Error: ' + err : '';
          view.attrs.textContent = err
            ? 'aria-invalid="true" aria-describedby="' + name + '-hint ' + name + '-err"'
            : 'aria-describedby="' + name + '-hint"';
          AF.tone(view.el, focus === name ? 'busy' : null);
        });
        const disabled = pending > 0 && !enabledT.get();
        submitBtn.disabled = disabled;
        dblBtn.disabled = disabled;
        buttonNode.set('Register release' + (focus === 'button' ? ' (has focus)' : ''),
          pending > 0 ? (enabledT.get() ? 'Still enabled while ' + plural(pending, 'request') + ' pending' : 'disabled, aria-busy="true": the request is pending') : 'enabled',
          focus === 'button' ? 'busy' : null);
        if (banner) {
          bannerNode.el.style.display = '';
          bannerNode.set(banner.tone === 'bad' ? 'The release was not registered' : 'Registered', banner.text + (banner.tone === 'bad' ? ' (role="alert")' : ' (role="status")'), banner.tone);
        } else {
          bannerNode.el.style.display = 'none';
        }
        const invalid = Object.keys(fieldErr).length;
        rSent.set(sent, overlaps ? 'warn' : null);
        rInvalid.set(invalid, invalid ? 'warn' : null);
        rFocus.set(focus === 'none' ? 'nothing' : focus === 'button' ? 'Register release' : FIELDS[focus].label);
        rFound.set(found, found === 'No' ? 'bad' : found.indexOf('Yes') === 0 ? 'ok' : null);
      }

      function reset() {
        epoch++;
        registered = new Set(SEED);
        pending = 0;
        sent = 0;
        overlaps = 0;
        fieldErr = {};
        banner = null;
        focus = 'none';
        found = '—';
        versionC.set('v 2.5');
        checksumC.set('sha256:9f2c');
        setCode(respCode, 'No response yet.');
        log.clear();
        srLog.clear();
        verdict.clear();
        render();
      }

      reset();
    }
  });

  // =====================================================================
  // 6. Routes, layouts and lazy screens
  // =====================================================================
  AF.register({
    id: 'ui-router',
    group: 'routing',
    order: 1,
    title: 'Routes, layouts and lazy screens',
    question: 'How does the console switch screens without reloading the page, and avoid downloading screens nobody opens?',
    status: 'built',
    slice: 'P1',
    where: [
      'web-console/src/app/routes.tsx',
      'web-console/src/app/App.tsx',
      'web-console/src/app/AppShell.tsx'
    ],
    idea: [
      'A client-side router maps the address to components. Clicking a link changes the address through the History API and renders the matching route, without asking the server for a new page. Routes nest: a parent route renders a layout with an <Outlet/>, and the matched child renders inside it, so the layout stays mounted while only the outlet changes.',
      'App.tsx creates one data router from src/app/routes.tsx. AppShell, with the navigation, search and <main>, is the parent route; every screen is a child rendered in its Outlet. Each child uses lazy: () => import(...), so Vite builds one chunk per screen and the router fetches it the first time someone navigates there.',
      'The first load fetches the entry chunk, with React, the router, the query cache and the shell, then the chunk for the screen you landed on. Another screen\'s chunk downloads once, on first visit; after that it is in memory and navigation is instant. Until a chunk arrives, the data router keeps the old screen on display.'
    ],
    terms: [
      ['Layout route', 'A parent route whose component renders shared chrome and an <Outlet/> where the child screen goes.'],
      ['Code splitting', 'Building the app into several files so each one downloads only when it is needed.'],
      ['Chunk', 'One of those files, here one per screen, named with a content hash so browsers can cache it.']
    ],
    tryIt: [
      'Watch the first load: the entry chunk, then the dashboard chunk, then the first paint. Press Reload (empty cache) to see it again.',
      'Press Applications, then Fleet: each downloads its chunk once while the old screen stays up. Press Dashboard: no download, instant.',
      'Turn on Bundle every screen up front: the page reloads with one big file, a later first paint, and then every screen is instant.',
      'Set Network to Slow mobile and press Reload (empty cache) with and without the switch, and compare the bars.'
    ],
    breakIt: 'Bundling every screen up front makes everyone download the fleet, access and audit screens on the first visit, even a viewer who may never open them, and the first paint waits for all of it.',
    say: 'routes.tsx is one data router with AppShell as the layout and each screen a lazy child in its Outlet, so the first load fetches only the shell and the current screen, and every other screen downloads once, on its first visit.',
    quiz: {
      q: 'A VIEWER opens the console and never visits the fleet screen. With lazy routes, what happens to the fleet screen\'s code?',
      options: [
        'It downloads in the background right after the first paint',
        'It downloads with the entry chunk but never runs',
        'It is never downloaded, because its chunk is only requested when someone navigates to /fleet',
        'It is part of the entry chunk, because AppShell imports it to build the navigation'
      ],
      answer: 2,
      why: 'lazy() calls import() only when the router matches that route. AppShell knows the fleet link, not the fleet screen\'s code, so the chunk stays on the server until somebody navigates to /fleet.'
    },
    mount(el, ctx) {
      const NETS = {
        fast: { label: 'Office Wi-Fi', kbPerMs: 2.5, rtt: 30 },
        slow: { label: 'Slow mobile', kbPerMs: 0.2, rtt: 300 }
      };
      const ENTRY = { file: 'index-3f9c2a.js', kb: 190 };
      const CHUNKS = [
        { path: '/', nav: 'Dashboard', mod: 'DashboardPage', file: 'DashboardPage-8d1e40.js', kb: 28 },
        { path: '/applications', nav: 'Applications', mod: 'ApplicationsPage', file: 'ApplicationsPage-b27c91.js', kb: 22 },
        { path: '/sessions', nav: 'Tool sessions', mod: 'SessionsPage', file: 'SessionsPage-5e0a7d.js', kb: 14 },
        { path: '/fleet', nav: 'Fleet', mod: 'FleetPage', file: 'FleetPage-c94f12.js', kb: 30 },
        { path: '/audit', nav: 'Audit trail', mod: 'AuditPage', file: 'AuditPage-71ad3e.js', kb: 26 },
        { mod: 'NewApplicationPage', kb: 10 },
        { mod: 'ApplicationPage', kb: 34 },
        { mod: 'DeployPage', kb: 18 },
        { mod: 'DeploymentPage', kb: 24 },
        { mod: 'AccessPage', kb: 20 }
      ];
      const NAVS = CHUNKS.filter(c => c.path);
      const SCREENS_KB = CHUNKS.reduce((a, c) => a + c.kb, 0);
      const BUNDLE = { file: 'index-a04be7.js', kb: ENTRY.kb + SCREENS_KB };
      const byPath = p => NAVS.find(c => c.path === p);

      let loaded = new Set();     // module names in memory
      let files = [];             // { file, kb }
      let downloaded = 0;
      let booting = false;
      let current = null;         // committed path
      let address = '/';
      let pendingPath = null;
      let navSeq = 0;
      let pageGen = 0;            // one per page load; a reload drops every download of the old page
      let inflight = new Map();   // module -> download promise, so two clicks share one request
      let firstPaint = null;
      let lastWait = null;
      let shellMounts = 0;

      const log = shortLog('Network and router log', '12rem');
      const verdict = stableVerdict();
      const net = () => NETS[netC.get()];
      const cost = kb => Math.round(net().rtt + kb / net().kbPerMs);

      // ---- controls
      const navBtns = NAVS.map(c => ui.button(c.nav, () => go(c), { small: true }));
      const reloadBtn = ui.button('Reload (empty cache)', () => { reload(); }, { variant: 'primary' });
      const netC = ui.choice('Network', [{ value: 'fast', label: NETS.fast.label }, { value: 'slow', label: NETS.slow.label }], 'fast', () => {
        log.add('Network: ' + net().label + '. It applies to the next download.', 'muted');
        drawBars();
      });
      const bundleT = ui.toggle('Bundle every screen up front', false, on => {
        log.add(on ? 'Break: the build puts every screen into one file. The page reloads.' : 'Fixed: one chunk per screen again. The page reloads.', on ? 'bad' : 'ok');
        reload();
      }, { tone: 'danger' });

      // ---- stage
      const addrTok = wrapToken('/', null);
      const shellNode = h('div', { class: 'node stack', style: 'gap:.4rem' });
      const shellSub = h('span', { class: 'node-sub' }, '');
      const outletNode = liveNode('', '', null);
      shellNode.append(h('span', null, 'AppShell'), shellSub, outletNode.el);
      const browserLane = ui.lane('Browser', ' ');
      browserLane.body.append(h('div', { class: 'stack', style: 'gap:.25rem' }, label('Address'), addrTok), shellNode);
      const filesLane = ui.lane('Downloaded files', ' ');
      const barsBox = h('div', { class: 'stack', style: 'gap:.4rem' });

      const rDown = ui.readout('Downloaded', '0 KB');
      const rPaint = ui.readout('First paint', '—');
      const rWait = ui.readout('Last navigation waited', '—');
      const rShell = ui.readout('AppShell mounts', 0);
      const rState = ui.readout('navigation.state', 'idle');

      el.append(
        controls(label('Go to'), ...navBtns),
        controls(reloadBtn, netC.el, bundleT.el),
        stage(cols(browserLane.el, filesLane.el)),
        readouts(rDown, rPaint, rWait, rShell, rState),
        verdict.el,
        cols(ui.panel('Time to show a screen on this network', barsBox), ui.panel('Log', log.el)),
        note('Illustrative: chunk sizes, file names and network speeds are made up, and times count transfer only, not parsing. The real sizes come from the Vite build output. The route chunk starts after the entry chunk runs, because only then does the router know which screen to load.')
      );

      // ---- loading
      /** Downloads one file. Resolves to its time in ms, or null if the page was reloaded meanwhile. */
      async function fetchFile(f) {
        const gen = pageGen;
        const ms = cost(f.kb);
        await AF.sleep(ctx, ms);
        if (!ctx.alive || gen !== pageGen) return null;
        files.push({ file: f.file || f.mod + '.js', kb: f.kb });
        downloaded += f.kb;
        log.add('GET /assets/' + (f.file || f.mod + '.js') + ', ' + f.kb + ' KB, about ' + ms + ' ms', 'muted');
        return ms;
      }

      async function reload() {
        const seq = ++navSeq;
        pageGen++;
        inflight = new Map();
        const path = address;
        booting = true;
        loaded = new Set();
        files = [];
        downloaded = 0;
        current = null;
        pendingPath = path;
        firstPaint = null;
        lastWait = null;
        shellMounts = 0;
        log.add('Reload with an empty cache: GET ' + path + ' returns index.html, which asks for the entry script', 'busy');
        render();
        let total = 0;
        if (bundleT.get()) {
          const ms = await fetchFile(BUNDLE);
          if (ms === null || seq !== navSeq) return;
          total += ms;
          CHUNKS.forEach(c => loaded.add(c.mod));
          log.add('The one file holds every screen, so the router renders ' + byPath(path).mod + ' at once', 'muted');
        } else {
          const ms1 = await fetchFile(ENTRY);
          if (ms1 === null || seq !== navSeq) return;
          total += ms1;
          const c = byPath(path);
          log.add('The entry runs: the router matches ' + path + ' and calls its lazy(), which imports ' + c.mod, 'muted');
          const ms2 = await fetchFile(c);
          if (ms2 === null || seq !== navSeq) return;
          total += ms2;
          loaded.add(c.mod);
        }
        booting = false;
        current = path;
        pendingPath = null;
        shellMounts = 1;
        firstPaint = total;
        log.add('First paint after about ' + total + ' ms: AppShell mounts, and ' + byPath(path).mod + ' renders in its Outlet', 'ok');
        render();
      }

      async function go(c) {
        if (booting) return;
        if (c.path === current && !pendingPath) {
          log.add('Already on ' + c.path + '.', 'muted');
          return;
        }
        const seq = ++navSeq;
        pendingPath = c.path;
        if (loaded.has(c.mod)) {
          commit(c, 0);
          return;
        }
        let p = inflight.get(c.mod);
        if (p) {
          log.add('Navigate to ' + c.path + ': ' + c.mod + ' is already downloading, so the router waits for the same request', 'busy');
        } else {
          log.add('Navigate to ' + c.path + ': ' + c.mod + ' is not loaded, so lazy() imports it. navigation.state is loading, and ' + byPath(current).mod + ' stays on screen.', 'busy');
          p = fetchFile(c);
          inflight.set(c.mod, p);
        }
        render();
        const ms = await p;
        if (ms === null) return;
        inflight.delete(c.mod);
        loaded.add(c.mod);
        if (seq !== navSeq) {
          if (pendingPath !== c.path) log.add(c.mod + ' arrived after a newer navigation started. It stays in memory for later.', 'muted');
          render();
          return;
        }
        commit(c, ms);
      }

      function commit(c, ms) {
        current = c.path;
        address = c.path;
        pendingPath = null;
        lastWait = ms;
        log.add(ms ? 'Commit: the address becomes ' + c.path + '. AppShell stays mounted; its Outlet renders ' + c.mod + '.'
          : 'Navigate to ' + c.path + ': ' + c.mod + ' is already in memory, so no request. The router commits at once.', ms ? 'ok' : 'ok');
        render();
      }

      // ---- view
      function drawBars() {
        const n = net();
        const split = cost(ENTRY.kb) + cost(byPath('/').kb);
        const one = cost(BUNDLE.kb);
        const later = cost(byPath('/fleet').kb);
        const max = Math.max(split, one, later);
        const fmt = v => v + ' ms';
        AF.clear(barsBox).append(
          ui.bar({ label: 'First paint on /, split', max, value: split, tone: 'ok', format: fmt }).el,
          ui.bar({ label: 'First paint on /, one bundle', max, value: one, tone: 'bad', format: fmt }).el,
          ui.bar({ label: 'First visit to Fleet, split', max, value: later, tone: 'ok', format: fmt }).el,
          ui.bar({ label: 'First visit to Fleet, one bundle', max, value: 0, tone: 'bad', format: fmt }).el,
          label('Bundle: ' + BUNDLE.kb + ' KB on the first visit. Split: ' + (ENTRY.kb + byPath('/').kb) + ' KB, then ' + byPath('/fleet').kb + ' KB when Fleet is first opened. ' + n.label + '.')
        );
      }

      function render() {
        const loading = !!pendingPath && !booting;
        addrTok.textContent = (current || address) + (loading ? '  (loading ' + pendingPath + ')' : '');
        browserLane.title.lastChild.textContent = net().label;
        if (booting) {
          shellSub.textContent = 'not mounted yet: the entry script is still downloading';
          AF.tone(shellNode, 'idle');
          outletNode.set('Outlet', 'empty', 'idle');
        } else {
          shellSub.textContent = 'layout route: navigation, search and <main>, mounted once';
          AF.tone(shellNode, null);
          const c = byPath(current);
          outletNode.set('Outlet: ' + c.mod, loading ? 'still showing while ' + byPath(pendingPath).mod + ' downloads' : 'rendered for ' + current, loading ? 'warn' : 'ok');
        }
        navBtns.forEach((b, i) => {
          b.disabled = booting;
          b.setAttribute('aria-current', !booting && NAVS[i].path === current ? 'page' : 'false');
        });

        filesLane.title.lastChild.textContent = plural(files.length, 'file');
        AF.clear(filesLane.body);
        files.forEach(f => filesLane.body.appendChild(wrapToken(f.file + ' · ' + f.kb + ' KB', f.kb > 300 ? 'bad' : f.file.indexOf('index') === 0 ? 'busy' : 'ok')));
        if (!files.length) filesLane.body.appendChild(label('Nothing yet.'));
        const inMemory = NAVS.filter(c => loaded.has(c.mod)).map(c => c.nav);
        filesLane.body.appendChild(label('Screens in memory: ' + (inMemory.length ? inMemory.join(', ') : 'none') + (bundleT.get() && loaded.size ? ', and every other screen' : '')));

        rDown.set(downloaded + ' KB', downloaded > 300 ? 'bad' : null);
        rPaint.set(firstPaint === null ? (booting ? 'waiting' : '—') : '~' + firstPaint + ' ms', firstPaint !== null && firstPaint > 1500 ? 'warn' : null);
        rWait.set(lastWait === null ? '—' : lastWait ? '~' + lastWait + ' ms' : 'instant', lastWait === 0 ? 'ok' : null);
        rShell.set(shellMounts);
        rState.set(booting ? 'booting' : loading ? 'loading' : 'idle', loading || booting ? 'busy' : null);

        if (booting) {
          verdict.set('busy', bundleT.get() ? 'First visit: downloading one file with every screen in it.' : 'First visit: downloading the entry chunk, then the chunk for ' + pendingPath + '.');
        } else if (loading) {
          verdict.set('busy', 'Loading ' + byPath(pendingPath).mod + '. The data router keeps ' + byPath(current).mod + ' on screen until the chunk arrives.');
        } else if (bundleT.get()) {
          verdict.set('bad', 'One bundle: ' + downloaded + ' KB before the first paint at about ' + firstPaint + ' ms, including screens this visitor may never open. Every later navigation is instant.');
        } else if (lastWait === 0) {
          verdict.set('ok', 'Instant: that screen\'s chunk was already in memory. AppShell stayed mounted; only the Outlet changed.');
        } else if (lastWait) {
          verdict.set('ok', 'First visit to this screen: one ' + byPath(current).kb + ' KB chunk, about ' + lastWait + ' ms. The next visit is instant.');
        } else {
          verdict.set('ok', 'Split by route: ' + downloaded + ' KB before the first paint at about ' + firstPaint + ' ms. Other screens download when first opened.');
        }
      }

      drawBars();
      reload();
    }
  });

  // =====================================================================
  // 7. Permission gating
  // =====================================================================
  AF.register({
    id: 'ui-guards',
    group: 'routing',
    order: 2,
    title: 'Permission gating',
    question: 'How does the console keep people out of screens they may not use without telling them those screens exist?',
    status: 'built',
    slice: 'P1, P3',
    where: [
      'web-console/src/app/RequirePermission.tsx',
      'web-console/src/app/NotFoundPage.tsx',
      'web-console/src/auth/permissions.ts',
      'web-console/src/app/AppShell.tsx'
    ],
    idea: [
      'The console reads the signed-in user\'s permissions, such as fleet:read, user:manage or audit:read, and asks can(permission). It never checks role names: VIEWER, DEPLOYER, OPERATOR, ADMIN and AUDITOR are bundles of permissions defined by the identity service, so the same check keeps working when a bundle changes.',
      'AppShell filters its navigation with can(), so people only see links they can use. Hiding a link does not stop anyone typing the address, so routes.tsx wraps fleet, access and audit in RequirePermission. Without the permission it renders NotFoundPage, the same page as an address that does not exist, so probing addresses reveals nothing.',
      'All of this is convenience. The API checks the same permissions on every request and refuses with 403 or 404, so someone who got past the console would still get no data. The console\'s job is to avoid showing screens that can only fail. Until identity-service ships (P3), the simulated backend issues the permissions.'
    ],
    terms: [
      ['Permission', 'One action on one kind of object, such as fleet:read. Roles are bundles of them.'],
      ['Guard', 'A component that renders its children only when a check passes.'],
      ['Enumeration', 'Learning what exists by probing addresses and comparing the answers.']
    ],
    tryIt: [
      'With Signed in as VIEWER, pick each address: /fleet, /access, /audit and /nowhere all render the same Page not found, and the navigation shows three links.',
      'Switch to AUDITOR: Audit trail appears in the navigation and /audit opens; /fleet still says not found.',
      'Back on VIEWER, turn on Hide the link, skip the guard and pick /fleet: the screen opens, then its API calls fail with 403.',
      'Turn that off and turn on Say Forbidden instead of not found: /fleet now differs from /nowhere, and Screens revealed by probing counts what a probe learns.'
    ],
    breakIt: 'Hide only the link and anyone who types /fleet gets a screen whose every call fails. Answer Forbidden instead of not found, and comparing /fleet with /nowhere tells a probing user which screens exist.',
    say: 'The console filters its navigation with can(permission) and wraps protected routes in RequirePermission, which renders the same not-found page as an unknown address, while the API enforces the same permissions, so the UI gate is convenience and never the security boundary.',
    quiz: {
      q: 'A VIEWER types /audit into the address bar. What does the console show, and why?',
      options: [
        'Page not found, the same page as any unknown address, because RequirePermission hides the screen without confirming that it exists',
        'The audit screen with empty tables, because the API returns no rows to viewers',
        'A 403 Forbidden page, so the user knows to ask for access',
        'Nothing: the router blocks the navigation and stays on the current page'
      ],
      answer: 0,
      why: 'The VIEWER bundle has no audit:read, so RequirePermission renders NotFoundPage. A Forbidden page would be friendlier but would confirm the screen exists; the API makes the same choice by answering 404 for objects you may not see.'
    },
    mount(el, ctx) {
      const VIEWER_P = ['application:read', 'deployment:read', 'session:use'];
      const DEPLOYER_P = VIEWER_P.concat(['application:create', 'release:create', 'deployment:create', 'deployment:rollback']);
      const OPERATOR_P = DEPLOYER_P.concat(['fleet:read', 'node:drain', 'task:reclaim', 'dlq:replay', 'projection:rebuild', 'catalog:publish']);
      const PERMS = {
        VIEWER: VIEWER_P,
        DEPLOYER: DEPLOYER_P,
        OPERATOR: OPERATOR_P,
        ADMIN: OPERATOR_P.concat(['user:manage', 'audit:read']),
        AUDITOR: VIEWER_P.concat(['audit:read'])
      };
      const NAV = [
        { label: 'Dashboard', perm: 'deployment:read' },
        { label: 'Applications', perm: 'application:read' },
        { label: 'Tool sessions', perm: 'session:use' },
        { label: 'Fleet and dead letters', perm: 'fleet:read' },
        { label: 'Access', perm: 'user:manage' },
        { label: 'Audit trail', perm: 'audit:read' }
      ];
      const ADDRS = {
        '/fleet': { screen: 'Fleet and dead letters', perm: 'fleet:read', calls: [['GET /api/v1/fleet', 'The fleet view needs OPERATOR.'], ['GET /api/v1/dlq', 'The dead-letter queue needs OPERATOR.']] },
        '/access': { screen: 'Access', perm: 'user:manage', calls: [['GET /api/v1/users', 'Managing users needs ADMIN.']] },
        '/audit': { screen: 'Audit trail', perm: 'audit:read', calls: [['GET /api/v1/audit', 'The audit trail needs audit:read.']] },
        '/nowhere': { screen: null }
      };
      const PROTECTED = ['/fleet', '/access', '/audit'];

      let epoch = 0;
      let callsDone = false;

      const log = shortLog('Router log');
      const verdict = stableVerdict();
      const can = p => PERMS[roleC.get()].includes(p);

      // ---- controls
      const roleC = ui.choice('Signed in as', Object.keys(PERMS).map(r => ({ value: r, label: r })), 'VIEWER', () => {
        log.add('Signed in as ' + roleC.get() + ': ' + PERMS[roleC.get()].join(', '), 'muted');
        visit();
      });
      const addrC = ui.choice('Type the address', Object.keys(ADDRS).map(a => ({ value: a, label: a })), '/fleet', () => visit());
      const skipT = ui.toggle('Hide the link, skip the guard', false, on => {
        log.add(on ? 'Break: routes.tsx renders the screens without RequirePermission; only the links are hidden' : 'Fixed: RequirePermission guards fleet, access and audit again', on ? 'bad' : 'ok');
        visit();
      }, { tone: 'danger' });
      const forbidT = ui.toggle('Say Forbidden instead of not found', false, on => {
        log.add(on ? 'Break: the guard renders a Forbidden page instead of NotFoundPage' : 'Fixed: the guard renders NotFoundPage, like an unknown address', on ? 'bad' : 'ok');
        visit();
      }, { tone: 'danger' });

      // ---- stage
      const navLane = ui.lane('Navigation', ' ');
      const browserLane = ui.lane('Browser', ' ');
      const probeLane = ui.lane('What each address renders', ' ');
      const addrTok = wrapToken('', null);
      const titleTok = wrapToken('', null);
      const pageNode = liveNode('', '', null);
      const callsBox = h('div', { class: 'stack', style: 'gap:.3rem' });
      browserLane.body.append(
        h('div', { class: 'stack', style: 'gap:.25rem' }, label('Address'), addrTok),
        h('div', { class: 'stack', style: 'gap:.25rem' }, label('Tab title'), titleTok),
        pageNode.el,
        callsBox
      );

      const rLinks = ui.readout('Links shown', '');
      const rRenders = ui.readout('This address renders', '');
      const rApi = ui.readout('API answers', '');
      const rRevealed = ui.readout('Screens revealed by probing', 0);

      el.append(
        controls(roleC.el),
        controls(addrC.el),
        controls(skipT.el, forbidT.el),
        stage(cols(navLane.el, browserLane.el, probeLane.el)),
        readouts(rLinks, rRenders, rApi, rRevealed),
        verdict.el,
        log.el,
        note('Permission bundles and 403 messages are the simulated backend\'s (mocks/db.ts and mocks/handlers). can() here ignores teams. The guard sits inside each lazy route, so the screen\'s code still downloads for a blocked user; it holds no data.')
      );

      function outcome(addr) {
        const a = ADDRS[addr];
        if (!a.screen) return 'notfound';
        if (can(a.perm)) return 'screen';
        if (skipT.get()) return 'broken';
        if (forbidT.get()) return 'forbidden';
        return 'notfound';
      }

      function describe(kind, a) {
        if (kind === 'notfound') return 'Page not found';
        if (kind === 'forbidden') return '403 Forbidden: ' + a.screen;
        if (kind === 'broken') return a.screen + ', every call failing';
        return a.screen;
      }

      function visit() {
        const ep = ++epoch;
        callsDone = false;
        const addr = addrC.get();
        const a = ADDRS[addr];
        const kind = outcome(addr);
        if (!a.screen) log.add('Typed ' + addr + ': no route matches, so the * route renders NotFoundPage', 'muted');
        else if (kind === 'screen') log.add('Typed ' + addr + ': RequirePermission checks can("' + a.perm + '"): true, so ' + a.screen + ' renders', 'ok');
        else if (kind === 'broken') log.add('Typed ' + addr + ': no guard, so ' + a.screen + ' renders and starts its queries', 'bad');
        else if (kind === 'forbidden') log.add('Typed ' + addr + ': can("' + a.perm + '") is false, and the guard says Forbidden', 'bad');
        else log.add('Typed ' + addr + ': can("' + a.perm + '") is false, so RequirePermission renders NotFoundPage', 'ok');
        render();
        if (kind === 'screen' || kind === 'broken') {
          ctx.timeout(() => {
            if (ep !== epoch) return;
            callsDone = true;
            a.calls.forEach(([call, msg]) => log.add(kind === 'screen' ? call + ': 200' : call + ': 403 forbidden, "' + msg + '"', kind === 'screen' ? 'ok' : 'bad'));
            render();
          }, 450);
        }
      }

      function render() {
        const role = roleC.get();
        const addr = addrC.get();
        const a = ADDRS[addr];
        const kind = outcome(addr);

        // navigation
        AF.clear(navLane.body);
        let shown = 0;
        NAV.forEach(n => {
          const ok = can(n.perm);
          if (ok) shown++;
          const node = ui.node(n.label, ok ? 'shown: can("' + n.perm + '")' : 'hidden: needs ' + n.perm);
          AF.tone(node, ok ? null : 'idle');
          navLane.body.appendChild(node);
        });
        navLane.title.lastChild.textContent = role;

        // browser
        addrTok.textContent = addr;
        titleTok.textContent = (kind === 'notfound' ? 'Page not found' : kind === 'forbidden' ? 'Forbidden' : a.screen) + ' - Appfleet';
        if (kind === 'notfound') pageNode.set('Page not found', 'This page does not exist, or you do not have access to it.', 'idle');
        else if (kind === 'forbidden') pageNode.set('403 Forbidden', 'You do not have access to ' + a.screen + '.', 'warn');
        else if (kind === 'broken') pageNode.set(a.screen, callsDone ? 'ErrorNotice: Forbidden. ' + a.calls[0][1] : 'Loading…', callsDone ? 'bad' : 'busy');
        else pageNode.set(a.screen, callsDone ? 'Data loaded' : 'Loading…', callsDone ? 'ok' : 'busy');
        AF.clear(callsBox);
        if (kind === 'screen' || kind === 'broken') {
          a.calls.forEach(([call]) => callsBox.appendChild(wrapToken(call + (callsDone ? (kind === 'screen' ? ' · 200' : ' · 403 forbidden') : ' · pending'),
            callsDone ? (kind === 'screen' ? 'ok' : 'bad') : 'busy')));
        } else {
          callsBox.appendChild(label('No API calls: the screen never rendered.'));
        }
        browserLane.title.lastChild.textContent = describe(kind, a);

        // probes
        AF.clear(probeLane.body);
        const nowhere = describe(outcome('/nowhere'), ADDRS['/nowhere']);
        let revealed = 0;
        Object.keys(ADDRS).forEach(p => {
          const k = outcome(p);
          const d = describe(k, ADDRS[p]);
          const blocked = PROTECTED.includes(p) && !can(ADDRS[p].perm);
          const leaks = blocked && d !== nowhere;
          if (leaks) revealed++;
          const sub = p === '/nowhere' ? 'unknown address'
            : !blocked ? 'allowed for ' + role
              : leaks ? 'differs from /nowhere: it exists' : 'same as /nowhere';
          const node = ui.node(p + ': ' + d, sub);
          AF.tone(node, leaks ? 'bad' : k === 'screen' ? 'ok' : 'idle');
          if (p === addr) node.style.outline = '2px solid var(--signal)';
          probeLane.body.appendChild(node);
        });
        probeLane.title.lastChild.textContent = role;

        rLinks.set(shown + ' of ' + NAV.length);
        rRenders.set(kind === 'notfound' ? 'Not found' : kind === 'forbidden' ? 'Forbidden' : kind === 'broken' ? 'Broken screen' : 'The screen',
          kind === 'screen' ? 'ok' : kind === 'notfound' ? null : 'bad');
        rApi.set(kind === 'screen' ? (callsDone ? '200' : 'pending') : kind === 'broken' ? (callsDone ? '403' : 'pending') : 'none',
          kind === 'broken' && callsDone ? 'bad' : null);
        rRevealed.set(revealed, revealed ? 'bad' : 'ok');

        if (kind === 'broken') {
          verdict.set('bad', 'The screen opened for ' + role + ' and ' + (callsDone ? 'every call failed with 403' : 'its calls are on the way') +
            '. The API enforced the rule, so no data leaked, but the user got a broken screen and learned that ' + addr + ' exists.');
        } else if (kind === 'forbidden') {
          verdict.set('bad', 'Forbidden for ' + addr + ', Page not found for /nowhere: the difference confirms that ' + addr + ' exists. Probing reveals ' + plural(revealed, 'screen') + '.');
        } else if (kind === 'screen') {
          verdict.set('ok', role + ' has ' + a.perm + ': the link is shown and the screen opens with its data.');
        } else if (a.screen) {
          verdict.set('ok', 'Page not found, exactly like /nowhere. ' + role + ' cannot tell whether ' + addr + ' exists, and the API would refuse its calls anyway.');
        } else {
          verdict.set('ok', 'Unknown address: Page not found.' + (revealed ? ' Compare it with the protected addresses on the right.' : ' Protected screens ' + role + ' may not open look exactly like this.'));
        }
      }

      visit();
    }
  });

  // =====================================================================
  // 8. State in the address
  // =====================================================================
  AF.register({
    id: 'ui-url-state',
    group: 'routing',
    order: 3,
    title: 'State in the address',
    question: 'Where should a filter live so that a reload, a shared link and the Back button all keep it?',
    status: 'built',
    slice: 'P1',
    where: [
      'web-console/src/features/dashboard/DashboardPage.tsx',
      'web-console/src/features/applications/ApplicationsPage.tsx',
      'web-console/src/features/audit/AuditPage.tsx',
      'web-console/src/features/deploy/DeployPage.tsx'
    ],
    idea: [
      'Some state decides what a screen shows: a filter, a selected item, a search. Kept in component state, it vanishes on reload, a copied link opens the unfiltered screen, and Back skips it. Kept in the address\'s search params, the URL describes the view, so it survives a reload, can be shared, and a change can become a history entry.',
      'The console reads these with useSearchParams. The dashboard\'s status filter is ?status=flight, the applications list filters on ?q=, the audit trail opens the event for ?cid= from any error notice\'s link, and the deploy screen keeps its choice in ?release= and ?env=.',
      'A write can push a new history entry or replace the current one. The dashboard\'s filter buttons push, so Back undoes a filter. Typing replaces: ApplicationsPage calls setParams with { replace: true }, because otherwise every keystroke would become an entry and Back would walk through b, bi, bil. DeployPage replaces too, so Back leaves the form.'
    ],
    terms: [
      ['Search params', 'The ?key=value part of a URL. useSearchParams reads it, and setParams writes it.'],
      ['Push', 'Adds a history entry: Back returns to the previous state.'],
      ['Replace', 'Overwrites the current entry: Back skips over the change.']
    ],
    tryIt: [
      'Press Needs attention: the address becomes /?status=attention and the list filters. Press Reload: the filter stays.',
      'Press Copy link and open in a new tab: tab 2 shows the same filtered list.',
      'Turn on Keep the filter in component state and choose In flight: the address stays /. Press Copy link and open in a new tab, then Reload: tab 2, and then tab 1, show All.',
      'Press Type bill in Filter applications, then Back: one press returns to the dashboard. Turn on Push an entry per keystroke and repeat: Back walks through each letter.'
    ],
    breakIt: 'Keep a filter in component state and the URL no longer describes the view: a reload drops it, a shared link opens the unfiltered list, and Back skips over it. Push on every keystroke and Back walks back one letter at a time.',
    say: 'Filters and selections live in search params, like ?status= on the dashboard and ?q= on applications, so reloads, shared links and Back all keep them; clicks push history entries and typing replaces the current one.',
    quiz: {
      q: 'Why does ApplicationsPage pass { replace: true } when the filter text changes?',
      options: [
        'Replace is faster than push, because the router does not re-render',
        'Without it the filter would not survive a reload',
        'Push would keep the filter in component state instead of the URL',
        'Each keystroke would otherwise add a history entry, so Back would step through every partial word before leaving the page'
      ],
      answer: 3,
      why: 'Push and replace both put the filter in the URL, so reloads and shared links work either way. The difference is history: one entry per keystroke turns Back into an undo for single letters.'
    },
    mount(el, ctx) {
      const DEPLOYS = [
        ['billing-api 2.4.0', 'staging', 'DEPLOYING'],
        ['checkout-web 5.12.0', 'dev', 'DEPLOYING'],
        ['ledger-worker 0.18.2', 'prod', 'DEGRADED'],
        ['billing-api 2.5.0-rc1', 'qa', 'FAILED'],
        ['checkout-web 5.11.4', 'staging', 'HEALTHY'],
        ['billing-api 2.3.0', 'prod', 'ROLLED_BACK']
      ];
      const GROUPS = { flight: ['PENDING', 'VALIDATING', 'DEPLOYING'], attention: ['DEGRADED', 'FAILED'], finished: ['HEALTHY', 'ROLLED_BACK'] };
      const TONE = { DEPLOYING: 'busy', DEGRADED: 'bad', FAILED: 'bad', HEALTHY: 'ok', ROLLED_BACK: 'idle' };
      const LABEL = { all: 'All', flight: 'In flight', attention: 'Needs attention', finished: 'Finished' };
      const APPS = ['billing-api', 'checkout-web', 'ledger-worker', 'search-indexer', 'query-gateway'];

      let tabs = [];
      let epoch = 0;
      let typing = false;

      const log = shortLog('History log');
      const verdict = stableVerdict();

      const urlStr = u => u.path + (u.status ? '?status=' + u.status : u.q ? '?q=' + encodeURIComponent(u.q) : '');
      const newTab = u => ({ history: [u], index: 0, comp: 'all' });
      const cur = t => t.history[t.index];
      const statusOf = t => (compT.get() ? t.comp : (cur(t).status || 'all'));
      /** Leaving a screen unmounts it, so its component state is gone when you come back. */
      function moved(t, prevPath) {
        if (cur(t).path === prevPath) return;
        if (prevPath === '/') t.lost = t.comp;
        t.comp = 'all';
      }
      function push(t, u) { const p = cur(t).path; t.history = t.history.slice(0, t.index + 1); t.history.push(u); t.index++; moved(t, p); }
      function replace(t, u) { t.history[t.index] = u; }

      // ---- controls
      const statusC = ui.choice('Status', Object.keys(LABEL).map(k => ({ value: k, label: LABEL[k] })), 'all', v => setStatus(v));
      const typeBtn = ui.button('Type bill in Filter applications', () => { typeBill(); });
      const copyBtn = ui.button('Copy link and open in a new tab', copyLink);
      const reloadBtn = ui.button('Reload', reload);
      const backBtn = ui.button('Back', back);
      const compT = ui.toggle('Keep the filter in component state', false, on => {
        epoch++;
        typing = false;
        tabs = [newTab({ path: '/' })];
        log.add(on ? 'Break: DashboardPage keeps the filter in useState(\'all\') and no longer reads ?status=. The code changed, so the page reloads.'
          : 'Fixed: the filter lives in ?status= again. The page reloads.', on ? 'bad' : 'ok');
        verdict.clear();
        render();
      }, { tone: 'danger' });
      const pushT = ui.toggle('Push an entry per keystroke', false, on => {
        log.add(on ? 'Break: the filter box calls setParams without { replace: true }' : 'Fixed: the filter box replaces the current entry again', on ? 'bad' : 'ok');
      }, { tone: 'danger' });
      const resetBtn = ui.button('Reset', reset, { variant: 'quiet' });

      // ---- stage
      const lanes = [ui.lane('Tab 1', ' '), ui.lane('Tab 2', 'not open')];
      const histLane = ui.lane('Tab 1 history', ' ');
      const rTab1 = ui.readout('Tab 1 shows', '');
      const rTab2 = ui.readout('Tab 2 shows', '—');
      const rEntries = ui.readout('History entries, tab 1', 1);
      const rBack = ui.readout('Back presses to the dashboard', 0);

      el.append(
        controls(statusC.el),
        controls(typeBtn, copyBtn, reloadBtn, backBtn),
        controls(compT.el, pushT.el, resetBtn),
        stage(cols(lanes[0].el, lanes[1].el, histLane.el)),
        readouts(rTab1, rTab2, rEntries, rBack),
        verdict.el,
        log.el,
        note('Illustrative rows. The status groups are the dashboard\'s: in flight is PENDING, VALIDATING or DEPLOYING; needs attention is DEGRADED or FAILED; finished is HEALTHY or ROLLED_BACK.')
      );

      // ---- actions
      function setStatus(v) {
        const t = tabs[0];
        if (cur(t).path !== '/') return;
        if (compT.get()) {
          if (t.comp === v) return;
          t.comp = v;
          log.add('setStatus("' + v + '"): the list filters, and the address stays ' + urlStr(cur(t)), 'warn');
        } else {
          const next = v === 'all' ? { path: '/' } : { path: '/', status: v };
          if (urlStr(next) === urlStr(cur(t))) return;
          push(t, next);
          log.add('setParams: push ' + urlStr(next), 'ok');
        }
        verdict.clear();
        render();
      }

      function copyLink() {
        const u = cur(tabs[0]);
        tabs[1] = newTab(Object.assign({}, u));
        log.add('Copied ' + urlStr(u) + ' and opened it in tab 2: a fresh page, so component state starts empty', 'busy');
        const s1 = statusOf(tabs[0]);
        const s2 = statusOf(tabs[1]);
        if (u.path !== '/') verdict.set('ok', 'Tab 2 opened ' + urlStr(u) + ' and shows the same filtered list.');
        else if (s1 === s2) verdict.set('ok', 'Tab 2 opened ' + urlStr(u) + ' and shows ' + LABEL[s2] + ', the same as tab 1.');
        else verdict.set('bad', 'The link was just ' + urlStr(u) + ', so tab 2 shows All while tab 1 shows ' + LABEL[s1] + '. The filter never reached the address.');
        render();
      }

      function reload() {
        const t = tabs[0];
        const before = statusOf(t);
        t.comp = 'all';
        log.add('Reload tab 1: the address and history stay; component state starts again', 'busy');
        const after = statusOf(t);
        if (cur(t).path !== '/') verdict.set('ok', 'Reloaded: ' + urlStr(cur(t)) + ' came back from the address.');
        else if (before === after) verdict.set('ok', 'Reloaded: the dashboard shows ' + LABEL[after] + (compT.get() ? '.' : ', read back from the address.'));
        else verdict.set('bad', 'Reloaded: the filter was only in component state, so the dashboard opened on All instead of ' + LABEL[before] + '.');
        render();
      }

      function back() {
        const t = tabs[0];
        if (t.index === 0 || typing) return;
        const p = cur(t).path;
        t.index--;
        moved(t, p);
        const u = cur(t);
        log.add('Back: tab 1 shows ' + urlStr(u), 'busy');
        if (u.path !== '/') {
          verdict.clear();
        } else if (p !== '/') {
          if (compT.get()) {
            const lost = t.lost && t.lost !== 'all';
            verdict.set(lost ? 'bad' : 'ok', lost
              ? 'Back on the dashboard, but it mounted again with useState(\'all\'): the ' + LABEL[t.lost] + ' filter is gone.'
              : 'Back on the dashboard.');
          } else {
            verdict.set('ok', 'Back on the dashboard' + (u.status ? ': ?status=' + u.status + ' brought the ' + LABEL[u.status] + ' filter back.' : '.'));
          }
        } else {
          verdict.set('ok', 'Back undid the last filter change: the dashboard shows ' + LABEL[statusOf(t)] + '.');
        }
        render();
      }

      async function typeBill() {
        if (typing) return;
        typing = true;
        const ep = epoch;
        const t = tabs[0];
        verdict.clear();
        if (cur(t).path !== '/applications') {
          push(t, { path: '/applications' });
          log.add('Click Applications in the navigation: push /applications', 'busy');
        } else if (cur(t).q) {
          replace(t, { path: '/applications' });
          log.add('Clear the filter box: replace with /applications', 'muted');
        }
        render();
        let q = '';
        for (const ch of 'bill') {
          await AF.sleep(ctx, ctx.reducedMotion ? 80 : 260);
          if (!ctx.alive || ep !== epoch) return;
          q += ch;
          const u = { path: '/applications', q };
          if (pushT.get()) push(t, u);
          else replace(t, u);
          log.add('Keystroke "' + ch + '": setParams({ q: "' + q + '" }' + (pushT.get() ? '): push' : ', { replace: true }): replace'), pushT.get() ? 'warn' : 'muted');
          render();
        }
        typing = false;
        const presses = backCount(t);
        verdict.set(pushT.get() ? 'bad' : 'ok', pushT.get()
          ? 'Each keystroke pushed an entry: Back now takes ' + presses + ' presses to reach the dashboard, one letter at a time.'
          : 'Typing replaced one entry, so one Back returns to the dashboard with its filter.');
        render();
      }

      function backCount(t) {
        for (let j = t.index; j >= 0; j--) if (t.history[j].path === '/') return t.index - j;
        return null;
      }

      // ---- view
      function renderTab(lane, t, n) {
        AF.clear(lane.body);
        if (!t) {
          lane.title.lastChild.textContent = 'not open';
          lane.body.appendChild(label('Press Copy link and open in a new tab.'));
          return 'not open';
        }
        const u = cur(t);
        lane.title.lastChild.textContent = n === 1 ? 'your tab' : 'opened from the link';
        lane.body.appendChild(h('div', { class: 'stack', style: 'gap:.25rem' }, label('Address'), wrapToken(urlStr(u), null)));
        if (u.path === '/') {
          const st = statusOf(t);
          lane.body.appendChild(h('div', { class: 'row', style: 'gap:.4rem' }, h('b', null, 'Dashboard'), label('Status: ' + LABEL[st])));
          DEPLOYS.filter(d => st === 'all' || GROUPS[st].includes(d[2])).forEach(d => {
            lane.body.appendChild(h('div', { class: 'node row', style: 'justify-content:space-between;gap:.4rem' },
              h('span', null, d[0] + ' · ' + d[1]), ui.token(d[2], TONE[d[2]])));
          });
          return 'Dashboard, ' + LABEL[st];
        }
        lane.body.appendChild(h('div', { class: 'row', style: 'gap:.4rem' }, h('b', null, 'Applications'), label('Filter: ' + (u.q ? '"' + u.q + '"' : 'empty'))));
        APPS.filter(a => !u.q || a.includes(u.q)).forEach(a => lane.body.appendChild(ui.node(a)));
        return 'Applications' + (u.q ? ', "' + u.q + '"' : '');
      }

      function render() {
        const t = tabs[0];
        const onDash = cur(t).path === '/';
        statusC.set(onDash ? statusOf(t) : 'all');
        choiceDisabled(statusC, !onDash || typing);
        const s1 = renderTab(lanes[0], t, 1);
        const s2 = renderTab(lanes[1], tabs[1], 2);

        AF.clear(histLane.body);
        histLane.title.lastChild.textContent = plural(t.history.length, 'entry', 'entries');
        t.history.forEach((u, i) => {
          histLane.body.appendChild(wrapToken((i + 1) + '. ' + urlStr(u) + (i === t.index ? '  (current)' : ''), i === t.index ? 'busy' : null));
        });

        const presses = backCount(t);
        rTab1.set(s1);
        rTab2.set(s2);
        rEntries.set(t.history.length, t.history.length > 4 && pushT.get() ? 'warn' : null);
        rBack.set(presses === null ? '—' : presses, presses > 1 ? 'bad' : null);
        backBtn.disabled = t.index === 0 || typing;
        typeBtn.disabled = typing;
        copyBtn.disabled = typing;
        reloadBtn.disabled = typing;
      }

      function reset() {
        epoch++;
        typing = false;
        tabs = [newTab({ path: '/' })];
        log.clear();
        verdict.clear();
        render();
      }

      reset();
    }
  });

  // =====================================================================
  // 9. Focus after navigation
  // =====================================================================
  AF.register({
    id: 'ui-focus',
    group: 'routing',
    order: 4,
    title: 'Focus after navigation',
    question: 'When a click swaps the screen without a page load, how do keyboard and screen-reader users find out where they are?',
    status: 'built',
    slice: 'P1',
    where: [
      'web-console/src/app/AppShell.tsx',
      'web-console/src/hooks/useDocumentTitle.ts',
      'web-console/src/app/AppShell.module.css'
    ],
    idea: [
      'A full page load starts focus at the top of a new document, and a screen reader announces the new page. A client-side navigation only swaps part of the DOM. The browser does not move focus, so it stays on the link you used, or falls to the page body if that link was removed, and a screen reader says nothing about the new screen.',
      'AppShell fixes this with an effect on location.pathname: it moves focus to <main>, which has tabIndex={-1} so code can focus it without adding a Tab stop, and scrolls to the top. It skips the first render, when the page has just loaded. useDocumentTitle gives every screen its own tab title, such as "Applications - Appfleet", which also names history entries.',
      'Two more aids: a "Skip to content" link, the first thing Tab reaches, jumps past the navigation to #main, and NavLink marks the link for the current screen with aria-current="page", so a screen reader says "current page" there.'
    ],
    terms: [
      ['Focus', 'The element that receives keyboard input. Tab moves it forward, Shift+Tab back.'],
      ['tabIndex -1', 'Lets an element take focus from code, or from a #link, without becoming a Tab stop.'],
      ['aria-current', 'Marks the item that represents the current page in a set of links.']
    ],
    tryIt: [
      'Press Tab twice: the skip link, then Dashboard, read as current page.',
      'Press Tab once more to reach Applications and press Enter: the screen changes, focus moves to main, and the screen reader names the new screen.',
      'Press Tab: one press reaches the first link in the new content.',
      'Turn on Leave focus where it was, press Shift+Tab four times to reach Dashboard and press Enter: focus stays on that link, nothing is announced, and reaching the content takes 4 Tabs. Press Tab four times, then Enter on Deploy an application: focus falls to the page body.'
    ],
    breakIt: 'Without moving focus, a keyboard user stays in the navigation after every click and has to tab through it again, and a screen-reader user hears nothing, so the screen changed without telling them. If the link was inside the old screen, focus falls to the page body.',
    say: 'After a client-side navigation the browser leaves focus where it was, so AppShell moves focus to <main> and scrolls to the top in an effect on the pathname, useDocumentTitle names each screen, NavLink sets aria-current, and a skip link jumps past the navigation.',
    quiz: {
      q: 'Why does <main> get tabIndex={-1} rather than tabIndex={0}?',
      options: [
        'tabIndex={-1} hides the element from screen readers until it is focused',
        'tabIndex={0} would stop the skip link from working',
        'It lets code focus <main> after navigation without adding an extra Tab stop that keyboard users would land on every time',
        'Negative values put the element first in the Tab order'
      ],
      answer: 2,
      why: 'An element with tabIndex -1 can be focused by script, and by the skip link\'s #main target, but Tab passes it by. With 0, every trip through the page would stop on the whole content area, which does nothing when activated.'
    },
    mount(el, ctx) {
      const NAV = [
        { label: 'Dashboard', to: '/', end: true },
        { label: 'Applications', to: '/applications' },
        { label: 'Fleet and dead letters', to: '/fleet' }
      ];
      const appScreen = name => ({
        title: name, h1: name,
        items: [{ label: 'Applications', kind: 'link', to: '/applications', note: 'breadcrumb' }, { label: 'Deploy', kind: 'link', to: '/applications/' + name + '/deploy', note: 'ButtonLink, still a link' }]
      });
      const SCREENS = {
        '/': { title: 'Dashboard', h1: 'What is happening now', items: [{ label: 'Deploy an application', kind: 'link', to: '/applications', note: 'ButtonLink, still a link' }, { label: 'billing-api', kind: 'link', to: '/applications/billing-api' }] },
        '/applications': { title: 'Applications', h1: 'Applications', items: [{ label: 'billing-api', kind: 'link', to: '/applications/billing-api' }, { label: 'checkout-web', kind: 'link', to: '/applications/checkout-web' }] },
        '/applications/billing-api': appScreen('billing-api'),
        '/applications/checkout-web': appScreen('checkout-web'),
        '/applications/billing-api/deploy': { title: 'New deployment', h1: 'New deployment', items: [{ label: 'billing-api', kind: 'link', to: '/applications/billing-api', note: 'breadcrumb' }] },
        '/applications/checkout-web/deploy': { title: 'New deployment', h1: 'New deployment', items: [{ label: 'checkout-web', kind: 'link', to: '/applications/checkout-web', note: 'breadcrumb' }] },
        '/fleet': { title: 'Fleet and dead letters', h1: 'Fleet and dead letters', items: [{ label: 'Drain', kind: 'button', name: 'Drain dev-node-01' }, { label: 'Replay', kind: 'button', name: 'Replay dead letter 0192d1f0' }] }
      };

      let path = '/';
      let focus = 'body';
      let bodyWhy = 'load';     // 'load' | 'removed'
      let scroll = '—';
      let lastNav = null;       // { tone, text }
      let tabsToContent = null;

      const log = shortLog('What happened');
      const srLog = shortLog('Screen reader');
      const verdict = stableVerdict();

      const screen = () => SCREENS[path];
      const titleOf = () => screen().title + ' - Appfleet';
      const isCurrent = i => (NAV[i].end ? path === NAV[i].to : path === NAV[i].to || path.indexOf(NAV[i].to + '/') === 0);
      function stops() {
        const s = ['skip'];
        NAV.forEach((n, i) => s.push('nav:' + i));
        s.push('search');
        screen().items.forEach((it, i) => s.push('item:' + i));
        return s;
      }
      function nameOf(stop) {
        if (stop === 'skip') return 'Skip to content';
        if (stop === 'search') return 'Search applications';
        if (stop === 'main') return 'main';
        if (stop === 'body') return 'page body';
        const [kind, n] = stop.split(':');
        if (kind === 'nav') return NAV[+n].label;
        const it = screen().items[+n];
        return it.name || it.label;
      }
      function speak(stop) {
        if (stop === 'skip') return 'Skip to content, link';
        if (stop === 'search') return 'Search applications, search edit text';
        if (stop === 'main') return 'Main landmark. ' + screen().h1 + ', heading level 1';
        const [kind, n] = stop.split(':');
        if (kind === 'nav') return NAV[+n].label + ', link' + (isCurrent(+n) ? ', current page' : '');
        const it = screen().items[+n];
        return (it.name || it.label) + ', ' + (it.kind === 'button' ? 'button' : 'link');
      }
      function countTabs() {
        const order = stops();
        const first = order.findIndex(s => s.indexOf('item:') === 0);
        if (first < 0) return null;
        if (focus === 'main') return 1;
        if (focus === 'body') return first + 1;
        const at = order.indexOf(focus);
        return at < first ? first - at : null;
      }

      // ---- controls
      const tabBtn = ui.button('Tab', () => move(1), { variant: 'primary' });
      const shiftBtn = ui.button('Shift+Tab', () => move(-1));
      const enterBtn = ui.button('Enter', enter);
      const breakT = ui.toggle('Leave focus where it was', false, on => {
        log.add(on ? 'Break: AppShell no longer moves focus or scrolls after navigation' : 'Fixed: AppShell\'s effect focuses <main> and scrolls to the top after each navigation', on ? 'bad' : 'ok');
      }, { tone: 'danger' });
      const resetBtn = ui.button('Reset', reset, { variant: 'quiet' });

      // ---- stage
      const titleTok = wrapToken('', null);
      const addrTok = wrapToken('', null);
      const navLane = ui.lane('Top of the page', 'AppShell');
      const mainLane = ui.lane('<main id="main" tabIndex={-1}>', ' ');
      const bodyTok = wrapToken('Focus is on the page body', 'warn');

      const rFocus = ui.readout('Focus on', '');
      const rTitle = ui.readout('Tab title', '');
      const rScroll = ui.readout('Scroll after the last navigation', '—');
      const rTabs = ui.readout('Tabs to reach the new content', '—');

      el.append(
        controls(tabBtn, shiftBtn, enterBtn, breakT.el, resetBtn),
        stage(
          h('div', { class: 'row', style: 'margin-bottom:.6rem;gap:.4rem 1rem' },
            h('div', { class: 'stack', style: 'gap:.2rem;min-width:0' }, label('Tab title'), titleTok),
            h('div', { class: 'stack', style: 'gap:.2rem;min-width:0' }, label('Address'), addrTok)),
          cols(navLane.el, mainLane.el),
          h('div', { style: 'margin-top:.6rem' }, bodyTok)
        ),
        readouts(rFocus, rTitle, rScroll, rTabs),
        verdict.el,
        cols(ui.panel('What happened', log.el), ui.panel('Screen reader says', srLog.el)),
        note('The screen-reader lines are approximate; wording differs between screen readers. The navigation shows three of the console\'s links. Past the last stop, Tab moves into the browser\'s own controls; here it wraps to the top.')
      );

      // ---- keys
      function announce(stop) { srLog.add(speak(stop), 'ok'); }

      function move(dir) {
        const order = stops();
        let next;
        if (focus === 'main') {
          next = dir > 0 ? (order.find(s => s.indexOf('item:') === 0) || order[0]) : 'search';
        } else if (focus === 'body') {
          next = dir > 0 ? order[0] : order[order.length - 1];
          if (bodyWhy === 'removed') log.add('Focus was on the page body. Here the next Tab starts from the top; some browsers continue from where the removed link was.', 'muted');
        } else {
          let j = order.indexOf(focus) + dir;
          if (j >= order.length) { j = 0; log.add('Past the last stop: focus would move to the browser\'s own controls. Wrapping to the top.', 'muted'); }
          if (j < 0) { j = order.length - 1; log.add('Before the first stop: wrapping to the end.', 'muted'); }
          next = order[j];
        }
        focus = next;
        log.add((dir > 0 ? 'Tab' : 'Shift+Tab') + ': focus on ' + nameOf(next), 'muted');
        announce(next);
        render();
      }

      function enter() {
        const f = focus;
        if (f === 'skip') {
          focus = 'main';
          log.add('Enter on the skip link: href="#main" moves focus to <main>, past the navigation', 'ok');
          announce('main');
          render();
          return;
        }
        if (f === 'main' || f === 'body') {
          log.add('Enter does nothing on ' + nameOf(f) + '.', 'muted');
          return;
        }
        if (f === 'search') {
          log.add('Enter submits the empty search form: navigate("/applications")', 'muted');
          navigate('/applications', f);
          return;
        }
        const [kind, n] = f.split(':');
        if (kind === 'nav') { navigate(NAV[+n].to, f); return; }
        const it = screen().items[+n];
        if (it.kind === 'button') {
          log.add('Enter would activate ' + it.name + '. This walkthrough follows links only.', 'muted');
          return;
        }
        navigate(it.to, f);
      }

      function navigate(to, from) {
        if (to === path) {
          log.add('Already on ' + to + ': the pathname did not change, so AppShell\'s effect does not run and focus stays put.', 'muted');
          return;
        }
        const prevName = nameOf(from);
        path = to;
        log.add('Navigate to ' + to + ': React Router swaps the screen inside <main>; useDocumentTitle sets "' + titleOf() + '"', 'busy');
        if (!breakT.get()) {
          focus = 'main';
          scroll = 'Reset to top';
          log.add('AppShell\'s effect on location.pathname: focus <main> (preventScroll), then window.scrollTo(0, 0)', 'ok');
          announce('main');
          tabsToContent = countTabs();
          lastNav = { tone: 'ok', text: 'Focus moved to main and the screen reader read the new heading.' + (tabsToContent ? ' One Tab reaches the new content.' : '') };
        } else {
          scroll = 'Left where it was';
          const removed = from.indexOf('item:') === 0;
          if (removed) {
            focus = 'body';
            bodyWhy = 'removed';
            log.add('The focused link belonged to the old screen and was removed with it: focus falls to the page body', 'bad');
          } else {
            log.add('Focus stays on ' + prevName + '; the browser has no reason to move it', 'bad');
          }
          srLog.add('(silence: focus did not move to anything new, so nothing is read)', 'muted');
          tabsToContent = countTabs();
          const reach = tabsToContent === null ? '' : ', and reaching the new content takes ' + plural(tabsToContent, 'Tab');
          lastNav = removed
            ? { tone: 'bad', text: 'The link you used was removed with the old screen, so focus fell to the page body. Nothing was announced' + reach + ' from the top.' }
            : { tone: 'bad', text: 'Focus stayed on ' + prevName + (from.indexOf('nav:') === 0 ? ' in the navigation' : '') + '. Nothing was announced' + reach + '.' };
        }
        render();
      }

      // ---- view
      function stopNode(stop, text, sub) {
        const has = focus === stop;
        const n = ui.node((has ? 'Focus: ' : '') + text, sub);
        AF.tone(n, has ? 'busy' : null);
        if (has) n.style.outline = '3px solid var(--signal)';
        return n;
      }

      function render() {
        titleTok.textContent = titleOf();
        addrTok.textContent = path;
        AF.clear(navLane.body);
        navLane.body.appendChild(stopNode('skip', 'Skip to content', 'href="#main", visible only while focused'));
        NAV.forEach((n, i) => navLane.body.appendChild(stopNode('nav:' + i, n.label, 'NavLink to ' + n.to + (isCurrent(i) ? ', aria-current="page"' : ''))));
        navLane.body.appendChild(stopNode('search', 'Search applications', 'search box'));

        AF.clear(mainLane.body);
        mainLane.title.lastChild.textContent = focus === 'main' ? 'has focus' : '';
        AF.tone(mainLane.el, focus === 'main' ? 'busy' : null);
        mainLane.el.style.outline = focus === 'main' ? '3px solid var(--signal)' : '';
        mainLane.body.appendChild(h('b', null, screen().h1));
        screen().items.forEach((it, i) => mainLane.body.appendChild(stopNode('item:' + i, it.name || it.label,
          (it.kind === 'button' ? 'button' : 'link to ' + it.to) + (it.note ? ' · ' + it.note : ''))));
        bodyTok.style.display = focus === 'body' ? '' : 'none';
        bodyTok.textContent = bodyWhy === 'removed' ? 'Focus is on the page body: the element that had it was removed' : 'Focus is on the page body: the page has just loaded';

        rFocus.set(nameOf(focus), focus === 'body' && bodyWhy === 'removed' ? 'bad' : null);
        rTitle.set(titleOf());
        rScroll.set(scroll, scroll === 'Left where it was' ? 'bad' : scroll === 'Reset to top' ? 'ok' : null);
        rTabs.set(tabsToContent === null ? '—' : tabsToContent, tabsToContent === null ? null : tabsToContent > 1 ? 'bad' : 'ok');
        if (lastNav) verdict.set(lastNav.tone, lastNav.text);
        else verdict.clear();
      }

      function reset() {
        path = '/';
        focus = 'body';
        bodyWhy = 'load';
        scroll = '—';
        lastNav = null;
        tabsToContent = null;
        log.clear();
        srLog.clear();
        log.add('Page loaded at /. Focus starts on the page body; the first Tab reaches the skip link.', 'muted');
        render();
      }

      reset();
    }
  });
})();
