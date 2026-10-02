/*
 * labs-kafka.js: the Kafka lessons for "How Appfleet works".
 *
 *   1. kf-partitions           ordering per partition, consumer groups, rebalance
 *   2. kf-outbox               transactional outbox against the two dual writes
 *   3. kf-idempotent-consumer  ack timing and dedupe on idempotencyToken
 *   4. kf-retry                backoff with jitter, failure kinds, task.work.DLT, replay
 *   5. kf-cqrs                 query-service projections, asOf, replay and rebuild
 *
 * Status as of 2026-10-02: every Kafka feature (S4 to S7) is planned. What exists is the
 * compose infrastructure: a KRaft broker with auto-create off, and the topics kafka-init
 * creates (deployment.commands 3, task.work 6, task.work.DLT 3, task.events 3,
 * deployment.events 3 partitions), plus control-api's outbox_message table and entity.
 */
(function () {
  'use strict';

  if (!window.AF) return;
  const h = AF.h;
  const ui = AF.ui;
  const SVG_NS = 'http://www.w3.org/2000/svg';

  // ---------- shared helpers ----------

  /** Small muted note under a simulation. */
  const note = text => h('p', { class: 'small muted' }, text);

  /** Muted placeholder text inside a lane. */
  const empty = text => h('span', { class: 'small muted' }, text);

  /** Replace an element's children, skipping null entries. */
  function fill(el, kids) {
    AF.clear(el);
    kids.forEach(k => { if (k) el.appendChild(k); });
    return el;
  }

  /** SVG element with attributes (colours go through style so var(--...) tokens resolve). */
  function svg(tag, attrs, text) {
    const el = document.createElementNS(SVG_NS, tag);
    if (attrs) Object.keys(attrs).forEach(k => el.setAttribute(k, String(attrs[k])));
    if (text !== undefined) el.textContent = text;
    return el;
  }

  function shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      const t = arr[i]; arr[i] = arr[j]; arr[j] = t;
    }
    return arr;
  }

  const plural = (n, one, many) => n + ' ' + (n === 1 ? one : (many || one + 's'));

  /** A lane whose aside text can be changed later through ln.aside. */
  function lane(title, aside) {
    const ln = ui.lane(title, aside || ' ');
    ln.aside = ln.title.lastChild;
    return ln;
  }

  const tokenRow = () => h('div', { class: 'row', style: 'gap:.35rem' });

  // =====================================================================
  // 1. Partitions and ordering
  // =====================================================================

  /** Kafka's murmur2 (org.apache.kafka.common.utils.Utils.murmur2) over the key's bytes. */
  function murmur2(str) {
    const data = [];
    for (let i = 0; i < str.length; i++) data.push(str.charCodeAt(i) & 0xff);
    const length = data.length;
    const m = 0x5bd1e995;
    let hash = (0x9747b28c ^ length) | 0;
    const length4 = Math.floor(length / 4);
    for (let i = 0; i < length4; i++) {
      const i4 = i * 4;
      let k = data[i4] + (data[i4 + 1] << 8) + (data[i4 + 2] << 16) + (data[i4 + 3] << 24);
      k = Math.imul(k, m);
      k ^= k >>> 24;
      k = Math.imul(k, m);
      hash = Math.imul(hash, m);
      hash ^= k;
    }
    const rem = length % 4;
    const base = length & ~3;
    if (rem === 3) hash ^= data[base + 2] << 16;
    if (rem >= 2) hash ^= data[base + 1] << 8;
    if (rem >= 1) { hash ^= data[base]; hash = Math.imul(hash, m); }
    hash ^= hash >>> 13;
    hash = Math.imul(hash, m);
    hash ^= hash >>> 15;
    return hash | 0;
  }

  /** The keyed path of Kafka's default partitioner: toPositive(murmur2(key)) % partitions. */
  const partitionFor = (key, n) => (murmur2(key) & 0x7fffffff) % n;

  /** Range-style assignment: contiguous blocks, the remainder to the first consumers. */
  function rangeAssign(ids, parts) {
    const owners = new Array(parts).fill(null);
    const n = ids.length;
    if (!n) return owners;
    const per = Math.floor(parts / n);
    const extra = parts % n;
    let p = 0;
    ids.forEach((id, i) => {
      const count = per + (i < extra ? 1 : 0);
      for (let k = 0; k < count; k++) owners[p++] = id;
    });
    return owners;
  }

  const ownedBy = (owners, id) => owners.map((o, p) => (o === id ? p : -1)).filter(p => p >= 0);

  /** One tick: each consumer handles the head of its next non-empty partition, one message at a time. */
  function stepGroup(queues, owners, ptrs) {
    const handled = [];
    const byConsumer = new Map();
    owners.forEach((id, p) => {
      if (id === null) return;
      if (!byConsumer.has(id)) byConsumer.set(id, []);
      byConsumer.get(id).push(p);
    });
    byConsumer.forEach((parts, id) => {
      const start = ptrs.get(id) || 0;
      for (let i = 0; i < parts.length; i++) {
        const idx = (start + i) % parts.length;
        const p = parts[idx];
        if (queues[p].length) {
          handled.push({ consumer: id, partition: p, msg: queues[p].shift() });
          ptrs.set(id, (idx + 1) % parts.length);
          break;
        }
      }
    });
    return handled;
  }

  const KF_P = 6;                         // task.work partitions in docker-compose.yml
  const KF_DEPS = ['A', 'B', 'C', 'D'];
  const KF_EVENTS = 4;
  const KF_BACKLOG = [2, 0, 3, 0, 1, 0];  // earlier work already waiting (illustrative)
  const KF_BATCH = 3;                     // sticky batch size for the no-key case (illustrative)

  function freshOrder() {
    const o = {};
    KF_DEPS.forEach(d => { o[d] = { max: 0, seen: [] }; });
    return o;
  }

  /** Record a handled message; returns true when a later event of the same deployment was already handled. */
  function track(order, msg) {
    if (!msg.dep) return false;
    const o = order[msg.dep];
    const late = msg.seq < o.max;
    o.max = Math.max(o.max, msg.seq);
    o.seen.push({ seq: msg.seq, late });
    return late;
  }

  const backlogQueues = () => KF_BACKLOG.map(n => Array.from({ length: n }, () => ({ dep: null, label: 'old' })));

  function countLate(queues, owners) {
    const q = queues.map(x => x.slice());
    const ptrs = new Map();
    const order = freshOrder();
    let late = 0;
    let guard = 0;
    while (q.some(x => x.length) && guard++ < 500) {
      stepGroup(q, owners, ptrs).forEach(hd => { if (track(order, hd.msg)) late++; });
    }
    return late;
  }

  /**
   * Build the partitions for one burst. deploymentId keys hash deterministically.
   * Random and missing keys pick a spread that really does reorder under the current
   * assignment, so a lucky draw never hides the lesson.
   */
  function buildBurst(mode, owners) {
    const msgs = [];
    for (let seq = 1; seq <= KF_EVENTS; seq++) {
      KF_DEPS.forEach(d => msgs.push({ dep: d, seq, label: d + seq, i: msgs.length }));
    }
    const place = parts => {
      const q = backlogQueues();
      msgs.forEach((msg, i) => q[parts[i]].push(Object.assign({}, msg, { p: parts[i] })));
      return q;
    };
    if (mode === 'deploymentId') return place(msgs.map(msg => partitionFor('dep-' + msg.dep, KF_P)));
    const tries = mode === 'none'
      ? shuffle([0, 1, 2, 3, 4, 5]).map(start => msgs.map((msg, i) => (start + Math.floor(i / KF_BATCH)) % KF_P))
      : Array.from({ length: 40 }, () => msgs.map(() => Math.floor(Math.random() * KF_P)));
    let fallback = null;
    for (const parts of tries) {
      const q = place(parts);
      if (countLate(q, owners) > 0) return q;
      fallback = fallback || q;
    }
    return fallback;
  }

  const who = list => (list.length === 1 ? 'consumer ' : 'consumers ') + list.join(', ');

  AF.register({
    id: 'kf-partitions',
    group: 'kafka',
    order: 1,
    title: 'Partitions and ordering',
    question: 'How can several consumers share the work while each deployment\'s events are still handled in order?',
    status: 'planned',
    slice: 'S0 infra, S4, S7',
    where: [
      'docker-compose.yml, kafka-init (task.work created with 6 partitions)',
      'docs/specs/SPRING-PROJECT.md, Kafka and the actor-model table',
      'docs/specs/project/03-TASK-SERVICE.md, Consumption'
    ],
    idea: [
      'A Kafka topic is split into partitions. Each partition is an ordered log, but Kafka promises nothing about order across partitions. The producer picks the partition from the message key: the same key always hashes to the same partition, so messages that share a key stay in the order they were sent.',
      'Consumers in one group divide the partitions between them, and each partition has exactly one owner at a time. A consumer can own several partitions; a consumer with none sits idle. When a consumer joins, leaves or dies, the group rebalances and hands its partitions to the others.',
      'Appfleet keys every message by deploymentId, so all events for one deployment queue on one partition and are handled one at a time: the actor model\'s mailbox, on a durable log. task-service consumes as group task-service. docker-compose creates task.work with 6 partitions on purpose, so S7 can prove a seventh consumer sits idle.'
    ],
    terms: [
      ['Partition', 'An ordered, append-only slice of a topic. Order holds inside it, never across partitions.'],
      ['Message key', 'The value hashed to choose a partition. Same key, same partition.'],
      ['Consumer group', 'Consumers sharing one subscription. Each partition goes to exactly one member.'],
      ['Rebalance', 'The group re-dividing partitions after a member joins, leaves or dies.']
    ],
    tryIt: [
      'Leave Message key on deploymentId and press Produce a burst: each deployment\'s events sit on one partition and are handled in order.',
      'Switch Message key to random key or no key and produce again: the order panel marks events handled late.',
      'Drag Consumers to 7 or 8: the extra consumers get no partition and stay idle.',
      'Press Kill a consumer during a burst: the group rebalances and the survivors take over its partitions.'
    ],
    breakIt: 'Send with a random key or no key and one deployment\'s events scatter over several partitions. Partitions drain at their own pace, so a later event can be handled before an earlier one.',
    say: 'Kafka orders messages per partition, not per topic, so I key by deploymentId to get per-deployment order, and the partition count caps how many consumers in a group can work in parallel.',
    quiz: {
      q: 'dep-A\'s events are sent with a random key instead of its deploymentId. Why can its second event be handled before its first?',
      options: [
        'The two events can land on different partitions, and Kafka keeps no order across partitions',
        'Kafka reorders messages inside a partition to balance load',
        'Messages without a stable key are delivered newest first',
        'The consumer group sorts messages by key before handing them out'
      ],
      answer: 0,
      why: 'Order exists only inside one partition. Different partitions are drained at their own pace, by different consumers or in turns by one, so nothing keeps dep-A\'s events in sequence across them. Keying by deploymentId puts them all on one partition.'
    },
    mount(el, ctx) {
      const TICK = 450;
      let keyMode = 'deploymentId';
      let ids = [1, 2, 3];
      let nextId = 4;
      let owners = rangeAssign(ids, KF_P);
      let ptrs = new Map();
      let queues = backlogQueues();
      let order = freshOrder();
      let late = 0;
      let rebalances = 0;
      let running = false;
      let rebalancing = false;
      let runId = 0;
      const active = new Set();
      const lastHandled = new Map();

      const keyChoice = ui.choice('Message key', [
        { value: 'deploymentId', label: 'deploymentId' },
        { value: 'random', label: 'random key' },
        { value: 'none', label: 'no key' }
      ], keyMode, v => { keyMode = v; renderKeyNote(); });
      const consumerSlider = ui.slider({ label: 'Consumers', min: 1, max: 8, value: ids.length, onInput: v => setConsumers(v) });
      const produceBtn = ui.button('Produce a burst', produce, { variant: 'primary' });
      const killBtn = ui.button('Kill a consumer', kill, { variant: 'danger' });
      const resetBtn = ui.button('Reset', reset, { variant: 'quiet' });

      const lanes = [];
      const partGrid = h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fill,minmax(7.5rem,1fr));gap:.6rem' });
      for (let p = 0; p < KF_P; p++) {
        const ln = lane('P' + p);
        ln.row = h('div', { class: 'row', style: 'gap:.3rem' });
        ln.body.appendChild(ln.row);
        partGrid.appendChild(ln.el);
        lanes.push(ln);
      }
      const consRow = h('div', { class: 'row' });
      const keyNote = h('p', { class: 'small muted' });
      const stage = h('div', { class: 'sim-stage stack' },
        h('div', { class: 'small' }, h('b', null, 'task.work'), ', 6 partitions. Each partition is read by exactly one consumer in the group.'),
        partGrid,
        h('div', { class: 'small' }, h('b', null, 'Consumer group')),
        consRow,
        keyNote);

      const consumersR = ui.readout('Consumers', ids.length);
      const ownR = ui.readout('Own a partition', ids.length);
      const idleR = ui.readout('Idle', 0);
      const rebR = ui.readout('Rebalances', 0);
      const lateR = ui.readout('Handled out of order', 0);
      const orderRows = h('div', { class: 'stack', style: 'gap:.4rem' });
      const verdict = ui.verdict();
      const idleVerdict = ui.verdict();
      const log = ui.log({ label: 'Partition and group log' });

      el.appendChild(h('div', { class: 'sim-controls' }, keyChoice.el, consumerSlider.el, produceBtn, killBtn, resetBtn));
      el.appendChild(stage);
      el.appendChild(h('div', { class: 'readouts' }, consumersR.el, ownR.el, idleR.el, rebR.el, lateR.el));
      el.appendChild(ui.panel('Order each deployment was handled in', orderRows));
      el.appendChild(verdict.el);
      el.appendChild(idleVerdict.el);
      el.appendChild(log.el);
      el.appendChild(note('Illustrative: 4 deployments with 4 events each, plus a fixed backlog of earlier work marked old. Partition = murmur2(key) mod 6, as Kafka\'s default partitioner computes it. Assignment is shown range style.'));

      const modeLabel = m => (m === 'deploymentId' ? 'deploymentId' : m === 'random' ? 'a random key' : 'no key');

      function renderKeyNote() {
        if (keyMode === 'deploymentId') {
          const map = {};
          KF_DEPS.forEach(d => {
            const p = partitionFor('dep-' + d, KF_P);
            (map[p] = map[p] || []).push('dep-' + d);
          });
          keyNote.textContent = 'Key deploymentId: murmur2(key) mod 6 sends ' +
            Object.keys(map).map(p => map[p].join(' and ') + ' to P' + p).join(', ') +
            '. Same key, same partition, every time.';
        } else if (keyMode === 'random') {
          keyNote.textContent = 'Random key: every message gets a fresh key, so the events of one deployment land on any partition.';
        } else {
          keyNote.textContent = 'No key: the producer fills one partition per batch (' + KF_BATCH + ' messages here), then moves on, so a deployment\'s events spread out.';
        }
      }

      function render() {
        lanes.forEach((ln, p) => {
          const owner = owners[p];
          ln.aside.textContent = rebalancing ? 'rebalancing' : owner === null ? 'no owner' : 'consumer ' + owner;
          fill(ln.row, queues[p].length
            ? queues[p].map((msg, i) => ui.token(msg.label, !msg.dep ? 'idle' : (i === 0 && running && !rebalancing ? 'busy' : null)))
            : [empty('empty')]);
        });

        fill(consRow, ids.map(id => {
          const parts = ownedBy(owners, id);
          const sub = rebalancing ? 'rebalancing, paused'
            : parts.length ? 'owns ' + parts.map(p => 'P' + p).join(', ') + (lastHandled.has(id) ? ' · last ' + lastHandled.get(id) : '')
              : 'idle: no partition';
          const n = ui.node('consumer ' + id, sub);
          return AF.tone(n, rebalancing ? 'warn' : !parts.length ? 'idle' : active.has(id) ? 'busy' : null);
        }));

        fill(orderRows, KF_DEPS.map(d => {
          const o = order[d];
          const bad = o.seen.some(x => x.late);
          const status = !o.seen.length ? 'waiting' : bad ? 'out of order' : o.seen.length === KF_EVENTS ? 'in order' : 'in order so far';
          return h('div', { class: 'row', style: 'gap:.35rem' },
            h('span', { style: 'min-width:3.6rem;font-weight:600' }, 'dep-' + d),
            o.seen.map(x => ui.token(d + x.seq + (x.late ? ' late' : ''), x.late ? 'bad' : 'ok')),
            h('span', { class: bad ? 'small' : 'small muted' }, status));
        }));

        const owning = ids.filter(id => owners.includes(id));
        const idle = ids.filter(id => !owners.includes(id));
        consumersR.set(ids.length);
        ownR.set(rebalancing ? '…' : owning.length);
        idleR.set(rebalancing ? '…' : idle.length, !rebalancing && idle.length ? 'warn' : null);
        rebR.set(rebalances);
        lateR.set(late, late ? 'bad' : null);
        if (!rebalancing && idle.length) {
          idleVerdict.set('warn', (idle.length === 1 ? 'Consumer ' + idle[0] + ' has' : 'Consumers ' + idle.join(' and ') + ' have') +
            ' no partition and ' + (idle.length === 1 ? 'sits' : 'sit') + ' idle: with 6 partitions, at most 6 consumers in a group can work. Partition count is the parallelism ceiling.');
        } else {
          idleVerdict.clear();
        }
      }

      function sync() {
        produceBtn.disabled = running;
        killBtn.disabled = ids.length <= 1;
      }

      function assignmentText() {
        return ids.map(id => {
          const ps = ownedBy(owners, id);
          return 'consumer ' + id + ': ' + (ps.length ? ps.map(p => 'P' + p).join(' ') : 'idle');
        }).join(' · ');
      }

      function finishRebalance() {
        rebalancing = false;
        owners = rangeAssign(ids, KF_P);
        ptrs = new Map();
        log.add('Assignment: ' + assignmentText(), 'muted');
        render();
      }

      function requestRebalance(reason, tone) {
        rebalances++;
        log.add(reason + '. The group rebalances.', tone || 'warn');
        if (running) { rebalancing = true; render(); } else finishRebalance();
        sync();
      }

      function setConsumers(v) {
        if (v === ids.length) return;
        const before = ids.slice();
        while (ids.length < v) ids.push(nextId++);
        const removed = [];
        while (ids.length > v) removed.unshift(ids.pop());
        requestRebalance(ids.length > before.length ? who(ids.slice(before.length)) + ' joined' : who(removed) + ' left');
      }

      function kill() {
        if (ids.length <= 1) return;
        const owning = ids.filter(id => owners.includes(id));
        const victim = AF.pick(owning.length ? owning : ids);
        const orphaned = ownedBy(owners, victim).map(p => 'P' + p);
        ids = ids.filter(id => id !== victim);
        lastHandled.delete(victim);
        active.delete(victim);
        consumerSlider.set(ids.length);
        requestRebalance('Consumer ' + victim + ' died' + (orphaned.length ? '; ' + orphaned.join(', ') + ' need a new owner' : '; it owned nothing'), 'bad');
      }

      function finishVerdict(mode) {
        if (late === 0 && mode === 'deploymentId') {
          verdict.set('ok', 'In order: every deployment\'s events were handled first to last. One key, one partition, one consumer at a time: the mailbox guarantee.');
        } else if (late === 0) {
          verdict.set('warn', 'No reordering this time, but nothing guaranteed it: with ' + modeLabel(mode) + ' the events of one deployment still sat on several partitions.');
        } else {
          verdict.set('bad', 'Out of order: ' + plural(late, 'event was', 'events were') + ' handled after a later event of the same deployment. With ' +
            modeLabel(mode) + ' one deployment spreads over several partitions, and partitions do not wait for each other.');
        }
      }

      async function produce() {
        if (running) return;
        const my = ++runId;
        const mode = keyMode;
        running = true;
        order = freshOrder();
        late = 0;
        lastHandled.clear();
        active.clear();
        verdict.clear();
        sync();
        const built = buildBurst(mode, owners);
        log.add('The producer sends 16 events, 4 for each of dep-A to dep-D, with ' + modeLabel(mode) + ' as the key.', 'busy');
        if (ctx.reducedMotion) {
          queues = built;
          render();
        } else {
          queues = built.map(q => q.filter(msg => !msg.dep));
          const msgs = [];
          built.forEach(q => q.forEach(msg => { if (msg.dep) msgs.push(msg); }));
          msgs.sort((a, b) => a.i - b.i);
          for (const msg of msgs) {
            queues[msg.p].push(msg);
            render();
            await AF.sleep(ctx, 60);
            if (!ctx.alive || my !== runId) return;
          }
        }
        while (queues.some(q => q.length)) {
          await AF.sleep(ctx, TICK);
          if (!ctx.alive || my !== runId) return;
          if (rebalancing) { finishRebalance(); continue; }
          active.clear();
          stepGroup(queues, owners, ptrs).forEach(hd => {
            active.add(hd.consumer);
            if (!hd.msg.dep) return;
            lastHandled.set(hd.consumer, hd.msg.label);
            if (track(order, hd.msg)) {
              late++;
              log.add('Consumer ' + hd.consumer + ' handled ' + hd.msg.label + ' from P' + hd.partition + ' after a later event of dep-' + hd.msg.dep + '.', 'bad');
            }
          });
          render();
        }
        if (rebalancing) finishRebalance();
        running = false;
        active.clear();
        sync();
        render();
        finishVerdict(mode);
        log.add('Burst done: ' + (late ? plural(late, 'event') + ' out of order.' : 'every deployment in order.'), late ? 'bad' : 'ok');
      }

      function reset() {
        runId++;
        running = false;
        rebalancing = false;
        ids = [1, 2, 3];
        nextId = 4;
        consumerSlider.set(ids.length);
        owners = rangeAssign(ids, KF_P);
        ptrs = new Map();
        queues = backlogQueues();
        order = freshOrder();
        late = 0;
        rebalances = 0;
        lastHandled.clear();
        active.clear();
        keyMode = 'deploymentId';
        keyChoice.set(keyMode);
        verdict.clear();
        log.clear();
        log.add('Reset: 3 consumers, 2 partitions each. Tokens marked old are earlier work already waiting.', 'muted');
        renderKeyNote();
        sync();
        render();
      }

      log.add('3 consumers share 6 partitions, 2 each. Tokens marked old are earlier work already waiting.', 'muted');
      renderKeyNote();
      sync();
      render();
    }
  });

  // =====================================================================
  // 2. Transactional outbox
  // =====================================================================

  // Sketch of each write path. Marker objects become "// crash here" when that crash point is chosen.
  const OUTBOX_CODE = {
    'commit-publish': [
      'deploymentService.create(request);    // @Transactional: INSERT, COMMIT',
      { at: 'after-commit', indent: '' },
      'kafkaTemplate.send("deployment.commands", id, payload);',
      { at: 'after-publish', indent: '' }
    ],
    'publish-commit': [
      '@Transactional',
      'public void create(...) {',
      '    deployments.save(deployment);       // INSERT, not committed yet',
      '    kafkaTemplate.send("deployment.commands", id, payload);',
      { at: 'after-publish', indent: '    ' },
      '}                                       // COMMIT',
      { at: 'after-commit', indent: '' }
    ],
    outbox: [
      '@Transactional',
      'public void create(...) {',
      '    deployments.save(deployment);',
      '    outbox.save(new OutboxMessage(id, payload));',
      '}                                       // COMMIT: both rows or neither',
      { at: 'after-commit', indent: '' },
      '',
      '@Scheduled(fixedDelay = POLL_MS)',
      'void publishPending() {',
      '    for (OutboxMessage m : outbox.findBySentAtIsNull()) {',
      '        kafkaTemplate.send("deployment.commands",',
      '            m.getAggregateId().toString(), m.getPayload()).join();',
      { at: 'after-publish', indent: '        ' },
      '        m.markSent();',
      '    }',
      '}'
    ]
  };

  AF.register({
    id: 'kf-outbox',
    group: 'kafka',
    order: 2,
    title: 'Transactional outbox',
    question: 'How do you save a change and announce it on Kafka without ever doing only one of the two?',
    status: 'planned',
    slice: 'S4',
    where: [
      'control-api/src/main/java/io/appfleet/control/outbox/OutboxMessage.java (entity exists, poller planned)',
      'control-api/src/main/resources/db/migration/V1__init.sql, outbox_message',
      'docs/specs/project/01-CONTROL-API.md, S4 (the outbox and its kill test)',
      'docs/design/control-api/control-api-spring-flow.md, Outbox flow'
    ],
    idea: [
      'A database commit and a Kafka publish happen in two separate systems, and no transaction spans both. Write to one, then the other, and a crash in between leaves them disagreeing: a saved change nobody hears about, or an announcement of a change that rolled back.',
      'The outbox moves the message into the database. The transaction that inserts the deployment also inserts an outbox_message row, so both commit or neither does. A scheduled poller reads unsent rows with findBySentAtIsNull, publishes each one, marks it sent with markSent, and deletes it later.',
      'If the app dies after a publish but before markSent, the poller publishes that row again on restart. So the outbox gives at-least-once publishing, and consumers must be idempotent (next lesson). control-api will publish deployment.commands this way in S4; the outbox_message table and entity already exist.'
    ],
    terms: [
      ['Dual write', 'Writing to two systems one after the other, with nothing tying the two writes together.'],
      ['Outbox row', 'A pending message stored in the same transaction as the change it announces.'],
      ['At-least-once', 'Every message gets delivered, possibly more than once.']
    ],
    tryIt: [
      'Choose Write path dual write: commit then publish and Crash point after commit, then press Create a deployment: the row exists, the message never leaves.',
      'Choose dual write: publish then commit with Crash point after publish: Kafka carries a deployment that Postgres rolled back.',
      'Choose outbox and try both crash points: after commit it still delivers once after the restart; after publish it delivers twice.'
    ],
    breakIt: 'Use a dual write and kill the process between the two writes: commit then publish loses the message, publish then commit announces a phantom deployment.',
    say: 'I never dual-write: the event goes into an outbox table in the same transaction as the state change and a poller publishes it, which gives at-least-once delivery that idempotent consumers absorb.',
    quiz: {
      q: 'With the outbox, the app crashes after Kafka acknowledged the publish but before the row was marked sent. What happens on restart?',
      options: [
        'The poller publishes the message again, so consumers see it twice',
        'The message is lost, because the poller already ran',
        'The deployment row rolls back to match',
        'Kafka recognises the repeat and drops it automatically'
      ],
      answer: 0,
      why: 'The row is still unsent, so the next poll publishes it again. That is the at-least-once trade the outbox makes, and idempotent consumers turn the repeat into a no-op. Kafka\'s idempotent producer only removes duplicates from its own retries within one producer session; a fresh send after a restart is a new message.'
    },
    mount(el, ctx) {
      const STEP = 750;
      let running = false;
      let runId = 0;
      let depN = 40;
      let runMode = 'commit-publish';
      let proc = 'running';
      let deps = [];
      let outbox = [];
      let topic = [];
      let phantom = false;

      const modeChoice = ui.choice('Write path', [
        { value: 'commit-publish', label: 'dual write: commit then publish' },
        { value: 'publish-commit', label: 'dual write: publish then commit' },
        { value: 'outbox', label: 'outbox' }
      ], 'commit-publish', () => { renderCode(); if (!running) render(); });
      const crashChoice = ui.choice('Crash point', [
        { value: 'none', label: 'no crash' },
        { value: 'after-commit', label: 'after commit' },
        { value: 'after-publish', label: 'after publish' }
      ], 'none', () => renderCode());
      const runBtn = ui.button('Create a deployment', run, { variant: 'primary' });

      const procBox = h('div');
      const depList = h('div', { class: 'stack', style: 'gap:.35rem' });
      const outboxList = h('div', { class: 'stack', style: 'gap:.35rem' });
      const topicList = h('div', { class: 'stack', style: 'gap:.35rem' });
      const cols = h('div', { class: 'sim-cols' }, [
        ['control-api process', procBox],
        ['Postgres: deployment', depList],
        ['Postgres: outbox_message', outboxList],
        ['Kafka: deployment.commands', topicList]
      ].map(([title, body]) => { const ln = ui.lane(title); ln.body.appendChild(body); return ln.el; }));
      const codeBox = h('div');

      const rowsR = ui.readout('Committed deployment rows', 0);
      const unsentR = ui.readout('Unsent outbox rows', 0);
      const msgsR = ui.readout('Messages on the topic', 0);
      const outcomeR = ui.readout('Outcome', '—');
      const verdict = ui.verdict();
      const log = ui.log({ label: 'Write path log' });

      el.appendChild(h('div', { class: 'sim-controls' }, modeChoice.el, crashChoice.el, runBtn));
      el.appendChild(h('div', { class: 'sim-stage' }, cols));
      el.appendChild(ui.panel('Sketch of the write path (planned for S4, not built yet)', codeBox));
      el.appendChild(h('div', { class: 'readouts' }, rowsR.el, unsentR.el, msgsR.el, outcomeR.el));
      el.appendChild(verdict.el);
      el.appendChild(log.el);
      el.appendChild(note('Illustrative: each step is slowed to under a second so you can watch it. The crash is a kill of the control-api process at the chosen point.'));

      function renderCode() {
        const crash = crashChoice.get();
        const lines = [];
        OUTBOX_CODE[modeChoice.get()].forEach(line => {
          if (typeof line === 'string') lines.push(line);
          else if (line.at === crash) lines.push(line.indent + '// crash here (' + (crash === 'after-commit' ? 'after commit' : 'after publish') + ')');
        });
        fill(codeBox, [ui.code(lines.join('\n'), 'Sketch of the write path')]);
      }

      function render() {
        const mode = running ? runMode : modeChoice.get();
        const pn = ui.node('control-api', proc === 'crashed' ? 'crashed: process killed' : proc === 'restarted' ? 'restarted' : 'running');
        fill(procBox, [AF.tone(pn, proc === 'crashed' ? 'bad' : proc === 'restarted' ? 'ok' : null)]);

        fill(depList, deps.length ? deps.map(d => ui.token(
          d.id + (d.state === 'rolled back' ? ' rolled back' : d.state === 'uncommitted' ? ' PENDING, uncommitted' : ' PENDING'),
          d.state === 'rolled back' ? 'bad' : d.state === 'uncommitted' ? 'busy' : 'ok')) : [empty('no rows')]);

        fill(outboxList, mode !== 'outbox' ? [empty('Not used by a dual write.')]
          : outbox.length ? outbox.map(o => ui.token(
            'for ' + o.dep + ', sent_at ' + (o.sent ? 'set' : 'null') + (o.state === 'uncommitted' ? ', uncommitted' : ''),
            o.state === 'uncommitted' ? 'busy' : o.sent ? 'ok' : 'warn')) : [empty('no rows')]);

        fill(topicList, topic.length ? topic.map((m, i) => ui.token(
          m.dep + (phantom ? ' phantom' : i > 0 ? ' again' : ''),
          phantom ? 'bad' : i > 0 ? 'warn' : 'ok')) : [empty('nothing published')]);

        rowsR.set(deps.filter(d => d.state === 'committed').length);
        unsentR.set(outbox.filter(o => !o.sent && o.state === 'committed').length);
        msgsR.set(topic.length, topic.length > 1 || phantom ? 'warn' : null);
      }

      function lock(on) {
        running = on;
        runBtn.disabled = on;
        modeChoice.el.disabled = on;
        crashChoice.el.disabled = on;
      }

      function finish(outcome, mode, crash, id) {
        const dual = mode !== 'outbox';
        if (outcome === 'lost') {
          outcomeR.set('Lost', 'bad');
          verdict.set('bad', 'Lost: ' + id + ' is committed in Postgres, but nothing was published and nothing on restart knows a publish was owed. task-service never hears of it, so it stays PENDING.');
        } else if (outcome === 'phantom') {
          outcomeR.set('Phantom', 'bad');
          verdict.set('bad', 'Phantom: deployment.commands announces ' + id + ', but its transaction rolled back. task-service will start work for a deployment that does not exist.');
        } else if (outcome === 'twice') {
          outcomeR.set('Delivered twice', 'warn');
          verdict.set('warn', 'Delivered twice: the crash came after the publish but before markSent, so the poller sent the row again. Nothing lost, but consumers must be idempotent.');
        } else if (dual) {
          outcomeR.set('Delivered once', 'warn');
          verdict.set('warn', 'Delivered once, but only because no crash hit the gap between the two writes. Nothing protects that gap.');
        } else {
          outcomeR.set('Delivered once', 'ok');
          verdict.set('ok', crash === 'after-commit'
            ? 'Delivered once, after the restart: the unsent outbox row survived the crash and the poller published it.'
            : 'Delivered once: the deployment row and its outbox row committed together, and the poller did the publishing.');
        }
        log.add('Outcome: ' + (outcome === 'twice' ? 'delivered twice' : outcome === 'once' ? 'delivered once' : outcome) + '.', outcome === 'once' ? (dual ? 'warn' : 'ok') : outcome === 'twice' ? 'warn' : 'bad');
        lock(false);
        render();
      }

      async function run() {
        if (running) return;
        const my = ++runId;
        const mode = modeChoice.get();
        const crash = crashChoice.get();
        runMode = mode;
        lock(true);
        depN++;
        const id = 'dep-' + depN;
        proc = 'running';
        deps = [];
        outbox = [];
        topic = [];
        phantom = false;
        outcomeR.set('…');
        verdict.clear();
        log.clear();

        const ok = () => ctx.alive && my === runId;
        const step = async (text, tone) => {
          if (text) log.add(text, tone);
          render();
          await AF.sleep(ctx, STEP);
          return ok();
        };
        const crashNow = async what => {
          proc = 'crashed';
          deps.forEach(d => { if (d.state === 'uncommitted') d.state = 'rolled back'; });
          if (!await step('Process killed ' + what + '. Open transactions roll back.', 'bad')) return false;
          proc = 'restarted';
          return step('control-api restarts.', 'muted');
        };

        deps.push({ id, state: 'uncommitted' });
        if (!await step('BEGIN; INSERT deployment ' + id + ' (PENDING)', 'busy')) return;

        if (mode === 'commit-publish') {
          deps[0].state = 'committed';
          if (!await step('COMMIT', 'ok')) return;
          if (crash === 'after-commit') {
            if (!await crashNow('after the commit, before the publish')) return;
            if (!await step('Nothing on restart remembers that a message was owed.', 'bad')) return;
            return finish('lost', mode, crash, id);
          }
          topic.push({ dep: id });
          if (!await step('kafkaTemplate.send("deployment.commands", ' + id + ')', 'ok')) return;
          if (crash === 'after-publish' && !await crashNow('after both writes')) return;
          return finish('once', mode, crash, id);
        }

        if (mode === 'publish-commit') {
          topic.push({ dep: id });
          if (!await step('kafkaTemplate.send("deployment.commands", ' + id + ') while the transaction is still open', 'warn')) return;
          if (crash === 'after-publish') {
            phantom = true;
            if (!await crashNow('after the publish, before the commit')) return;
            if (!await step('The message is already on the topic. It cannot be taken back.', 'bad')) return;
            return finish('phantom', mode, crash, id);
          }
          deps[0].state = 'committed';
          if (!await step('COMMIT', 'ok')) return;
          if (crash === 'after-commit' && !await crashNow('after both writes')) return;
          return finish('once', mode, crash, id);
        }

        // outbox
        outbox.push({ dep: id, sent: false, state: 'uncommitted' });
        if (!await step('INSERT outbox_message (aggregate_id ' + id + ', sent_at null)', 'busy')) return;
        deps[0].state = 'committed';
        outbox[0].state = 'committed';
        if (!await step('COMMIT: the deployment row and the outbox row together', 'ok')) return;
        if (crash === 'after-commit') {
          if (!await crashNow('after the commit, before the poller ran')) return;
          if (!await step('outbox_message still holds the unsent row.', 'ok')) return;
        }
        if (!await step('OutboxPoller: findBySentAtIsNull() returns 1 row', 'busy')) return;
        topic.push({ dep: id });
        if (!await step('kafkaTemplate.send("deployment.commands", key ' + id + ').join(): the broker acked', 'ok')) return;
        let copies = 1;
        if (crash === 'after-publish') {
          if (!await crashNow('after the publish, before markSent()')) return;
          if (!await step('OutboxPoller: findBySentAtIsNull() returns the same row again', 'warn')) return;
          topic.push({ dep: id });
          copies = 2;
          if (!await step('kafkaTemplate.send(...) publishes ' + id + ' a second time', 'warn')) return;
        }
        outbox[0].sent = true;
        if (!await step('markSent(): sent_at = now()', 'ok')) return;
        outbox = [];
        if (!await step('Cleanup deletes the sent row.', 'muted')) return;
        finish(copies === 2 ? 'twice' : 'once', mode, crash, id);
      }

      log.add('Pick a write path and a crash point, then press Create a deployment.', 'muted');
      renderCode();
      render();
    }
  });

  // =====================================================================
  // 3. Idempotent consumer and ack timing
  // =====================================================================

  AF.register({
    id: 'kf-idempotent-consumer',
    group: 'kafka',
    order: 3,
    title: 'Idempotent consumer and ack timing',
    question: 'If Kafka can deliver the same command twice, how do you make sure it creates only one task?',
    status: 'planned',
    slice: 'S4',
    where: [
      'docs/specs/project/03-TASK-SERVICE.md, Consumption',
      'docs/specs/SPRING-PROJECT.md, Kafka (idempotent consumers)',
      'task-service/src/main/resources/db/migration/V1__init.sql (empty today; schema task planned)'
    ],
    idea: [
      'Kafka records a consumer group\'s progress as a committed offset: the next message to read. When you commit it decides how you fail. Commit before the work and a crash mid-message skips it for good. Commit after the database commit and a crash in between replays it. Systems choose the replay, so at-least-once is what you actually get.',
      'An idempotent consumer makes the replay harmless. task-service will keep a processed-messages table keyed by idempotencyToken, the token control-api sets on each command and carries end to end. The token check, the new task row and the token row commit in one transaction, so a second delivery finds the token and only acks.',
      'task-service will offer record and batch listeners behind one TaskIntake interface, chosen by config (Strategy plus Factory); both ack only after the commit. The rebalance drill kills a worker mid-task: the stale-claim reaper stops the task being lost, and the token check stops it being doubled.'
    ],
    terms: [
      ['Committed offset', 'The position a consumer group has confirmed; after a crash, reading resumes there.'],
      ['Manual ack', 'The listener commits the offset itself, only after its work is safely stored.'],
      ['idempotencyToken', 'Set by control-api on each command and carried end to end; the dedupe key.'],
      ['Idempotent', 'Doing it twice has the same effect as doing it once.']
    ],
    tryIt: [
      'With Ack mode on manual ack after commit, press Process next, then Crash mid-message: the next worker reads the command again and the dedupe skips it.',
      'Press Deliver again to put a copy of the last command on the topic, then Process next: still one task.',
      'Switch on Turn off dedupe and repeat either step: the repeat becomes a second task.',
      'Switch Ack mode to auto-ack before processing and press Crash mid-message: the offset moved on, the task was never written, the command is lost.'
    ],
    breakIt: 'Turn off the dedupe and every redelivery creates another task. Auto-ack before processing swaps that duplicate for a command that is silently lost.',
    say: 'Exactly-once end to end is really at-least-once delivery plus an idempotent consumer: I commit the offset after the database transaction and dedupe on the idempotency token inside that transaction.',
    quiz: {
      q: 'Why must the processed-token check run in the same transaction as inserting the task?',
      options: [
        'Otherwise a crash between them can store the token without the task, or the task without the token',
        'Kafka requires one database transaction per consumed message',
        'It makes the consumer faster by batching two writes',
        'So the Kafka offset commit rolls back with it'
      ],
      answer: 0,
      why: 'Token and task must be all or nothing. Token saved without the task: the retry is wrongly skipped and the work is lost. Task saved without the token: the retry makes a duplicate. The offset commit is a separate Kafka write, which is exactly why the dedupe has to live in the database transaction.'
    },
    mount(el, ctx) {
      const STEP = 650;
      const START = [['dep-A', 'tok-a'], ['dep-B', 'tok-b'], ['dep-C', 'tok-c'], ['dep-D', 'tok-d']];
      let topic, committed, position, tasks, processed, worker, skipped, current, lastPolled;
      let running = false;
      let runId = 0;

      function init() {
        topic = START.map(([dep, token], i) => ({ offset: i, dep, token, copy: false, lost: false }));
        committed = 0;
        position = 0;
        tasks = [];
        processed = new Set();
        worker = 1;
        skipped = 0;
        current = -1;
        lastPolled = null;
      }
      init();

      const ackChoice = ui.choice('Ack mode', [
        { value: 'auto', label: 'auto-ack before processing' },
        { value: 'manual', label: 'manual ack after commit' }
      ], 'manual', () => renderHint());
      const dedupeOff = ui.toggle('Turn off dedupe', false, on => {
        log.add(on ? 'Dedupe off: the consumer no longer looks for the token before inserting a task.'
          : 'Dedupe on: the token is checked inside the same transaction as the insert.', on ? 'bad' : 'ok');
        render();
      }, { tone: 'danger' });
      const nextBtn = ui.button('Process next', () => run(false), { variant: 'primary' });
      const againBtn = ui.button('Deliver again', deliverAgain);
      const crashBtn = ui.button('Crash mid-message', () => run(true), { variant: 'danger' });
      const resetBtn = ui.button('Reset', reset, { variant: 'quiet' });
      const hint = h('p', { class: 'small muted', style: 'width:100%' });

      const topicLane = lane('deployment.commands, P0');
      const topicRow = tokenRow();
      topicLane.body.appendChild(topicRow);
      const workerLane = lane('task-service consumer', 'group task-service');
      const workerBox = h('div', { class: 'stack' });
      workerLane.body.appendChild(workerBox);
      const dbLane = lane('Postgres, schema task');
      const taskRow = tokenRow();
      const procRow = tokenRow();
      dbLane.body.appendChild(h('div', { class: 'small', style: 'font-weight:600' }, 'tasks'));
      dbLane.body.appendChild(taskRow);
      dbLane.body.appendChild(h('div', { class: 'small', style: 'font-weight:600' }, 'processed messages (keyed by idempotencyToken)'));
      dbLane.body.appendChild(procRow);

      const committedR = ui.readout('Committed offset', 0);
      const tasksR = ui.readout('Tasks', 0);
      const dupR = ui.readout('Duplicate tasks', 0);
      const lostR = ui.readout('Lost commands', 0);
      const skippedR = ui.readout('Repeats skipped', 0);
      const verdict = ui.verdict();
      const log = ui.log({ label: 'Consumer log' });

      el.appendChild(h('div', { class: 'sim-controls' }, ackChoice.el, dedupeOff.el, nextBtn, againBtn, crashBtn, resetBtn, hint));
      el.appendChild(h('div', { class: 'sim-stage' }, h('div', { class: 'sim-cols' }, topicLane.el, workerLane.el, dbLane.el)));
      el.appendChild(h('div', { class: 'readouts' }, committedR.el, tasksR.el, dupR.el, lostR.el, skippedR.el));
      el.appendChild(verdict.el);
      el.appendChild(log.el);
      el.appendChild(note('Illustrative: one partition and four commands. Values like tok-a stand in for real idempotencyToken values.'));

      function renderHint() {
        hint.textContent = ackChoice.get() === 'manual'
          ? 'Manual ack: the task row commits first, then the offset. Crash mid-message dies between the two, so the command is delivered again.'
          : 'Auto-ack: the offset commits first, then the task row. Crash mid-message dies between the two, so the command is skipped for good.';
      }

      function sync() {
        const drained = position >= topic.length;
        nextBtn.disabled = running || drained;
        crashBtn.disabled = running || drained;
        againBtn.disabled = running;
        resetBtn.disabled = running;
        ackChoice.el.disabled = running;
      }

      function judge(extra, lost) {
        if (lost) {
          verdict.set('bad', 'Lost: ' + plural(lost, 'command') + ' never became a task. The offset was committed before the task row existed, then the worker died. No row exists, so not even the stale-claim reaper can bring it back.');
        } else if (extra) {
          verdict.set('bad', 'Duplicated: ' + plural(extra, 'extra task') + '. With the dedupe off, a repeated command made another task for the same deployment.');
        } else if (skipped) {
          verdict.set('ok', 'Repeat absorbed: ' + plural(skipped, 'delivery', 'deliveries') + ' found the token already processed, so each command still made exactly one task.');
        } else if (tasks.length) {
          verdict.set('ok', 'So far each command made exactly one task.');
        } else {
          verdict.clear();
        }
      }

      function render() {
        topicLane.aside.textContent = 'committed offset ' + committed;
        fill(topicRow, topic.map(m => {
          const acked = m.offset < committed && !m.lost;
          const text = m.offset + ' ' + m.dep + ' ' + m.token + (m.copy ? ' copy' : '') + (m.lost ? ' lost' : acked ? ' acked' : '');
          return ui.token(text, m.lost ? 'bad' : running && m.offset === current ? 'busy' : acked ? 'ok' : null);
        }));

        const nodes = [];
        if (worker > 1) nodes.push(AF.tone(ui.node('worker ' + (worker - 1), 'died; its partition moved'), 'bad'));
        nodes.push(AF.tone(ui.node('worker ' + worker, 'owns P0 · next offset ' + position), running ? 'busy' : null));
        fill(workerBox, nodes);

        const counts = {};
        tasks.forEach(t => { counts[t.token] = (counts[t.token] || 0) + 1; });
        fill(taskRow, tasks.length
          ? tasks.map(t => ui.token('task ' + t.dep + (counts[t.token] > 1 ? ' duplicate' : ''), counts[t.token] > 1 ? 'bad' : 'ok'))
          : [empty('none yet')]);
        const procKids = Array.from(processed).map(tok => ui.token(tok));
        if (dedupeOff.get()) procKids.push(empty('not checked while dedupe is off'));
        fill(procRow, procKids.length ? procKids : [empty('none yet')]);

        const extra = tasks.length - Object.keys(counts).length;
        const lost = topic.filter(m => m.lost).length;
        committedR.set(committed);
        tasksR.set(tasks.length);
        dupR.set(extra, extra ? 'bad' : null);
        lostR.set(lost, lost ? 'bad' : null);
        skippedR.set(skipped, skipped ? 'ok' : null);
        judge(extra, lost);
        sync();
      }

      /** The database transaction: token check, task insert and token insert commit together. */
      async function applyTx(msg, step) {
        const dedupe = !dedupeOff.get();
        if (dedupe && processed.has(msg.token)) {
          skipped++;
          return step('BEGIN; ' + msg.token + ' is already in processed messages, so no new task; COMMIT', 'ok');
        }
        const dup = tasks.some(t => t.token === msg.token);
        tasks.push({ dep: msg.dep, token: msg.token });
        if (dedupe) {
          processed.add(msg.token);
          return step('BEGIN; ' + msg.token + ' not seen; INSERT task for ' + msg.dep + '; INSERT processed ' + msg.token + '; COMMIT', 'ok');
        }
        return step('BEGIN; no dedupe check; INSERT task for ' + msg.dep + '; COMMIT' + (dup ? ': a second task for the same command' : ''), dup ? 'bad' : 'ok');
      }

      async function crashWorker(step, why) {
        if (!await step(why, 'bad')) return false;
        worker++;
        position = committed;
        return step('Rebalance: P0 moves to worker ' + worker + ', which resumes at committed offset ' + committed + '.', 'warn');
      }

      async function run(crash) {
        if (running || position >= topic.length) return;
        const my = ++runId;
        const mode = ackChoice.get();
        running = true;
        const ok = () => ctx.alive && my === runId;
        const step = async (text, tone) => {
          log.add(text, tone);
          render();
          await AF.sleep(ctx, STEP);
          return ok();
        };
        const msg = topic[position];
        current = msg.offset;
        lastPolled = msg;
        if (!await step('Worker ' + worker + ' polls offset ' + msg.offset + ': ' + msg.dep + ' (' + msg.token + ')', 'busy')) return;

        if (mode === 'auto') {
          committed = msg.offset + 1;
          if (!await step('Auto-ack: committed offset is now ' + committed + ', before any work is done', 'warn')) return;
          if (crash) {
            if (!await step('BEGIN; INSERT task for ' + msg.dep + ' ...', 'busy')) return;
            if (!await crashWorker(step, 'Worker ' + worker + ' dies before COMMIT. The insert rolls back.')) return;
            msg.lost = true;
            if (!await step('Offset ' + msg.offset + ' is behind the committed offset and is never read again: ' + msg.dep + ' is lost.', 'bad')) return;
            return done();
          }
          if (!await applyTx(msg, step)) return;
          position = msg.offset + 1;
          return done();
        }

        // manual ack after the database commit
        if (!await applyTx(msg, step)) return;
        if (crash) {
          if (!await crashWorker(step, 'Worker ' + worker + ' dies after COMMIT, before the ack. The offset stays at ' + committed + '.')) return;
          if (!await step('Worker ' + worker + ' polls offset ' + msg.offset + ' again: ' + msg.dep + ' (' + msg.token + ')', 'warn')) return;
          if (!await applyTx(msg, step)) return;
        }
        committed = msg.offset + 1;
        position = committed;
        if (!await step('Ack: committed offset is now ' + committed, 'ok')) return;
        done();
      }

      function done() {
        running = false;
        current = -1;
        render();
        if (position >= topic.length) log.add('Nothing left to read. Press Deliver again or Reset.', 'muted');
      }

      function deliverAgain() {
        if (running) return;
        const src = lastPolled || topic[0];
        const copy = { offset: topic.length, dep: src.dep, token: src.token, copy: true, lost: false };
        topic.push(copy);
        log.add('The outbox published ' + src.dep + ' again: offset ' + copy.offset + ' carries the same idempotencyToken ' + src.token + '.', 'warn');
        render();
      }

      function reset() {
        runId++;
        running = false;
        init();
        log.clear();
        log.add('Reset: four commands on P0, nothing read yet.', 'muted');
        render();
      }

      log.add('Four commands wait on P0. Press Process next.', 'muted');
      renderHint();
      render();
    }
  });

  // =====================================================================
  // 4. Retries, jitter and the dead-letter topic
  // =====================================================================

  const RT_CLIENTS = 30;
  const RT_RETRIES = 4;
  const RT_BASE = 1;        // seconds, illustrative
  const RT_JITTER = 0.5;    // +/- 50% of each delay, illustrative
  const RT_BIN = 0.25;      // seconds per chart slot
  const RT_XMAX = 24;       // seconds shown
  const RT_CAP = 15;        // downstream capacity per slot, illustrative
  const RT_UNKNOWN_CAP = 2; // the spec says only "retry with a cap"; 2 is illustrative
  const RT_COLORS = ['var(--signal)', 'var(--ok)', 'var(--warn)', 'var(--ink-2)'];
  const RT_ERRORS = { TRANSIENT: 'connection refused', PERMANENT: 'image not found', UNKNOWN: 'unexpected response' };

  /** Arrival times of every retry of 30 clients that all failed at t = 0. */
  function retryArrivals(jitter) {
    const out = [];
    const times = new Array(RT_CLIENTS).fill(0);
    for (let a = 0; a < RT_RETRIES; a++) {
      const d = RT_BASE * Math.pow(2, a);
      // Stratified jitter: random, but spread over the whole window so a draw cannot clump by luck.
      const fr = shuffle(Array.from({ length: RT_CLIENTS }, (_, i) => ((i + Math.random()) / RT_CLIENTS) * 2 - 1));
      for (let c = 0; c < RT_CLIENTS; c++) {
        times[c] += jitter ? d * (1 + RT_JITTER * fr[c]) : d;
        out.push({ t: times[c], attempt: a });
      }
    }
    return out;
  }

  AF.register({
    id: 'kf-retry',
    group: 'kafka',
    order: 4,
    title: 'Retries, jitter and the dead-letter topic',
    question: 'How do you retry failed work without stampeding the service that failed, and what happens to work that never succeeds?',
    status: 'planned',
    slice: 'S4, S7',
    where: [
      'docs/specs/project/03-TASK-SERVICE.md, Retry engine',
      'docker-compose.yml, kafka-init (task.work.DLT, 3 partitions)',
      'docs/specs/SPRING-PROJECT.md, Slice 7 (backoff and jitter, DLQ and replay)'
    ],
    idea: [
      'Exponential backoff waits longer after each failure: delay = base × 2^attempt. But clients that fail together also retry together, so every wave lands at once on a service trying to recover: a thundering herd. Jitter adds a random plus or minus to each delay, and the waves smear out instead of arriving in step.',
      'Not every failure deserves a retry. task-service will sort them: TRANSIENT is retried, PERMANENT goes to the dead-letter topic at once, UNKNOWN is retried under a cap. After maxAttempts the task becomes DEAD and is published to task.work.DLT with failure metadata in its headers. Attempts are append-only, so the history is the debugging story.',
      'Delays are stored, not slept: a retry_at column that the reaper claims when due, simpler to inspect than Kafka delay topics. An OPERATOR can call POST /api/v1/dlq/{taskId}/replay, which resets attempts, requeues the task and writes an audit entry.'
    ],
    terms: [
      ['Exponential backoff', 'Doubling the wait after each failed attempt.'],
      ['Jitter', 'A random offset added to each delay so clients drift apart.'],
      ['Thundering herd', 'Many clients waking at the same instant and swamping a shared service.'],
      ['Dead-letter topic', 'Where a message goes once retries are exhausted, kept for inspection and replay.']
    ],
    tryIt: [
      'Switch on No jitter and press Fail 30 clients at once: every retry wave is one spike of 30.',
      'Switch No jitter off and press Fail 30 clients at once again: the same retries spread into low, wide humps.',
      'Set Failure kind to PERMANENT and press Run a task: it lands in task.work.DLT after one attempt. Then try TRANSIENT with different Max attempts, and with Downstream recovers on attempt 3.',
      'Press Replay on a dead-lettered task: its attempts reset and it is requeued.'
    ],
    breakIt: 'Switch off jitter and all 30 clients retry at exactly the same instants, so every wave hits the recovering service at full force.',
    say: 'I retry only transient failures, with exponential backoff plus jitter so clients drift apart, and send exhausted or permanent failures to a dead-letter topic with an audited replay endpoint.',
    quiz: {
      q: '30 workers fail at the same moment and all use delay = base × 2^attempt with no jitter. What does the downstream service see?',
      options: [
        'A spike of 30 requests at each retry, every time',
        'Requests spread evenly, because the delays keep growing',
        'One spike, after which the retries naturally drift apart',
        'Nothing until maxAttempts is reached'
      ],
      answer: 0,
      why: 'Identical inputs give identical delays, so every client wakes at the same instant on every attempt. Growing delays only space the spikes further apart; jitter is what breaks the synchronization.'
    },
    mount(el, ctx) {
      const NB = Math.round(RT_XMAX / RT_BIN);
      const STEP = 600;
      let chartRun = 0;
      let taskRun = 0;
      let busy = false;
      let taskN = 100;
      let dlt = [];

      // ----- part A: the herd -----
      const noJitter = ui.toggle('No jitter', false, on => {
        log.add(on ? 'Jitter off: every client uses exactly base × 2^attempt.' : 'Jitter on: each delay moves by up to ±50%.', on ? 'bad' : 'ok');
      }, { tone: 'danger' });
      const failBtn = ui.button('Fail 30 clients at once', failClients, { variant: 'primary' });
      const chart = svg('svg', { class: 'chart', viewBox: '0 0 640 220', role: 'img', 'aria-label': 'Retry arrivals over time' });
      const peakR = ui.readout('Peak in one 250 ms slot', '—');
      const overR = ui.readout('Slots over capacity', '—');
      const totalR = ui.readout('Retries sent', '—');
      const verdictA = ui.verdict();

      const partA = ui.panel('30 clients fail at the same moment',
        h('div', { class: 'sim-controls' }, noJitter.el, failBtn),
        h('div', { class: 'sim-stage' }, chart),
        h('div', { class: 'readouts' }, peakR.el, overR.el, totalR.el),
        verdictA.el);

      // ----- part B: one task's path -----
      const kindChoice = ui.choice('Failure kind', [
        { value: 'TRANSIENT', label: 'TRANSIENT' },
        { value: 'PERMANENT', label: 'PERMANENT' },
        { value: 'UNKNOWN', label: 'UNKNOWN' }
      ], 'TRANSIENT');
      const maxSlider = ui.slider({ label: 'Max attempts', min: 1, max: 6, value: 4 });
      const recovers = ui.toggle('Downstream recovers on attempt 3', false);
      const runBtn = ui.button('Run a task', () => runTask(null), { variant: 'primary' });
      const timeline = tokenRow();
      const dltLane = lane('task.work.DLT');
      const dltList = h('div', { class: 'stack', style: 'gap:.4rem' });
      dltLane.body.appendChild(dltList);
      const attemptsR = ui.readout('Attempts used', '—');
      const stateR = ui.readout('Final state', '—');
      const dltR = ui.readout('In task.work.DLT', 0);
      const verdictB = ui.verdict();

      const partB = ui.panel('One task\'s path to SUCCEEDED or DEAD',
        h('div', { class: 'sim-controls' }, kindChoice.el, maxSlider.el, recovers.el, runBtn),
        h('div', { class: 'sim-stage stack' }, timeline, dltLane.el),
        h('div', { class: 'readouts' }, attemptsR.el, stateR.el, dltR.el),
        verdictB.el);

      const log = ui.log({ label: 'Retry log' });

      el.appendChild(h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(min(100%,24rem),1fr));gap:1.2rem;align-items:start' }, partA, partB));
      el.appendChild(log.el);
      el.appendChild(note('Illustrative: base 1 s, jitter ±50%, capacity 15 per slot, an UNKNOWN cap of 2 attempts and the example errors are chosen for the demo; the spec fixes none of them. Task waits are compressed. Retry delays in the task panel follow the No jitter switch too.'));

      // ----- chart -----
      function binsFor(arrivals) {
        const bins = Array.from({ length: NB }, () => new Array(RT_RETRIES).fill(0));
        arrivals.forEach(a => {
          const b = Math.min(NB - 1, Math.floor(a.t / RT_BIN + 1e-9));
          bins[b][a.attempt]++;
        });
        return bins;
      }

      function drawChart(bins, upto, waves) {
        AF.clear(chart);
        const W = 640, H = 220, L = 34, R = 8, T = 26, B = 26;
        const pw = W - L - R;
        const ph = H - T - B;
        const bw = pw / NB;
        const y = v => T + ph - (v / RT_CLIENTS) * ph;
        [0, 15, 30].forEach(v => {
          chart.appendChild(svg('line', { x1: L, x2: W - R, y1: y(v), y2: y(v), style: 'stroke:var(--line)' }));
          chart.appendChild(svg('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end' }, String(v)));
        });
        for (let sec = 0; sec <= RT_XMAX; sec += 4) {
          chart.appendChild(svg('text', { x: L + (sec / RT_BIN) * bw, y: H - 8, 'text-anchor': 'middle' }, sec + ' s'));
        }
        if (bins) {
          for (let b = 0; b < Math.min(upto, NB); b++) {
            let acc = 0;
            for (let a = 0; a < RT_RETRIES; a++) {
              const v = bins[b][a];
              if (!v) continue;
              chart.appendChild(svg('rect', {
                x: L + b * bw + 0.5, y: y(acc + v), width: Math.max(1, bw - 1), height: y(acc) - y(acc + v),
                style: 'fill:' + RT_COLORS[a]
              }));
              acc += v;
            }
          }
          if (waves && upto >= NB) {
            waves.forEach((t, a) => {
              chart.appendChild(svg('text', { x: L + (t / RT_BIN) * bw, y: T - 10, 'text-anchor': 'middle' }, 'retry ' + (a + 1)));
            });
          }
        }
        chart.appendChild(svg('line', { x1: L, x2: W - R, y1: y(RT_CAP), y2: y(RT_CAP), style: 'stroke:var(--bad);stroke-width:1.5;stroke-dasharray:5 4' }));
        chart.appendChild(svg('text', { x: W - R, y: y(RT_CAP) - 5, 'text-anchor': 'end' }, 'capacity per slot (illustrative)'));
        chart.appendChild(svg('line', { x1: L, x2: W - R, y1: T + ph, y2: T + ph, style: 'stroke:var(--rail)' }));
      }

      async function failClients() {
        const my = ++chartRun;
        const jitter = !noJitter.get();
        failBtn.disabled = true;
        const arrivals = retryArrivals(jitter);
        const bins = binsFor(arrivals);
        const totals = bins.map(b => b.reduce((s, v) => s + v, 0));
        const peak = Math.max.apply(null, totals);
        const over = totals.filter(v => v > RT_CAP).length;
        const waves = [];
        for (let a = 0; a < RT_RETRIES; a++) {
          const ts = arrivals.filter(x => x.attempt === a).map(x => x.t).sort((p, q) => p - q);
          waves.push(ts[Math.floor(ts.length / 2)]);
        }
        log.add('30 clients fail at t = 0 and retry ' + RT_RETRIES + ' times each, ' + (jitter ? 'with' : 'without') + ' jitter.', jitter ? 'busy' : 'warn');
        verdictA.clear();
        if (!ctx.reducedMotion) {
          for (let upto = 0; upto < NB; upto += 8) {
            drawChart(bins, upto, waves);
            await AF.sleep(ctx, 45);
            if (!ctx.alive || my !== chartRun) return;
          }
        }
        drawChart(bins, NB, waves);
        chart.setAttribute('aria-label', 'Retry arrivals over ' + RT_XMAX + ' seconds, ' + (jitter ? 'with' : 'without') + ' jitter: peak ' + peak + ' in one 250 ms slot, ' + plural(over, 'slot') + ' over capacity.');
        peakR.set(peak + ' of 30', peak > RT_CAP ? 'bad' : 'ok');
        overR.set(over, over ? 'bad' : 'ok');
        totalR.set(arrivals.length);
        if (jitter) {
          verdictA.set('ok', 'Spread out: the same ' + arrivals.length + ' retries peak at ' + peak + ' per slot, ' + (over ? plural(over, 'slot') + ' over capacity' : 'none over capacity') + '. Each wave widens, because every client drifts by its own random amount.');
        } else {
          verdictA.set('bad', 'Thundering herd: every wave is all 30 clients in the same 250 ms slot, at 1, 3, 7 and 15 s. ' + plural(over, 'slot') + ' over capacity, and longer delays never break the lockstep.');
        }
        log.add('Peak ' + peak + ' per slot; ' + plural(over, 'slot') + ' over capacity.', over ? 'bad' : 'ok');
        failBtn.disabled = false;
      }

      // ----- task path -----
      function renderDlt() {
        fill(dltList, dlt.length ? dlt.map(e => h('div', { class: 'row', style: 'gap:.4rem' },
          ui.token(e.id + ' ' + e.kind + ', ' + plural(e.attempts, 'attempt'), 'bad'),
          h('span', { class: 'small muted' }, 'last error: ' + e.err),
          ui.button('Replay', () => replay(e), { small: true, disabled: busy, ariaLabel: 'Replay ' + e.id }))) : [empty('empty')]);
        dltLane.aside.textContent = plural(dlt.length, 'message');
        dltR.set(dlt.length, dlt.length ? 'warn' : null);
      }

      function lockB(on) {
        busy = on;
        runBtn.disabled = on;
        kindChoice.el.disabled = on;
        renderDlt();
      }

      async function runTask(replayOf) {
        if (busy) return;
        const my = ++taskRun;
        const id = replayOf ? replayOf.id : 't-' + (++taskN);
        const kind = replayOf ? replayOf.kind : kindChoice.get();
        const max = maxSlider.get();
        const cap = kind === 'PERMANENT' ? 1 : kind === 'UNKNOWN' ? Math.min(max, RT_UNKNOWN_CAP) : max;
        const willRecover = recovers.get();
        const items = [];
        const show = (text, tone) => { items.push(ui.token(text, tone)); fill(timeline, items); };
        const swap = (text, tone) => { items[items.length - 1] = ui.token(text, tone); fill(timeline, items); };
        const ok = () => ctx.alive && my === taskRun;

        lockB(true);
        verdictB.clear();
        attemptsR.set('…');
        stateR.set('…');
        show(id + ' QUEUED', 'idle');
        log.add(replayOf ? id + ' requeued with attempts reset to 0.' : id + ' QUEUED with failure kind ' + kind + ', max attempts ' + max + '.', 'busy');
        await AF.sleep(ctx, STEP);
        if (!ok()) return;

        let attempt = 0;
        let final = 'DEAD';
        for (;;) {
          attempt++;
          show('attempt ' + attempt + ' RUNNING', 'busy');
          await AF.sleep(ctx, STEP);
          if (!ok()) return;
          const succeeds = replayOf ? true : (willRecover && kind !== 'PERMANENT' && attempt === 3);
          if (succeeds) {
            swap('attempt ' + attempt + ' SUCCEEDED', 'ok');
            log.add(id + ' attempt ' + attempt + ' succeeded.', 'ok');
            final = 'SUCCEEDED';
            break;
          }
          swap('attempt ' + attempt + ' failed: ' + kind, 'bad');
          log.add(id + ' attempt ' + attempt + ' failed: ' + kind + ' (' + RT_ERRORS[kind] + '). The attempt row is appended.', 'bad');
          if (kind === 'PERMANENT') {
            log.add('PERMANENT: retrying cannot help, so no retry.', 'warn');
            break;
          }
          if (attempt >= cap) {
            log.add(kind + ': ' + plural(attempt, 'attempt') + ' used, the cap is ' + cap + '.', 'warn');
            break;
          }
          const d = RT_BASE * Math.pow(2, attempt - 1);
          const delay = noJitter.get() ? d : d * (1 + RT_JITTER * (Math.random() * 2 - 1));
          show('retry_at +' + delay.toFixed(1) + ' s', 'warn');
          log.add('QUEUED again with retry_at = now + ' + delay.toFixed(1) + ' s (base × 2^' + (attempt - 1) + (noJitter.get() ? '' : ' ± jitter') + '). The reaper claims it when due.', 'muted');
          await AF.sleep(ctx, STEP);
          if (!ok()) return;
        }

        attemptsR.set(attempt);
        if (final === 'SUCCEEDED') {
          show('SUCCEEDED', 'ok');
          stateR.set('SUCCEEDED', 'ok');
          verdictB.set('ok', id + ' SUCCEEDED on attempt ' + attempt + (replayOf ? ', after the replay.' : '.'));
        } else {
          show('DEAD', 'bad');
          dlt.push({ id, kind, attempts: attempt, err: RT_ERRORS[kind] });
          stateR.set('DEAD', 'bad');
          log.add(id + ' is DEAD: published to task.work.DLT with headers for failure kind ' + kind + ', ' + plural(attempt, 'attempt') + ' and last error.', 'bad');
          verdictB.set('bad', id + ' is DEAD after ' + plural(attempt, 'attempt') + ' and sits in task.work.DLT. ' +
            (kind === 'PERMANENT' ? 'A PERMANENT failure skips retries, since repeating it cannot fix it.'
              : kind === 'UNKNOWN' ? 'UNKNOWN failures retry, but under a tighter cap.'
                : 'TRANSIENT failures retry until maxAttempts runs out.'));
        }
        lockB(false);
      }

      function replay(entry) {
        if (busy) return;
        dlt = dlt.filter(e => e !== entry);
        renderDlt();
        log.add('POST /api/v1/dlq/' + entry.id + '/replay as OPERATOR: attempts reset, task requeued on task.work, audit entry written.', 'busy');
        log.add('This replay assumes the operator fixed the cause first.', 'muted');
        runTask(entry);
      }

      drawChart(null, 0, null);
      fill(timeline, [empty('Press Run a task to follow one task.')]);
      renderDlt();
      log.add('Press Fail 30 clients at once, then try it with No jitter.', 'muted');
    }
  });

  // =====================================================================
  // 5. CQRS read side
  // =====================================================================

  AF.register({
    id: 'kf-cqrs',
    group: 'kafka',
    order: 5,
    title: 'CQRS read side',
    question: 'How do you serve fast dashboard reads without bending the write model, and stay honest about being slightly behind?',
    status: 'planned',
    slice: 'S6',
    where: [
      'docs/specs/project/05-QUERY-SERVICE.md, Read models and Projection discipline',
      'docs/specs/project/01-CONTROL-API.md, S6 (domain events to deployment.events)',
      'docker-compose.yml, kafka-init (deployment.events, task.events)',
      'query-service/src/main/resources/db/migration/V1__init.sql (empty today; schema query planned)'
    ],
    idea: [
      'CQRS splits writing from reading. control-api stays the authoritative write model and publishes events; query-service folds them into read tables shaped for each screen: deployment_summary, application_history, fleet_view and task_timeline. Reads never touch the write schema, and the read side uses JdbcClient, not JPA, since a projection needs no dirty checking or lazy loading.',
      'Each projection is its own consumer group, so a slow one never holds up another, and its progress is kept in projection_offset. It checks each event id before applying it, so a replay changes nothing. Order is promised per deployment only, never globally. Every read carries asOf, the projection\'s high-water time, so staleness shows instead of hiding.',
      'Because the topic keeps the history, POST /admin/projections/{name}/rebuild can truncate a table and re-consume from the earliest offset. That rebuild is what makes this CQRS rather than a cache. There is no event sourcing: the write side\'s tables stay the truth, and the read side is disposable.'
    ],
    terms: [
      ['Projection', 'Code that folds a stream of events into a read table.'],
      ['asOf', 'The timestamp of the newest event a projection has applied, returned with every read.'],
      ['Projection lag', 'How far a projection trails the end of its topic: the read side\'s honest SLO.'],
      ['Rebuild', 'Truncate the read table and replay the topic from the earliest offset.']
    ],
    tryIt: [
      'Press Deploy a few times and raise Projection delay: application_history falls behind while deployment_summary keeps up, and the reader\'s asOf and lag show it.',
      'Press Replay from earliest: with the event-id check on, every repeat is skipped and the counts stay right.',
      'Switch on Skip the event-id check and press Replay from earliest again: the counts double and the verdict says diverged.',
      'Press Rebuild: the table is truncated and re-consumed, and it matches the write side again.'
    ],
    breakIt: 'Skip the event-id check and a replay applies every event a second time, so application_history reports twice as many deployments as really happened.',
    say: 'My read side is a disposable projection: idempotent on event id, rebuildable from the topic, and every response carries asOf, so eventual consistency is visible instead of hidden.',
    quiz: {
      q: 'What makes query-service\'s tables CQRS projections rather than just a cache?',
      options: [
        'They can be truncated and rebuilt from the topic at any time, without touching the write database',
        'They live in a different Postgres schema from the write side',
        'They expire after a TTL and refill on the next read',
        'They are updated in the same transaction as the write side'
      ],
      answer: 0,
      why: 'A cache is filled from the source of truth on demand. A projection is derived from the event stream and can be rebuilt from it at any time, which is the property the spec calls out. A separate schema or a TTL does not give you that, and sharing a transaction with the write side would undo the split.'
    },
    mount(el, ctx) {
      const SUMMARY_MS = 150;
      const SUCCEED_AFTER = 1600;
      const t0 = performance.now();
      const now = () => performance.now() - t0;
      const clock = ms => {
        if (ms === null) return 'none yet';
        const s = ms / 1000;
        return String(Math.floor(s / 60)).padStart(2, '0') + ':' + (s % 60).toFixed(1).padStart(4, '0');
      };
      const short = type => type.replace('Deployment', '');
      let gen = 0;
      let events, write, sum, hist, depN, evN;

      function init() {
        events = [];
        write = { deployments: 0, succeeded: 0 };
        sum = { offset: 0, rows: new Map(), startedAt: null };
        hist = { offset: 0, deployments: 0, succeeded: 0, seen: new Set(), asOf: null, startedAt: null, mode: null, skippedRun: 0, doubledRun: 0 };
        depN = 0;
        evN = 0;
      }
      init();

      const deployBtn = ui.button('Deploy', deploy, { variant: 'primary' });
      const delay = ui.slider({ label: 'Projection delay', min: 0, max: 2000, step: 100, value: 300, format: v => v + ' ms per event' });
      const skipCheck = ui.toggle('Skip the event-id check', false, on => {
        log.add(on ? 'application_history now applies every event it receives, seen or not.' : 'application_history checks each event id before applying it again.', on ? 'bad' : 'ok');
      }, { tone: 'danger' });
      const replayBtn = ui.button('Replay from earliest', replay);
      const rebuildBtn = ui.button('Rebuild', rebuild);
      const resetBtn = ui.button('Reset', reset, { variant: 'quiet' });

      const writeLane = lane('control-api', 'write side');
      const writeBox = h('div', { class: 'stack' });
      writeLane.body.appendChild(writeBox);
      const topicLane = lane('deployment.events');
      const topicList = h('div', { class: 'stack', style: 'gap:.3rem;align-items:flex-start' });
      topicLane.body.appendChild(topicList);
      const sumLane = lane('deployment_summary');
      const sumList = h('div', { class: 'stack', style: 'gap:.3rem;align-items:flex-start' });
      sumLane.body.appendChild(empty('own consumer group, fast'));
      sumLane.body.appendChild(sumList);
      const histLane = lane('application_history');
      const histList = h('div', { class: 'stack', style: 'gap:.3rem;align-items:flex-start' });
      histLane.body.appendChild(empty('own consumer group, Projection delay applies'));
      histLane.body.appendChild(histList);

      const response = ui.code('', 'Reader response');
      const lagBar = ui.bar({ label: 'Projection lag', max: 10, value: 0, format: v => plural(v, 'event') });
      const lagTimeR = ui.readout('Lag in time', '0.0 s');
      const writeR = ui.readout('Write side deployments', 0);
      const readR = ui.readout('application_history deployments', 0);
      const verdict = ui.verdict();
      const log = ui.log({ label: 'Projection log' });

      el.appendChild(h('div', { class: 'sim-controls' }, deployBtn, delay.el, skipCheck.el, replayBtn, rebuildBtn, resetBtn));
      el.appendChild(h('div', { class: 'sim-stage' }, h('div', { class: 'sim-cols' }, writeLane.el, topicLane.el, sumLane.el, histLane.el)));
      el.appendChild(ui.panel('Reader: GET /api/v1/applications/{id}/history', response));
      el.appendChild(lagBar.el);
      el.appendChild(h('div', { class: 'readouts' }, lagTimeR.el, writeR.el, readR.el));
      el.appendChild(verdict.el);
      el.appendChild(log.el);
      el.appendChild(note('Illustrative timings on a clock that starts when this lesson opens. Every deployment here succeeds about 1.6 s after it is requested.'));

      function emit(type, dep) {
        events.push({ offset: events.length, id: 'ev-' + String(++evN).padStart(2, '0'), type, dep, t: now() });
      }

      function deploy() {
        const g = gen;
        const dep = 'dep-' + (++depN);
        write.deployments++;
        emit('DeploymentRequested', dep);
        log.add('control-api commits ' + dep + ' (PENDING) and publishes DeploymentRequested.', 'busy');
        ctx.timeout(() => {
          if (g !== gen) return;
          write.succeeded++;
          emit('DeploymentSucceeded', dep);
          log.add(dep + ' is HEALTHY; DeploymentSucceeded published.', 'ok');
          render();
        }, SUCCEED_AFTER);
        render();
      }

      function applySummary(e) {
        sum.rows.set(e.dep, e.type === 'DeploymentRequested' ? 'PENDING' : 'HEALTHY');
      }

      function applyHistory(e) {
        const seen = hist.seen.has(e.id);
        if (seen && !skipCheck.get()) {
          hist.skippedRun++;
        } else {
          if (seen) hist.doubledRun++;
          if (e.type === 'DeploymentRequested') hist.deployments++;
          else hist.succeeded++;
          hist.seen.add(e.id);
        }
        hist.asOf = hist.asOf === null ? e.t : Math.max(hist.asOf, e.t);
      }

      function caughtUp() {
        if (hist.mode === 'replay') {
          const doubled = hist.doubledRun;
          log.add('Replay finished: ' + plural(hist.skippedRun, 'event') + ' skipped by the event-id check, ' + plural(doubled, 'event') + ' applied twice.', doubled ? 'bad' : 'ok');
        } else if (hist.mode === 'rebuild') {
          const match = hist.deployments === write.deployments && hist.succeeded === write.succeeded;
          log.add('Rebuild finished: application_history ' + (match ? 'matches the write side.' : 'is still catching up with new events.'), match ? 'ok' : 'warn');
        }
        hist.mode = null;
      }

      function tick() {
        const t = now();
        let changed = false;
        if (sum.offset < events.length) {
          if (sum.startedAt === null) sum.startedAt = t;
          if (t - sum.startedAt >= SUMMARY_MS) {
            applySummary(events[sum.offset]);
            sum.offset++;
            sum.startedAt = null;
            changed = true;
          }
        }
        if (hist.offset < events.length) {
          if (hist.startedAt === null) hist.startedAt = t;
          if (t - hist.startedAt >= delay.get()) {
            applyHistory(events[hist.offset]);
            hist.offset++;
            hist.startedAt = null;
            changed = true;
            if (hist.offset === events.length) caughtUp();
          }
        }
        if (changed) render(); else renderLive();
      }

      function renderLive() {
        const t = now();
        const behind = events.length - hist.offset;
        const lagMs = behind ? t - events[hist.offset].t : 0;
        lagBar.set(behind, behind ? 'warn' : 'ok');
        lagTimeR.set((lagMs / 1000).toFixed(1) + ' s', behind ? 'warn' : null);
        response.firstChild.textContent = '{ "deployments": ' + hist.deployments + ', "succeeded": ' + hist.succeeded +
          ', "asOf": ' + (hist.asOf === null ? 'null' : '"' + clock(hist.asOf) + '"') + ' }';
      }

      function judge() {
        const behind = events.length - hist.offset;
        const over = hist.deployments > write.deployments || hist.succeeded > write.succeeded;
        if (over) {
          verdict.set('bad', 'Diverged: application_history says ' + hist.deployments + ' deployments and ' + hist.succeeded + ' succeeded; the write side has ' +
            write.deployments + ' and ' + write.succeeded + '. Events were applied twice because the event-id check was skipped. Rebuild to recover.');
        } else if (hist.mode === 'replay') {
          verdict.set('warn', 'Replaying from the earliest offset, ' + plural(behind, 'event') + ' to go. ' + (skipCheck.get()
            ? 'The event-id check is skipped, so each repeat will be applied again.'
            : 'The event-id check recognises each one, so the counts hold.'));
        } else if (behind) {
          verdict.set('warn', 'Behind by ' + plural(behind, 'event') + ': the reader gets data as of ' + clock(hist.asOf) + ', and the asOf field says so. Stale, but visibly stale.');
        } else if (events.length) {
          verdict.set('ok', 'In step: application_history matches the write side as of ' + clock(hist.asOf) + '.');
        } else {
          verdict.clear();
        }
      }

      function render() {
        fill(writeBox, [
          ui.node('authoritative write model', 'publishes through the outbox'),
          h('div', { class: 'stack', style: 'gap:.3rem;align-items:flex-start' },
            ui.token('deployments ' + write.deployments),
            ui.token('succeeded ' + write.succeeded))
        ]);

        topicLane.aside.textContent = plural(events.length, 'event');
        const shown = events.slice(-8);
        const first = shown.length ? shown[0].offset : 0;
        const topicKids = [];
        if (first > 0) topicKids.push(empty('+' + first + ' earlier'));
        const marker = () => h('span', { class: 'small', style: 'font-weight:600' }, 'application_history is here');
        if (hist.offset < events.length && hist.offset < first) topicKids.push(marker());
        shown.forEach(e => {
          if (e.offset === hist.offset) topicKids.push(marker());
          topicKids.push(ui.token(e.offset + ' ' + e.id + ' ' + short(e.type) + ' ' + e.dep, e.offset >= hist.offset ? 'busy' : null));
        });
        if (!events.length) topicKids.push(empty('empty: press Deploy'));
        fill(topicList, topicKids);

        sumLane.aside.textContent = 'offset ' + sum.offset;
        const rows = Array.from(sum.rows.entries()).slice(-6);
        fill(sumList, rows.length ? rows.map(([dep, st]) => ui.token(dep + ' ' + st, st === 'HEALTHY' ? 'ok' : 'busy')) : [empty('no rows')]);

        const behind = events.length - hist.offset;
        histLane.aside.textContent = 'offset ' + hist.offset;
        fill(histList, [
          ui.token('deployments ' + hist.deployments + (hist.deployments > write.deployments ? ', too many' : ''), hist.deployments > write.deployments ? 'bad' : null),
          ui.token('succeeded ' + hist.succeeded + (hist.succeeded > write.succeeded ? ', too many' : ''), hist.succeeded > write.succeeded ? 'bad' : null),
          empty(plural(hist.seen.size, 'event id') + ' recorded'),
          h('span', { class: 'small' }, hist.mode === 'rebuild' ? 'rebuilding from earliest' : hist.mode === 'replay' ? 'replaying from earliest' : behind ? plural(behind, 'event') + ' behind' : 'caught up')
        ]);

        writeR.set(write.deployments);
        readR.set(hist.deployments, hist.deployments > write.deployments ? 'bad' : hist.deployments < write.deployments ? 'warn' : null);
        renderLive();
        judge();
      }

      function replay() {
        if (!events.length) { log.add('Nothing to replay yet: press Deploy first.', 'muted'); return; }
        hist.offset = 0;
        hist.startedAt = null;
        hist.mode = 'replay';
        hist.skippedRun = 0;
        hist.doubledRun = 0;
        log.add('application_history\'s offset is reset to earliest: ' + plural(events.length, 'event is', 'events are') + ' delivered again.', 'warn');
        render();
      }

      function rebuild() {
        hist.offset = 0;
        hist.deployments = 0;
        hist.succeeded = 0;
        hist.seen = new Set();
        hist.asOf = null;
        hist.startedAt = null;
        hist.mode = events.length ? 'rebuild' : null;
        hist.skippedRun = 0;
        hist.doubledRun = 0;
        log.add('POST /admin/projections/application_history/rebuild: TRUNCATE, then re-consume from the earliest offset.', 'busy');
        render();
      }

      function reset() {
        gen++;
        init();
        log.clear();
        log.add('Reset: empty topic, empty read tables.', 'muted');
        render();
      }

      ctx.interval(tick, 100);
      log.add('Press Deploy to write a deployment and publish its events.', 'muted');
      render();
    }
  });
})();
