/*
 * labs-kafka-2.js: more Kafka lessons for "How Appfleet works" (group 'kafka', orders 6 and up).
 *
 * One AF.register call per lesson. Facts come from control-api S4.5 (the outbox poller), its tests and its
 * Results sections as of 2026-10-06. Anything that was not measured is labelled in the UI.
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


  AF.register({
    id: 'kf-outbox-poller',
    group: 'kafka',
    order: 6,
    title: 'The outbox poller: two guards, order and at-least-once',
    question: 'The poller moves committed rows to Kafka: what stops two pollers publishing a row twice, what stops a later row overtaking an earlier one, and what happens when the broker is down?',
    status: 'built',
    slice: 'S4.5',
    where: [
      'control-api/src/main/java/io/appfleet/control/outbox/OutboxPoller.java (pollOnce, cycle, publish, purgeSentBefore)',
      'OutboxMessageRepository.java (tryLeaderLock, lockPending, deleteSentBefore)',
      'OutboxPollerTest, OutboxOrderTest (leaderLock_stopsALaterRowOvertaking), OutboxDeliveryTest (tests 8 to 13)',
      'docs/design/control-api/control-api-s4-5-outbox.md (decisions 5 to 8, section 5, Results 9.3 to 9.9); control-api-s4-5-outbox-code.md (sections 7, 10, 15, 16.4, 16.5, 16.9)'
    ],
    idea: [
      'The outbox row is already committed with the state change; the poller only moves it to Kafka. One cycle is one transaction: pg_try_advisory_xact_lock(7450001) to become the single leader (a poller that does not get it skips the cycle), then lockPending, which reads the oldest unsent rows in id order with FOR UPDATE SKIP LOCKED, then for each row a send that waits for the broker’s acknowledgement, then markSent on the acknowledged rows, then commit. A row is marked sent only after the broker has it, and the cycle never throws: a failure is logged at WARN and the next cycle, one second later, tries again.',
      'Appfleet found by mutation that the two locks do different jobs. Duplicates are prevented by two independent guards, the advisory lock and the row locks: removing either one alone leaves twoPollers_publishEachMessageOnce green, and only removing both turns it red, "Expected size: 50 but was: 100". Order is protected by the advisory lock alone. OutboxOrderTest.leaderLock_stopsALaterRowOvertaking uses batch size 1 so poller A holds only row 1; without the lock, poller B skips row 1 and publishes row 2 first. Delivery is at least once: if the commit fails after the send, the next cycle sends the row again with the same message-id header (crashAfterSend_resendsTheMessage). A failed send stops the batch, so the row behind it waits (failedSend_stopsTheBatch_inOrder).',
      'The price is real. One poller publishes at a time, so throughput is traded for order. One row that can never be sent blocks every row behind it (head-of-line blocking), accepted and recorded; the escape, an attempts column and a parking state, is deferred. Because the poller never throws, every bug inside a cycle is only a WARN line: the S4.5 typos sent_as and task.word showed up that way, and a missing topic on the real stack gave 29 WARN lines over 2.5 minutes, with nothing lost and the row delivered within one cycle once the topics existed. Nothing in control-api deduplicates the repeated message; task-service must, and that is a stated dependency, not a verified one. The purge deletes only SENT rows older than the retention (24 hours); pending rows are never deleted.'
    ],
    terms: [
      ['Leader lock', 'pg_try_advisory_xact_lock: a Postgres lock on a number, held until the transaction ends. The poller that gets it publishes this cycle; the other skips it. It cannot leak a connection because commit or rollback releases it.'],
      ['FOR UPDATE SKIP LOCKED', 'The pending-rows query locks the rows it returns and skips rows another transaction has locked. Alone, it lets two pollers split the table, which is why it cannot protect order.'],
      ['At least once', 'A row is marked sent only after the acknowledgement, so a crash between the acknowledgement and the commit sends it again. The duplicate carries the same message-id header.'],
      ['Head-of-line blocking', 'A failed send stops the batch, so the failed row and every row behind it wait. Order is kept; a row that can never be sent blocks the line.'],
      ['Seam', 'A protected method (beforePublish, beforeCommit) that a test overrides to pause a poller or force a failure at an exact moment.']
    ],
    tryIt: [
      'Leave everything on its default (2 pollers, both toggles on, batch 100, failure "None") and press "Run round 1": poller B skips the cycle, the topic holds r1, r2, r3 once each.',
      'Switch off "Advisory leader lock" only, then run: still no duplicate, because SKIP LOCKED covers it. Then also switch off "FOR UPDATE SKIP LOCKED": both pollers send the same rows. That is the one combination where test 8 goes red.',
      'Switch off "Advisory leader lock", keep SKIP LOCKED and choose Batch size 1: poller B publishes r2 while A holds r1, and the topic order is r2 then r1. This is test 8b.',
      'Choose Failure "One send fails" with one poller, run round 1, then "Run round 2, fault cleared": r2 fails, r3 is not touched, and round 2 sends r2 then r3. Switch off "Stop the batch on a failed send" to see r3 jump the queue.',
      'Choose "Crash after send, before commit" and run twice: all rows are on the topic twice, and the log says the second records carry the same message-id. Choose "Topic missing" to see WARN lines and no loss, then "Run round 2, fault cleared".'
    ],
    breakIt: 'Switch on "Mark sent before the send" and choose "One send fails" or "Topic missing". The row is marked sent, the commit succeeds, and the message is never on the topic: it is lost for good, and nothing in the database says a message is still owed. Appfleet proved this mutation red in failedSend_stopsTheBatch_inOrder and kafkaDown_requestStillSucceeds_andIsSentLater.',
    say: 'The poller does a leader lock, a SKIP LOCKED select, a send that waits for the acknowledgement, markSent and a commit in one transaction; duplicates are blocked by two independent guards (I measured that only removing both gives 100 records for 50 rows) while only the advisory lock protects order, delivery is at least once with the same message-id on a resend, and a failed send stops the batch so order is kept at the price of head-of-line blocking.',
    quiz: {
      q: 'With batch size 1, what is the only thing that stops poller B publishing row 2 while poller A holds row 1 and has not sent it yet?',
      options: [
        'FOR UPDATE SKIP LOCKED, because B cannot read a locked row',
        'The advisory leader lock: B does not get it, so B skips the whole cycle',
        'acks=all on the producer',
        'enable.idempotence=true on the producer'
      ],
      answer: 1,
      why: 'SKIP LOCKED makes B skip row 1 and take row 2, which is exactly the overtaking. Test 8b removed the leader lock and got a record on the topic while A was still holding row 1. acks=all and idempotence protect the send to the broker, not the order between two pollers.'
    },
    mount(el, ctx) {
      // Rows r1..r3 are three pending commands of one deployment. The two-poller interleaving is the one test 8b forces:
      // A locks its rows and is held before its first send, B runs a whole cycle, then A is released.
      const ROWS = ['r1', 'r2', 'r3'];
      let st;

      const logBox = ui.log({ label: 'Poller steps', max: 80 });
      const rowsBox = h('div', { class: 'stack' });
      const topicBox = h('div', { class: 'stack' });
      const verdict = ui.verdict();
      const rTopic = ui.readout('Records on task.work');
      const rSent = ui.readout('Rows marked sent');
      const rPend = ui.readout('Rows pending');
      const rOrder = ui.readout('Topic order');

      const pollers = ui.choice('Pollers', [{ value: 1, label: '1' }, { value: 2, label: '2' }], 2, reset);
      const adv = ui.toggle('Advisory leader lock', true, reset, { tone: 'danger' });
      const skip = ui.toggle('FOR UPDATE SKIP LOCKED', true, reset, { tone: 'danger' });
      const batch = ui.choice('Batch size', [{ value: 1, label: '1' }, { value: 100, label: '100' }], 100, reset);
      const fail = ui.choice('Failure', [
        { value: 'none', label: 'None' },
        { value: 'send', label: 'One send fails' },
        { value: 'crash', label: 'Crash after send, before commit' },
        { value: 'topic', label: 'Topic missing' }
      ], 'none', reset);
      const stop = ui.toggle('Stop the batch on a failed send', true, reset);
      const markFirst = ui.toggle('Mark sent before the send', false, reset, { tone: 'danger' });
      const run1 = ui.button('Run round 1', () => round(fail.get()), { variant: 'primary' });
      const run2 = ui.button('Run round 2, fault cleared', () => round('none'));

      function fresh() {
        return {
          rows: ROWS.map(id => ({ id, sent: false, lockedBy: null })),
          topic: [],
          rounds: 0,
          crashUsed: false,
          sendUsed: false,
          warns: 0,
          lastFailure: 'none'
        };
      }

      function reset() {
        st = fresh();
        logBox.clear();
        render();
        verdict.set('idle', 'Three commands, r1 to r3 of one deployment, are pending. Pick a setup and press "Run round 1".');
      }

      function log(text, tone) { logBox.add(text, tone); }

      function round(failure) {
        st.rounds += 1;
        st.lastFailure = failure;
        log('--- round ' + st.rounds + (failure === 'none' ? ' (no fault)' : ' (fault: ' + failure + ')') + ' ---');
        const names = pollers.get() === 2 ? ['A', 'B'] : ['A'];
        const ps = names.map(name => ({ name, active: false, rows: [] }));
        begin(ps[0]);
        if (ps.length === 2) {
          log('A is held here, after it locked its rows and before its first send (the beforePublish seam of test 8b). B runs a full cycle.', 'info');
          begin(ps[1]);
          finish(ps[1], failure);
          log('A is released.', 'info');
        }
        finish(ps[0], failure);
        render();
        analyse(failure);
      }

      function begin(p) {
        if (adv.get()) {
          if (st.leader) {
            log(p.name + ': pg_try_advisory_xact_lock = false, skips this cycle', 'warn');
            return;
          }
          st.leader = p.name;
          log(p.name + ': pg_try_advisory_xact_lock = true, now the leader');
        }
        p.active = true;
        const limit = batch.get();
        const sel = st.rows.filter(r => !r.sent && !(skip.get() && r.lockedBy && r.lockedBy !== p.name)).slice(0, limit);
        if (skip.get()) sel.forEach(r => { r.lockedBy = p.name; });
        p.rows = sel;
        const how = skip.get() ? 'lockPending(' + limit + ') with SKIP LOCKED' : 'plain select, no row locks';
        log(p.name + ': ' + how + ' -> ' + (sel.length ? sel.map(r => r.id).join(', ') : 'no rows'));
      }

      function send(p, row, failure) {
        const failNow = failure === 'topic' || (failure === 'send' && row.id === 'r2' && !st.sendUsed);
        if (failNow) {
          if (failure === 'send') st.sendUsed = true;
          st.warns += 1;
          log(failure === 'topic'
            ? 'WARN Outbox message ' + row.id + ' not sent: KafkaException: Send failed (the send waited up to max.block.ms, 3 s)'
            : 'WARN Outbox message ' + row.id + ' not sent: send failed (injected, once)', 'bad');
          return false;
        }
        st.topic.push({ row: row.id, by: p.name, round: st.rounds, dup: st.topic.some(t => t.row === row.id) });
        log(p.name + ': sends ' + row.id + ', acknowledged' + (st.topic.length > 1 && st.topic[st.topic.length - 1].dup ? ' (a second record for this row)' : ''), 'ok');
        return true;
      }

      function finish(p, failure) {
        if (!p.active) return;
        const marks = [];
        for (const row of p.rows) {
          if (markFirst.get()) marks.push(row);
          if (!send(p, row, failure)) {
            if (stop.get()) { log(p.name + ': break, the rest of the batch waits', 'warn'); break; }
            log(p.name + ': continue, goes on to the next row', 'warn');
            continue;
          }
          if (!markFirst.get()) marks.push(row);
        }
        const release = () => {
          st.rows.forEach(r => { if (r.lockedBy === p.name) r.lockedBy = null; });
          if (st.leader === p.name) st.leader = null;
        };
        if (failure === 'crash' && !st.crashUsed && marks.length) {
          st.crashUsed = true;
          log(p.name + ': the commit fails after the sends, markSent is rolled back, ' + marks.map(r => r.id).join(', ') + ' stay pending', 'bad');
        } else {
          marks.forEach(r => { r.sent = true; });
          log(p.name + ': commit' + (marks.length ? ', ' + marks.map(r => r.id).join(', ') + ' marked sent' : ', nothing to mark'));
        }
        release();
      }

      function measuredNote(failure) {
        const n = pollers.get(), a = adv.get(), k = skip.get(), b = batch.get();
        const realLocks = a && k && b === 100;
        const plain = stop.get() && !markFirst.get();
        let m = null;
        if (n === 1 && realLocks && plain && ['none', 'send', 'crash', 'topic'].indexOf(failure) >= 0) m = true;
        if (n === 1 && realLocks && !stop.get() && !markFirst.get() && failure === 'send') m = true;
        if (n === 1 && realLocks && stop.get() && markFirst.get() && (failure === 'send' || failure === 'topic')) m = true;
        if (n === 2 && failure === 'none' && plain) {
          if (b === 100) m = true;
          if (b === 1 && !k && a) m = false;
          if (b === 1 && k) m = true;
        }
        return m;
      }

      function analyse(failure) {
        const onTopic = id => st.topic.some(t => t.row === id);
        const lost = st.rows.filter(r => r.sent && !onTopic(r.id));
        const first = [];
        st.topic.forEach(t => { if (first.indexOf(t.row) < 0) first.push(t.row); });
        const jumped = first.some((id, i) => i > 0 && ROWS.indexOf(id) < ROWS.indexOf(first[i - 1]))
          || st.rows.some((r, i) => i > 0 && onTopic(r.id) && !onTopic(st.rows[i - 1].id));
        const concurrentDup = st.topic.some(t => t.dup && st.topic.some(u => u.row === t.row && u.by !== t.by && u.round === t.round));
        const resendDup = st.topic.some(t => t.dup) && !concurrentDup;
        const pending = st.rows.filter(r => !r.sent).length;
        const m = measuredNote(fail.get());
        const tag = m === true ? 'Measured in Appfleet. ' : m === false ? 'Measured in Appfleet (50 rows, not these 3). ' : 'Reasoned from the code, not measured for this combination. ';
        let tone, text;
        if (lost.length) {
          tone = 'bad';
          text = lost.map(r => r.id).join(', ') + ' is marked sent but never reached the topic: lost for good. Caught by failedSend_stopsTheBatch_inOrder and kafkaDown_requestStillSucceeds_andIsSentLater (the markSent-before-send mutation turned both red). ' + tag;
        } else if (jumped) {
          tone = 'bad';
          text = !stop.get() && failure === 'send'
            ? 'r3 reached the topic while r2 is still pending: with continue instead of break the row behind a failure overtakes it. Caught by failedSend_stopsTheBatch_inOrder (red: "the row behind it waits, in order"). ' + tag
            : 'A later row reached the topic before an earlier one (' + first.join(', ') + '). Only the advisory lock prevents this. Caught by leaderLock_stopsALaterRowOvertaking (red: "Expecting empty but was: [ConsumerRecord(topic = task.work ..."). ' + tag;
        } else if (concurrentDup) {
          tone = 'bad';
          text = 'Both pollers published the same rows: ' + st.topic.length + ' records for 3 rows. Both guards are off, and this is the only combination that fails twoPollers_publishEachMessageOnce (with 50 rows: Expected size: 50 but was: 100). ' + tag;
        } else if (resendDup) {
          tone = 'warn';
          text = 'A row is on the topic twice with the same message-id: at-least-once, not a bug. crashAfterSend_resendsTheMessage shows it on purpose. Nothing in control-api deduplicates; task-service must. ' + (m === true ? 'Measured in Appfleet for one row (test 10); the record count for 3 rows is reasoned. ' : 'Reasoned from the code, not measured for this combination. ');
        } else if (st.crashUsed && pending && st.topic.length) {
          tone = 'warn';
          text = 'The records are already on the topic but the commit failed, so every row is still pending. Press "Run round 2, fault cleared": the same rows are sent again with the same message-id. Test: crashAfterSend_resendsTheMessage (one row). ' + (m === true ? 'Measured in Appfleet for one row; the 3-row count is reasoned. ' : 'Reasoned from the code, not measured for this combination. ');
        } else if (st.warns && pending) {
          tone = 'warn';
          text = 'WARN lines, ' + plural(pending, 'row') + ' still pending, nothing lost and no request failed. The poller never throws, so a failure is only a log line. Press "Run round 2, fault cleared": the waiting rows go out in order. Tests: ' + (failure === 'topic' ? 'kafkaDown_requestStillSucceeds_andIsSentLater (dead broker); the missing topic was the live kill-test, 29 WARN lines over 2.5 minutes. ' : 'failedSend_stopsTheBatch_inOrder. ') + tag;
        } else if (pending === 0) {
          tone = 'ok';
          text = 'All three rows are on the topic once, in order r1, r2, r3, and marked sent. Tests: poller_publishesAPendingMessage and poller_keepsPerDeploymentOrder' + (pollers.get() === 2 ? ', twoPollers_publishEachMessageOnce' : '') + '. ' + tag;
        } else {
          tone = 'idle';
          text = plural(pending, 'row') + ' still pending. Run another round. ' + tag;
        }
        verdict.set(tone, text);
      }

      function render() {
        AF.clear(rowsBox);
        st.rows.forEach(r => {
          const tone = r.sent ? 'ok' : r.lockedBy ? 'busy' : 'idle';
          rowsBox.append(ui.token(r.id + (r.sent ? ' sent_at set' : r.lockedBy ? ' locked by ' + r.lockedBy : ' pending'), tone));
        });
        AF.clear(topicBox);
        if (!st.topic.length) topicBox.append(label('empty'));
        st.topic.forEach(t => topicBox.append(ui.token(t.row + ' from ' + t.by + (t.dup ? ' (again)' : ''), t.dup ? 'warn' : 'ok')));
        const first = [];
        st.topic.forEach(t => { if (first.indexOf(t.row) < 0) first.push(t.row); });
        const sent = st.rows.filter(r => r.sent).length;
        rTopic.set(st.topic.length, st.topic.length > 3 ? 'bad' : null);
        rSent.set(sent + ' of 3');
        rPend.set(3 - sent, 3 - sent ? 'busy' : 'ok');
        rOrder.set(st.topic.length ? first.join(' ') : '—');
      }

      el.append(
        controls(pollers.el, adv.el, skip.el, batch.el, fail.el, stop.el, markFirst.el, run1, run2, ui.button('Reset', reset, { variant: 'quiet' })),
        stage(h('div', { class: 'sim-cols' },
          ui.panel('Outbox rows', rowsBox),
          ui.panel('Poller steps', logBox.el),
          ui.panel('Topic task.work, in arrival order', topicBox))),
        readouts(rTopic, rSent, rPend, rOrder),
        note('Illustrative model: three rows of one deployment and a fixed interleaving (A locks its rows and is held before its first send, B runs a whole cycle, A resumes), the one test 8b forces. Verdicts say "Measured" only for combinations recorded in S4.5 Results 9.5 to 9.9 (test 8 with each guard removed, test 8b, tests 10 and 11, the markSent and continue mutations, the missing-topic kill-test); the 50-row numbers belong to test 8, not to these 3 rows. Every other combination is reasoned from the code.'),
        verdict.el
      );
      reset();
    }
  });

  AF.register({
    id: 'kf-advertised-listeners',
    group: 'kafka',
    order: 7,
    title: 'Advertised listeners: why kafka-init could not create topics',
    question: 'Why did kafka-init loop on "Connection to node 1 (localhost/127.0.0.1:9092)" when it was told to connect to kafka:9092?',
    status: 'built',
    slice: 'S4.5',
    where: [
      'docker-compose.yml (kafka: KAFKA_LISTENERS, KAFKA_ADVERTISED_LISTENERS, KAFKA_LISTENER_SECURITY_PROTOCOL_MAP, KAFKA_INTER_BROKER_LISTENER_NAME; kafka-init: --bootstrap-server)'
    ],
    idea: [
      'A Kafka client uses the bootstrap address only for its first request. The broker answers with metadata that lists every broker by its advertised listener, and the client reconnects to that address for all later requests. So the address in KAFKA_ADVERTISED_LISTENERS must work from where the client runs, not from where the broker runs.',
      'Appfleet had one listener, advertised as localhost:9092. That works for Spring apps on the host, where localhost:9092 is the port published by Docker. It fails for kafka-init: it reached kafka:9092, got metadata that says localhost:9092, and then dialled itself. Measured on 2026-10-06: the init container logged "Connection to node 1 (localhost/127.0.0.1:9092) could not be established" once per second and never exited.',
      'The fix is a second listener. PLAINTEXT stays on 9092 and is advertised as localhost:9092 for the host. INTERNAL is on 19092 and is advertised as kafka:19092 for containers, and it also carries inter-broker traffic. kafka-init now uses kafka:19092. Measured: with the fix, a one-off container created deployment.commands through kafka:19092. Not re-measured in this session: a Spring app on the host through localhost:9092. That path is unchanged and is reasoned from the config.'
    ],
    terms: [
      ['Bootstrap server', 'The first address a client contacts. It is used to fetch metadata and then not used again.'],
      ['Advertised listener', 'The address the broker tells clients to use for it. A wrong value fails after the first connection succeeds.'],
      ['Listener security protocol map', 'Maps each listener name to a protocol. A new listener name needs an entry here, or the broker does not start.'],
      ['Inter-broker listener', 'The listener that brokers use to talk to each other. With one node, it still must be a listener that resolves inside the container network.']
    ],
    tryIt: [
      'Choose client "Container (kafka-init)" and listeners "One listener": the verdict shows the loop. This is the measured failure.',
      'Choose "Two listeners": the container client now gets kafka:19092 and connects.',
      'Choose client "Host (Spring app)": both configurations work, because localhost:9092 is the published port.'
    ],
    breakIt: 'Add INTERNAL to KAFKA_LISTENERS but leave it out of KAFKA_LISTENER_SECURITY_PROTOCOL_MAP. The broker refuses to start because it has no protocol for that listener name. This is reasoned from Kafka behaviour, not measured in Appfleet.',
    say: 'A Kafka client reconnects to the address in the broker metadata, not to its bootstrap address; so with one listener advertised as localhost, a container client dials itself, and the fix is a second listener advertised as the service name, which I measured by creating a topic through kafka:19092.',
    quiz: {
      q: 'kafka-init uses --bootstrap-server kafka:9092 and the broker advertises only localhost:9092. Which address does the client dial after its first request?',
      options: [
        'kafka:9092, because that is what it was told',
        'localhost:9092 inside the init container, which is the container itself',
        'localhost:9092 on the host machine',
        'The Docker gateway address'
      ],
      answer: 1,
      why: 'The metadata response replaces the bootstrap address. The log line "Connection to node 1 (localhost/127.0.0.1:9092)" shows it.'
    },
    mount(el) {
      const verdict = ui.verdict();
      const client = ui.choice('Client', [
        { value: 'container', label: 'Container (kafka-init)' },
        { value: 'host', label: 'Host (Spring app)' }
      ], 'container', render);
      const listeners = ui.choice('Broker listeners', [
        { value: 'one', label: 'One listener' },
        { value: 'two', label: 'Two listeners' }
      ], 'one', render);

      function render() {
        const c = client.get(), l = listeners.get();
        if (c === 'host') {
          verdict.set('ok', 'Connects: metadata says localhost:9092, the port Docker publishes. Reasoned, unchanged by the fix.');
        } else if (l === 'one') {
          verdict.set('bad', 'Loops: metadata says localhost:9092, which inside the container is the container itself. Measured 2026-10-06.');
        } else {
          verdict.set('ok', 'Connects: metadata says kafka:19092. Measured: topic created through kafka:19092.');
        }
      }

      el.append(
        controls(client.el, listeners.el),
        stage(h('div', { class: 'stack' })),
        note('Illustrative model of one decision: which address the metadata hands back. Two verdicts are measured on 2026-10-06 (container with one listener, container with two); the host verdicts are reasoned from the configuration.'),
        verdict.el
      );
      render();
    }
  });

  // @@LESSONS@@
})();
