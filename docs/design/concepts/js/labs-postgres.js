/*
 * labs-postgres.js: the "Postgres and JPA" lessons for "How Appfleet works".
 *
 * Nine lessons, one AF.register call each. Every simulation keeps a small model in JS,
 * builds its DOM from AF.h and AF.ui atoms, and schedules time only through ctx.
 * Facts and measurements come from docs/design/control-api and docs/specs/project
 * as of 2026-10-02. Anything that was not measured is labelled illustrative in the UI.
 */
(function () {
  'use strict';

  const h = AF.h;
  const ui = AF.ui;
  const SVGNS = 'http://www.w3.org/2000/svg';

  // ---------- shared helpers ----------

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

  // Deployment state machine, exactly as DeploymentState.canTransitionTo.
  const STATES = ['PENDING', 'VALIDATING', 'DEPLOYING', 'HEALTHY', 'DEGRADED', 'FAILED', 'ROLLED_BACK'];
  const LEGAL = {
    PENDING: ['VALIDATING'],
    VALIDATING: ['DEPLOYING', 'FAILED'],
    DEPLOYING: ['HEALTHY', 'FAILED'],
    HEALTHY: ['DEGRADED', 'ROLLED_BACK'],
    DEGRADED: ['HEALTHY', 'ROLLED_BACK'],
    FAILED: [],
    ROLLED_BACK: []
  };
  const canTransition = (from, to) => LEGAL[from].indexOf(to) >= 0;
  const isFinal = st => LEGAL[st].length === 0;

  // =====================================================================
  // 1. Deployment state machine
  // =====================================================================
  AF.register({
    id: 'pg-fsm',
    group: 'postgres',
    order: 1,
    title: 'Deployment state machine',
    question: 'How do you stop code from moving a deployment into a state that makes no sense, such as FAILED straight back to HEALTHY?',
    status: 'built',
    slice: 'S2',
    where: [
      'DeploymentState.canTransitionTo, Deployment.transitionTo',
      'DeploymentTest, DeploymentStateTest',
      'DeploymentService.requestRollback, RollbackAlreadyRequestedException',
      'docs/specs/project/01-CONTROL-API.md, "The Deployment state machine"'
    ],
    idea: [
      'A state machine lists every state an object can be in and the moves allowed between them. Instead of letting any code write any status, every change goes through one method that checks the list first and refuses anything not on it. The rules live in one place, so they cannot drift apart.',
      'In Appfleet the enum DeploymentState owns its legal moves in canTransitionTo. Deployment.transitionTo throws IllegalTransitionException for anything else, which the API returns as 409 illegal-transition. FAILED and ROLLED_BACK are final. A rollback request is legal only from HEALTHY or DEGRADED: it records a ROLLBACK task in PENDING and returns 202, but leaves status alone, because nothing has rolled back yet.',
      'current_status is a deliberate copy of status for fast reads. transitionTo does not touch it; an AFTER_COMMIT listener will own it in S6, when the enum is also refactored to the State pattern. The CHECK constraint in the database knows the seven legal values, not the legal moves, so the enum is the only guard on transitions.'
    ],
    terms: [
      ['State machine', 'A fixed set of states plus the moves allowed between them; every other move is rejected.'],
      ['409 illegal-transition', 'The ProblemDetail Appfleet returns when a requested move is not in the enum’s list.'],
      ['Final state', 'A state with no way out. FAILED and ROLLED_BACK are final.'],
      ['Denormalised column', 'A copy of data kept for faster reads. Something must keep it in step with the original.']
    ],
    tryIt: [
      'Press "VALIDATING", then "DEPLOYING", then "HEALTHY": each move is legal and the version goes up.',
      'Now press "PENDING" or "FAILED" and read the 409 illegal-transition in the log.',
      'Press "Request rollback" twice: the first returns 202 with a PENDING task, the second gets 409 conflict.',
      'Press "Reset", turn on "Let controllers set status directly", then press "HEALTHY": the deployment skips validation entirely.'
    ],
    breakIt: 'With "Let controllers set status directly" on, status becomes a plain setter. PENDING can jump to HEALTHY with no validation and no deploy, and a FAILED deployment can come back to life; the CHECK constraint accepts both because the values themselves are legal.',
    say: 'Deployment status is an enum that owns its legal transitions, every change goes through transitionTo and an illegal move is a 409, and rollback only records intent as a task so the API never reports a state the system has not reached.',
    quiz: {
      q: 'A HEALTHY deployment receives POST /api/v1/deployments/{id}/rollback. What does Appfleet return, and what happens to status?',
      options: [
        '200, and status becomes ROLLED_BACK at once',
        '202, and status becomes ROLLED_BACK while the task is recorded',
        '202 with a ROLLBACK task in PENDING; status stays HEALTHY',
        '409 illegal-transition, because a rollback must go through DEGRADED first'
      ],
      answer: 2,
      why: 'Rollback records intent. Moving status to ROLLED_BACK before anything has rolled back would make the response a lie; the worker that executes the task (S5, S6) is what changes status.'
    },
    mount(el, ctx) {
      const uid = 'pgfsm' + Math.floor(Math.random() * 1e9);
      const W = 124;
      const H = 36;
      const POS = {
        PENDING: [10, 50], VALIDATING: [170, 50], DEPLOYING: [330, 50], HEALTHY: [490, 50],
        DEGRADED: [660, 50], FAILED: [250, 190], ROLLED_BACK: [575, 190]
      };
      // [from, to, start point, end point]
      const EDGES = [
        ['PENDING', 'VALIDATING', [134, 68], [170, 68]],
        ['VALIDATING', 'DEPLOYING', [294, 68], [330, 68]],
        ['DEPLOYING', 'HEALTHY', [454, 68], [490, 68]],
        ['HEALTHY', 'DEGRADED', [614, 61], [660, 61]],
        ['DEGRADED', 'HEALTHY', [660, 76], [614, 76]],
        ['VALIDATING', 'FAILED', [232, 86], [290, 190]],
        ['DEPLOYING', 'FAILED', [392, 86], [334, 190]],
        ['HEALTHY', 'ROLLED_BACK', [552, 86], [615, 190]],
        ['DEGRADED', 'ROLLED_BACK', [722, 86], [659, 190]]
      ];
      let m;
      let taskSeq = 0;

      const log = ui.log({ label: 'Deployment events' });
      const verdict = ui.verdict();
      const rStatus = ui.readout('status');
      const rCurrent = ui.readout('current_status');
      const rVersion = ui.readout('version');
      const rTask = ui.readout('Rollback task');
      const rIllegal = ui.readout('Illegal moves stored');

      const direct = ui.toggle('Let controllers set status directly', false, on => {
        log.add(on
          ? 'Break switch on: status is a plain setter now. Nothing asks canTransitionTo.'
          : 'Break switch off: every change goes through transitionTo again.', on ? 'warn' : 'muted');
        verdict.clear();
        render();
      }, { tone: 'danger' });
      const targetBtns = {};
      STATES.forEach(st => {
        targetBtns[st] = ui.button(st, () => move(st), { small: true, title: 'Move the deployment to ' + st });
      });
      const rollbackBtn = ui.button('Request rollback', requestRollback, { variant: 'primary' });
      const finishBtn = ui.button('Run the rollback task', finishRollback);
      const resetBtn = ui.button('Reset', reset, { variant: 'quiet' });

      const diagram = s('svg', { class: 'chart', viewBox: '0 0 800 252', role: 'img', style: { minWidth: '620px', maxWidth: '820px' } });
      const legalLine = h('p', { class: 'small' });
      const tasksRow = h('div', { class: 'row' });

      const openTask = () => m.tasks.find(t => t.status === 'PENDING');
      const marker = (id, colour) => s('marker', { id, viewBox: '0 0 10 10', refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: 'auto-start-reverse' },
        s('path', { d: 'M0,0 L10,5 L0,10 z', style: { fill: colour } }));

      function drawDiagram() {
        AF.clear(diagram);
        diagram.appendChild(s('defs', null, marker(uid + 'i', 'var(--rail)'), marker(uid + 'h', 'var(--signal)'), marker(uid + 'b', 'var(--bad)')));
        diagram.appendChild(s('text', { x: 10, y: 38 }, 'POST /deployments creates PENDING'));
        EDGES.forEach(e => {
          const hot = e[0] === m.status;
          diagram.appendChild(s('line', {
            x1: e[2][0], y1: e[2][1], x2: e[3][0], y2: e[3][1],
            'marker-end': 'url(#' + uid + (hot ? 'h' : 'i') + ')',
            style: { stroke: hot ? 'var(--signal)' : 'var(--rail)', strokeWidth: hot ? '2.5' : '1.5' }
          }));
        });
        // Illegal moves that the break switch let through: dashed curves over the diagram.
        m.forced.forEach(pair => {
          const ax = POS[pair[0]][0] + W / 2, ay = POS[pair[0]][1];
          const bx = POS[pair[1]][0] + W / 2, by = POS[pair[1]][1];
          const cx = (ax + bx) / 2, cy = Math.min(ay, by) - 44;
          diagram.appendChild(s('path', {
            d: `M${ax},${ay} Q${cx},${cy} ${bx},${by}`,
            'marker-end': 'url(#' + uid + 'b)',
            style: { fill: 'none', stroke: 'var(--bad)', strokeWidth: '2', strokeDasharray: '6 4' }
          }));
        });
        STATES.forEach(st => {
          const x = POS[st][0], y = POS[st][1];
          const now = st === m.status;
          const next = canTransition(m.status, st);
          diagram.appendChild(s('rect', {
            x, y, width: W, height: H, rx: 6,
            style: {
              fill: now ? 'var(--signal-wash)' : 'var(--white)',
              stroke: now || next ? 'var(--signal)' : 'var(--rail)',
              strokeWidth: now ? '2.5' : '1.2',
              strokeDasharray: isFinal(st) ? '5 3' : 'none'
            }
          }));
          diagram.appendChild(s('text', { x: x + W / 2, y: y + 22, 'text-anchor': 'middle', style: { fill: 'var(--ink)', fontWeight: now ? '700' : '500' } },
            st + (now ? ' (now)' : '')));
        });
        diagram.appendChild(s('text', { x: 312, y: 244, 'text-anchor': 'middle' }, 'final'));
        diagram.appendChild(s('text', { x: 637, y: 244, 'text-anchor': 'middle' }, 'final'));
        const legal = LEGAL[m.status];
        diagram.setAttribute('aria-label', 'Deployment state diagram. Now ' + m.status + '. ' +
          (legal.length ? 'Legal next: ' + legal.join(', ') + '.' : 'Final state, no legal moves.'));
      }

      function render() {
        drawDiagram();
        const legal = LEGAL[m.status];
        legalLine.textContent = legal.length
          ? `Legal from ${m.status}: ${legal.join(', ')}. Every other button is an illegal move.`
          : `${m.status} is final: every button is an illegal move.`;
        STATES.forEach(st => AF.tone(targetBtns[st], canTransition(m.status, st) ? 'ok' : null));
        rStatus.set(m.status);
        const stale = m.current !== m.status;
        rCurrent.set(m.current + (stale ? ' (stale)' : ''), stale ? 'warn' : null);
        rVersion.set(m.version);
        const open = openTask();
        rTask.set(open ? open.id + ' PENDING' : 'none open', open ? 'busy' : null);
        rIllegal.set(m.illegal, m.illegal ? 'bad' : null);
        finishBtn.disabled = !open;
        AF.clear(tasksRow);
        tasksRow.appendChild(label('Tasks on this deployment:'));
        if (!m.tasks.length) tasksRow.appendChild(label('none yet'));
        m.tasks.forEach(t => tasksRow.appendChild(ui.token(`${t.id} ROLLBACK ${t.status}`,
          t.status === 'PENDING' ? 'busy' : t.status === 'SUCCEEDED' ? 'ok' : 'bad')));
      }

      function consequence(from, to) {
        if (isFinal(from)) {
          return `${from} is final, yet the deployment moved to ${to}.` + (isFinal(to) ? '' :
            ' The partial unique index counts it as active again, so it can block a real new deployment to the same environment.');
        }
        if (to === 'HEALTHY') return `${from} to HEALTHY skipped the steps in between: no validation passed and no agent reported the release up, yet the record says HEALTHY.`;
        if (to === 'ROLLED_BACK') return `${from} to ROLLED_BACK: the record says a rollback happened, but no ROLLBACK task ever ran.`;
        return `${from} to ${to} is not a legal move. The CHECK constraint knows legal values, not legal moves, so nothing stopped it.`;
      }

      function move(target) {
        const from = m.status;
        if (direct.get()) {
          if (from === target) {
            log.add(`setStatus(${target}): same value, nothing written.`, 'muted');
            return;
          }
          const legal = canTransition(from, target);
          m.status = target;
          m.version++;
          if (legal) {
            log.add(`setStatus(${target}) from ${from}: no check, but legal anyway. UPDATE deployment SET status = '${target}', version = ${m.version}`, 'ok');
            verdict.set('ok', `${from} to ${target} happens to be legal, so nothing went wrong this time. Try an illegal one.`);
          } else {
            m.illegal++;
            m.forced.push([from, target]);
            log.add(`setStatus(${target}) from ${from}: no check. UPDATE deployment SET status = '${target}', version = ${m.version}`, 'bad');
            log.add(`CHECK (status IN (...)) passes: ${target} is a legal value, so Postgres stores the row.`, 'warn');
            verdict.set('bad', 'Stored. ' + consequence(from, target));
          }
        } else if (!canTransition(from, target)) {
          log.add(`transitionTo(${target}) from ${from}: IllegalTransitionException`, 'bad');
          log.add(`409 urn:appfleet:problem:illegal-transition "Illegal transition from ${from} to ${target}"`, 'bad');
          verdict.set('bad', `409 illegal-transition. ${from} cannot move to ${target}, so status stays ${from} and nothing is written.`);
        } else {
          m.status = target;
          m.version++;
          log.add(`transitionTo(${target}) from ${from}: ok. UPDATE deployment SET status = '${target}', version = ${m.version}`, 'ok');
          verdict.set('ok', `${from} to ${target} is legal. status is ${target} at version ${m.version}; current_status still says ${m.current}, because transitionTo never touches it.`);
        }
        render();
      }

      function requestRollback() {
        log.add('POST /api/v1/deployments/{id}/rollback', 'busy');
        log.add(`findLockedById (OPTIMISTIC_FORCE_INCREMENT): status ${m.status}, version ${m.version}`, 'muted');
        if (!canTransition(m.status, 'ROLLED_BACK')) {
          log.add(`409 urn:appfleet:problem:illegal-transition: ${m.status} cannot be rolled back`, 'bad');
          verdict.set('bad', '409 illegal-transition. Rollback is legal only from HEALTHY or DEGRADED; the service asks canTransitionTo(ROLLED_BACK) instead of repeating that list.');
        } else if (openTask()) {
          log.add('RollbackAlreadyRequestedException: a ROLLBACK task is still PENDING', 'bad');
          log.add('409 urn:appfleet:problem:conflict "A rollback is already pending for this deployment."', 'bad');
          verdict.set('bad', '409 conflict. One rollback is already open, so a second one is refused instead of piling up tasks.');
        } else {
          const t = { id: 'task-' + (++taskSeq), status: 'PENDING' };
          m.tasks.push(t);
          m.version++;
          log.add(`INSERT task (ROLLBACK, PENDING); audit ROLLBACK_REQUESTED; COMMIT forces version to ${m.version}`, 'ok');
          log.add(`202 Accepted, Location: /api/v1/tasks/${t.id}`, 'ok');
          verdict.set('ok', `202 Accepted. ${t.id} is a PENDING ROLLBACK task and status is still ${m.status}: nothing has rolled back yet, so the API does not claim it has.`);
        }
        render();
      }

      function finishRollback() {
        const t = openTask();
        if (!t) return;
        if (canTransition(m.status, 'ROLLED_BACK')) {
          const from = m.status;
          t.status = 'SUCCEEDED';
          m.status = 'ROLLED_BACK';
          m.version++;
          log.add(`Worker runs ${t.id}: task SUCCEEDED, then transitionTo(ROLLED_BACK) from ${from}, version ${m.version}`, 'ok');
          verdict.set('ok', `Now the rollback really happened, so status moves to ROLLED_BACK, which is final. current_status still says ${m.current}.`);
        } else {
          t.status = 'FAILED';
          log.add(`Worker runs ${t.id}: transitionTo(ROLLED_BACK) from ${m.status} is illegal, task FAILED`, 'bad');
          verdict.set('bad', `The task could not finish: ${m.status} cannot move to ROLLED_BACK.`);
        }
        render();
      }

      function reset() {
        m = { status: 'PENDING', current: 'PENDING', version: 0, tasks: [], illegal: 0, forced: [] };
        taskSeq = 0;
        log.clear();
        verdict.clear();
        log.add('POST /api/v1/deployments: new deployment, status PENDING, current_status PENDING, version 0', 'muted');
        render();
      }

      el.append(
        controls(label('transitionTo:'), STATES.map(st => targetBtns[st])),
        controls(direct.el, rollbackBtn, finishBtn, resetBtn),
        stage(h('div', { class: 'stack' }, diagram, legalLine, tasksRow)),
        readouts(rStatus, rCurrent, rVersion, rTask, rIllegal),
        note('"Run the rollback task" stands in for the planned worker (S5, S6) that executes the task and calls transitionTo(ROLLED_BACK); today nothing runs it. Nothing updates current_status until the S6 AFTER_COMMIT listener.'),
        verdict.el,
        log.el
      );
      reset();
    }
  });

  // =====================================================================
  // 2. Optimistic locking
  // =====================================================================
  AF.register({
    id: 'pg-optimistic',
    group: 'postgres',
    order: 2,
    title: 'Optimistic locking',
    question: 'What stops two callers who read the same deployment from silently overwriting each other’s change?',
    status: 'built',
    slice: 'S2',
    where: [
      'Deployment @Version, V3__add_deployment_version.sql',
      'DeploymentOptimisticLockTest',
      'DeploymentRepository.findLockedById, OPTIMISTIC_FORCE_INCREMENT',
      'DeploymentEndpointsTest.concurrentRollbacks_one202_one409_exactlyOneTask'
    ],
    idea: [
      'Optimistic locking assumes conflicts are rare, so reading takes no lock. Each row carries a version number. A write says "update this row, but only if the version is still the one I read" and bumps it. If someone else wrote first, the update matches zero rows and fails, instead of silently erasing their change.',
      'Deployment has @Version (the column comes from V3__add_deployment_version.sql), so Hibernate writes UPDATE ... SET version = N+1 WHERE id = ? AND version = N. The loser gets ObjectOptimisticLockingFailureException, returned as 409 concurrent-modification. Appfleet fails fast and never retries automatically: a transition is a decision made on state the caller saw, so the caller re-reads and decides again.',
      'Rollback requests reuse the idea. requestRollback loads the deployment with OPTIMISTIC_FORCE_INCREMENT, which bumps the version at commit even though no column changed. Two concurrent rollbacks then collide: one 202, the other 409 concurrent-modification, and exactly one ROLLBACK task exists.'
    ],
    terms: [
      ['Optimistic locking', 'Read without locking; at write time, check that nobody changed the row since you read it.'],
      ['Version column', 'A counter bumped on every write. The UPDATE matches only if the counter still holds the value you read.'],
      ['Lost update', 'Two writers read the same row and the second write silently erases the first.'],
      ['OPTIMISTIC_FORCE_INCREMENT', 'A JPA lock mode that bumps the version at commit even when the row itself did not change.']
    ],
    tryIt: [
      'Press "Play the race": both sessions read VALIDATING at version 1, and the second save gets 409 concurrent-modification.',
      'Press the loser’s load button ("A loads" or "B loads") to re-read, then its save button to decide again on fresh data.',
      'Turn on "Turn off @Version" and play the race again: both saves succeed and one decision is lost.',
      'Pick "Two rollbacks" and play it with "Remove the force-increment lock" off, then on.'
    ],
    breakIt: 'Without the version check both UPDATEs match the row and the last writer wins: the first caller’s transition vanishes and nobody gets an error. Without the force-increment lock, two concurrent rollbacks both return 202 and leave two ROLLBACK tasks.',
    say: 'Deployment uses @Version so a stale write matches zero rows and fails with 409, we deliberately do not retry because a transition is a decision on observed state, and rollback uses OPTIMISTIC_FORCE_INCREMENT so concurrent requests collide on the version.',
    quiz: {
      q: 'Two callers both read a deployment in VALIDATING at version 1. A saves DEPLOYING first. What happens when B then saves FAILED?',
      options: [
        'B is retried automatically on fresh data, and the status becomes FAILED',
        'B gets 409 concurrent-modification: its UPDATE ... WHERE version = 1 matches no row',
        'B gets 409 illegal-transition, because VALIDATING to FAILED is illegal',
        'Both succeed, and the final status is FAILED'
      ],
      answer: 1,
      why: 'B’s UPDATE carries the version it read. A already moved the row to version 2, so zero rows match and Spring throws ObjectOptimisticLockingFailureException. Appfleet does not retry for B, because B decided on a state it no longer sees.'
    },
    mount(el, ctx) {
      const TARGET = { A: 'DEPLOYING', B: 'FAILED' };
      let db;
      let sess;
      let runId = 0;
      let playing = false;
      let landed = 0;
      let lost = 0;

      const log = ui.log({ label: 'SQL and responses' });
      const verdict = ui.verdict();
      const sqlBox = ui.code('-- the last statement appears here', 'Last SQL statement');
      const rStatus = ui.readout('Row status');
      const rVersion = ui.readout('Row version');
      const rLanded = ui.readout('Writes that landed');
      const rExtra = ui.readout('Lost updates');

      const scenario = ui.choice('Scenario', [
        { value: 'transition', label: 'Two transitions' },
        { value: 'rollback', label: 'Two rollbacks' }
      ], 'transition', () => reset());
      const order = ui.choice('Who saves first', [
        { value: 'A', label: 'Session A' },
        { value: 'B', label: 'Session B' }
      ], 'A');
      const noVersion = ui.toggle('Turn off @Version', false, on => {
        reset();
        log.add(on ? 'Break switch on: Deployment has no @Version, so the UPDATE has no version condition.' : 'Break switch off: @Version is back.', on ? 'warn' : 'muted');
      }, { tone: 'danger' });
      const noLock = ui.toggle('Remove the force-increment lock', false, on => {
        reset();
        log.add(on ? 'Break switch on: findLockedById loses @Lock(OPTIMISTIC_FORCE_INCREMENT).' : 'Break switch off: the force-increment lock is back.', on ? 'warn' : 'muted');
      }, { tone: 'danger' });
      const playBtn = ui.button('Play the race', play, { variant: 'primary' });
      const resetBtn = ui.button('Reset', () => reset(), { variant: 'quiet' });

      const isTx = () => scenario.get() === 'transition';

      function sessionLane(name) {
        const lane = ui.lane('Session ' + name, 'wants');
        const loadBtn = ui.button(name + ' loads', () => load(name), { small: true });
        const saveBtn = ui.button(name + ' saves', () => save(name), { small: true });
        const steps = h('div', { class: 'stack' });
        lane.body.append(h('div', { class: 'row' }, loadBtn, saveBtn), steps);
        return { lane, loadBtn, saveBtn, steps, aside: lane.title.lastChild };
      }
      const L = { A: sessionLane('A'), B: sessionLane('B') };
      const dbLane = ui.lane('deployment d-1', 'in Postgres');

      const step = (name, text, tone) => L[name].steps.appendChild(ui.token(text, tone));

      function reset() {
        runId++;
        playing = false;
        landed = 0;
        lost = 0;
        db = isTx() ? { status: 'VALIDATING', version: 1, tasks: 0 } : { status: 'HEALTHY', version: 3, tasks: 0 };
        sess = {
          A: { phase: 'idle', snap: null, out: null, reread: false },
          B: { phase: 'idle', snap: null, out: null, reread: false }
        };
        AF.clear(L.A.steps);
        AF.clear(L.B.steps);
        log.clear();
        verdict.clear();
        setCode(sqlBox, '-- the last statement appears here');
        log.add(isTx() ? 'Seed: deployment d-1 is VALIDATING at version 1.' : 'Seed: deployment d-1 is HEALTHY at version 3, with no ROLLBACK task.', 'muted');
        render();
      }

      function load(name) {
        const ss = sess[name];
        if (ss.phase === 'failed') ss.reread = true;
        ss.snap = { status: db.status, version: db.version, openSeen: db.tasks > 0 };
        ss.phase = 'loaded';
        ss.out = null;
        const v = isTx() && noVersion.get() ? '' : `, version ${db.version}`;
        if (isTx()) {
          step(name, `read ${db.status}${v}`, null);
          log.add(`${name}: SELECT ... FROM deployment WHERE id = 'd-1' -> ${db.status}${v}`, 'muted');
        } else {
          const open = ss.snap.openSeen ? 'yes' : 'no';
          step(name, `read ${db.status}${v}, open rollback: ${open}`, null);
          log.add(`${name}: ${noLock.get() ? 'findById' : 'findLockedById'} -> ${db.status}${v}; open ROLLBACK task: ${open}`, 'muted');
        }
        render();
      }

      function save(name) {
        const ss = sess[name];
        if (ss.phase !== 'loaded') return;
        if (isTx()) saveTransition(name, ss, ss.snap);
        else saveRollback(name, ss, ss.snap);
        ss.phase = ss.out === 'ok' ? 'saved' : 'failed';
        render();
        judge();
      }

      function saveTransition(name, ss, snap) {
        const target = TARGET[name];
        if (!canTransition(snap.status, target)) {
          ss.out = 'illegal';
          step(name, '409 illegal-transition', 'bad');
          log.add(`${name}: transitionTo(${target}) on the copy it read (${snap.status}): 409 illegal-transition`, 'bad');
          setCode(sqlBox, `-- nothing sent: ${snap.status} cannot move to ${target}`);
          return;
        }
        if (noVersion.get()) {
          const overwritten = db.status !== snap.status ? db.status : null;
          db.status = target;
          landed++;
          ss.out = 'ok';
          setCode(sqlBox, `UPDATE deployment\n   SET status = '${target}', updated_at = ?\n WHERE id = 'd-1';\n-- 1 row: there is no version condition, so it always matches`);
          step(name, 'UPDATE: 1 row, committed', overwritten ? 'warn' : 'ok');
          log.add(`${name}: UPDATE ... WHERE id = 'd-1' -> 1 row, committed`, 'ok');
          if (overwritten) {
            lost++;
            log.add(`${name} overwrote ${overwritten} without ever seeing it. Lost update.`, 'bad');
          }
          return;
        }
        const rows = db.version === snap.version ? 1 : 0;
        setCode(sqlBox, `UPDATE deployment\n   SET status = '${target}', updated_at = ?, version = ${snap.version + 1}\n WHERE id = 'd-1' AND version = ${snap.version};\n-- ${plural(rows, 'row')}`);
        if (rows) {
          db.status = target;
          db.version++;
          landed++;
          ss.out = 'ok';
          step(name, `UPDATE: 1 row, now version ${db.version}`, 'ok');
          log.add(`${name}: UPDATE ... WHERE version = ${snap.version} -> 1 row, committed at version ${db.version}`, 'ok');
        } else {
          ss.out = 'cm';
          step(name, '0 rows: 409 concurrent-modification', 'bad');
          log.add(`${name}: UPDATE ... WHERE version = ${snap.version} -> 0 rows (the row is at version ${db.version})`, 'bad');
          log.add(`${name}: ObjectOptimisticLockingFailureException, 409 urn:appfleet:problem:concurrent-modification`, 'bad');
        }
      }

      function saveRollback(name, ss, snap) {
        if (snap.openSeen) {
          ss.out = 'conflict';
          step(name, '409 conflict: rollback already pending', 'bad');
          log.add(`${name}: RollbackAlreadyRequestedException, 409 urn:appfleet:problem:conflict`, 'bad');
          setCode(sqlBox, '-- nothing sent: the pending-task check found an open ROLLBACK task');
          return;
        }
        const insert = "INSERT INTO task (id, deployment_id, task_type, status, ...)\nVALUES (?, 'd-1', 'ROLLBACK', 'PENDING', ...);";
        if (noLock.get()) {
          db.tasks++;
          landed++;
          ss.out = 'ok';
          setCode(sqlBox, `${insert}\nCOMMIT;   -- no version check: the deployment row itself did not change`);
          step(name, '202 Accepted', db.tasks > 1 ? 'warn' : 'ok');
          log.add(`${name}: INSERT ROLLBACK task, COMMIT -> 202 Accepted (${plural(db.tasks, 'ROLLBACK task')} now)`, db.tasks > 1 ? 'bad' : 'ok');
          return;
        }
        const rows = db.version === snap.version ? 1 : 0;
        setCode(sqlBox, `${insert}\nUPDATE deployment SET version = ${snap.version + 1}\n WHERE id = 'd-1' AND version = ${snap.version};   -- force increment at commit\n-- ${plural(rows, 'row')}`);
        if (rows) {
          db.tasks++;
          db.version++;
          landed++;
          ss.out = 'ok';
          step(name, `202 Accepted, version ${db.version}`, 'ok');
          log.add(`${name}: INSERT task, force increment -> 1 row, COMMIT -> 202 Accepted`, 'ok');
        } else {
          ss.out = 'cm';
          step(name, '0 rows: 409 concurrent-modification', 'bad');
          log.add(`${name}: force increment -> 0 rows, so the task insert rolls back with it`, 'bad');
          log.add(`${name}: ObjectOptimisticLockingFailureException, 409 urn:appfleet:problem:concurrent-modification`, 'bad');
        }
      }

      function judge() {
        const a = sess.A, b = sess.B;
        const pending = x => x.phase === 'idle' || x.phase === 'loaded';
        if (pending(a) || pending(b)) return;
        const any = out => a.out === out || b.out === out;
        if (isTx()) {
          if (lost) verdict.set('bad', `Both saves reported success and the row says ${db.status}. The other session’s decision was overwritten and nobody was told: a lost update.`);
          else if (any('cm')) verdict.set('ok', `One write landed (version ${db.version}); the other got 409 concurrent-modification. Appfleet does not retry for the loser: it re-reads and decides again with fresh data.`);
          else if (any('illegal')) verdict.set('warn', 'The fresh read showed a state where that move is illegal, so transitionTo refused it. Deciding on fresh data works as intended.');
          else if (a.reread || b.reread) verdict.set('ok', `The loser re-read, saw the new state and saved deliberately. Two writes in order, version ${db.version}. That is the policy: a deliberate retry by the caller, never an automatic one.`);
          else verdict.set('ok', 'No overlap, so no conflict: the second session read after the first one’s write and decided on fresh data.');
        } else if (db.tasks > 1) {
          verdict.set('bad', `Two 202 responses and ${db.tasks} ROLLBACK tasks for one deployment. Both requests checked for an open task before either committed.`);
        } else if (any('cm')) {
          verdict.set('ok', 'One 202, one 409 concurrent-modification, exactly one ROLLBACK task. The forced version bump made the second commit fail.');
        } else if (any('conflict')) {
          verdict.set('ok', 'The second request read after the first one committed, so the pending-task check answered 409 conflict.');
        } else {
          verdict.set('ok', 'Exactly one ROLLBACK task.');
        }
      }

      function render() {
        const tx = isTx();
        noVersion.el.style.display = tx ? '' : 'none';
        noLock.el.style.display = tx ? 'none' : '';
        L.A.aside.textContent = tx ? 'wants ' + TARGET.A : 'wants a rollback';
        L.B.aside.textContent = tx ? 'wants ' + TARGET.B : 'wants a rollback';
        ['A', 'B'].forEach(n => {
          const ph = sess[n].phase;
          L[n].loadBtn.disabled = playing || ph === 'loaded' || ph === 'saved';
          L[n].saveBtn.disabled = playing || ph !== 'loaded';
        });
        playBtn.disabled = playing;
        AF.clear(dbLane.body);
        const versionText = tx && noVersion.get() ? 'version not mapped' : 'version ' + db.version;
        [
          ui.token('status ' + db.status),
          ui.token(versionText),
          tx ? null : ui.token(plural(db.tasks, 'ROLLBACK task'), db.tasks > 1 ? 'bad' : db.tasks ? 'busy' : 'idle')
        ].filter(Boolean).forEach(t => dbLane.body.appendChild(t));
        rStatus.set(db.status);
        rVersion.set(tx && noVersion.get() ? 'not mapped' : db.version);
        rLanded.set(landed);
        if (tx) {
          setLabel(rExtra, 'Lost updates');
          rExtra.set(lost, lost ? 'bad' : null);
        } else {
          setLabel(rExtra, 'ROLLBACK tasks');
          rExtra.set(db.tasks, db.tasks > 1 ? 'bad' : null);
        }
      }

      async function play() {
        reset();
        const run = runId;
        playing = true;
        render();
        const first = order.get();
        const second = first === 'A' ? 'B' : 'A';
        const steps = [() => load('A'), () => load('B'), () => save(first), () => save(second)];
        for (const fn of steps) {
          await pace(ctx, 700);
          if (!ctx.alive || run !== runId) return;
          fn();
        }
        playing = false;
        render();
      }

      el.append(
        controls(scenario.el, order.el, noVersion.el, noLock.el),
        controls(playBtn, resetBtn),
        stage(h('div', { class: 'sim-cols' }, L.A.lane.el, dbLane.el, L.B.lane.el)),
        sqlBox,
        readouts(rStatus, rVersion, rLanded, rExtra),
        verdict.el,
        log.el
      );
      reset();
    }
  });

  // =====================================================================
  // 3. Constraints in the database
  // =====================================================================
  AF.register({
    id: 'pg-constraints',
    group: 'postgres',
    order: 3,
    title: 'Constraints in the database',
    question: 'How do you guarantee a rule like "one active deployment per application and environment" when two requests arrive at the same moment?',
    status: 'built',
    slice: 'S1, S3',
    where: [
      'V1__init.sql: uq_application_name, uq_deployment_active_per_app_env, CHECK on status',
      'ApiExceptionHandler, KNOWN_CONFLICTS',
      'ApplicationEndpointsTest.concurrentCreate_sameName_oneCreated_oneConflict',
      'DeploymentEndpointsTest.concurrentDeployments_sameTarget_one202_one409'
    ],
    idea: [
      'A rule checked only in Java has a gap: two requests can both check, both see "allowed", and both insert. The database sees every insert under its own locks, so a constraint there cannot be raced. Foreign keys, CHECK constraints and unique indexes are rules the database enforces on every write, whatever code sends it.',
      'V1__init.sql declares them: foreign keys between tables, a CHECK on the seven status values, unique names such as uq_application_name, and the partial unique index uq_deployment_active_per_app_env on (application_id, environment_id) WHERE status NOT IN (FAILED, ROLLED_BACK). Finished rows do not count, so a new deployment is allowed once the old one ends.',
      'ApiExceptionHandler turns a known constraint name into 409 conflict with a readable detail; any other violation is a bug and stays a 500. Two concurrent creates of the same application name give exactly one 201 and one 409, never a 500, as ApplicationEndpointsTest proves.'
    ],
    terms: [
      ['Partial unique index', 'A unique index over only the rows that match a WHERE clause.'],
      ['Check-then-act race', 'Two requests both check a condition, both see it allowed, then both act on it.'],
      ['CHECK constraint', 'A rule on column values that the database enforces on every insert and update.'],
      ['Foreign key', 'A column that must point at an existing row in another table.']
    ],
    tryIt: [
      'Press "Run the race": request 2 waits for request 1, then fails on uq_deployment_active_per_app_env with 409 conflict.',
      'Press "Fail the active deployment", then "Run the race" again: the partial index ignores FAILED rows, so one new deployment gets in.',
      'Press "Reset", turn on "Check in Java only" and run the race: both checks find nothing and both insert.',
      'Try "Insert an unknown status" and "Insert an unknown release_id" to meet the CHECK and the foreign key.'
    ],
    breakIt: 'With "Check in Java only", the service asks "is there an active deployment?" and then inserts. Under concurrency both requests pass the check before either inserts, so the rule breaks exactly when it matters.',
    say: 'Invariants that must hold under concurrency live in the database: a partial unique index enforces one active deployment per application and environment, and the exception handler maps that constraint name to a 409 instead of a 500.',
    quiz: {
      q: 'Why does Appfleet rely on the partial unique index instead of checking "is there an active deployment?" in Java before inserting?',
      options: [
        'A Java check is slower than an index lookup',
        'JPA cannot run a query before an insert in the same transaction',
        'The index also stops a FAILED deployment from being retried',
        'Two concurrent requests can both pass the Java check before either inserts; only the database sees both inserts'
      ],
      answer: 3,
      why: 'Check-then-insert is a race: each request checks before the other has inserted. The unique index makes the second insert wait for the first transaction and then fail, so the rule holds under concurrency.'
    },
    mount(el, ctx) {
      const KIND = {
        deploy: {
          table: 'deployment rows, checkout-service in prod',
          count: 'Active deployments, checkout-service in prod',
          constraint: 'uq_deployment_active_per_app_env',
          ok: '202 Accepted',
          okShort: '202',
          detail: 'An active deployment already exists for this application and environment.',
          check: "SELECT count(*) FROM deployment WHERE application_id = ? AND environment_id = ? AND status NOT IN ('FAILED','ROLLED_BACK')",
          insert: "INSERT INTO deployment (id, application_id, environment_id, status, ...) VALUES (?, ?, ?, 'PENDING', ...)",
          ddl: "V1__init.sql: CREATE UNIQUE INDEX uq_deployment_active_per_app_env ON deployment (application_id, environment_id) WHERE status NOT IN ('FAILED','ROLLED_BACK')",
          already: 'an active deployment already exists. Press "Fail the active deployment" to free the slot.',
          broken: c => `checkout-service now has ${c} active deployments in prod, which the rule forbids.`
        },
        app: {
          table: 'application rows',
          count: 'Applications named checkout-service',
          constraint: 'uq_application_name',
          ok: '201 Created',
          okShort: '201',
          detail: 'An application with this name already exists.',
          check: "SELECT count(*) FROM application WHERE name = 'checkout-service'",
          insert: "INSERT INTO application (id, name, owner_team_id, ...) VALUES (?, 'checkout-service', ?, ...)",
          ddl: 'V1__init.sql: CONSTRAINT uq_application_name UNIQUE (name)',
          already: 'the name is taken.',
          broken: c => `There are now ${c} applications named checkout-service.`
        }
      };
      let rows = [];
      let seq = 0;
      let runId = 0;
      let running = false;
      let res = {};

      const log = ui.log({ label: 'SQL and responses' });
      const verdict = ui.verdict();
      const rCount = ui.readout('Active deployments');
      const rResp = ui.readout('Responses');
      const rBy = ui.readout('Decided by');
      const race = ui.choice('Race', [
        { value: 'deploy', label: 'Two deploys, same app and env' },
        { value: 'app', label: 'Two creates, same name' }
      ], 'deploy', () => reset());
      const javaOnly = ui.toggle('Check in Java only', false, () => reset(), { tone: 'danger' });
      const runBtn = ui.button('Run the race', run, { variant: 'primary' });
      const failBtn = ui.button('Fail the active deployment', failActive);
      const resetBtn = ui.button('Reset', () => reset(), { variant: 'quiet' });
      const checkBtn = ui.button('Insert an unknown status', rawCheck, { small: true });
      const fkBtn = ui.button('Insert an unknown release_id', rawFk, { small: true });
      const lane1 = ui.lane('Request 1');
      const lane2 = ui.lane('Request 2');
      const laneDb = ui.lane('table');

      const kind = () => KIND[race.get()];
      const isDeploy = () => race.get() === 'deploy';
      const active = r => r.committed && r.status !== 'FAILED' && r.status !== 'ROLLED_BACK';
      const countTarget = () => (isDeploy() ? rows.filter(active).length : rows.filter(r => r.committed).length);

      function addRow(committed) {
        const r = { id: (isDeploy() ? 'd-' : 'app-') + (++seq), status: 'PENDING', name: 'checkout-service', committed };
        rows.push(r);
        return r;
      }

      function raceSteps() {
        const k = kind();
        const existed = countTarget() > 0;
        const S = [];
        const set = (n, code, by) => () => { res[n] = code; if (by) res.by = by; };
        if (javaOnly.get()) {
          const found = existed ? 1 : 0;
          [1, 2].forEach(n => S.push({ lane: n, chip: `check: ${found} found`, tone: found ? 'bad' : 'ok', log: `R${n}: ${k.check} -> ${found}`, logTone: 'muted' }));
          if (found) {
            [1, 2].forEach(n => S.push({ lane: n, chip: '409 conflict', tone: 'bad', log: `R${n}: the Java check found one -> 409 conflict`, fn: set(n, '409', 'Java check') }));
            return S;
          }
          const made = {};
          [1, 2].forEach(n => S.push({ lane: n, chip: 'INSERT, uncommitted', tone: 'busy', log: `R${n}: ${k.insert}`, fn: () => { made[n] = addRow(false); } }));
          [1, 2].forEach(n => S.push({
            lane: n, chip: 'COMMIT: ' + k.ok, tone: n === 1 ? 'ok' : 'bad', log: `R${n}: COMMIT -> ${k.ok}`,
            fn: () => { made[n].committed = true; res[n] = k.okShort; res.by = 'nothing'; }
          }));
          return S;
        }
        if (existed) {
          [1, 2].forEach(n => {
            S.push({ lane: n, chip: 'INSERT: unique violation', tone: 'bad', log: `R${n}: ${k.insert}` });
            S.push({ lane: n, chip: '409 conflict', tone: 'bad', log: `R${n}: ERROR: duplicate key value violates unique constraint "${k.constraint}" -> 409 conflict`, fn: set(n, '409', k.constraint) });
          });
          return S;
        }
        let r1 = null;
        S.push({ lane: 1, chip: 'INSERT, uncommitted', tone: 'busy', log: `R1: ${k.insert}`, fn: () => { r1 = addRow(false); } });
        S.push({ lane: 2, chip: 'INSERT waits for request 1', tone: 'warn', log: `R2: ${k.insert}   -- blocks: request 1 holds the same key in ${k.constraint}` });
        S.push({ lane: 1, chip: 'COMMIT: ' + k.ok, tone: 'ok', log: `R1: COMMIT -> ${k.ok}`, fn: () => { r1.committed = true; res[1] = k.okShort; } });
        S.push({ lane: 2, chip: '409 conflict', tone: 'bad', log: `R2: ERROR: duplicate key value violates unique constraint "${k.constraint}"`, fn: set(2, '409', k.constraint) });
        S.push({ lane: 0, log: `R2: 409 urn:appfleet:problem:conflict "${k.detail}"`, tone: 'bad' });
        return S;
      }

      async function run() {
        if (running) return;
        running = true;
        const id = ++runId;
        const existed = countTarget() > 0;
        res = { 1: '…', 2: '…', by: '…' };
        AF.clear(lane1.body);
        AF.clear(lane2.body);
        verdict.clear();
        render();
        for (const st of raceSteps()) {
          await pace(ctx, 650);
          if (!ctx.alive || id !== runId) return;
          if (st.fn) st.fn();
          if (st.lane) (st.lane === 1 ? lane1 : lane2).body.appendChild(ui.token(st.chip, st.tone));
          if (st.log) log.add(st.log, st.logTone || st.tone);
          render();
        }
        running = false;
        const k = kind();
        const c = countTarget();
        if (javaOnly.get()) {
          if (existed) verdict.set('warn', 'Both requests saw the committed row and refused. A Java check works when requests take turns; it fails when they overlap, which is exactly when the rule matters.');
          else verdict.set('bad', `Both checks found nothing, both inserted, both got ${k.okShort}. ${k.broken(c)}`);
        } else if (existed) {
          verdict.set('ok', 'Both refused with 409 conflict: ' + k.already);
        } else {
          verdict.set('ok', `One ${k.okShort} and one 409 conflict, never a 500. Request 2 waited on request 1’s uncommitted key, then hit ${k.constraint}.`);
        }
        render();
      }

      function failActive() {
        const r = rows.find(active);
        if (!r || running) return;
        r.status = 'FAILED';
        log.add(`${r.id}: transitionTo(VALIDATING), then transitionTo(FAILED). The partial index covers only rows WHERE status NOT IN ('FAILED','ROLLED_BACK'), so ${r.id} no longer counts.`, 'muted');
        verdict.set('ok', `${r.id} is FAILED, so the slot for checkout-service in prod is free again. Run the race.`);
        render();
      }

      function rawCheck() {
        log.add("psql: INSERT INTO deployment (id, application_id, release_id, environment_id, status, ...) VALUES (..., 'DONE', ...)", 'busy');
        log.add('ERROR: new row for relation "deployment" violates check constraint "deployment_status_check"', 'bad');
        verdict.set('warn', 'The CHECK constraint refuses any status outside the seven enum values, whoever sends the SQL. Over HTTP this cannot happen: status is an enum. If it did, the handler would answer 500, because only whitelisted constraint names become 409.');
      }

      function rawFk() {
        log.add("psql: INSERT INTO deployment (..., release_id, ...) VALUES (..., '<an id no release has>', ...)", 'busy');
        log.add('ERROR: insert or update on table "deployment" violates foreign key constraint "deployment_release_id_fkey"', 'bad');
        verdict.set('warn', 'The foreign key refuses a deployment that points at no release. The API checks first and answers 422 unprocessable, so the database is the last line of defence, not the only one.');
      }

      function render() {
        const k = kind();
        laneDb.title.firstChild.textContent = k.table;
        AF.clear(laneDb.body);
        if (!rows.length) laneDb.body.appendChild(label('no rows yet'));
        const c = countTarget();
        rows.forEach(r => {
          let text;
          let tone;
          if (!r.committed) {
            text = `${r.id} ${isDeploy() ? r.status : r.name}, uncommitted`;
            tone = 'idle';
          } else if (isDeploy()) {
            const a = active(r);
            text = `${r.id} ${r.status}, ${a ? 'active' : 'inactive'}`;
            tone = a ? (c > 1 ? 'bad' : 'busy') : 'idle';
          } else {
            text = `${r.id} ${r.name}`;
            tone = c > 1 ? 'bad' : 'ok';
          }
          laneDb.body.appendChild(ui.token(text, tone));
        });
        setLabel(rCount, k.count);
        rCount.set(c + (c > 1 ? ' (rule broken)' : ''), c > 1 ? 'bad' : null);
        rResp.set(res[1] === undefined ? '—' : `${res[1]} and ${res[2]}`);
        rBy.set(res.by === undefined ? '—' : res.by, res.by === 'nothing' ? 'bad' : null);
        runBtn.disabled = running;
        failBtn.disabled = running || !isDeploy() || !rows.some(active);
      }

      function reset() {
        runId++;
        running = false;
        rows = [];
        seq = 0;
        res = {};
        AF.clear(lane1.body);
        AF.clear(lane2.body);
        log.clear();
        verdict.clear();
        log.add(javaOnly.get()
          ? `No ${kind().constraint}: the service runs a check in Java, then inserts.`
          : kind().ddl, 'muted');
        render();
      }

      el.append(
        controls(race.el, javaOnly.el, runBtn, failBtn, resetBtn),
        controls(label('Other guards on deployment:'), checkBtn, fkBtn),
        stage(h('div', { class: 'sim-cols' }, lane1.el, laneDb.el, lane2.el)),
        readouts(rCount, rResp, rBy),
        note('Illustrative timing. The order is what Postgres does: a second insert of the same key waits for the first transaction to finish, then fails.'),
        verdict.el,
        log.el
      );
      reset();
    }
  });

  // =====================================================================
  // 4. The N+1 query problem
  // =====================================================================
  AF.register({
    id: 'pg-nplusone',
    group: 'postgres',
    order: 4,
    title: 'The N+1 query problem',
    question: 'Why can listing 50 deployments with their tasks quietly send 51 queries to the database, and how do you get it down to one?',
    status: 'built',
    slice: 'S2',
    where: [
      'DeploymentNPlusOneTest',
      'DeploymentRepository.findAllWithTasksJoinFetch, findAllBy',
      'Deployment.tasks, @BatchSize(size = 25)',
      'DeploymentListView, DeploymentProjectionTest'
    ],
    idea: [
      'With lazy loading, a list query fetches only the parents. The first time code touches one parent’s children, the ORM runs another query for just those children. Loop over 50 parents and that is 1 query plus 50 more: N+1. Nothing in the Java looks wrong, so it hides until someone counts.',
      'DeploymentNPlusOneTest counts statements with Hibernate statistics on 50 deployments with 3 tasks each. The naive loop gives 51, kept as a @Disabled test. JOIN FETCH and @EntityGraph give 1, and @BatchSize(size = 25) gives 3. JOIN FETCH is an inner join and drops deployments with no tasks; @EntityGraph uses a left join, which is why it is the preferred fix.',
      '@BatchSize stays on the field as a safety net: any unplanned lazy load costs 1 + N/25 instead of 1 + N. When a list does not need tasks at all, the interface projection DeploymentListView selects only 4 columns, as DeploymentProjectionTest checks.'
    ],
    terms: [
      ['N+1 queries', 'One query for the list, then one more per item to load its children.'],
      ['Lazy loading', 'Children load on first access, through a query you never wrote.'],
      ['Entity graph', 'A declaration of which associations to fetch together with the root entity, in one query.'],
      ['Interface projection', 'A repository returns an interface with only the getters you need, so the SQL selects only those columns.']
    ],
    tryIt: [
      'Turn on "Remove @BatchSize(25)", keep "findAll() then loop" and press "Run the list": 51 statements for 50 deployments.',
      'Turn the switch off and run again: the same loop now costs 3 statements.',
      'Pick "@EntityGraph" and "JOIN FETCH" and run each: 1 statement.',
      'Turn on "Make one deployment have no tasks" and compare how many deployments "JOIN FETCH" and "@EntityGraph" return.'
    ],
    breakIt: 'Without @BatchSize or an explicit fetch, findAll() followed by getTasks() in a loop sends one query per deployment: 51 statements for 50 rows, and one more for every deployment added.',
    say: 'I count statements with Hibernate statistics: the naive list was 51 queries for 50 deployments, @EntityGraph makes it one left-joined query, and @BatchSize(25) stays on the association as a safety net that turns surprise lazy loads into 1 + N/25.',
    quiz: {
      q: 'Deployment.tasks has @BatchSize(size = 25). New code calls findAll() for 60 deployments and reads each one’s tasks in a loop. How many statements run?',
      options: [
        '61: one for the list and one per deployment',
        '1: @BatchSize turns the loop into a join',
        '4: one for the deployments, then ceil(60 / 25) = 3 batched task loads',
        '2: one for deployments and one for all tasks'
      ],
      answer: 2,
      why: '@BatchSize sits on the association, so every lazy load of tasks is batched, up to 25 deployments per statement. It softens the N+1 but does not remove it; a known list endpoint should use @EntityGraph.'
    },
    mount(el, ctx) {
      const PER = 3;
      const BATCH = 25;
      const DEP_COLS = 'd1_0.id,d1_0.application_id,d1_0.created_at,d1_0.current_status,\n       d1_0.environment_id,d1_0.release_id,d1_0.status,d1_0.updated_at,d1_0.version';
      const TASK_COLS = 't1_0.deployment_id,t1_0.id,t1_0.created_at,t1_0.status,t1_0.task_type,t1_0.updated_at';
      const SQL = {
        dep: `select ${DEP_COLS}\nfrom control.deployment d1_0`,
        lazy: `select ${TASK_COLS}\nfrom control.task t1_0\nwhere t1_0.deployment_id=?`,
        batch: `select ${TASK_COLS}\nfrom control.task t1_0\nwhere t1_0.deployment_id = any (?)`,
        join: 'select d1_0.id,d1_0.application_id,...,t1_0.deployment_id,t1_0.id,...\nfrom control.deployment d1_0\njoin control.task t1_0 on d1_0.id=t1_0.deployment_id\n-- column lists shortened: 9 deployment columns, 6 task columns',
        graph: 'select d1_0.id,d1_0.application_id,...,t1_0.deployment_id,t1_0.id,...\nfrom control.deployment d1_0\nleft join control.task t1_0 on d1_0.id=t1_0.deployment_id\n-- column lists shortened: 9 deployment columns, 6 task columns',
        view: 'select d1_0.id,d1_0.status,d1_0.current_status,d1_0.created_at\nfrom control.deployment d1_0\nwhere d1_0.application_id=?'
      };
      const BAR_DEFS = [['loop', 'findAll() then loop'], ['join', 'JOIN FETCH'], ['graph', '@EntityGraph'], ['view', 'DeploymentListView']];
      let runId = 0;

      const log = ui.log({ label: 'Statements sent' });
      const verdict = ui.verdict();
      const sqlBox = ui.code('', 'Distinct SQL text');
      const formula = h('p', { class: 'small' });
      const tokens = h('div', { class: 'row' });
      const rStmts = ui.readout('Statements');
      const rDeps = ui.readout('Deployments returned');
      const rTasks = ui.readout('Tasks loaded');
      const rRows = ui.readout('Rows sent');
      const rCols = ui.readout('Columns per row');

      const method = ui.choice('Repository call', [
        { value: 'loop', label: 'findAll() then loop' },
        { value: 'join', label: 'JOIN FETCH' },
        { value: 'graph', label: '@EntityGraph' },
        { value: 'view', label: 'DeploymentListView' }
      ], 'loop', () => preview());
      const count = ui.slider({ label: 'Deployments', min: 1, max: 150, value: 50, onInput: () => preview() });
      const empty = ui.toggle('Make one deployment have no tasks', false, () => preview());
      const noBatch = ui.toggle('Remove @BatchSize(25)', false, () => preview(), { tone: 'danger' });
      const runBtn = ui.button('Run the list', () => runList(), { variant: 'primary' });

      const barOpts = {};
      const bars = {};
      BAR_DEFS.forEach(([k, lab]) => {
        barOpts[k] = { label: lab, max: 51, value: 0, format: v => plural(v, 'statement') };
        bars[k] = ui.bar(barOpts[k]);
      });

      function compute() {
        const N = count.get();
        const e = empty.get() ? 1 : 0;
        const withTasks = N - e;
        const tasks = withTasks * PER;
        const m = method.get();
        const batched = !noBatch.get();
        const st = [];
        const r = { n: N, st, batched, deps: N, tasks, rows: 0, cols: '', sql: '', formula: '', verdict: null };
        if (m === 'loop') {
          st.push({ chip: 'deployment', line: 'select ... from control.deployment d1_0', tone: 'busy' });
          if (batched) {
            const k = Math.ceil(N / BATCH);
            for (let i = 0; i < k; i++) {
              const size = Math.min(BATCH, N - i * BATCH);
              st.push({ chip: 'task ×' + size, line: `select ... from control.task t1_0 where t1_0.deployment_id = any (?)   -- ${size} deployment ids`, tone: 'warn' });
            }
            r.formula = `1 + ceil(${N} / 25) = ${1 + k} statements. @BatchSize loads the tasks of up to 25 deployments at a time.`;
            r.sql = SQL.dep + '\n\n-- then once per 25 deployments:\n' + SQL.batch;
            r.verdict = ['warn', `${1 + k} statements. @BatchSize softens the N+1 to 1 + N/25, but findAll() plus a loop is still not the right call for a known list. Prefer @EntityGraph.`];
          } else {
            for (let i = 1; i <= N; i++) {
              st.push({ chip: 'task', line: `select ... from control.task t1_0 where t1_0.deployment_id=?   -- deployment ${i}`, tone: 'bad' });
            }
            r.formula = `1 + N = 1 + ${N} = ${N + 1} statements: one for the list, then one per deployment.`;
            r.sql = SQL.dep + `\n\n-- then once per deployment, ${N} times, only the bound id differs:\n` + SQL.lazy;
            r.verdict = ['bad', `${N + 1} statements for one list. This is the N+1, kept in DeploymentNPlusOneTest as the @Disabled naive_issuesOnePlusNStatements.`];
          }
          r.rows = N + tasks;
          r.cols = '9, then 6';
        } else if (m === 'join') {
          st.push({ chip: 'deployment join task', line: 'select ... from control.deployment d1_0 join control.task t1_0 on d1_0.id=t1_0.deployment_id', tone: 'ok' });
          r.deps = withTasks;
          r.rows = tasks;
          r.cols = '15';
          r.formula = '1 statement. The inner join returns one row per task; Hibernate folds the rows back into deployments.';
          r.sql = SQL.join;
          r.verdict = e
            ? ['warn', `1 statement, but only ${fmt(withTasks)} of ${fmt(N)} deployments came back: the inner join dropped the one with no tasks.`]
            : ['ok', '1 statement with an inner join. It would drop any deployment that has no tasks; turn on "Make one deployment have no tasks" to see it.'];
        } else if (m === 'graph') {
          st.push({ chip: 'deployment left join task', line: 'select ... from control.deployment d1_0 left join control.task t1_0 on d1_0.id=t1_0.deployment_id', tone: 'ok' });
          r.rows = tasks + e;
          r.cols = '15';
          r.formula = '1 statement. An entity graph defaults to a left join, so deployments without tasks stay in the result.';
          r.sql = SQL.graph;
          r.verdict = ['ok', `1 statement with a left join, all ${fmt(N)} deployments kept. This is Appfleet’s preferred fix for a list with children.`];
        } else {
          st.push({ chip: 'deployment, 4 columns', line: 'select d1_0.id,d1_0.status,d1_0.current_status,d1_0.created_at from control.deployment d1_0 where d1_0.application_id=?', tone: 'ok' });
          r.tasks = null;
          r.rows = N;
          r.cols = '4';
          r.formula = '1 statement, 4 columns, no tasks: DeploymentListView is a closed interface projection.';
          r.sql = SQL.view;
          r.verdict = ['ok', '1 statement selecting 4 columns. When a list needs no tasks, the cheapest fetch is not loading them.'];
        }
        return r;
      }

      const chip = (st, i) => ui.token(`#${i + 1} ${st.chip}`, st.tone);

      function show(r) {
        const n = r.st.length;
        rStmts.set(n, n > 3 ? 'bad' : n > 1 ? 'warn' : 'ok');
        rDeps.set(r.deps < r.n ? `${fmt(r.deps)} of ${fmt(r.n)}` : fmt(r.deps), r.deps < r.n ? 'warn' : null);
        rTasks.set(r.tasks === null ? 'not loaded' : fmt(r.tasks));
        rRows.set(fmt(r.rows));
        rCols.set(r.cols);
        formula.textContent = r.formula;
        setCode(sqlBox, r.sql);
        const N = count.get();
        const vals = { loop: r.batched ? 1 + Math.ceil(N / BATCH) : N + 1, join: 1, graph: 1, view: 1 };
        BAR_DEFS.forEach(([k]) => {
          barOpts[k].max = N + 1;
          bars[k].set(vals[k], k === 'loop' ? (r.batched ? 'warn' : 'bad') : 'ok');
        });
      }

      function preview() {
        runId++;
        runBtn.disabled = false;
        const r = compute();
        AF.clear(tokens);
        r.st.forEach((st, i) => tokens.appendChild(chip(st, i)));
        show(r);
        verdict.set(r.verdict[0], r.verdict[1]);
        log.clear();
        log.add('Press "Run the list" to send these statements one by one.', 'muted');
      }

      async function runList() {
        const id = ++runId;
        const r = compute();
        runBtn.disabled = true;
        AF.clear(tokens);
        log.clear();
        verdict.clear();
        const total = r.st.length;
        const delay = Math.max(10, Math.min(300, Math.round(1500 / total)));
        for (let i = 0; i < total; i++) {
          if (!ctx.reducedMotion) {
            await AF.sleep(ctx, delay);
            if (!ctx.alive || id !== runId) return;
          }
          tokens.appendChild(chip(r.st[i], i));
          log.add(`#${i + 1}  ${r.st[i].line}`, r.st[i].tone === 'bad' ? 'warn' : 'muted');
          rStmts.set(i + 1);
        }
        show(r);
        verdict.set(r.verdict[0], r.verdict[1]);
        runBtn.disabled = false;
      }

      el.append(
        controls(method.el, count.el),
        controls(empty.el, noBatch.el, runBtn),
        stage(h('div', { class: 'sim-cols' },
          ui.panel('Statements sent, one chip each', tokens),
          ui.panel('Statements per call at this size', BAR_DEFS.map(([k]) => bars[k].el), formula))),
        sqlBox,
        readouts(rStmts, rDeps, rTasks, rRows, rCols),
        note('Measured in DeploymentNPlusOneTest with 50 deployments and 3 tasks each: 51 (naive, now @Disabled), 1 (JOIN FETCH), 1 (@EntityGraph), 3 (@BatchSize). Other sizes follow the same formulas.'),
        verdict.el,
        log.el
      );
      preview();
    }
  });

  // =====================================================================
  // 5. Offset versus keyset pagination
  // =====================================================================
  AF.register({
    id: 'pg-pagination',
    group: 'postgres',
    order: 5,
    title: 'Offset versus keyset pagination',
    question: 'Why does page 10,000 of a task history get slower with OFFSET, and how does a cursor keep every page equally fast?',
    status: 'built',
    slice: 'S1, S3.4',
    where: [
      'V4__add_task_deployment_index.sql',
      'TaskService.history, TaskService.historyByOffset, CursorCodec',
      'TaskHistoryEndpointsTest',
      'docs/design/control-api/control-api-s3-4-task-history.md, section 12'
    ],
    idea: [
      'OFFSET 200000 makes the database find, read and throw away 200,000 rows before it returns 20. The deeper the page, the more work. Keyset pagination remembers the last key the client saw and asks for rows after it: WHERE id > cursor. With the right index the database seeks straight there, so page 10,000 costs the same as page 1.',
      'GET /api/v1/deployments/{id}/tasks returns a cursor: base64url of the last task id. UUIDv7 ids start with a timestamp, so id order is creation order. The service fetches limit + 1 rows; the extra row only says whether a next page exists. GET .../tasks/by-offset exists only for the benchmark.',
      'V4 adds the index (deployment_id, id): equality column first, range-and-sort column second. Measured on 1,200,101 seeded tasks: offset page 10,000 fell from 54.7 ms to 17.3 ms with the index, while keyset is 0.04 ms. A quiet deployment’s first page fell from 123 ms to 0.04 ms, and deleting 600 deployments from 10 s to 64 ms.'
    ],
    terms: [
      ['Offset pagination', 'Skip N rows and return the next page; the database still reads every skipped row.'],
      ['Keyset (cursor) pagination', 'Remember the last key and ask for rows after it; an index seeks straight there.'],
      ['Composite index', 'One index over several columns; the leftmost ones must be matched by equality for the next one to help.'],
      ['UUIDv7', 'A UUID that starts with a millisecond timestamp, so sorting by id sorts by creation time.']
    ],
    tryIt: [
      'With "Hot, 250,000 tasks" and "Offset", drag "Page" from 0 to 10,000 and watch rows read and SQL time climb.',
      'Switch "Method" to "Keyset (cursor)": 21 rows read and about 0.04 ms at every page.',
      'At page 10,000 turn on "Drop idx_task_deployment_id", then pick "Quiet, 570 tasks" to see 123 ms for a first page.',
      'Press "Delete the 600 seed deployments" with the index on, then off.'
    ],
    breakIt: 'Without idx_task_deployment_id, offset page 10,000 becomes a parallel seq scan plus a sort that spills to disk (54.7 ms), and even keyset is slow whenever a deployment’s ids are scattered: 123 ms for the first page of a 570-task deployment.',
    say: 'On 1.2 million tasks, offset page 10,000 still cost 17 ms with a (deployment_id, id) index because it reads every skipped entry, while the keyset cursor stayed at 0.04 ms at any depth, so the API pages with an opaque base64url cursor over UUIDv7 ids.',
    quiz: {
      q: 'With idx_task_deployment_id in place, why is offset page 10,000 still 17.3 ms while the keyset query at the same position is 0.039 ms?',
      options: [
        'The index helps only keyset queries',
        'OFFSET 200000 still reads and discards 200,000 index entries; keyset seeks straight to id > cursor',
        'Postgres cannot use an index for ORDER BY together with OFFSET',
        'The offset endpoint also runs count(*) on every request'
      ],
      answer: 1,
      why: 'The offset query’s index condition is only deployment_id = ?, so Postgres walks 200,021 entries to skip 200,000. The keyset query puts both conditions in the index and reads 21 entries. The offset endpoint returns a Slice, so no count runs.'
    },
    mount(el, ctx) {
      const PAGES = [0, 100, 1000, 10000];
      const AFTER_MS = { offset: [0.035, 0.232, 1.884, 17.306], keyset: [0.038, 0.038, 0.042, 0.039] };
      const EXAMPLE_ID = '01999f2c-3a10-7c4e-9b21-6d0f8e2a4c51';
      const EXAMPLE_CURSOR = btoa(EXAMPLE_ID).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
      const TOTAL = 1200101;

      const verdict = ui.verdict();
      const sqlBox = ui.code('', 'SQL for this page');
      const plan = h('p', { class: 'small' });
      const rMs = ui.readout('SQL time');
      const rHttp = ui.readout('HTTP median');
      const rRead = ui.readout('Rows read');
      const rRet = ui.readout('Rows returned');
      const rBuf = ui.readout('Buffers');
      const rDel = ui.readout('Delete 600 deployments');
      const barRead = ui.bar({ label: 'Rows read', max: TOTAL, value: 0, format: v => fmt(v) });
      const barRet = ui.bar({ label: 'Rows returned', max: TOTAL, value: 21, tone: 'ok', format: v => fmt(v) });
      const barMs = ui.bar({ label: 'SQL time', max: 123, value: 0, format: v => (v ? v + ' ms' : 'not measured') });

      const dep = ui.choice('Deployment', [
        { value: 'hot', label: 'Hot, 250,000 tasks' },
        { value: 'quiet', label: 'Quiet, 570 tasks' }
      ], 'hot', update);
      const meth = ui.choice('Method', [
        { value: 'offset', label: 'Offset' },
        { value: 'keyset', label: 'Keyset (cursor)' }
      ], 'offset', update);
      const page = ui.slider({ label: 'Page', min: 0, max: 3, value: 3, format: v => fmt(PAGES[v]), onInput: update });
      const noIndex = ui.toggle('Drop idx_task_deployment_id', false, () => { rDel.set('—'); update(); }, { tone: 'danger' });
      const delBtn = ui.button('Delete the 600 seed deployments', del);

      const X = [96, 220, 344, 468];
      const Y = v => 152 - (v / 18) * 126;
      const chart = s('svg', {
        class: 'chart', viewBox: '0 0 540 192', role: 'img', style: { maxWidth: '560px', minWidth: '320px' },
        'aria-label': 'Measured SQL time after V4 for the hot deployment. Offset: 0.035, 0.232, 1.884 and 17.306 ms at pages 0, 100, 1,000 and 10,000. Keyset: 0.038, 0.038, 0.042 and 0.039 ms.'
      });

      function drawChart() {
        AF.clear(chart);
        const hot = dep.get() === 'hot';
        const idx = !noIndex.get();
        const p = page.get();
        const mth = meth.get();
        [0, 6, 12, 18].forEach(v => {
          chart.appendChild(s('line', { x1: 60, x2: 500, y1: Y(v), y2: Y(v), style: { stroke: 'var(--line)', strokeWidth: '1' } }));
          chart.appendChild(s('text', { x: 54, y: Y(v) + 4, 'text-anchor': 'end' }, v + ' ms'));
        });
        PAGES.forEach((pg, i) => chart.appendChild(s('text', { x: X[i], y: 170, 'text-anchor': 'middle' }, 'page ' + fmt(pg))));
        chart.appendChild(s('text', { x: 280, y: 188, 'text-anchor': 'middle' }, 'Measured after V4: hot deployment, 20 per page, SQL only'));
        if (hot && idx) {
          chart.appendChild(s('line', { x1: X[p], x2: X[p], y1: 22, y2: 152, style: { stroke: 'var(--ink-2)', strokeWidth: '1', strokeDasharray: '3 3' } }));
        }
        [['offset', 'var(--bad)'], ['keyset', 'var(--ok)']].forEach(([k, colour]) => {
          chart.appendChild(s('polyline', { points: AFTER_MS[k].map((v, i) => X[i] + ',' + Y(v)).join(' '), style: { fill: 'none', stroke: colour, strokeWidth: '2' } }));
          AFTER_MS[k].forEach((v, i) => {
            const sel = hot && idx && i === p && k === mth;
            chart.appendChild(s('circle', { cx: X[i], cy: Y(v), r: sel ? 6 : 3.5, style: { fill: sel ? 'var(--white)' : colour, stroke: colour, strokeWidth: sel ? '3' : '1' } }));
          });
        });
        chart.appendChild(s('text', { x: X[3] - 12, y: Y(17.306) + 2, 'text-anchor': 'end', style: { fill: 'var(--bad-ink)' } }, 'Offset, 17.3 ms at page 10,000'));
        chart.appendChild(s('text', { x: X[3] - 12, y: Y(0.039) - 8, 'text-anchor': 'end', style: { fill: 'var(--ok)' } }, 'Keyset, flat near 0.04 ms'));
      }

      function measure() {
        const quiet = dep.get() === 'quiet';
        const m = meth.get();
        const idx = !noIndex.get();
        const p = quiet ? 0 : page.get();
        const off = PAGES[p] * 20;
        if (quiet) {
          // The first page with OFFSET 0 sends the same query as the first keyset page.
          return idx
            ? { ms: 0.040, read: 21, buffers: '4', plan: 'Index scan on idx_task_deployment_id', http: null, tone: 'ok', text: '0.040 ms with the index: Postgres seeks to this deployment and reads 21 entries. On a first page, offset and keyset send the same query.' }
            : { ms: 123, read: 862985, buffers: '860k', plan: 'Scan on task_pkey, 862,964 rows removed by the filter', http: null, tone: 'bad', text: '123 ms for the first page of a 570-task deployment. Without the index Postgres walked task_pkey and threw away 862,964 rows that belong to other deployments.' };
        }
        if (idx) {
          if (m === 'offset') {
            return {
              ms: AFTER_MS.offset[p], read: off + 21, buffers: p === 3 ? '3,660' : 'not recorded',
              plan: 'Index scan on idx_task_deployment_id, reading every skipped entry',
              http: p === 3 ? 24.4 : p === 0 ? 8.9 : null,
              tone: p === 0 ? 'ok' : 'warn',
              text: p === 0
                ? 'At page 0 there is nothing to skip: 0.035 ms, the same as the first keyset page.'
                : `${AFTER_MS.offset[p]} ms: OFFSET ${fmt(off)} reads ${fmt(off + 21)} index entries to return 21.` +
                  (p === 3 ? ' Over HTTP that is 24.4 ms against 9.2 ms for the cursor.' : ' The cost grows by about 0.087 µs per skipped row.')
            };
          }
          return {
            ms: AFTER_MS.keyset[p], read: 21, buffers: p === 3 ? '4' : 'not recorded',
            plan: 'Index range scan on idx_task_deployment_id, both conditions in the index',
            http: p === 3 ? 9.2 : p === 0 ? 8.7 : null,
            tone: 'ok',
            text: `${AFTER_MS.keyset[p]} ms. The index seeks straight to ${p === 0 ? 'this deployment’s first task' : 'id > cursor'} and reads 21 entries, whatever the depth.`
          };
        }
        if (p !== 3) {
          return { ms: null, read: null, buffers: null, plan: null, http: null, tone: 'idle', text: 'Not measured: before V4 only page 10,000 was timed. Move "Page" to 10,000, or turn the index back on.' };
        }
        if (m === 'offset') {
          return { ms: 54.7, read: TOTAL, buffers: '14.8k plus temp files', plan: 'Parallel seq scan, then a sort that spilled about 20 MB to disk', http: null, tone: 'bad', text: '54.7 ms: Postgres scanned all 1,200,101 tasks, sorted this deployment’s 250,000 on disk, then skipped 200,000 of them.' };
        }
        return { ms: 0.044, read: 21, buffers: '4', plan: 'Index scan on task_pkey from the cursor, filter on deployment_id', http: null, tone: 'warn', text: '0.044 ms, but by luck: this deployment’s ids sit together in task_pkey. Pick the quiet deployment to see what keyset costs without the right index.' };
      }

      function sqlFor() {
        const quiet = dep.get() === 'quiet';
        const pg = quiet ? 0 : PAGES[page.get()];
        if (meth.get() === 'offset') {
          return `-- GET /api/v1/deployments/{id}/tasks/by-offset?page=${pg}&size=20\nSELECT * FROM task\n WHERE deployment_id = :d\n ORDER BY id\n LIMIT 21 OFFSET ${pg * 20};   -- 21 = size + 1: the extra row only says "there is a next page"`;
        }
        if (pg === 0) {
          return '-- GET /api/v1/deployments/{id}/tasks?limit=20   (first page, no cursor yet)\nSELECT * FROM task\n WHERE deployment_id = :d\n ORDER BY id\n LIMIT 21;   -- limit + 1';
        }
        return `-- GET /api/v1/deployments/{id}/tasks?cursor=${EXAMPLE_CURSOR}&limit=20\n-- cursor = base64url of the last id on the previous page (example id ${EXAMPLE_ID})\nSELECT * FROM task\n WHERE deployment_id = :d AND id > :cursor_id\n ORDER BY id\n LIMIT 21;   -- limit + 1`;
      }

      function update() {
        const quiet = dep.get() === 'quiet';
        const input = page.el.querySelector('input');
        if (quiet) page.set(0);
        input.disabled = quiet;
        const r = measure();
        const barTone = r.tone === 'idle' ? null : r.tone;
        rMs.set(r.ms === null ? 'not measured' : r.ms + ' ms', barTone);
        rHttp.set(r.http ? r.http + ' ms' : 'not measured');
        rRead.set(r.read === null ? '—' : fmt(r.read), barTone);
        rRet.set('21 (20 + 1)');
        rBuf.set(r.buffers || '—');
        barRead.set(r.read || 0, barTone);
        barMs.set(r.ms || 0, barTone);
        plan.textContent = 'Plan: ' + (r.plan || 'not measured');
        setCode(sqlBox, sqlFor());
        verdict.set(r.tone, r.text);
        drawChart();
      }

      function del() {
        const idx = !noIndex.get();
        rDel.set(idx ? '64 ms' : '10,080 ms', idx ? 'ok' : 'bad');
      }

      el.append(
        controls(dep.el, meth.el),
        controls(page.el, noIndex.el, delBtn),
        stage(h('div', { class: 'sim-cols' },
          ui.panel('Work for one page of 20', barRead.el, barRet.el, barMs.el, plan),
          ui.panel('Depth curve with the index', chart))),
        sqlBox,
        readouts(rMs, rHttp, rRead, rRet, rBuf, rDel),
        note('All numbers are measured (PostgreSQL 16, 1,200,101 seeded tasks, median of 5 warm runs; HTTP is the median of 10). Before V4 only page 10,000 and the quiet first page were timed, so other points say "not measured". Deleting 600 deployments makes Postgres check that no task still references each one: 10,080 ms without the index, 64 ms with it.'),
        verdict.el
      );
      update();
    }
  });

  // =====================================================================
  // 6. Transaction boundaries and rollback rules
  // =====================================================================
  AF.register({
    id: 'pg-transactions',
    group: 'postgres',
    order: 6,
    title: 'Transaction boundaries and rollback rules',
    question: 'When a request fails halfway, which rows should survive, and why does Spring sometimes commit when you expected a rollback?',
    status: 'built',
    slice: 'S2, S3.3',
    where: [
      'AuditEventRecorder.record, REQUIRES_NEW',
      'DeploymentServiceAuditRecordingTest, DeploymentServiceRollbackTest',
      'DeploymentService.requestDeployment, saveAndFlush before the audit',
      'DeploymentEndpointsTest.secondActiveDeployment_returns409_andLeavesNoOrphanAudit'
    ],
    idea: [
      'A transaction makes a group of writes all-or-nothing. In Spring, @Transactional opens one around a method, and propagation decides what an inner @Transactional call does: REQUIRED joins the caller’s transaction and shares its fate, REQUIRES_NEW pauses it and commits on its own. By default Spring rolls back only for unchecked exceptions; a checked exception commits unless rollbackFor names it.',
      'AuditEventRecorder.record runs in REQUIRES_NEW, so the audit row survives a rolled-back deployment, as DeploymentServiceAuditRecordingTest proves. DeploymentServiceRollbackTest pins both sides of the checked-exception rule: without rollbackFor the deployment commits, with it the row is gone.',
      'REQUIRES_NEW has a cost. In requestDeployment, saveAndFlush runs before the audit, so a unique violation fails at the flush and the 409 leaves no orphan audit row. The proxy trap that silently ignores REQUIRES_NEW is taught in the Spring lesson on proxies (sp-proxy).'
    ],
    terms: [
      ['Propagation', 'What a @Transactional method does when called inside an existing transaction: join it (REQUIRED) or suspend it and start its own (REQUIRES_NEW).'],
      ['rollbackFor', 'Names checked exceptions that should roll the transaction back too.'],
      ['Flush', 'Hibernate sends its pending SQL now, inside the transaction, instead of waiting for the commit.'],
      ['Orphan row', 'A row that refers to something which was never committed.']
    ],
    tryIt: [
      'With "REQUIRES_NEW" and "RuntimeException", press "Send the request": the deployment rolls back, the audit row stays.',
      'Switch "Audit propagation" to "REQUIRED" and send again: the audit row rolls back too.',
      'Pick "Checked exception", turn on "Leave out rollbackFor" and send: 422, yet the deployment row commits.',
      'Pick "Unique violation at flush", turn on "Write audit before the flush" and send: 409 plus an orphan audit row.'
    ],
    breakIt: 'Leave out rollbackFor and a checked exception commits the half-done deployment while the caller sees an error. Write the REQUIRES_NEW audit before the flush and a 409 leaves an audit row for a deployment that never existed.',
    say: 'Audit uses REQUIRES_NEW so it survives a rolled-back deployment, we flush the insert before writing audit so a constraint violation fails first, and checked exceptions need rollbackFor because Spring rolls back only on unchecked ones by default.',
    quiz: {
      q: 'A @Transactional method saves a deployment, then throws the checked DeploymentValidationException. There is no rollbackFor. What is in the database afterwards?',
      options: [
        'Nothing: any exception rolls the transaction back',
        'Nothing, but only because the audit recorder uses REQUIRES_NEW',
        'The deployment row, flagged as rolled back',
        'The deployment row, committed: by default Spring rolls back only on unchecked exceptions'
      ],
      answer: 3,
      why: 'Spring’s default rule marks a transaction for rollback on RuntimeException and Error only. A checked exception propagates to the caller, but the transaction still commits unless rollbackFor names that exception.'
    },
    mount(el, ctx) {
      let deps = [];
      let audits = [];
      let seq = 0;
      let runId = 0;
      let running = false;

      const log = ui.log({ label: 'SQL and transaction events' });
      const verdict = ui.verdict();
      const code = ui.code('', 'Model of the service method');
      const rResp = ui.readout('Response');
      const rDeps = ui.readout('deployment rows');
      const rAudit = ui.readout('audit_event rows');
      const rOrphan = ui.readout('Audit rows with no deployment');

      const prop = ui.choice('Audit propagation', [
        { value: 'new', label: 'REQUIRES_NEW' },
        { value: 'req', label: 'REQUIRED' }
      ], 'new', showCode);
      const fail = ui.choice('Failure', [
        { value: 'none', label: 'None' },
        { value: 'runtime', label: 'RuntimeException' },
        { value: 'checked', label: 'Checked exception' },
        { value: 'unique', label: 'Unique violation at flush' }
      ], 'runtime', showCode);
      const noRollbackFor = ui.toggle('Leave out rollbackFor', false, showCode, { tone: 'danger' });
      const auditFirst = ui.toggle('Write audit before the flush', false, showCode, { tone: 'danger' });
      const sendBtn = ui.button('Send the request', send, { variant: 'primary' });
      const resetBtn = ui.button('Reset tables', reset, { variant: 'quiet' });
      const laneTx = ui.lane('This request', 'outer transaction');
      const laneDep = ui.lane('deployment', 'committed rows');
      const laneAud = ui.lane('audit_event', 'committed rows');

      function showCode() {
        const newTx = prop.get() === 'new';
        const ann = noRollbackFor.get() ? '@Transactional' : '@Transactional(rollbackFor = DeploymentValidationException.class)';
        const audit = '    auditEventRecorder.record(event);               // ' + (newTx ? 'REQUIRES_NEW: own transaction, commits at once' : 'REQUIRED: joins this transaction');
        const ending = {
          none: '    return accepted;',
          runtime: '    throw new IllegalStateException("simulated failure");          // unchecked',
          checked: '    throw new DeploymentValidationException("simulated failure");  // checked',
          unique: '    return accepted;   // never reached when the flush fails'
        }[fail.get()];
        const lines = [ann, 'public DeploymentAccepted requestDeployment(...) {', '    Deployment deployment = new Deployment(app, release, env);'];
        if (auditFirst.get()) {
          lines.push('    deploymentRepository.save(deployment);          // no INSERT yet: it waits for the flush', audit,
            '    deploymentRepository.flush();                   // INSERT now: the unique index can fire here');
        } else {
          lines.push('    deploymentRepository.saveAndFlush(deployment);  // INSERT now: the unique index can fire here', audit);
        }
        lines.push(ending, '}');
        setCode(code, lines.join('\n'));
      }

      function buildScript(cfg, id, app, n) {
        const S = [];
        const pending = [];
        let violated = false;
        const add = (chip, tone, text, fn) => S.push({ chip, tone, text, fn });
        const auditRow = () => audits.push({ id: 'a-' + n, target: id, fate: null });
        const insertSql = `INSERT INTO deployment (id, application_id, environment_id, status, ...) VALUES ('${id}', '${app}', 'prod', 'PENDING', ...);`;
        const auditSql = `INSERT INTO audit_event (id, action, target_id, ...) VALUES ('a-${n}', 'DEPLOYMENT_REQUESTED', '${id}', ...);`;

        const audit = () => {
          if (cfg.prop === 'new') {
            add('outer suspended', 'idle', '-- outer transaction suspended');
            add('audit: BEGIN, INSERT, COMMIT', 'ok', `BEGIN; ${auditSql} COMMIT;   -- REQUIRES_NEW: durable now, whatever happens next`, auditRow);
            add('outer resumed', 'idle', '-- outer transaction resumed');
          } else {
            add('INSERT audit, uncommitted', 'busy', auditSql + '   -- REQUIRED: inside the outer transaction');
            pending.push('audit');
          }
        };
        const flush = () => {
          if (cfg.fail === 'unique') {
            add('INSERT deployment: unique violation', 'bad', insertSql);
            add(null, 'bad', 'ERROR: duplicate key value violates unique constraint "uq_deployment_active_per_app_env"');
            violated = true;
          } else {
            add('INSERT deployment, uncommitted', 'busy', insertSql);
            pending.push('deployment');
          }
        };

        add('BEGIN', 'busy', 'BEGIN   -- @Transactional on the service method');
        if (cfg.auditFirst) {
          add('save(): no SQL yet', 'idle', `deploymentRepository.save(${id})   -- @Version entity: the INSERT waits for the flush`);
          audit();
          flush();
        } else {
          flush();
          if (!violated) audit();
        }

        let outcome;
        let response;
        if (violated) {
          outcome = 'rollback';
          response = '409 conflict';
        } else if (cfg.fail === 'runtime') {
          add('throw IllegalStateException', 'bad', 'throw new IllegalStateException(...)   -- unchecked');
          outcome = 'rollback';
          response = '500 internal-error';
        } else if (cfg.fail === 'checked') {
          add('throw DeploymentValidationException', 'bad', 'throw new DeploymentValidationException(...)   -- checked');
          outcome = cfg.rollbackFor ? 'rollback' : 'commit';
          response = '422 unprocessable';
        } else {
          outcome = 'commit';
          response = '202 Accepted';
        }
        if (outcome === 'commit') {
          add('COMMIT', cfg.fail === 'checked' ? 'warn' : 'ok',
            cfg.fail === 'checked' ? 'COMMIT   -- a checked exception does not mark the transaction for rollback by default' : 'COMMIT',
            () => {
              if (pending.indexOf('deployment') >= 0) deps.push({ id, app, status: 'PENDING' });
              if (pending.indexOf('audit') >= 0) auditRow();
            });
        } else {
          const why = violated ? 'the flush failed' : cfg.fail === 'checked' ? 'rollbackFor names this checked exception' : 'unchecked exception';
          add('ROLLBACK', 'bad', `ROLLBACK   -- ${why}` + (pending.length ? ': discards the uncommitted ' + pending.join(' and ') + ' row' + (pending.length > 1 ? 's' : '') : ''));
        }
        const detail = {
          '409 conflict': '409 urn:appfleet:problem:conflict "An active deployment already exists for this application and environment."',
          '500 internal-error': '500 urn:appfleet:problem:internal-error',
          '422 unprocessable': '422 urn:appfleet:problem:unprocessable',
          '202 Accepted': `202 Accepted, Location: /api/v1/tasks/{taskId}`
        }[response];
        add(response, response === '202 Accepted' ? 'ok' : 'bad', detail);
        return { S, response, violated };
      }

      function judge(cfg, sc) {
        const newTx = cfg.prop === 'new';
        if (sc.violated) {
          if (cfg.auditFirst && newTx) return ['bad', '409 conflict, but the REQUIRES_NEW audit row had already committed: it records a deployment request for a row that does not exist. Flush first, then audit.'];
          if (cfg.auditFirst) return ['warn', '409 and no orphan, because the audit row shared the rolled-back transaction. With REQUIRED, though, no audit row ever survives a failure.'];
          return ['ok', '409 conflict at the flush, before any audit write, so no orphan audit row. This is the order requestDeployment uses: saveAndFlush, then audit.'];
        }
        if (cfg.fail === 'runtime') {
          return newTx
            ? ['ok', 'The deployment rolled back and the audit row survived in its own transaction. DeploymentServiceAuditRecordingTest proves exactly this.']
            : ['warn', 'The audit row rolled back together with the deployment: no trace that anyone tried. That is why AuditEventRecorder uses REQUIRES_NEW.'];
        }
        if (cfg.fail === 'checked') {
          return cfg.rollbackFor
            ? ['ok', 'rollbackFor turns the checked exception into a rollback: 422 and no deployment row.' + (newTx ? ' The audit row survived on its own.' : '')]
            : ['bad', 'The caller got 422, yet the deployment row COMMITTED. Spring rolls back only on unchecked exceptions unless rollbackFor says otherwise, as DeploymentServiceRollbackTest pins.'];
        }
        return ['ok', '202 Accepted. The deployment and its audit row are both committed.'];
      }

      function renderTables() {
        AF.clear(laneDep.body);
        deps.forEach(d => laneDep.body.appendChild(ui.token(`${d.id} ${d.app} ${d.status}${d.seed ? ', seed' : ''}`, d.seed ? 'idle' : 'ok')));
        AF.clear(laneAud.body);
        if (!audits.length) laneAud.body.appendChild(label('no rows yet'));
        let orphans = 0;
        audits.forEach(a => {
          const has = deps.some(d => d.id === a.target);
          let text = `${a.id} DEPLOYMENT_REQUESTED for ${a.target}`;
          let tone = 'ok';
          if (!has) {
            orphans++;
            if (a.fate && a.fate.indexOf('409') === 0) { text += ': orphan, the request was refused'; tone = 'bad'; }
            else if (a.fate) { text += ': survived the rollback'; tone = 'warn'; }
            else { text += ': committed, deployment still open'; tone = 'busy'; }
          }
          laneAud.body.appendChild(ui.token(text, tone));
        });
        rDeps.set(deps.length);
        rAudit.set(audits.length);
        rOrphan.set(orphans, orphans ? 'warn' : null);
      }

      async function send() {
        if (running) return;
        running = true;
        sendBtn.disabled = true;
        const id = ++runId;
        seq++;
        const depId = 'd-' + seq;
        const cfg = { prop: prop.get(), fail: fail.get(), rollbackFor: !noRollbackFor.get(), auditFirst: auditFirst.get() };
        const app = cfg.fail === 'unique' ? 'checkout-service' : 'app-' + seq;
        const sc = buildScript(cfg, depId, app, seq);
        AF.clear(laneTx.body);
        verdict.clear();
        rResp.set('…');
        log.add(`POST /api/v1/deployments for ${app} in prod`, 'busy');
        for (const st of sc.S) {
          await pace(ctx, 420);
          if (!ctx.alive || id !== runId) return;
          if (st.fn) st.fn();
          if (st.chip) laneTx.body.appendChild(ui.token(st.chip, st.tone));
          if (st.text) log.add(st.text, st.tone === 'idle' ? 'muted' : st.tone);
          renderTables();
        }
        audits.forEach(a => { if (a.target === depId) a.fate = sc.response; });
        rResp.set(sc.response, sc.response === '202 Accepted' ? 'ok' : 'bad');
        const v = judge(cfg, sc);
        verdict.set(v[0], v[1]);
        running = false;
        sendBtn.disabled = false;
        renderTables();
      }

      function reset() {
        runId++;
        running = false;
        sendBtn.disabled = false;
        seq = 0;
        deps = [{ id: 'd-0', app: 'checkout-service', status: 'HEALTHY', seed: true }];
        audits = [];
        AF.clear(laneTx.body);
        log.clear();
        verdict.clear();
        rResp.set('—');
        log.add('Seed: d-0 is an active (HEALTHY) deployment of checkout-service in prod. "Unique violation at flush" requests the same pair.', 'muted');
        renderTables();
        showCode();
      }

      el.append(
        controls(prop.el, fail.el),
        controls(noRollbackFor.el, auditFirst.el, sendBtn, resetBtn),
        stage(h('div', { class: 'sim-cols' }, laneTx.el, laneDep.el, laneAud.el)),
        code,
        note('A model method that combines requestDeployment with the S2 demonstrations. If record() were called on this instead of on the AuditEventRecorder bean, REQUIRES_NEW would be silently ignored; the Spring lesson on proxies (sp-proxy) shows why.'),
        readouts(rResp, rDeps, rAudit, rOrphan),
        verdict.el,
        log.el
      );
      reset();
    }
  });

  // =====================================================================
  // 7. A work queue in a table (planned)
  // =====================================================================
  AF.register({
    id: 'pg-skiplocked',
    group: 'postgres',
    order: 7,
    title: 'A work queue in a table',
    question: 'How can several workers take jobs from one database table without two of them grabbing the same job or waiting on each other?',
    status: 'planned',
    slice: 'S4, S6',
    where: [
      'docs/specs/project/03-TASK-SERVICE.md, "Work claiming"',
      'docs/specs/project/03-TASK-SERVICE.md, "Domain model"',
      'docs/specs/project/01-CONTROL-API.md, S6 reaper'
    ],
    idea: [
      'A table can work as a queue: each worker selects the oldest QUEUED row and marks it CLAIMED. Without a lock, two workers can read the same row at the same instant and both claim it. FOR UPDATE locks the row, which stops double claims, but the other workers wait in line for that lock. SKIP LOCKED makes them skip locked rows and take the next free one.',
      'task-service (planned, S4 and S6) will claim work that arrives by polling rather than Kafka, such as delayed retries, with SELECT ... FOR UPDATE SKIP LOCKED: several instances, no double claim, no blocking. The planned task states are QUEUED, CLAIMED, RUNNING, then SUCCEEDED, FAILED or DEAD.',
      'A worker can die holding a claim. A stale-claim reaper moves any row CLAIMED for longer than the lease back to QUEUED, so another worker picks it up. When task-service scales out, the reaper runs on every instance; the spec fixes that with the same claim table, so the fix and the bug are one mechanism.'
    ],
    terms: [
      ['Row lock', 'FOR UPDATE locks the selected rows until the transaction ends; anyone else who wants them waits.'],
      ['SKIP LOCKED', 'Instead of waiting, skip rows that someone else has locked.'],
      ['Lease', 'How long a claim is trusted; after that the reaper assumes the worker is gone.'],
      ['Reaper', 'A periodic job that returns stale claims to the queue.']
    ],
    tryIt: [
      'With "No lock" selected, press "Run the workers": every task runs three times.',
      'Pick "FOR UPDATE" and run: no double claims, but "Ticks spent waiting" grows as workers queue for one lock.',
      'Pick "FOR UPDATE SKIP LOCKED", run, and press "Kill worker 2 mid-task": after the lease the reaper returns its task to QUEUED.',
      'Turn on "Turn off the reaper", run again and kill worker 2: its task stays CLAIMED forever.'
    ],
    breakIt: 'With no lock, every idle worker reads the same QUEUED row and claims it, so one job runs several times. Without the reaper, a task claimed by a crashed worker stays CLAIMED forever.',
    say: 'For polled work, task-service will claim rows with SELECT ... FOR UPDATE SKIP LOCKED so many instances share one table without double claims or lock waits, and a reaper returns claims older than the lease to QUEUED.',
    quiz: {
      q: 'Three task-service instances poll the same table. Why is FOR UPDATE SKIP LOCKED better than plain FOR UPDATE?',
      options: [
        'SKIP LOCKED takes no locks at all, so it is faster',
        'Plain FOR UPDATE lets two workers claim the same row',
        'Each worker skips rows another worker has locked and takes the next one, so nobody waits',
        'SKIP LOCKED makes the stale-claim reaper unnecessary'
      ],
      answer: 2,
      why: 'Plain FOR UPDATE is already safe from double claims, but everyone queues behind the row the first worker locked. SKIP LOCKED still locks the row it takes; it just does not wait for rows locked by others. Crashed workers still need the reaper.'
    },
    mount(el, ctx) {
      const N_TASKS = 6;
      const CLAIM = 2;
      const WORK = 3;
      const LEASE = 8;
      const TICK = 380;
      let rows;
      let workers;
      let tick;
      let timer = null;
      let stats;
      let killPending;
      let finished;

      const log = ui.log({ label: 'Workers and reaper' });
      const verdict = ui.verdict();
      const sqlBox = ui.code('', 'Claim query and reaper');
      const rDone = ui.readout('Succeeded');
      const rExec = ui.readout('Executions');
      const rDouble = ui.readout('Double claims');
      const rWait = ui.readout('Ticks spent waiting');
      const rReaped = ui.readout('Reclaimed by reaper');
      const rTick = ui.readout('Tick');

      const mode = ui.choice('Claim query', [
        { value: 'none', label: 'No lock' },
        { value: 'fu', label: 'FOR UPDATE' },
        { value: 'skip', label: 'FOR UPDATE SKIP LOCKED' }
      ], 'none', () => reset());
      const runBtn = ui.button('Run the workers', start, { variant: 'primary' });
      const killBtn = ui.button('Kill worker 2 mid-task', kill, { variant: 'danger' });
      const noReaper = ui.toggle('Turn off the reaper', false, on => {
        log.add(on ? 'Reaper off: nothing returns stale claims to QUEUED.' : `Reaper on: claims older than the lease (${LEASE} ticks) go back to QUEUED.`, on ? 'warn' : 'muted');
        render();
      }, { tone: 'danger' });
      const resetBtn = ui.button('Reset', () => reset(), { variant: 'quiet' });
      const tableLane = ui.lane('task table', 'one chip per row');
      const workerLane = ui.lane('task-service workers', '3 instances');
      const tableRow = h('div', { class: 'row' });
      tableLane.body.appendChild(tableRow);

      const short = w => 'w' + w.n;

      function showSql() {
        const m = mode.get();
        const lock = { none: '', fu: '\n   FOR UPDATE', skip: '\n   FOR UPDATE SKIP LOCKED' }[m];
        const comment = {
          none: '-- no lock: two workers can read the same row at the same instant',
          fu: '-- others that reach a locked row wait here until the lock holder commits',
          skip: '-- rows locked by someone else are skipped, not waited for'
        }[m];
        setCode(sqlBox, `-- each worker, in its own short transaction ${comment}\nSELECT id FROM task\n WHERE state = 'QUEUED'\n ORDER BY id\n LIMIT 1${lock};\nUPDATE task SET state = 'CLAIMED', claimed_by = :me, claimed_at = now() WHERE id = :id;\nCOMMIT;\n\n-- reaper, on a schedule\nUPDATE task SET state = 'QUEUED', claimed_by = NULL\n WHERE state = 'CLAIMED' AND claimed_at < now() - :lease;`);
      }

      function stop() {
        if (timer !== null) {
          clearInterval(timer);
          timer = null;
        }
      }

      function reset() {
        stop();
        rows = [];
        for (let i = 1; i <= N_TASKS; i++) rows.push({ id: 't' + i, state: 'QUEUED', lockedBy: null, by: null, claimedAt: 0, execs: 0 });
        workers = [1, 2, 3].map(n => ({ n, name: 'worker ' + n, alive: true, phase: 'idle', row: null, left: 0, waitOn: null, since: 0 }));
        tick = 0;
        stats = { execs: 0, doubles: 0, waits: 0, reaped: 0 };
        killPending = false;
        finished = false;
        log.clear();
        verdict.clear();
        log.add(`${N_TASKS} tasks QUEUED. Claim query: ${mode.get() === 'none' ? 'no lock' : mode.get() === 'fu' ? 'FOR UPDATE' : 'FOR UPDATE SKIP LOCKED'}.`, 'muted');
        showSql();
        render();
      }

      function start() {
        if (timer !== null) return;
        if (finished) reset();
        log.add('Workers start polling.', 'muted');
        timer = ctx.interval(stepTick, TICK);
        render();
      }

      function die(w) {
        if (w.phase === 'claiming' && w.row && w.row.lockedBy === w) w.row.lockedBy = null;
        w.alive = false;
        w.phase = 'stopped';
        log.add(`${w.name} stopped mid-task. ` + (w.row && w.row.state === 'CLAIMED' ? `${w.row.id} stays CLAIMED by a worker that no longer exists.` : ''), 'bad');
      }

      function kill() {
        const w = workers[1];
        if (!w.alive || killPending) return;
        if (w.phase === 'working') die(w);
        else {
          killPending = true;
          log.add('worker 2 will stop right after its next claim commits.', 'warn');
        }
        render();
      }

      function stepTick() {
        tick++;
        // 1. work in progress
        workers.forEach(w => {
          if (!w.alive || w.phase !== 'working') return;
          w.left--;
          if (w.left > 0) return;
          const r = w.row;
          if (r.state === 'SUCCEEDED') log.add(`${w.name} finished ${r.id} again: its side effects ran twice`, 'bad');
          else {
            r.state = 'SUCCEEDED';
            log.add(`${w.name}: ${r.id} SUCCEEDED`, 'ok');
          }
          w.phase = 'idle';
          w.row = null;
          w.since = tick;
        });
        // 2. claim transactions that commit now
        workers.forEach(w => {
          if (!w.alive || w.phase !== 'claiming') return;
          w.left--;
          if (w.left > 0) return;
          const r = w.row;
          if (r.lockedBy === w) r.lockedBy = null;
          if (r.state !== 'QUEUED') {
            stats.doubles++;
            log.add(`${w.name}: UPDATE ${r.id} SET state = 'CLAIMED' -> committed, but ${r.by} already claimed it. Double claim.`, 'bad');
          } else {
            log.add(`${w.name}: claimed ${r.id}, COMMIT`, 'busy');
          }
          r.state = 'CLAIMED';
          r.by = w.name;
          r.claimedAt = tick;
          r.execs++;
          stats.execs++;
          w.phase = 'working';
          w.left = WORK;
          if (killPending && w === workers[1]) {
            killPending = false;
            die(w);
          }
        });
        // 3. reaper
        if (!noReaper.get()) {
          rows.forEach(r => {
            if (r.state === 'CLAIMED' && tick - r.claimedAt >= LEASE) {
              log.add(`reaper: ${r.id} CLAIMED for ${tick - r.claimedAt} ticks, longer than the lease of ${LEASE}: back to QUEUED`, 'warn');
              r.state = 'QUEUED';
              r.by = null;
              stats.reaped++;
            }
          });
        }
        // 4. idle and waiting workers try to claim, oldest request first
        const want = workers.filter(w => w.alive && (w.phase === 'idle' || w.phase === 'waiting'))
          .sort((a, b) => a.since - b.since || a.n - b.n);
        const m = mode.get();
        const blocked = [];
        want.forEach(w => {
          let r;
          if (m === 'skip') r = rows.find(x => x.state === 'QUEUED' && !x.lockedBy);
          else r = rows.find(x => x.state === 'QUEUED');
          if (!r) {
            w.phase = 'idle';
            w.waitOn = null;
            return;
          }
          if (m === 'fu' && r.lockedBy && r.lockedBy !== w) {
            if (w.phase !== 'waiting') w.since = tick;
            w.phase = 'waiting';
            w.waitOn = r.id;
            stats.waits++;
            blocked.push(w);
            return;
          }
          if (m !== 'none') r.lockedBy = w;
          w.phase = 'claiming';
          w.row = r;
          w.left = CLAIM;
          w.waitOn = null;
          log.add(`${w.name}: SELECT ... -> ${r.id}${m === 'none' ? ' (no lock taken)' : ', row locked'}`, 'muted');
        });
        if (blocked.length) log.add(`${blocked.map(w => w.name).join(' and ')} blocked on the row lock for ${blocked[0].waitOn}`, 'warn');
        checkEnd();
        render();
      }

      function checkEnd() {
        if (rows.every(r => r.state === 'SUCCEEDED')) {
          finish();
          return;
        }
        const anyWork = workers.some(w => w.alive && (w.phase === 'working' || w.phase === 'claiming'));
        const queued = rows.some(r => r.state === 'QUEUED');
        const stuck = rows.filter(r => r.state === 'CLAIMED' && !workers.some(w => w.alive && w.row === r));
        if (!anyWork && !queued && stuck.length && noReaper.get()) {
          stop();
          finished = true;
          verdict.set('bad', `${stuck.map(r => r.id).join(', ')} stuck in CLAIMED by a worker that is gone. With the reaper off, nothing will ever pick it up.`);
          log.add('Run ended with work stuck.', 'bad');
        } else if (tick > 200) {
          stop();
          finished = true;
        }
      }

      function finish() {
        stop();
        finished = true;
        const m = mode.get();
        const reaped = stats.reaped
          ? ` The reaper returned ${plural(stats.reaped, 'stale claim')} to QUEUED after the lease, and a live worker finished the work.`
          : '';
        if (m === 'none') verdict.set('bad', `All ${N_TASKS} tasks done, but they ran ${stats.execs} times: ${plural(stats.doubles, 'double claim')}. Every idle worker read the same QUEUED row.` + reaped);
        else if (m === 'fu') verdict.set('warn', `No double claims (${stats.execs} executions for ${N_TASKS} tasks), but workers spent ${plural(stats.waits, 'tick')} blocked behind each other’s row locks and finished at tick ${tick}.` + reaped);
        else verdict.set('ok', `No double claims and no waiting: ${stats.execs} executions for ${N_TASKS} tasks, finished at tick ${tick}.` + reaped);
        log.add(`All tasks SUCCEEDED at tick ${tick}.`, 'ok');
      }

      function render() {
        AF.clear(tableRow);
        rows.forEach(r => {
          let text = `${r.id} ${r.state}`;
          let tone = 'idle';
          if (r.state === 'QUEUED') {
            if (r.lockedBy) { text += `, locked by ${short(r.lockedBy)}`; tone = 'busy'; }
          } else if (r.state === 'CLAIMED') {
            const live = workers.some(w => w.alive && w.row === r);
            text += ` by ${r.by.replace('worker ', 'w')}, age ${tick - r.claimedAt}` + (live ? '' : ', stale');
            tone = live ? 'busy' : 'warn';
          } else {
            if (r.execs > 1) text += `, ran ${r.execs} times`;
            tone = r.execs > 1 ? 'bad' : 'ok';
          }
          tableRow.appendChild(ui.token(text, tone));
        });
        AF.clear(workerLane.body);
        workers.forEach(w => {
          let sub;
          let tone;
          if (w.phase === 'stopped') { sub = 'stopped' + (w.row ? `, was holding ${w.row.id}` : ''); tone = 'bad'; }
          else if (w.phase === 'waiting') { sub = `waiting for the lock on ${w.waitOn}`; tone = 'warn'; }
          else if (w.phase === 'claiming') { sub = `claiming ${w.row.id}, transaction open`; tone = 'busy'; }
          else if (w.phase === 'working') { sub = `working on ${w.row.id}, ${plural(w.left, 'tick')} left`; tone = 'ok'; }
          else { sub = 'idle'; tone = 'idle'; }
          workerLane.body.appendChild(AF.tone(ui.node(w.name, sub), tone));
        });
        const done = rows.filter(r => r.state === 'SUCCEEDED').length;
        rDone.set(`${done} of ${N_TASKS}`, done === N_TASKS ? 'ok' : null);
        rExec.set(stats.execs);
        rDouble.set(stats.doubles, stats.doubles ? 'bad' : null);
        rWait.set(stats.waits, stats.waits ? 'warn' : null);
        rReaped.set(stats.reaped);
        rTick.set(tick);
        const running = timer !== null;
        runBtn.disabled = running;
        killBtn.disabled = !running || !workers[1].alive || killPending;
      }

      el.append(
        controls(mode.el),
        controls(runBtn, killBtn, noReaper.el, resetBtn),
        stage(h('div', { class: 'sim-cols' }, tableLane.el, workerLane.el)),
        sqlBox,
        readouts(rDone, rExec, rDouble, rWait, rReaped, rTick),
        note(`Planned for task-service (S4, S6); nothing here is built yet. Illustrative timings: a claim transaction takes ${CLAIM} ticks, the work ${WORK}, the lease is ${LEASE}. Column names in the SQL are a sketch.`),
        verdict.el,
        log.el
      );
      reset();
    }
  });

  // =====================================================================
  // 8. Normalised writes, denormalised reads
  // =====================================================================
  AF.register({
    id: 'pg-schema',
    group: 'postgres',
    order: 8,
    title: 'Normalised writes, denormalised reads',
    question: 'Why does control-api store each fact exactly once, while the planned query-service copies the same facts into wide rows?',
    status: 'built',
    slice: 'S1, S6',
    where: [
      'docs/design/control-api/control-api-schema-3nf.md',
      'V1__init.sql to V4__add_task_deployment_index.sql',
      'docs/specs/project/05-QUERY-SERVICE.md, "Read models"',
      'docs/specs/project/01-CONTROL-API.md, "Ownership note"'
    ],
    idea: [
      'A normalised schema (3NF) stores each fact once: the application name lives only in application, and a deployment points at it by id. An update touches one row and cannot disagree with itself. The price is joins on every read. A denormalised read model copies the facts a screen needs into one row, so reads are cheap but every change must reach every copy.',
      'control-api’s schema (Flyway V1 to V4) is 3NF and checked against BCNF, with one deliberate exception: deployment.current_status duplicates status for the read path. Today nothing updates it; an S6 AFTER_COMMIT listener will, after the commit, so a rolled-back change never leaks into it. If the listener fails, the copy drifts until the next transition.',
      'Each service owns its schema in one Postgres instance and never reads another’s. When Team and User move to identity-service in S4, control-api keeps ownerTeamId as a plain column, not a JPA relation. query-service (planned, S6) builds deployment_summary, application_history, fleet_view and task_timeline, shaped by query and rebuildable from events.'
    ],
    terms: [
      ['3NF', 'Every non-key column depends on the key, the whole key, and nothing but the key.'],
      ['Read model', 'A table shaped for one query and rebuilt from events; denormalised on purpose.'],
      ['Drift', 'A copy that no longer matches its source because an update was missed.'],
      ['AFTER_COMMIT listener', 'Code that runs only once a transaction has committed, so it never acts on a change that rolled back.']
    ],
    tryIt: [
      'Switch "Answer the dashboard from" between the two options and compare joins and rows touched, then drag "Tasks per deployment" up.',
      'Press "Rename the application": one row changes in control-api, five in deployment_summary.',
      'Turn on "Skip the AFTER_COMMIT update", press "Advance deployment d1" and watch current_status go stale.',
      'Turn on "Projection loses the event", advance again, then press "Rebuild deployment_summary" to replay and repair.'
    ],
    breakIt: 'If the AFTER_COMMIT update is skipped, deployment.current_status keeps showing the old state while status moves on, and nothing in the schema repairs it until the next transition.',
    say: 'control-api writes to a 3NF schema with one documented denormalisation kept by an AFTER_COMMIT listener, and query-service will serve dashboards from denormalised read models that are disposable projections rebuilt from the event topic.',
    quiz: {
      q: 'deployment.current_status breaks 3NF on purpose. What will keep it consistent once S6 lands, and why after the commit?',
      options: [
        'An AFTER_COMMIT listener, so a rolled-back transition can never leave current_status showing a change that did not happen',
        'A database trigger in the same transaction, so it can never lag',
        'transitionTo sets both columns, so they cannot differ',
        'A nightly job that copies status into current_status'
      ],
      answer: 0,
      why: 'Updating after the commit means only committed changes reach the copy. The price is a window: if the listener fails or the app crashes between commit and listener, current_status lags until the next transition.'
    },
    mount(el, ctx) {
      const BASE = [
        { id: 'd1', env: 'prod', release: 'v1.4.0', status: 'DEPLOYING', tasks: 3 },
        { id: 'd2', env: 'staging', release: 'v1.4.0', status: 'HEALTHY', tasks: 4 },
        { id: 'd3', env: 'dev', release: 'v1.5.0', status: 'PENDING', tasks: 1 },
        { id: 'd4', env: 'prod', release: 'v1.3.0', status: 'ROLLED_BACK', tasks: 5 },
        { id: 'd5', env: 'prod', release: 'v1.2.0', status: 'FAILED', tasks: 2 }
      ];
      const NF_SQL = [
        '-- 20 newest deployments, from control-api’s 3NF tables',
        'SELECT d.id, a.name AS application, e.name AS environment,',
        '       r.version AS release, d.status, count(t.id) AS tasks',
        '  FROM deployment d',
        '  JOIN application a ON a.id = d.application_id',
        '  JOIN environment e ON e.id = d.environment_id',
        '  JOIN release     r ON r.id = d.release_id',
        '  LEFT JOIN task   t ON t.deployment_id = d.id',
        ' GROUP BY d.id, a.name, e.name, r.version, d.status',
        ' ORDER BY d.id DESC',
        ' LIMIT 20;'
      ].join('\n');
      const RM_SQL = [
        '-- the same question from query-service’s read model (planned, S6)',
        'SELECT deployment_id, application_name, environment_name,',
        '       release_version, status, task_count',
        '  FROM deployment_summary',
        ' ORDER BY deployment_id DESC',
        ' LIMIT 20;'
      ].join('\n');
      let app;
      let deps;
      let summary;
      let busy = false;
      let runId = 0;
      let lastWrites = { write: 0, copies: 0 };

      const log = ui.log({ label: 'Writes and projections' });
      const verdict = ui.verdict();
      const sqlBox = ui.code('', 'Dashboard query');
      const rJoins = ui.readout('Joins in the dashboard query');
      const rTouched = ui.readout('Rows touched');
      const rWrite = ui.readout('Rows written, write model');
      const rCopies = ui.readout('Rows written, copies');
      const rStale = ui.readout('Stale values');

      const src = ui.choice('Answer the dashboard from', [
        { value: 'nf', label: 'control-api tables (3NF)' },
        { value: 'rm', label: 'deployment_summary' }
      ], 'nf', showQuery);
      const tasksPer = ui.slider({ label: 'Tasks per deployment', min: 1, max: 40, value: 3, onInput: showQuery });
      const renameBtn = ui.button('Rename the application', rename);
      const advanceBtn = ui.button('Advance deployment d1', advance);
      const rebuildBtn = ui.button('Rebuild deployment_summary', rebuild);
      const skipAfter = ui.toggle('Skip the AFTER_COMMIT update', false, on => {
        log.add(on ? 'Break switch on: the AFTER_COMMIT listener will not update current_status.' : 'Break switch off: the listener updates current_status after each commit.', on ? 'warn' : 'muted');
      }, { tone: 'danger' });
      const loseEvent = ui.toggle('Projection loses the event', false, on => {
        log.add(on ? 'Break switch on: the projection will drop the next events instead of applying them.' : 'Break switch off: the projection applies every event.', on ? 'warn' : 'muted');
      }, { tone: 'danger' });
      const resetBtn = ui.button('Reset', reset, { variant: 'quiet' });
      const left = h('div', { class: 'stack' });
      const right = h('div', { class: 'stack' });

      const project = d => ({ id: d.id, app, env: d.env, release: d.release, status: d.status, tasks: d.tasks });

      function showQuery() {
        const t = tasksPer.get();
        if (src.get() === 'nf') {
          setCode(sqlBox, NF_SQL);
          rJoins.set(4);
          rTouched.set(fmt(80 + 20 * t), t > 10 ? 'warn' : null);
        } else {
          setCode(sqlBox, RM_SQL);
          rJoins.set(0, 'ok');
          rTouched.set(20, 'ok');
        }
      }

      function staleCount() {
        const current = deps.filter(d => d.current !== d.status).length;
        let sum = 0;
        summary.forEach(r => {
          const d = deps.find(x => x.id === r.id);
          if (r.app !== app) sum++;
          if (r.status !== d.status) sum++;
        });
        return { current, summary: sum, total: current + sum };
      }

      function judge() {
        const st = staleCount();
        if (!st.total) {
          verdict.set('ok', `Everything agrees. The write model changed ${plural(lastWrites.write, 'row')}; the copies needed ${plural(lastWrites.copies, 'row')} to keep up.`);
          return;
        }
        const parts = [];
        if (st.current) parts.push(`${st.current} in current_status`);
        if (st.summary) parts.push(`${st.summary} in deployment_summary`);
        verdict.set('bad', `${plural(st.total, 'stale value')}: ${parts.join(', ')}. ` +
          (st.current ? 'Nothing repairs current_status until the next transition runs the listener. ' : '') +
          (st.summary ? 'Press "Rebuild deployment_summary" to replay the events.' : ''));
      }

      function render() {
        AF.clear(left);
        AF.clear(right);
        left.appendChild(h('div', { class: 'row' }, ui.token('application: ' + app, 'ok')));
        deps.forEach(d => {
          const stale = d.current !== d.status;
          left.appendChild(h('div', { class: 'row' },
            ui.token(`${d.id} ${d.env} ${d.release}`),
            ui.token('status ' + d.status),
            ui.token('current_status ' + d.current + (stale ? ', stale' : ''), stale ? 'warn' : null)));
        });
        if (!summary.length) right.appendChild(label('empty: rebuilding'));
        summary.forEach(r => {
          const d = deps.find(x => x.id === r.id);
          const appStale = r.app !== app;
          const stStale = r.status !== d.status;
          right.appendChild(h('div', { class: 'row' },
            ui.token(r.id),
            ui.token(r.app + (appStale ? ', stale' : ''), appStale ? 'warn' : null),
            ui.token(`${r.env} ${r.release}`),
            ui.token(r.status + (stStale ? ', stale' : ''), stStale ? 'warn' : null),
            ui.token(r.tasks + ' tasks')));
        });
        const st = staleCount();
        rWrite.set(lastWrites.write);
        rCopies.set(lastWrites.copies);
        rStale.set(st.total, st.total ? 'bad' : 'ok');
        [renameBtn, advanceBtn, rebuildBtn].forEach(b => { b.disabled = busy; });
      }

      async function rename() {
        if (busy) return;
        busy = true;
        const id = ++runId;
        const from = app;
        const to = app === 'checkout-service' ? 'checkout' : 'checkout-service';
        app = to;
        lastWrites = { write: 1, copies: 0 };
        verdict.clear();
        log.add(`BEGIN; UPDATE application SET name = '${to}' WHERE id = ?; COMMIT;   -- 1 row in control-api`, 'ok');
        render();
        if (loseEvent.get()) {
          await pace(ctx, 500);
          if (!ctx.alive || id !== runId) return;
          log.add(`The projection dropped the event: deployment_summary still says '${from}' in ${plural(summary.length, 'row')}.`, 'bad');
        } else {
          log.add(`projection: UPDATE deployment_summary SET application_name = '${to}' WHERE application_id = ?   -- ${plural(summary.length, 'row')}`, 'busy');
          for (const row of summary) {
            await pace(ctx, 260);
            if (!ctx.alive || id !== runId) return;
            row.app = to;
            lastWrites.copies++;
            render();
          }
        }
        busy = false;
        render();
        judge();
      }

      async function advance() {
        if (busy) return;
        busy = true;
        const id = ++runId;
        const d = deps[0];
        const from = d.status;
        const to = from === 'HEALTHY' ? 'DEGRADED' : 'HEALTHY';
        d.status = to;
        lastWrites = { write: 1, copies: 0 };
        verdict.clear();
        log.add(`BEGIN; UPDATE deployment SET status = '${to}', version = version + 1 WHERE id = 'd1'; COMMIT;   -- transitionTo(${to}) from ${from}, 1 row`, 'ok');
        render();
        await pace(ctx, 450);
        if (!ctx.alive || id !== runId) return;
        if (skipAfter.get()) {
          log.add(`AFTER_COMMIT update skipped: current_status still says ${d.current}.`, 'bad');
        } else {
          d.current = to;
          lastWrites.copies++;
          log.add(`AFTER_COMMIT listener: UPDATE deployment SET current_status = '${to}' WHERE id = 'd1'`, 'busy');
        }
        render();
        await pace(ctx, 550);
        if (!ctx.alive || id !== runId) return;
        const row = summary.find(r => r.id === 'd1');
        if (loseEvent.get()) {
          log.add(`The projection dropped the event: deployment_summary still says ${row.status} for d1.`, 'bad');
        } else {
          row.status = to;
          lastWrites.copies++;
          log.add(`deployment.events -> projection: UPDATE deployment_summary SET status = '${to}' WHERE deployment_id = 'd1'`, 'busy');
        }
        busy = false;
        render();
        judge();
      }

      async function rebuild() {
        if (busy) return;
        busy = true;
        const id = ++runId;
        lastWrites = { write: 0, copies: 0 };
        verdict.clear();
        log.add('POST /admin/projections/deployment_summary/rebuild: TRUNCATE, then replay deployment.events from the earliest offset', 'busy');
        summary = [];
        render();
        for (const d of deps) {
          await pace(ctx, 220);
          if (!ctx.alive || id !== runId) return;
          summary.push(project(d));
          lastWrites.copies++;
          render();
        }
        log.add('Rebuild done: deployment_summary matches the write side again.', 'ok');
        busy = false;
        render();
        judge();
      }

      function reset() {
        runId++;
        busy = false;
        app = 'checkout-service';
        deps = BASE.map(d => Object.assign({ current: d.status }, d));
        summary = deps.map(project);
        lastWrites = { write: 0, copies: 0 };
        log.clear();
        verdict.clear();
        log.add('checkout-service has 5 deployments. Both copies start in step with the write model.', 'muted');
        render();
        showQuery();
      }

      el.append(
        controls(src.el, tasksPer.el),
        controls(renameBtn, advanceBtn, rebuildBtn, skipAfter.el, loseEvent.el, resetBtn),
        stage(h('div', { class: 'stack' },
          sqlBox,
          h('div', { class: 'sim-cols' },
            ui.panel('control-api tables, 3NF (built)', left),
            ui.panel('query-service deployment_summary (planned, S6)', right)))),
        readouts(rJoins, rTouched, rWrite, rCopies, rStale),
        note('Rows touched is an illustrative count: 20 deployments, one lookup each in application, environment and release, plus one index entry per task. Renaming is illustrative too: control-api has no rename endpoint. deployment_summary column names are a sketch. Today nothing updates current_status; this sim shows the S6 listener.'),
        verdict.el,
        log.el
      );
      reset();
    }
  });

  // =====================================================================
  // 9. How an index speeds up a JPA query
  // =====================================================================
  AF.register({
    id: 'pg-indexes',
    group: 'postgres',
    order: 9,
    title: 'How an index speeds up a JPA query',
    question: 'JPA never mentions an index, so how did two small migrations turn 123 ms, 10 seconds and 7 ms into almost nothing, and what can an index not fix?',
    status: 'built',
    slice: 'S1, S3.4, S4.4',
    where: [
      'V4__add_task_deployment_index.sql, V5__add_application_owner_team_index.sql',
      'TaskRepository.findByDeployment_IdAndIdGreaterThanOrderByIdAsc, ApplicationRepository.findByOwnerTeamIdInOrderByIdAsc',
      'ApplicationOwnerIndexTest (red without V5, green with it)',
      'docs/design/control-api/control-api-s3-4-task-history.md, section 12; control-api-s4-4-idor.md, section 9.7'
    ],
    idea: [
      'An index is a database object, not a JPA one. A repository method becomes SQL with a WHERE and an ORDER BY, and the index decides whether Postgres answers it by seeking to a few entries or by walking rows and throwing most of them away. So the loop is always the same: switch on org.hibernate.SQL to see the statement JPA really sends, then run it under EXPLAIN (ANALYZE) and look for a primary-key walk with thousands of "Rows Removed by Filter".',
      'Appfleet hit three shapes. Filter plus sort: the task history walked task_pkey for 123 ms until V4 added (deployment_id, id), then 0.04 ms. Foreign key: task.deployment_id references deployment, and Postgres does not index the referencing column by itself, so deleting 600 deployments scanned task for each one, 10,080 ms, then 64 ms with the same index. Team filter: the S4.4 list adds WHERE owner_team_id IN (...) ORDER BY id, and V5 adds (owner_team_id, id). In a 200,000-application experiment that is 7 to 10 ms without it and 0.03 to 0.2 ms with it.',
      'Order the columns equality first, then the one you range over or sort by: the index then hands back one team’s or one deployment’s rows already in id order, with no sort. And an index fixes only the cost of one statement. It does not reduce how many statements JPA sends (N+1 needs @EntityGraph or JOIN FETCH), it slows every insert and update a little, and on 21 rows Postgres rightly ignores it.'
    ],
    terms: [
      ['Index scan', 'Postgres seeks into the index and reads only matching entries. The goal.'],
      ['Primary-key walk with a filter', 'Postgres reads rows in id order and discards those that do not match. Cost grows with the table. "Rows Removed by Filter" in EXPLAIN is the sign.'],
      ['Composite index', 'One index over several columns. Equality columns first, then the range or sort column; the leftmost column must be usable for the rest to help.'],
      ['Foreign-key check', 'On every delete of a parent row, Postgres looks for child rows. Without an index on the child column that is a scan.'],
      ['N+1', 'One query for the parents plus one per parent for a lazy association. An index makes each query faster, not fewer.']
    ],
    tryIt: [
      'Pick "Task history, first page" and switch "Index" from "No index" to "Right index": 123 ms becomes 0.040 ms, and rows read fall from 862,985 to 21.',
      'Pick "Delete 600 deployments": the foreign key makes Postgres scan task for every deleted row, 10,080 ms against 64 ms.',
      'Pick "Team-filtered list" and compare. The numbers come from a 200,000-row experiment in a rolled-back transaction, not from the app’s own 21 applications.',
      'Pick "N+1" and switch the index on and off: the statement count stays 51. Turn on "@EntityGraph" and it becomes 1.',
      'Choose "Wrong column order" anywhere: the lab says "not measured" and explains why the leftmost-column rule defeats it.'
    ],
    breakIt: 'Create the index with the columns the wrong way round, (id, deployment_id). Postgres cannot seek on deployment_id because it is the second column, so it falls back to the primary-key walk and the migration looks done while nothing improved. This was not measured in Appfleet; the lab labels it so.',
    say: 'JPA never sees an index, so I read the SQL it generates with org.hibernate.SQL and run it under EXPLAIN ANALYZE: V4 (deployment_id, id) took the task history from 123 ms to 0.04 ms and the 600-deployment delete from 10 s to 64 ms because the foreign key had no index, and V5 (owner_team_id, id) removed a 7 to 10 ms primary-key walk from the team-filtered list, while N+1 still needed an EntityGraph.',
    quiz: {
      q: 'task.deployment_id has a foreign key to deployment. Before V4, why did deleting 600 deployments take about 10 seconds?',
      options: [
        'JPA cascades every delete to each task row one at a time',
        'Postgres does not index the referencing column of a foreign key, so each deleted deployment made it scan task to check that no task still referenced it',
        'The delete held a lock on the whole deployment table',
        'The transaction log had to be flushed 600 times'
      ],
      answer: 1,
      why: 'A foreign key adds the check, not an index on the child column. With idx_task_deployment_id the check is an index lookup per deployment: 64 ms in total. The seed deleted the deployments with SQL, so JPA cascades and locks played no part.'
    },
    mount(el, ctx) {
      // Every number is a measurement from docs/design/control-api (S3.4 section 12, S4.4 section 9.7).
      // 'team' comes from a 200,000-row experiment in a rolled-back transaction, not from the app's 21 rows.
      const QUERIES = {
        hist: {
          name: 'Task history, first page',
          index: 'idx_task_deployment_id (deployment_id, id)',
          sql: '-- TaskRepository.findByDeployment_IdOrderByIdAsc(deploymentId, Limit.of(21))\nSELECT * FROM task\n WHERE deployment_id = :d\n ORDER BY id\n LIMIT 21;   -- a quiet deployment: 570 of 1,200,101 tasks',
          none: { ms: 123, read: 862985, plan: 'Scan on task_pkey, 862,964 rows removed by the filter', tone: 'bad', text: '123 ms. Without the index Postgres walked task_pkey in id order and discarded 862,964 rows that belong to other deployments.' },
          right: { ms: 0.040, read: 21, plan: 'Index scan on idx_task_deployment_id: seek to this deployment, read 21 entries', tone: 'ok', text: '0.040 ms. Entries for one deployment sit together and already in id order, so Postgres reads 21 and stops.' }
        },
        offset: {
          name: 'Task history, offset page 10,000',
          index: 'idx_task_deployment_id (deployment_id, id)',
          sql: '-- GET .../tasks/by-offset?page=10000&size=20 on the hot deployment (250,000 tasks)\nSELECT * FROM task\n WHERE deployment_id = :d\n ORDER BY id\n LIMIT 21 OFFSET 200000;',
          none: { ms: 54.7, read: 1200101, plan: 'Parallel seq scan of all tasks, then a sort that spilled about 20 MB to disk', tone: 'bad', text: '54.7 ms: Postgres scanned every task, sorted this deployment’s 250,000 on disk, then skipped 200,000.' },
          right: { ms: 17.306, read: 200021, plan: 'Index scan on idx_task_deployment_id, reading every skipped entry', tone: 'warn', text: '17.3 ms: better, but OFFSET 200000 still reads 200,021 index entries. An index cannot make skipping free; the cursor of the pagination lesson can.' }
        },
        fk: {
          name: 'Delete 600 deployments',
          index: 'idx_task_deployment_id (deployment_id, id)',
          sql: '-- the foreign key task.deployment_id -> deployment(id) forces, per deleted deployment:\n--   "is any task still pointing at this id?"\nDELETE FROM deployment WHERE id IN (:600_ids);',
          none: { ms: 10080, read: null, plan: 'Seq scan of task for every deleted deployment (the foreign-key check)', tone: 'bad', text: '10,080 ms. A foreign key does not index the referencing column, so 600 deletes meant 600 scans of a 1.2 million-row table.' },
          right: { ms: 64, read: null, plan: 'Index lookup on idx_task_deployment_id for each deleted deployment', tone: 'ok', text: '64 ms. The foreign-key check is now an index lookup per deployment. The same V4 index that fixed the history query fixed this.' }
        },
        team: {
          name: 'Team-filtered application list',
          index: 'idx_application_owner_team_id (owner_team_id, id)',
          sql: '-- ApplicationRepository.findByOwnerTeamIdInOrderByIdAsc(teamIds, Limit.of(21))   (S4.4)\nSELECT * FROM application\n WHERE owner_team_id IN (:t1, :t2, :t3)\n ORDER BY id\n LIMIT 21;   -- experiment: 200,000 applications over 2,000 teams, caller in 3 teams',
          none: { ms: 7.264, read: 14768, plan: 'Index scan on application_pkey, 14,747 rows removed by the filter', tone: 'warn', text: '7.3 ms (10.4 ms for a cursor page far from the start). Not a sequential scan: a primary-key walk that filters. It grows with the table.' },
          right: { ms: 0.194, read: 300, plan: 'Bitmap scan on the (owner_team_id, id) index, 300 rows, top-N sort of 21', tone: 'ok', text: '0.19 ms for three teams, 0.03 ms for one team on a cursor page (index-only scan). Experiment numbers, not the app’s 21 applications.' }
        },
        n1: {
          name: 'N+1: deployments with their tasks',
          index: 'idx_task_deployment_id (deployment_id, id)',
          sql: '-- DeploymentService.listAllNaive(): 1 query for the deployments,\n-- then one query per deployment when the lazy tasks are touched\nSELECT * FROM deployment;                     -- 1\nSELECT * FROM task WHERE deployment_id = ?;   -- x 50'
        }
      };
      const WRONG = 'Not measured. With (id, deployment_id) the condition on deployment_id is on the second column, so Postgres cannot seek on it and falls back to the primary-key walk of the "No index" case. Pick another index to see a measured case.';

      const fmtMs = v => (v >= 1000 ? fmt(Math.round(v)) : v) + ' ms';
      const verdict = ui.verdict();
      const sqlBox = ui.code('', 'JPA and the SQL it sends');
      const plan = h('p', { class: 'small' });
      const rMs = ui.readout('Time');
      const rRead = ui.readout('Rows read');
      const rGain = ui.readout('Speed-up');
      const rIdx = ui.readout('Index');
      let shownMs = 0;
      let shownRead = 0;
      const barMs = ui.bar({ label: 'Time (log scale)', max: 6, value: 0, format: () => (shownMs ? fmtMs(shownMs) : 'not measured') });
      const barRead = ui.bar({ label: 'Rows read (root scale)', max: Math.sqrt(1200101), value: 0, format: () => (shownRead ? fmt(shownRead) : 'not recorded') });

      const q = ui.choice('Query', [
        { value: 'hist', label: 'Task history, first page' },
        { value: 'offset', label: 'Offset page 10,000' },
        { value: 'fk', label: 'Delete 600 deployments' },
        { value: 'team', label: 'Team-filtered list' },
        { value: 'n1', label: 'N+1' }
      ], 'hist', update);
      const idx = ui.choice('Index', [
        { value: 'none', label: 'No index' },
        { value: 'right', label: 'Right index' },
        { value: 'wrong', label: 'Wrong column order' }
      ], 'none', update);
      const eg = ui.toggle('@EntityGraph on the query', false, update);

      function update() {
        const key = q.get();
        const Q = QUERIES[key];
        const isN1 = key === 'n1';
        eg.el.style.display = isN1 ? '' : 'none';
        setCode(sqlBox, Q.sql);
        const wrongName = key === 'team' ? '(id, owner_team_id)' : '(id, deployment_id)';
        rIdx.set(idx.get() === 'none' ? 'none' : idx.get() === 'wrong' ? wrongName : Q.index.split(' ')[0]);

        if (isN1) {
          const stmts = eg.get() ? 1 : 51;
          shownMs = 0;
          shownRead = 0;
          barMs.set(0);
          barRead.set(0);
          rMs.set('not measured');
          rRead.set(stmts + (stmts === 1 ? ' statement' : ' statements'), eg.get() ? 'ok' : 'bad');
          rGain.set(eg.get() ? '51 to 1 statements' : '—');
          plan.textContent = 'Plan: the index changes how fast each of the ' + stmts + ' statement(s) runs, never how many JPA sends.';
          verdict.set(eg.get() ? 'ok' : 'bad', eg.get()
            ? '1 statement with @EntityGraph (measured in the N+1 drill: 51 naive, 1 with JOIN FETCH, 1 with EntityGraph, 3 with @BatchSize(25)). The index is irrelevant to this fix.'
            : '51 statements, with or without an index. An index speeds each one up; only a fetch plan (@EntityGraph, JOIN FETCH) sends fewer. Per-statement time was not measured here.');
          return;
        }

        if (idx.get() === 'wrong') {
          shownMs = 0;
          shownRead = 0;
          barMs.set(0);
          barRead.set(0);
          rMs.set('not measured');
          rRead.set('—');
          rGain.set('—');
          plan.textContent = 'Plan: not measured';
          verdict.set('idle', key === 'team' ? WRONG.replace('(id, deployment_id)', '(id, owner_team_id)').replace('deployment_id is on', 'owner_team_id is on') : WRONG);
          return;
        }

        const r = Q[idx.get()];
        shownMs = r.ms;
        shownRead = r.read || 0;
        barMs.set(Math.log10(r.ms / 0.01), r.tone);
        barRead.set(r.read ? Math.sqrt(r.read) : 0, r.tone);
        rMs.set(fmtMs(r.ms), r.tone);
        rRead.set(r.read ? fmt(r.read) : 'not recorded', r.read ? r.tone : null);
        const gain = Q.none.ms / Q.right.ms;
        rGain.set(idx.get() === 'right' ? '×' + (gain >= 100 ? fmt(Math.round(gain)) : gain.toFixed(1)) + ' faster than no index' : '—');
        plan.textContent = 'Plan: ' + r.plan;
        verdict.set(r.tone, r.text);
      }

      el.append(
        controls(q.el, idx.el, eg.el),
        stage(h('div', { class: 'sim-cols' },
          ui.panel('Work for this query', barMs.el, barRead.el, plan),
          ui.panel('JPA to SQL', sqlBox))),
        readouts(rMs, rRead, rGain, rIdx),
        note('Measured: PostgreSQL 16, the S3.4 seed of 1,200,101 tasks (history, offset and delete). The team list is a 200,000-application experiment in a rolled-back transaction, because the dev database has only 21 applications. N+1 shows statement counts, not times. Indexes also cost: every insert and update maintains each one, so add one for a query you have seen be slow.'),
        verdict.el
      );
      update();
    }
  });
})();
