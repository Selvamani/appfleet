/*
 * labs-spring.js: the Spring lessons for "How Appfleet works".
 *
 * Registers six lessons in group 'spring'. Each mount() builds a small simulation from the
 * AF.ui atoms in core.js and the CSS atoms in appfleet-concepts.html.
 *
 *   sp-autoconfig  conditional beans, fleet-audit-starter, the conditions report
 *   sp-proxy       proxies, self-invocation, @EnableMethodSecurity
 *   sp-filters     CorrelationIdFilter, the filter chain, MDC on pooled threads
 *   sp-errors      ProblemDetail and the status matrix
 *   sp-lazy        lazy loading, open-in-view, how long a connection is held
 *   sp-scheduled   @Scheduled on many instances: advisory lock or SKIP LOCKED
 *
 * Facts come from control-api, fleet-audit-starter and node-agent sources and docs/design
 * as of 2026-10-02. Planned code is shown as a labelled sketch, never as built.
 */
(function () {
  'use strict';

  const h = AF.h;
  const ui = AF.ui;

  // ---------- shared helpers ----------

  /** Sleep for ms, or for 0 ms when the reader prefers reduced motion (logic still runs). */
  const wait = (ctx, ms) => AF.sleep(ctx, ctx.reducedMotion ? 0 : ms);

  const hex = n => {
    let s = '';
    for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 16).toString(16);
    return s;
  };
  const uuidOf = version => hex(8) + '-' + hex(4) + '-' + version + hex(3) + '-' + AF.pick(['8', '9', 'a', 'b']) + hex(3) + '-' + hex(12);
  /** Correlation ids are generated with UUID.randomUUID(), version 4. Random, for looks only. */
  const corrId = () => uuidOf('4');
  /** Appfleet entity ids are UUIDv7. Random, for looks only. */
  const entityId = () => uuidOf('7');

  const arrow = () => h('span', { class: 'muted', 'aria-hidden': 'true' }, '→');
  const setCode = (pre, text) => { pre.firstChild.textContent = text; };
  const relabel = (readout, text) => { readout.el.firstChild.textContent = text; };
  const note = text => h('p', { class: 'muted small' }, text);
  const setAside = (lane, text) => { lane.title.lastChild.textContent = text; };

  /**
   * One animation at a time. start(fn) ignores clicks while a run is active;
   * cancel() abandons the active run, whose next live() check then returns false.
   */
  function runGuard(onBusy) {
    let token = 0;
    let busy = false;
    const set = b => { busy = b; if (onBusy) onBusy(b); };
    return {
      get busy() { return busy; },
      cancel() { token++; set(false); },
      start(fn) {
        if (busy) return;
        set(true);
        const mine = ++token;
        Promise.resolve()
          .then(() => fn(() => mine === token))
          .catch(err => console.error(err))
          .finally(() => { if (mine === token) set(false); });
      }
    };
  }

  // =====================================================================
  // 1. sp-autoconfig: conditional beans, the starter, the conditions report
  // =====================================================================

  const AUDIT_TYPE = 'io.appfleet.audit.AuditLogger';
  const RUNTIME_TYPE = 'io.appfleet.agent.runtime.ContainerRuntime';

  /** The outcome of @ConditionalOnProperty, worded like Spring Boot's OnPropertyCondition. */
  function propertyOutcome(prefix, name, want, actual) {
    const spec = '@ConditionalOnProperty (' + prefix + '.' + name + '=' + want + ')';
    if (actual === 'unset') return { ok: false, text: spec + " did not find property '" + name + "' (OnPropertyCondition)" };
    if (actual !== want) return { ok: false, text: spec + " found different value in property '" + name + "' (OnPropertyCondition)" };
    return { ok: true, text: spec + ' matched (OnPropertyCondition)' };
  }

  /** Lay entries out like the --debug conditions evaluation report. */
  function conditionsReport(entries) {
    const pos = entries.filter(e => e.ok);
    const neg = entries.filter(e => !e.ok);
    const out = ['Positive matches:', '-----------------', ''];
    if (!pos.length) out.push('   None', '');
    pos.forEach(e => out.push('   ' + e.subject + ' matched:', '      - ' + e.text, ''));
    out.push('Negative matches:', '-----------------', '');
    if (!neg.length) out.push('   None', '');
    neg.forEach(e => out.push('   ' + e.subject + ':', '      Did not match:', '         - ' + e.text, ''));
    return out.join('\n').replace(/\n+$/, '');
  }

  AF.register({
    id: 'sp-autoconfig',
    group: 'spring',
    order: 1,
    title: 'Auto-configuration and conditional beans',
    question: 'How does Spring Boot decide which beans to create, and how does an application overrule a default it did not write?',
    status: 'built',
    slice: 'S0, S5',
    where: [
      'fleet-audit-starter: AuditAutoConfiguration, AuditProperties, AutoConfiguration.imports',
      'AuditAutoConfigurationTest (3 ApplicationContextRunner tests)',
      'node-agent RuntimeAutoConfig, DockerRuntimeConfig (branch node-agent-phase-0, no tests yet)',
      'control-api AppfleetProperties (@Validated, @NotBlank environment)'
    ],
    idea: [
      'Spring Boot builds the application context from beans. An auto-configuration is a configuration class shipped in a jar and listed in that jar\'s AutoConfiguration.imports file. Boot merges those lists from every jar on the classpath and checks each class\'s conditions before it creates anything. A condition that fails means the bean is never created at all, not created empty.',
      'fleet-audit-starter is Appfleet\'s own starter. AuditAutoConfiguration applies only when appfleet.audit.enabled is true; a missing property counts as no. Its auditLogger method also carries @ConditionalOnMissingBean, so an application that defines its own AuditLogger simply wins, with no flag and no @Primary. AuditAutoConfigurationTest proves all three cases with ApplicationContextRunner, which starts a small throwaway context without a server.',
      'node-agent chooses its ContainerRuntime the same way: three @Bean methods in RuntimeAutoConfig, each guarded by @ConditionalOnProperty on appfleet.runtime.mode, so at most one matches. Settings bind to typed records with @ConfigurationProperties, never @Value. control-api\'s AppfleetProperties adds @Validated, so a blank appfleet.environment stops startup at once. Running with --debug prints the conditions evaluation report.'
    ],
    terms: [
      ['Auto-configuration', 'A configuration class Boot finds through AutoConfiguration.imports and applies only if its conditions match.'],
      ['@ConditionalOnProperty', 'Creates the bean only when a property has the given value. Without matchIfMissing, a missing property means no bean.'],
      ['@ConditionalOnMissingBean', 'Creates the default only if no bean of that type exists yet, so the application\'s own bean wins.'],
      ['Conditions evaluation report', 'Printed at startup with --debug: every condition Boot checked, matched or not, with the reason.']
    ],
    tryIt: [
      'Set appfleet.audit.enabled to not set and find AuditAutoConfiguration under Negative matches in the report.',
      'Set it back to true and switch on Define my own AuditLogger bean: the starter\'s auditLogger backs off.',
      'Switch on Forget @ConditionalOnMissingBean: two AuditLogger beans, and startup fails with NoUniqueBeanDefinitionException.',
      'Change appfleet.runtime.mode, then switch on Leave appfleet.environment blank to see fail-fast binding.'
    ],
    breakIt: 'Remove @ConditionalOnMissingBean from the starter and an application that defines its own logger ends up with two AuditLogger beans, so the first constructor that injects AuditLogger fails startup with NoUniqueBeanDefinitionException. The test enabledWithUserBean_backsOff catches it before any application does.',
    say: 'A starter supplies a default behind conditions: @ConditionalOnProperty switches the whole configuration on, @ConditionalOnMissingBean lets the application\'s own bean win, and ApplicationContextRunner tests prove both without starting a server.',
    quiz: {
      q: 'appfleet.audit.enabled is true and the application defines its own AuditLogger bean. What does Boot do with the starter\'s auditLogger method?',
      options: [
        'Skips it, because @ConditionalOnMissingBean finds the application\'s bean',
        'Creates both beans and marks the starter\'s one as @Primary',
        'Replaces the application\'s bean with Slf4jAuditLogger, because auto-configuration runs last',
        'Fails startup, because two configurations define an AuditLogger'
      ],
      answer: 0,
      why: 'Auto-configurations are evaluated after the application\'s own bean definitions, so @ConditionalOnMissingBean sees customAuditLogger and the default backs off. Nothing is marked @Primary, and two beans exist only if the condition is missing.'
    },
    mount(el, ctx) {
      const st = { audit: 'true', own: false, broken: false, mode: 'simulated', inject: true, blankEnv: false };

      const auditC = ui.choice('appfleet.audit.enabled', [
        { value: 'true', label: 'true' },
        { value: 'false', label: 'false' },
        { value: 'unset', label: 'not set' }
      ], st.audit, v => { st.audit = v; render(); });
      const ownT = ui.toggle('Define my own AuditLogger bean', st.own, v => { st.own = v; render(); });
      const brokenT = ui.toggle('Forget @ConditionalOnMissingBean', st.broken, v => { st.broken = v; render(); }, { tone: 'danger' });
      const modeC = ui.choice('appfleet.runtime.mode', [
        { value: 'docker', label: 'docker' },
        { value: 'simulated', label: 'simulated' },
        { value: 'swarm', label: 'swarm' },
        { value: 'unset', label: 'not set' }
      ], st.mode, v => { st.mode = v; render(); });
      const injectT = ui.toggle('Inject both beans into a service', st.inject, v => { st.inject = v; render(); });
      const envT = ui.toggle('Leave appfleet.environment blank', st.blankEnv, v => { st.blankEnv = v; render(); });

      const apiLane = ui.lane('control-api context', 'with fleet-audit-starter');
      const agentLane = ui.lane('node-agent context', 'RuntimeAutoConfig');
      const rAudit = ui.readout('AuditLogger beans');
      const rRuntime = ui.readout('ContainerRuntime beans');
      const rTest = ui.readout('AuditAutoConfigurationTest');
      const verdict = ui.verdict();
      const report = ui.code('', 'Conditions evaluation report');

      el.append(
        h('div', { class: 'sim-controls' }, auditC.el, ownT.el, brokenT.el),
        h('div', { class: 'sim-controls' }, modeC.el, injectT.el, envT.el),
        h('div', { class: 'sim-stage' },
          h('div', { class: 'stack' },
            h('div', { class: 'sim-cols' }, apiLane.el, agentLane.el),
            note('In the real code nothing injects AuditLogger or ContainerRuntime yet (SessionService is not a bean). The inject switch shows what startup does once something does.'))),
        h('div', { class: 'readouts' }, rAudit.el, rRuntime.el, rTest.el),
        verdict.el,
        ui.panel('Conditions evaluation report (--debug), Appfleet entries only', report)
      );

      const bean = (name, sub, tone) => AF.tone(ui.node(name, sub), tone);
      const RUNTIME_BEANS = {
        docker: [['dockerClient', 'DockerClient, from DockerRuntimeConfig'], ['dockerContainerRuntime', 'DockerRuntime']],
        simulated: [['simulatedContainerRuntime', 'SimulatedRuntime']],
        swarm: [['swarmContainerRuntime', 'SwarmRuntime']],
        unset: []
      };

      function render() {
        // ---- control-api: the starter ----
        const classMatch = propertyOutcome('appfleet.audit', 'enabled', 'true', st.audit);
        const starterBean = classMatch.ok && (st.broken || !st.own);
        const auditBeans = [];
        if (st.own) auditBeans.push(['customAuditLogger', 'your @Bean']);
        if (starterBean) auditBeans.push(['auditLogger', 'Slf4jAuditLogger, from the starter']);

        let apiFail = null;
        if (st.blankEnv) {
          apiFail = 'ConfigurationPropertiesBindException: AppfleetProperties is @Validated and environment is @NotBlank, so control-api refuses to start.';
        } else if (st.inject && auditBeans.length === 0) {
          apiFail = "NoSuchBeanDefinitionException: No qualifying bean of type '" + AUDIT_TYPE + "' available. Audit is off but a service still needs it, and startup says so.";
        } else if (st.inject && auditBeans.length > 1) {
          apiFail = "NoUniqueBeanDefinitionException: No qualifying bean of type '" + AUDIT_TYPE + "' available: expected single matching bean but found 2: customAuditLogger,auditLogger";
        }

        AF.clear(apiLane.body);
        if (st.blankEnv) {
          apiLane.body.append(bean('AppfleetProperties', 'binding failed: environment must not be blank', 'bad'));
        } else {
          apiLane.body.append(bean('AppfleetProperties', 'bound and validated', 'ok'));
          if (!auditBeans.length) apiLane.body.append(bean('No AuditLogger bean', 'AuditAutoConfiguration skipped', 'idle'));
          auditBeans.forEach(b => apiLane.body.append(bean(b[0], b[1], auditBeans.length > 1 ? 'bad' : 'ok')));
          if (st.inject) apiLane.body.append(bean('A service', 'constructor-injects one AuditLogger', apiFail ? 'bad' : 'ok'));
        }
        apiLane.body.append(h('div', null, ui.token(apiFail ? 'startup failed' : 'started', apiFail ? 'bad' : 'ok')));

        // ---- node-agent: one runtime ----
        const runtime = RUNTIME_BEANS[st.mode];
        const runtimeCount = runtime.length ? 1 : 0;
        const agentFail = st.inject && !runtimeCount
          ? "NoSuchBeanDefinitionException: No qualifying bean of type '" + RUNTIME_TYPE + "' available."
          : null;
        AF.clear(agentLane.body);
        if (!runtimeCount) agentLane.body.append(bean('No ContainerRuntime bean', 'no mode value matched', 'idle'));
        runtime.forEach(b => agentLane.body.append(bean(b[0], b[1], 'ok')));
        if (st.inject) agentLane.body.append(bean('SessionService', 'once a bean: injects one ContainerRuntime', agentFail ? 'bad' : 'ok'));
        agentLane.body.append(h('div', null, ui.token(agentFail ? 'startup failed' : 'started', agentFail ? 'bad' : 'ok')));

        // ---- the report ----
        const entries = [Object.assign({ subject: 'AuditAutoConfiguration' }, classMatch)];
        if (classMatch.ok && !st.broken) {
          const spec = '@ConditionalOnMissingBean (types: ' + AUDIT_TYPE + '; SearchStrategy: all)';
          entries.push(st.own
            ? { subject: 'AuditAutoConfiguration#auditLogger', ok: false, text: spec + " found beans of type '" + AUDIT_TYPE + "' customAuditLogger (OnBeanCondition)" }
            : { subject: 'AuditAutoConfiguration#auditLogger', ok: true, text: spec + ' did not find any beans (OnBeanCondition)' });
        }
        entries.push(Object.assign({ subject: 'DockerRuntimeConfig#dockerClient' }, propertyOutcome('appfleet.runtime', 'mode', 'docker', st.mode)));
        ['docker', 'simulated', 'swarm'].forEach(m => entries.push(
          Object.assign({ subject: 'RuntimeAutoConfig#' + m + 'ContainerRuntime' }, propertyOutcome('appfleet.runtime', 'mode', m, st.mode))));
        setCode(report, conditionsReport(entries));

        // ---- readouts and verdict ----
        if (st.blankEnv) rAudit.set('not created', 'bad');
        else rAudit.set(auditBeans.length, auditBeans.length === 1 ? 'ok' : (auditBeans.length > 1 || st.inject ? 'bad' : null));
        rRuntime.set(runtimeCount, runtimeCount ? 'ok' : (st.inject ? 'bad' : null));
        rTest.set(st.broken ? '2 of 3 pass' : '3 of 3 pass', st.broken ? 'bad' : 'ok');

        const fails = [];
        if (apiFail) fails.push('control-api fails to start. ' + apiFail);
        if (agentFail) fails.push('node-agent fails to start. ' + agentFail);
        if (fails.length) {
          verdict.set('bad', fails.join(' '));
        } else if (auditBeans.length > 1) {
          verdict.set('warn', 'Both contexts start, but only because nothing injects AuditLogger. There are two AuditLogger beans, and enabledWithUserBean_backsOff fails because hasSingleBean finds 2.');
        } else {
          const a = auditBeans.length
            ? auditBeans[0][0] + (st.own ? ' (yours; the starter backed off)' : ' (the starter\'s default)')
            : 'none (audit is off)';
          const r = runtimeCount ? runtime[runtime.length - 1][1] : 'none';
          let text = 'Both contexts start. AuditLogger: ' + a + '. ContainerRuntime: ' + r + '.';
          if (st.broken) text += ' The missing condition does no harm here yet, but enabledWithUserBean_backsOff already fails.';
          verdict.set(st.broken ? 'warn' : 'ok', text);
        }
      }

      render();
    }
  });

  // =====================================================================
  // 2. sp-proxy: proxies, self-invocation, @EnableMethodSecurity
  // =====================================================================

  const PRE = '@PreAuthorize("hasPermission(#request.applicationId(), \'Application\', \'DEPLOY\')")';

  AF.register({
    id: 'sp-proxy',
    group: 'spring',
    order: 2,
    title: 'Proxies and self-invocation',
    question: 'Why does an annotation like @Transactional or @PreAuthorize sometimes do nothing at all?',
    status: 'built',
    slice: 'S2, S4',
    where: [
      'DeploymentService.create() and createBroken()',
      'AuditEventRecorder.record() (REQUIRES_NEW, the collaborator bean)',
      'DeploymentServiceAuditRecordingTest (createBroken_auditRowDoesNotSurviveRollback is @Disabled)',
      '01-CONTROL-API.md, S4: @PreAuthorize("hasPermission(...)") (planned)'
    ],
    idea: [
      'Spring adds behaviour to a bean by wrapping it in a proxy. Other beans are given the proxy, not the object. When they call a method, the proxy runs an interceptor first (open a transaction, check access) and then calls the real method. A call from inside the object, this.inner(), never passes the proxy, so the annotation on inner() is silently ignored.',
      'Appfleet hit this in S2. Its audit row must survive a rolled-back deployment, so recording it needs REQUIRES_NEW, its own transaction. As a sibling method called with this., that annotation is never read. The fix moves the write to a separate bean: create() calls AuditEventRecorder.record(), the proxy opens a new transaction, and create_auditRowSurvivesRollback proves the row survives. The broken twin, createBroken(), stays behind a @Disabled test.',
      'S4 brings the same trap with @PreAuthorize, where it becomes a security hole: a skipped check means the call is allowed. Method security also has to be switched on with @EnableMethodSecurity. Without it every @PreAuthorize is just a comment, and nothing fails at startup to tell you.'
    ],
    terms: [
      ['Proxy', 'An object Spring puts in front of a bean. It runs interceptors, then forwards the call to the real bean.'],
      ['Self-invocation', 'A method calling another method on the same object through this. It skips the proxy.'],
      ['REQUIRES_NEW', 'Suspend the caller\'s transaction and run in a new one that commits or rolls back on its own.'],
      ['@EnableMethodSecurity', 'Registers the interceptors that read @PreAuthorize and similar annotations.']
    ],
    tryIt: [
      'Keep @Transactional, choose this.inner() and press Run call: the audit row is rolled back with the deployment.',
      'Choose Collaborator bean and run again: the proxy opens a new transaction and the audit row survives.',
      'Switch to @PreAuthorize with this.inner(): a Team A deployer deploys Team B\'s application.',
      'Choose Collaborator bean, run, then switch on Forget @EnableMethodSecurity and run again.'
    ],
    breakIt: 'Call an annotated method through this from a sibling method and the proxy is bypassed: REQUIRES_NEW never opens its own transaction, and in S4 @PreAuthorize never checks access. Nothing fails loudly; the annotation simply does nothing.',
    say: 'Spring\'s annotations work through a proxy, so a self-invoked call skips them; I move the annotated method to a collaborator bean, and Appfleet keeps the broken version behind a @Disabled test.',
    quiz: {
      q: 'outer() and inner() live in the same @Service. inner() has @PreAuthorize and @EnableMethodSecurity is on. A controller calls outer(), which calls this.inner(). What happens?',
      options: [
        'inner() runs with no access check, because that call never passes through the proxy',
        'Access is checked, because @EnableMethodSecurity covers every method of the bean',
        'Startup fails, because @PreAuthorize is not allowed on a method called internally',
        'Access is checked twice, once for outer() and once for inner()'
      ],
      answer: 0,
      why: 'The interceptor lives in the proxy. The controller\'s call to outer() goes through it, but outer() has no annotation, and this.inner() is a plain Java call on the real object. Moving inner() to another bean puts a proxy back in the path.'
    },
    mount(el, ctx) {
      const st = { ann: 'tx', style: 'self', noSec: false };

      const annC = ui.choice('Annotation', [
        { value: 'tx', label: '@Transactional' },
        { value: 'pre', label: '@PreAuthorize' }
      ], st.ann, v => { st.ann = v; reset(); });
      const styleC = ui.choice('Call to the annotated method', [
        { value: 'external', label: 'From another bean' },
        { value: 'self', label: 'this.inner()' },
        { value: 'collab', label: 'Collaborator bean' }
      ], st.style, v => { st.style = v; reset(); });
      const secT = ui.toggle('Forget @EnableMethodSecurity', st.noSec, v => { st.noSec = v; reset(); }, { tone: 'danger' });
      const runB = ui.button('Run call', () => guard.start(play), { variant: 'primary' });
      const guard = runGuard(b => { runB.disabled = b; });

      const scenario = h('p', { class: 'small' });
      const pathRow = h('div', { class: 'row' });
      const r1 = ui.readout('Interceptor');
      const r2 = ui.readout('Second');
      const r3 = ui.readout('Third');
      const verdict = ui.verdict();
      const log = ui.log({ label: 'Call log', max: 30 });
      const code = ui.code('', 'Code for this call path');

      el.append(
        h('div', { class: 'sim-controls' }, annC.el, styleC.el),
        h('div', { class: 'sim-controls' }, secT.el, runB),
        h('div', { class: 'sim-stage' }, h('div', { class: 'stack' }, scenario, pathRow)),
        h('div', { class: 'readouts' }, r1.el, r2.el, r3.el),
        verdict.el,
        h('div', { class: 'sim-cols' }, ui.panel('Call log', log.el), ui.panel('The code on this path', code))
      );

      // Each plan: nodes along the path, steps [nodeIndex, tone, logText], and the result.
      function planTx() {
        const caller = { label: 'Caller bean', sub: 'a controller or a test' };
        if (st.style === 'external') {
          return {
            nodes: [caller,
              { label: 'AuditEventRecorder proxy', sub: 'TransactionInterceptor' },
              { label: 'record()', sub: '@Transactional(REQUIRES_NEW)' }],
            steps: [
              [0, 'busy', 'Caller calls auditEventRecorder.record(event) on the proxy it was given'],
              [1, 'busy', 'TransactionInterceptor reads REQUIRES_NEW and opens a new transaction'],
              [2, 'busy', 'INSERT audit_event inside the new transaction'],
              [1, 'ok', 'TransactionInterceptor commits: the audit row is saved']
            ],
            result: { r1: ['ran', 'ok'], r2: ['not involved', null], r3: ['committed', 'ok'],
              verdict: ['ok', 'The call came in through the proxy, so the interceptor ran and REQUIRES_NEW opened its own transaction.'] }
          };
        }
        if (st.style === 'self') {
          return {
            nodes: [caller,
              { label: 'DeploymentService proxy', sub: 'TransactionInterceptor' },
              { label: 'outer()', sub: '@Transactional' },
              { label: 'No proxy here', sub: 'this is the raw object', skip: true },
              { label: 'this.recordAudit()', sub: 'REQUIRES_NEW, never read' }],
            steps: [
              [0, 'busy', 'Caller calls deploymentService.outer(...) on the proxy'],
              [1, 'busy', 'TransactionInterceptor opens transaction A'],
              [2, 'busy', 'save(deployment) runs inside A'],
              [3, 'idle', 'this.recordAudit(...) is a plain Java call: the proxy never sees it'],
              [4, 'warn', 'INSERT audit_event joins transaction A, because nothing read REQUIRES_NEW'],
              [2, 'bad', 'outer() throws IllegalStateException'],
              [1, 'bad', 'TransactionInterceptor rolls back A: the deployment and the audit row are both gone'],
              [4, 'bad', null]
            ],
            result: { r1: ['skipped', 'bad'], r2: ['rolled back', 'ok'], r3: ['lost in the rollback', 'bad'],
              verdict: ['bad', 'The audit row was rolled back with the deployment, because the self-invoked call skipped the proxy and REQUIRES_NEW never took effect.'] }
          };
        }
        return {
          nodes: [caller,
            { label: 'DeploymentService proxy', sub: 'TransactionInterceptor' },
            { label: 'create()', sub: '@Transactional' },
            { label: 'AuditEventRecorder proxy', sub: 'TransactionInterceptor' },
            { label: 'record()', sub: '@Transactional(REQUIRES_NEW)' }],
          steps: [
            [0, 'busy', 'Caller calls deploymentService.create(...) on the proxy'],
            [1, 'busy', 'TransactionInterceptor opens transaction A'],
            [2, 'busy', 'save(deployment) runs inside A'],
            [3, 'busy', 'auditEventRecorder.record(...) reaches another proxy: A is suspended, transaction B opens'],
            [4, 'busy', 'INSERT audit_event inside B'],
            [3, 'ok', 'B commits: the audit row is saved for good'],
            [2, 'bad', 'create() throws IllegalStateException'],
            [1, 'ok', 'TransactionInterceptor rolls back A: the deployment is gone, as intended']
          ],
          result: { r1: ['ran', 'ok'], r2: ['rolled back', 'ok'], r3: ['kept', 'ok'],
            verdict: ['ok', 'The deployment rolled back and the audit row survived, because the call to AuditEventRecorder went through its proxy. create_auditRowSurvivesRollback proves this.'] }
        };
      }

      function planPre() {
        const caller = { label: 'DeploymentController', sub: 'Alice: Team A, DEPLOYER' };
        const svcProxy = st.noSec
          ? { label: 'DeploymentService proxy', sub: 'TransactionInterceptor only, no security interceptor' }
          : { label: 'DeploymentService proxy', sub: 'AuthorizationManagerBeforeMethodInterceptor' };
        const denied = { r1: ['ran', 'ok'], r2: ['ran: denied', 'ok'], r3: ['blocked', 'ok'],
          verdict: ['ok', 'Denied before inner() ran: AccessDeniedException. S4 plans to answer 404 rather than 403, so the caller cannot even confirm the application exists.'] };
        const allowed = why => ({ r1: [why, 'bad'], r2: ['never ran', 'bad'], r3: ['allowed: IDOR', 'bad'] });

        if (st.style === 'external') {
          const nodes = [caller, svcProxy, { label: 'inner()', sub: '@PreAuthorize' }];
          if (st.noSec) {
            return { nodes,
              steps: [
                [0, 'busy', 'Controller calls service.inner(request) on the proxy'],
                [1, 'idle', 'No @EnableMethodSecurity: nothing on the proxy reads @PreAuthorize'],
                [2, 'bad', 'inner() runs: Team A deploys Team B\'s application']
              ],
              result: Object.assign(allowed('not registered'), {
                verdict: ['bad', 'Allowed. Without @EnableMethodSecurity every @PreAuthorize is just a comment, and nothing fails at startup to tell you.'] }) };
          }
          return { nodes,
            steps: [
              [0, 'busy', 'Controller calls service.inner(request) on the proxy'],
              [1, 'busy', 'AuthorizationManagerBeforeMethodInterceptor evaluates hasPermission: Team A may not deploy Team B\'s application'],
              [1, 'ok', 'AccessDeniedException: inner() never runs'],
              [2, 'idle', null]
            ],
            result: denied };
        }

        if (st.style === 'self') {
          return {
            nodes: [caller, svcProxy,
              { label: 'outer()', sub: 'no annotation' },
              { label: 'No proxy here', sub: 'this is the raw object', skip: true },
              { label: 'this.inner()', sub: '@PreAuthorize, never read' }],
            steps: [
              [0, 'busy', 'Controller calls service.outer(request) on the proxy'],
              [1, 'busy', st.noSec ? 'No security interceptor on the proxy at all' : 'The interceptor looks at outer(): no annotation, nothing to check'],
              [2, 'busy', 'outer() calls this.inner(request)'],
              [3, 'idle', 'Plain Java call: the proxy and its interceptor never see it'],
              [4, 'bad', 'inner() runs unchecked: Team A deploys Team B\'s application']
            ],
            result: Object.assign(allowed('skipped'), {
              verdict: ['bad', 'Allowed. The annotation is right there on inner(), but the call never passed a proxy. For @Transactional that loses a row; for @PreAuthorize it is a security hole.'] })
          };
        }

        const collabProxy = st.noSec
          ? { label: 'Collaborator', sub: 'no security interceptor registered' }
          : { label: 'Collaborator proxy', sub: 'AuthorizationManagerBeforeMethodInterceptor' };
        const nodes = [caller, svcProxy,
          { label: 'outer()', sub: 'no annotation' }, collabProxy,
          { label: 'collaborator.inner()', sub: '@PreAuthorize' }];
        const head = [
          [0, 'busy', 'Controller calls service.outer(request) on the proxy'],
          [1, 'busy', 'outer() has no annotation: nothing to check'],
          [2, 'busy', 'outer() calls collaborator.inner(request), an injected bean']
        ];
        if (st.noSec) {
          return { nodes,
            steps: head.concat([
              [3, 'idle', 'No @EnableMethodSecurity: nothing reads @PreAuthorize'],
              [4, 'bad', 'inner() runs: Team A deploys Team B\'s application']
            ]),
            result: Object.assign(allowed('not registered'), {
              verdict: ['bad', 'Allowed. The collaborator fixed the call path, but without @EnableMethodSecurity there is no interceptor to put in it.'] }) };
        }
        return { nodes,
          steps: head.concat([
            [3, 'busy', 'The collaborator\'s proxy evaluates hasPermission: Team A may not deploy Team B\'s application'],
            [3, 'ok', 'AccessDeniedException: inner() never runs'],
            [4, 'idle', null]
          ]),
          result: denied };
      }

      const plan = () => (st.ann === 'tx' ? planTx() : planPre());

      function codeFor() {
        if (st.ann === 'tx') {
          if (st.style === 'external') {
            return '// Any other bean is given AuditEventRecorder\'s proxy, not the object\n' +
              'auditEventRecorder.record(event);       // through the proxy: REQUIRES_NEW applies\n\n' +
              '// AuditEventRecorder (control-api), a separate @Service\n' +
              '@Transactional(propagation = Propagation.REQUIRES_NEW)\n' +
              'public void record(AuditEvent event) {\n' +
              '    auditEventRepository.save(event);\n' +
              '}';
          }
          if (st.style === 'self') {
            return '// The self-invocation pattern, simplified so the sibling writes the row itself\n' +
              '@Transactional\n' +
              'public Deployment outer(...) {\n' +
              '    deploymentRepository.save(deployment);\n' +
              '    this.recordAudit(actor, deployment);   // plain Java call: the proxy never sees it\n' +
              '    throw new IllegalStateException("simulated failure");\n' +
              '}\n\n' +
              '@Transactional(propagation = Propagation.REQUIRES_NEW)   // never read on this path\n' +
              'public void recordAudit(String actor, Deployment deployment) {\n' +
              '    auditEventRepository.save(new AuditEvent(actor, "DEPLOYMENT_CREATED", ...));\n' +
              '}';
          }
          return '// DeploymentService.create() (control-api)\n' +
            '@Transactional\n' +
            'public Deployment create(Application application, Release release, Environment environment, String actor) {\n' +
            '    Deployment deployment = new Deployment(application, release, environment);\n' +
            '    deploymentRepository.save(deployment);\n' +
            '    auditEventRecorder.record(new AuditEvent(actor, "DEPLOYMENT_CREATED", "deployment", deployment.getId(), null));\n' +
            '    throw new IllegalStateException("simulated failure to prove the audit row DOES survive this rollback");\n' +
            '}\n\n' +
            '// AuditEventRecorder, a separate @Service\n' +
            '@Transactional(propagation = Propagation.REQUIRES_NEW)\n' +
            'public void record(AuditEvent event) {\n' +
            '    auditEventRepository.save(event);\n' +
            '}';
        }
        const cfg = '// S4 sketch, not built yet\n' +
          '@Configuration\n' +
          (st.noSec ? '// @EnableMethodSecurity      forgotten: @PreAuthorize is now a comment\n' : '@EnableMethodSecurity\n') +
          'class MethodSecurityConfig { }\n\n';
        if (st.style === 'external') {
          return cfg + '// DeploymentController is given the service\'s proxy\n' +
            'service.inner(request);                 // through the proxy: checked\n\n' +
            PRE + '\n' +
            'public DeploymentAccepted inner(CreateDeploymentRequest request) { ... }';
        }
        if (st.style === 'self') {
          return cfg + 'public DeploymentAccepted outer(CreateDeploymentRequest request) {\n' +
            '    return this.inner(request);         // plain Java call: no proxy, no check\n' +
            '}\n\n' +
            PRE + '\n' +
            'public DeploymentAccepted inner(CreateDeploymentRequest request) { ... }';
        }
        return cfg + 'public DeploymentAccepted outer(CreateDeploymentRequest request) {\n' +
          '    return collaborator.inner(request); // another bean: through its proxy, checked\n' +
          '}\n\n' +
          '// in the collaborator bean\n' +
          PRE + '\n' +
          'public DeploymentAccepted inner(CreateDeploymentRequest request) { ... }';
      }

      let nodeEls = [];
      function drawPath(p) {
        AF.clear(pathRow);
        nodeEls = p.nodes.map(n => (n.skip ? AF.tone(ui.node(n.label, n.sub), 'idle') : ui.node(n.label, n.sub)));
        nodeEls.forEach((n, i) => { if (i) pathRow.append(arrow()); pathRow.append(n); });
      }

      function reset() {
        guard.cancel();
        const p = plan();
        drawPath(p);
        if (st.ann === 'tx') {
          scenario.textContent = 'Scenario: a @Transactional method saves a deployment, records an audit row that asks for REQUIRES_NEW, then fails. The deployment should roll back; the audit row should survive.' +
            (st.noSec ? ' Forget @EnableMethodSecurity changes nothing here: Spring Boot turns on transaction management by itself.' : '');
          relabel(r1, 'Interceptor on the audit call');
          relabel(r2, 'Deployment row');
          relabel(r3, 'Audit row');
        } else {
          scenario.textContent = 'Scenario (S4 sketch, not built): Alice, a DEPLOYER on Team A, asks to deploy an application owned by Team B. The permission check should refuse.';
          relabel(r1, 'Interceptor on inner()');
          relabel(r2, 'Access check');
          relabel(r3, 'Outcome');
        }
        [r1, r2, r3].forEach(r => r.set('—'));
        verdict.clear();
        log.clear();
        setCode(code, codeFor());
      }

      async function play(live) {
        const p = plan();
        drawPath(p);
        [r1, r2, r3].forEach(r => r.set('—'));
        verdict.clear();
        log.clear();
        for (const [i, tone, text] of p.steps) {
          AF.tone(nodeEls[i], tone);
          if (text) log.add(text, tone === 'idle' ? 'warn' : tone);
          await wait(ctx, 650);
          if (!ctx.alive || !live()) return;
        }
        nodeEls.forEach(n => { if (n.classList.contains('is-busy')) AF.tone(n, 'ok'); });
        r1.set(p.result.r1[0], p.result.r1[1]);
        r2.set(p.result.r2[0], p.result.r2[1]);
        r3.set(p.result.r3[0], p.result.r3[1]);
        verdict.set(p.result.verdict[0], p.result.verdict[1]);
      }

      reset();
    }
  });

  // =====================================================================
  // 3. sp-filters: CorrelationIdFilter, the filter chain, MDC on pooled threads
  // =====================================================================

  const CORRELATION_VALID = /^[A-Za-z0-9._-]{1,64}$/;   // CorrelationIdFilter.VALID

  AF.register({
    id: 'sp-filters',
    group: 'spring',
    order: 3,
    title: 'Servlet filters and the correlation id',
    question: 'How does every log line and every error for one request carry the same id, without passing it around by hand?',
    status: 'built',
    slice: 'S3.1, S5',
    where: [
      'CorrelationIdFilter (control-api web package)',
      'ProblemShapeTest: invalidCorrelationId_isReplaced, mdcIsClearedAfterRequest',
      'TemporaryOpenSecurityConfig, TemporaryOpenChainTest',
      '04-NODE-AGENT.md: MDC across Kafka, the MDC leak (S5, planned)'
    ],
    idea: [
      'A servlet filter wraps every request before Spring MVC sees it. Filters form a chain in a fixed order; each one can read the request, call the rest of the chain, and run code after it returns. CorrelationIdFilter runs first (HIGHEST_PRECEDENCE). It accepts X-Correlation-Id only if it is 1 to 64 letters, digits, dots, underscores or dashes; anything else is replaced by a fresh UUID.',
      'It puts the id in the MDC, a per-thread map the logger adds to every line, keeps it for the error handler, and writes it on the response before the chain runs, so even refused requests carry it. Spring Security\'s chain comes next: TemporaryOpenSecurityConfig permits /api/** until S4 brings the JWT filter.',
      'Servlet and Kafka threads are pooled and reused. The filter removes its MDC key in finally; skip that and the next work on the same thread starts with a stale id. S5 plans the same discipline for Kafka in node-agent: header in, MDC, headers out, cleared after every record.'
    ],
    terms: [
      ['MDC', 'Mapped Diagnostic Context: a per-thread key-value map the logger adds to every line written on that thread.'],
      ['OncePerRequestFilter', 'Spring\'s filter base class that runs once per request, even when the request is forwarded internally.'],
      ['Thread pool', 'A fixed set of threads reused for many requests or records, so per-thread state outlives the work that set it.']
    ],
    tryIt: [
      'In Filter chain, pick an X-Correlation-Id and a Path, press Send request, and compare the request and response.',
      'Send bad id with spaces: it is replaced. Send /actuator/env: security refuses it, yet the id is on the response.',
      'Switch Show to Pooled threads and press Run tasks: every line carries its own task\'s id, or none.',
      'Switch on Skip MDC.remove() in finally and run again: tasks without a header log another task\'s id.'
    ],
    breakIt: 'Skip the clean-up in finally and the id stays on the pooled thread. The next task on that thread that does not set its own id, such as a Kafka record without the header, logs the previous task\'s correlation id, and a search for that id now returns work it never did.',
    say: 'A highest-precedence filter puts a validated correlation id into the MDC and onto the response, and removes it in finally, because pooled threads otherwise leak one request\'s id into the next.',
    quiz: {
      q: 'Why does CorrelationIdFilter write the X-Correlation-Id response header before calling chain.doFilter rather than after it?',
      options: [
        'So the header is there even when a later filter or handler refuses or fails the request',
        'Because a servlet ignores every header set after doFilter, in all cases',
        'So Spring Security can read the id from the response',
        'Because MDC.put only works before the chain runs'
      ],
      answer: 0,
      why: 'Once a later filter or handler has written and committed the response, it is too late to add headers. Setting it first means a refusal from security, a 500 from a bug, and every ProblemDetail all carry an id the caller can quote.'
    },
    mount(el, ctx) {
      // ---------- view switch ----------
      const chainBox = h('div');
      const poolBox = h('div', { hidden: true });
      const viewC = ui.choice('Show', [
        { value: 'chain', label: 'Filter chain' },
        { value: 'pool', label: 'Pooled threads' }
      ], 'chain', v => { chainBox.hidden = v !== 'chain'; poolBox.hidden = v !== 'pool'; });
      el.append(h('div', { class: 'sim-controls' }, viewC.el), chainBox, poolBox);

      // ---------- view 1: the filter chain ----------
      const HEADERS = { valid: 'abc-123', none: null, spaces: 'bad id with spaces', long: 'a'.repeat(65) };
      const hdrC = ui.choice('X-Correlation-Id', [
        { value: 'valid', label: 'abc-123' },
        { value: 'none', label: 'not sent' },
        { value: 'spaces', label: 'bad id with spaces' },
        { value: 'long', label: '65 characters' }
      ], 'valid', () => resetChain());
      const pathC = ui.choice('Path', [
        { value: 'api', label: '/api/v1/deployments/{id}' },
        { value: 'env', label: '/actuator/env' },
        { value: 'bad', label: '/api/%zz' }
      ], 'api', () => resetChain());
      const sendB = ui.button('Send request', () => chainGuard.start(sendRequest), { variant: 'primary' });
      const chainGuard = runGuard(b => { sendB.disabled = b; });

      const nTomcat = ui.node('Tomcat', 'parses the request line');
      const nCorr = ui.node('CorrelationIdFilter', 'HIGHEST_PRECEDENCE');
      const nSec = ui.node('Security filter chain', 'TemporaryOpenSecurityConfig');
      const nDisp = ui.node('DispatcherServlet', 'Spring MVC');
      const nCtrl = ui.node('DeploymentController', 'get(id)');
      const strip = [nTomcat, nCorr, nSec, nDisp, nCtrl];
      const reqCode = ui.code('', 'Request');
      const resCode = ui.code('', 'Response');
      const rSource = ui.readout('Id on the response');
      const rDuring = ui.readout('MDC during the request');
      const rAfter = ui.readout('MDC after the request');
      const chainVerdict = ui.verdict();
      const chainLog = ui.log({ label: 'Application log', max: 30 });

      chainBox.append(h('div', { class: 'stack' },
        h('div', { class: 'sim-controls' }, hdrC.el, pathC.el, sendB),
        h('div', { class: 'sim-stage' },
          h('div', { class: 'stack' },
            h('div', { class: 'row' }, strip.map((n, i) => [i ? arrow() : null, n])),
            h('div', { class: 'sim-cols' }, ui.panel('Request in', reqCode), ui.panel('Response out (trimmed)', resCode)))),
        h('div', { class: 'readouts' }, rSource.el, rDuring.el, rAfter.el),
        chainVerdict.el,
        ui.panel('Log lines, with the real pattern [%X{correlationId:-}]', chainLog.el)));

      function resetChain() {
        chainGuard.cancel();
        strip.forEach(n => AF.tone(n, null));
        const hv = HEADERS[hdrC.get()];
        setCode(reqCode, requestText(hv, targetFor(pathC.get(), '{id}')));
        setCode(resCode, 'Press Send request.');
        [rSource, rDuring, rAfter].forEach(r => r.set('—'));
        chainVerdict.clear();
      }

      function targetFor(path, id) {
        if (path === 'api') return '/api/v1/deployments/' + id;
        if (path === 'env') return '/actuator/env';
        return '/api/%zz';
      }

      function requestText(hv, target) {
        return 'GET ' + target + ' HTTP/1.1\nHost: localhost:8081' + (hv === null ? '' : '\nX-Correlation-Id: ' + hv);
      }

      async function sendRequest(live) {
        const hv = HEADERS[hdrC.get()];
        const path = pathC.get();
        const target = targetFor(path, entityId());
        strip.forEach(n => AF.tone(n, null));
        [rSource, rDuring, rAfter].forEach(r => r.set('—'));
        chainVerdict.clear();
        setCode(reqCode, requestText(hv, target));
        setCode(resCode, 'Waiting for the response.');

        AF.tone(nTomcat, 'busy');
        await wait(ctx, 450);
        if (!ctx.alive || !live()) return;
        if (path === 'bad') {
          AF.tone(nTomcat, 'bad');
          [nCorr, nSec, nDisp, nCtrl].forEach(n => AF.tone(n, 'idle'));
          setCode(resCode, 'HTTP/1.1 400\nContent-Type: text/html;charset=utf-8\n\n(no X-Correlation-Id: no filter ever ran)');
          rSource.set('none', 'bad');
          rDuring.set('never set', 'warn');
          rAfter.set('empty', 'ok');
          chainLog.add('[] Tomcat rejected ' + target + ': illegal percent-encoding', 'warn');
          chainVerdict.set('warn', 'Tomcat rejected the URL before any filter ran, so there is no correlation id and no ProblemDetail, just an HTML 400. S3.1 recorded this gap and left it open.');
          return;
        }
        AF.tone(nTomcat, 'ok');

        const accepted = hv !== null && CORRELATION_VALID.test(hv);
        const id = accepted ? hv : corrId();
        AF.tone(nCorr, 'busy');
        rDuring.set('set', 'busy');
        rSource.set(accepted ? 'echoed' : 'generated', accepted ? 'ok' : 'warn');
        chainLog.add('[' + id + '] CorrelationIdFilter: ' + (accepted ? 'header accepted' : hv === null ? 'no header, generated a UUID' : 'header rejected, generated a UUID') + '; response header written', 'busy');
        await wait(ctx, 450);
        if (!ctx.alive || !live()) return;
        AF.tone(nCorr, 'ok');

        AF.tone(nSec, 'busy');
        await wait(ctx, 450);
        if (!ctx.alive || !live()) return;
        if (path === 'env') {
          AF.tone(nSec, 'bad');
          [nDisp, nCtrl].forEach(n => AF.tone(n, 'idle'));
          chainLog.add('[' + id + '] security: /actuator/env matches anyRequest().denyAll(), refused', 'bad');
          chainLog.add('[] request finished; finally removed correlationId from the MDC', 'muted');
          setCode(resCode, 'HTTP/1.1 403\nX-Correlation-Id: ' + id + '\n\n(empty body: security answered before Spring MVC)');
          rAfter.set('empty', 'ok');
          chainVerdict.set('warn', 'Refused by anyRequest().denyAll() (TemporaryOpenChainTest asserts a status of 400 or more). The id is on the response because the filter runs first, but the body is not a ProblemDetail: that gap waits for S4.');
          return;
        }
        AF.tone(nSec, 'ok');
        chainLog.add('[' + id + '] security: /api/** is permitAll() until S4', 'busy');

        AF.tone(nDisp, 'busy');
        await wait(ctx, 350);
        if (!ctx.alive || !live()) return;
        AF.tone(nDisp, 'ok');
        AF.tone(nCtrl, 'busy');
        chainLog.add('[' + id + '] DeploymentController.get handled ' + target, 'busy');
        await wait(ctx, 450);
        if (!ctx.alive || !live()) return;
        AF.tone(nCtrl, 'ok');
        chainLog.add('[] request finished; finally removed correlationId from the MDC', 'muted');
        setCode(resCode, 'HTTP/1.1 200\nContent-Type: application/json\nX-Correlation-Id: ' + id);
        rAfter.set('empty', 'ok');
        if (accepted) {
          chainVerdict.set('ok', 'The id you sent is echoed on the response and on every log line in between. After the request the MDC is empty again.');
        } else if (hv === null) {
          chainVerdict.set('ok', 'No header, so the filter generated a UUID. The caller can quote it from the response header.');
        } else {
          chainVerdict.set('ok', 'Rejected: the header did not match [A-Za-z0-9._-]{1,64}, so a fresh UUID was used. Copying raw header text into logs would let a caller forge log lines.');
        }
      }

      // ---------- view 2: pooled threads ----------
      // Model of the S5 plan: a record with a correlation header puts it in the MDC;
      // a record without one puts nothing, so it logs whatever its thread still holds.
      const TASKS = [
        { id: 'T1', corr: 'req-a1', worker: 0 },
        { id: 'T2', corr: 'req-b2', worker: 1 },
        { id: 'T3', corr: null, worker: 0 },
        { id: 'T4', corr: 'req-d4', worker: 1 },
        { id: 'T5', corr: null, worker: 1 },
        { id: 'T6', corr: 'req-f6', worker: 0 }
      ];
      const skipT = ui.toggle('Skip MDC.remove() in finally', false, () => resetPool(), { tone: 'danger' });
      const runB = ui.button('Run tasks', () => poolGuard.start(runPool), { variant: 'primary' });
      const resetB = ui.button('Reset', () => resetPool());
      const poolGuard = runGuard(b => { runB.disabled = b; });

      const queueLane = ui.lane('Queue', '6 records');
      const workers = [ui.lane('worker-1', 'MDC: empty'), ui.lane('worker-2', 'MDC: empty')];
      const rLines = ui.readout('Log lines');
      const rWrong = ui.readout('Lines under another task\'s id');
      const rLeft = ui.readout('MDC left on threads');
      const poolVerdict = ui.verdict();
      const poolLog = ui.log({ label: 'Worker log', max: 40 });

      poolBox.append(h('div', { class: 'stack' },
        h('div', { class: 'sim-controls' }, skipT.el, runB, resetB),
        h('div', { class: 'sim-stage' },
          h('div', { class: 'stack' },
            h('div', { class: 'sim-cols' }, queueLane.el, workers[0].el, workers[1].el),
            note('Model of the S5 plan for node-agent: a record with a correlation header puts it in the MDC; a record without one puts nothing, so it logs whatever its thread still holds. control-api\'s HTTP filter always sets an id, which is why the leak shows up on work that does not.'))),
        h('div', { class: 'readouts' }, rLines.el, rWrong.el, rLeft.el),
        poolVerdict.el,
        poolLog.el));

      const taskToken = t => ui.token(t.id + (t.corr ? ' · ' + t.corr : ' · no header'), null);

      function resetPool() {
        poolGuard.cancel();
        clearPool();
      }

      function clearPool() {
        AF.clear(queueLane.body);
        TASKS.forEach(t => queueLane.body.append(taskToken(t)));
        workers.forEach(w => { AF.clear(w.body); setAside(w, 'MDC: empty'); });
        rLines.set(0);
        rWrong.set(0);
        rLeft.set('—');
        poolVerdict.clear();
        poolLog.clear();
      }

      async function runPool(live) {
        clearPool();
        const skip = skipT.get();
        const mdc = [null, null];
        let lines = 0;
        let wrong = 0;
        const leaks = [];
        const queued = Array.from(queueLane.body.children);
        for (let k = 0; k < TASKS.length; k++) {
          const t = TASKS[k];
          const w = t.worker;
          const lane = workers[w];
          const name = 'worker-' + (w + 1);
          queued[k].remove();
          const chip = AF.tone(taskToken(t), 'busy');
          lane.body.append(chip);
          if (t.corr) mdc[w] = t.corr;
          setAside(lane, 'MDC: ' + (mdc[w] || 'empty'));
          const stale = !t.corr && mdc[w] !== null;
          const tone = stale ? 'bad' : (t.corr ? 'ok' : 'muted');
          poolLog.add('[' + (mdc[w] || '') + '] ' + name + ' ' + t.id + ' record received', tone);
          lines++;
          if (stale) wrong++;
          rLines.set(lines);
          rWrong.set(wrong, wrong ? 'bad' : null);
          await wait(ctx, 380);
          if (!ctx.alive || !live()) return;
          poolLog.add('[' + (mdc[w] || '') + '] ' + name + ' ' + t.id + ' done', tone);
          lines++;
          if (stale) { wrong++; leaks.push(t.id + ' logged as ' + mdc[w]); }
          rLines.set(lines);
          rWrong.set(wrong, wrong ? 'bad' : null);
          AF.tone(chip, stale ? 'bad' : 'ok');
          if (stale) chip.textContent = t.id + ' · logged as ' + mdc[w];
          if (!skip) mdc[w] = null;
          setAside(lane, 'MDC: ' + (mdc[w] || 'empty'));
          await wait(ctx, 280);
          if (!ctx.alive || !live()) return;
        }
        const left = mdc.map((v, i) => (v ? 'worker-' + (i + 1) + ': ' + v : null)).filter(Boolean);
        rLeft.set(left.length ? left.join(', ') : 'none', left.length ? 'bad' : 'ok');
        if (skip) {
          poolVerdict.set('bad', leaks.join(' and ') + ': their lines point at requests they had nothing to do with. Searching the logs for those ids now returns work the requests never did.');
        } else {
          poolVerdict.set('ok', 'Every line carries its own task\'s id, or [] when the task had none. Nothing outlives a task on a pooled thread.');
        }
      }

      resetChain();
      resetPool();
    }
  });

  // =====================================================================
  // 4. sp-errors: ProblemDetail and the status matrix
  // =====================================================================

  const DEPLOY_BODY = id => '{"applicationId": "' + id.app + '", "releaseId": "' + id.rel + '", "environment": "staging"}';

  // Titles, details and slugs are the ones ApiExceptionHandler produces (including S3.6's 429).
  const PROBLEMS = [
    { key: 'malformed', label: 'Malformed JSON', status: 400, slug: 'malformed-request', title: 'Bad Request', mvc: true,
      req: id => 'POST /api/v1/deployments\nContent-Type: application/json\n\n{"applicationId": "' + id.app + '", "releaseId": ',
      path: '/api/v1/deployments', detail: 'Failed to read request',
      why: 'The body is not valid JSON, so the request cannot be understood: 400. Spring MVC throws HttpMessageNotReadableException, and the inherited handler gives it the same shape.' },
    { key: 'missing', label: 'Missing field', status: 400, slug: 'validation-failed', title: 'Bad Request', mvc: true,
      req: id => 'POST /api/v1/deployments\nContent-Type: application/json\n\n{"applicationId": "' + id.app + '", "environment": "staging"}',
      path: '/api/v1/deployments', detail: 'Invalid request content.', errors: [['releaseId', 'must not be null']],
      why: 'The JSON parses but breaks its own schema: releaseId is @NotNull in CreateDeploymentRequest. That is 400 validation-failed, the only kind of error that carries an errors list.' },
    { key: 'badkey', label: 'Bad Idempotency-Key', status: 400, slug: 'validation-failed', title: 'Validation failed',
      req: id => 'POST /api/v1/deployments\nIdempotency-Key: my key\nContent-Type: application/json\n\n' + DEPLOY_BODY(id),
      path: '/api/v1/deployments', detail: 'One or more parameters are invalid.',
      errors: [['Idempotency-Key', 'Must be 1 to 255 printable ASCII characters, without spaces.']],
      why: 'A header that breaks its own format is bad input, not a domain decision: 400 validation-failed, with the header named as the field.' },
    { key: 'release', label: 'Unknown release id', status: 422, slug: 'unprocessable', title: 'Unprocessable request',
      req: id => 'POST /api/v1/deployments\nContent-Type: application/json\n\n' + DEPLOY_BODY(id) + '\n\n(no release with that id belongs to this application)',
      path: '/api/v1/deployments', detail: id => 'Release ' + id.rel + ' does not exist for application ' + id.app + '.',
      why: 'The body is well formed and valid, but the domain refuses it: 422, thrown as UnprocessableRequestException. Not 404, because the URL names nothing that is missing.' },
    { key: 'notfound', label: 'Unknown deployment id', status: 404, slug: 'not-found', title: 'Not found',
      req: id => 'GET /api/v1/deployments/' + id.dep,
      path: id => '/api/v1/deployments/' + id.dep, detail: id => 'Deployment ' + id.dep + ' not found',
      why: 'The URL names a resource that does not exist: 404. From S4, an object you may not see will also answer 404, so the API never confirms it exists.' },
    { key: 'active', label: 'Active deployment exists', status: 409, slug: 'conflict', title: 'Conflict',
      req: id => 'POST /api/v1/deployments\nContent-Type: application/json\n\n' + DEPLOY_BODY(id) + '\n\n(an active deployment already runs there)',
      path: '/api/v1/deployments', detail: 'An active deployment already exists for this application and environment.',
      why: 'The request is fine; the current state conflicts. The partial unique index uq_deployment_active_per_app_env rejects the insert, and only known constraint names map to 409 conflict.' },
    { key: 'illegal', label: 'Illegal transition', status: 409, slug: 'illegal-transition', title: 'Illegal state transition',
      req: id => 'POST /api/v1/deployments/' + id.dep + '/rollback\n\n(the deployment is PENDING)',
      path: id => '/api/v1/deployments/' + id.dep + '/rollback', detail: 'Illegal transition from PENDING to ROLLED_BACK',
      why: 'Rollback is legal only from HEALTHY or DEGRADED. The request is fine but the state machine refuses it: 409 illegal-transition.' },
    { key: 'race', label: 'Two rollbacks at once', status: 409, slug: 'concurrent-modification', title: 'Concurrent modification',
      req: id => 'POST /api/v1/deployments/' + id.dep + '/rollback\n\n(an identical request commits first)',
      path: id => '/api/v1/deployments/' + id.dep + '/rollback',
      detail: 'The resource was changed by another request. Re-read it and retry if still appropriate.',
      why: 'findLockedById bumps the version at commit, so the slower of two concurrent rollbacks fails with ObjectOptimisticLockingFailureException: 409 concurrent-modification. Appfleet fails fast and does not retry for you.' },
    { key: 'pending', label: 'Rollback already pending', status: 409, slug: 'conflict', title: 'Conflict',
      req: id => 'POST /api/v1/deployments/' + id.dep + '/rollback\n\n(a ROLLBACK task is still PENDING)',
      path: id => '/api/v1/deployments/' + id.dep + '/rollback', detail: 'A rollback is already pending for this deployment.',
      why: 'The first rollback already committed a PENDING task, so the second is a plain state conflict: 409 conflict, from RollbackAlreadyRequestedException.' },
    { key: 'inflight', label: 'Same key, still running', status: 409, slug: 'request-in-progress', title: 'Request in progress', retry: '1',
      req: id => 'POST /api/v1/deployments\nIdempotency-Key: k-42\nContent-Type: application/json\n\n' + DEPLOY_BODY(id) + '\n\n(the first request with k-42 has not finished)',
      path: '/api/v1/deployments', detail: 'A request with this Idempotency-Key is still being processed. Retry shortly to get its result.',
      why: 'Nothing is wrong with this request; it is early. The first request with the key has not finished: 409 request-in-progress, with Retry-After: 1.' },
    { key: 'reused', label: 'Same key, new body', status: 422, slug: 'idempotency-key-reused', title: 'Idempotency key reused',
      req: id => 'POST /api/v1/deployments\nIdempotency-Key: k-42\nContent-Type: application/json\n\n' + DEPLOY_BODY(id) + '\n\n(k-42 was used before with a different body)',
      path: '/api/v1/deployments',
      detail: 'This Idempotency-Key was already used with a different request body. Use a new key for a different request.',
      why: 'Reusing a key for a different body is a client mistake that waiting will not fix: 422 idempotency-key-reused, and no Retry-After.' },
    { key: 'redis', label: 'Redis down', status: 503, slug: 'service-unavailable', title: 'Service unavailable', retry: '5',
      req: id => 'POST /api/v1/deployments\nIdempotency-Key: k-43\nContent-Type: application/json\n\n' + DEPLOY_BODY(id) + '\n\n(Redis is unreachable)',
      path: '/api/v1/deployments', detail: 'A required backing service is unavailable. Retry later.',
      why: 'The request and the state are fine; the server cannot check the key without Redis. RedisConnectionFailureException becomes 503 service-unavailable, with Retry-After: 5.' },
    { key: 'rate', label: 'Rate limited', status: 429, slug: 'rate-limited', title: 'Too many requests', retry: '1',
      req: id => 'POST /api/v1/deployments\nContent-Type: application/json\n\n' + DEPLOY_BODY(id) + '\n\n(the team\'s token bucket is empty)',
      path: '/api/v1/deployments', detail: 'The rate limit for this team is exhausted. Retry after the time given in Retry-After.',
      why: 'Built in S3.6: an empty token bucket answers 429 rate-limited, with Retry-After in whole seconds, rounded up, at least 1.' },
    { key: 'bug', label: 'Unknown constraint', status: 500, slug: 'internal-error', title: 'Internal server error',
      req: id => 'POST /api/v1/deployments\nContent-Type: application/json\n\n' + DEPLOY_BODY(id) + '\n\n(a NOT NULL constraint fails: a bug, not a conflict)',
      path: '/api/v1/deployments', detail: 'An unexpected error occurred.',
      why: 'Only whitelisted unique constraints are 409. Anything else is a server bug: 500 internal-error with a fixed detail, so SQL and table names never leak. The stack trace is logged under the correlation id.' }
  ];

  AF.register({
    id: 'sp-errors',
    group: 'spring',
    order: 4,
    title: 'One error shape: ProblemDetail',
    question: 'How can a client tell exactly what went wrong from any failed request, in one predictable format?',
    status: 'built',
    slice: 'S3.1',
    where: [
      'ApiExceptionHandler extends ResponseEntityExceptionHandler',
      'ProblemShapeTest (32 tests)',
      'control-api-s3-rest.md §3.2 status matrix',
      'control-api-s3-6-rate-limiting.md (the 429 and its Retry-After)',
      'ProblemKind (io.appfleet.control.web.openapi): the one list of slugs, status and titles that the handler and the OpenAPI document both use',
      'OpenApiContractTest, control-api-s3-7-openapi.md'
    ],
    idea: [
      'RFC 7807 defines one JSON body for errors: type, title, status, detail and instance. Appfleet adds correlationId, and an errors list of field and message only on validation failures. The type, urn:appfleet:problem:<slug>, is the stable contract clients switch on; detail is free text and may change.',
      'ApiExceptionHandler extends ResponseEntityExceptionHandler, so Spring MVC\'s own exceptions (malformed JSON, 405, 415, unknown route) come out in the same shape, stamped by one override of handleExceptionInternal. Domain exceptions get their own handlers. Anything unexpected becomes a 500 with a fixed sentence, so internal messages never leak.',
      'The rules are short. 400: the request cannot be understood or breaks its own schema. 422: it is fine on its face, but the domain refuses it. 409: the request is fine, the current state conflicts, and several causes share it, told apart by type. 404: the id does not exist, and from S4 also when you may not see it.'
    ],
    terms: [
      ['ProblemDetail', 'Spring\'s class for an RFC 7807 error body, served as application/problem+json.'],
      ['type', 'A URI naming the kind of problem, here urn:appfleet:problem:<slug>. Clients switch on it, not on detail.'],
      ['Retry-After', 'A response header giving seconds to wait before retrying. Appfleet sends it with request-in-progress, service-unavailable and, once built, rate-limited.']
    ],
    tryIt: [
      'Pick a Scenario, press the status you expect under Your guess, then read the full response.',
      'Compare Missing field with Unknown release id: both are bad input to a person, but only one breaks the schema.',
      'Try Two rollbacks at once, Illegal transition and Active deployment exists: all 409, told apart by type.',
      'Switch on Check body before calling super and look at Malformed JSON again.'
    ],
    breakIt: 'Check body instanceof ProblemDetail before calling super, as the first S3.1 draft did: body is still null at that point, so Spring MVC\'s own errors go out with no type and no correlationId, while domain errors still look right. Only a shape test per type catches it.',
    say: 'Every failure is an RFC 7807 ProblemDetail with a stable type URI and the correlation id; 400 means malformed, 422 means the domain refuses a valid request, and 409 means the state conflicts, with type naming which conflict.',
    quiz: {
      q: 'A well-formed POST /api/v1/deployments names a releaseId that does not belong to the given application. Which response fits Appfleet\'s rules?',
      options: ['422 unprocessable', '400 validation-failed', '404 not-found', '409 conflict'],
      answer: 0,
      why: 'The body parses and satisfies its own schema, so it is not a 400. The URL names nothing missing, so not 404, and no current state conflicts with it. The domain refuses it: 422, which requestDeployment throws as UnprocessableRequestException.'
    },
    mount(el, ctx) {
      const ids = { app: entityId(), rel: entityId(), dep: entityId() };
      const st = { key: 'malformed', guessMode: true, broken: false, revealed: false, guess: null, right: 0, tried: 0 };
      const val = x => (typeof x === 'function' ? x(ids) : x);
      const byKey = k => PROBLEMS.find(p => p.key === k);

      const scenarioC = ui.choice('Scenario', PROBLEMS.map(p => ({ value: p.key, label: p.label })), st.key, v => {
        st.key = v;
        st.revealed = !st.guessMode;
        st.guess = null;
        render();
      });
      const guessT = ui.toggle('Guess first', st.guessMode, v => {
        st.guessMode = v;
        st.revealed = !v;
        st.guess = null;
        render();
      });
      const brokenT = ui.toggle('Check body before calling super', st.broken, v => { st.broken = v; render(); }, { tone: 'danger' });
      const CODES = [400, 404, 409, 422, 429, 500, 503];
      const guessBtns = CODES.map(c => ui.button(String(c), () => guess(c), { small: true, ariaLabel: 'Guess ' + c }));
      const guessRow = h('div', { class: 'row', role: 'group', 'aria-label': 'Your guess' },
        h('span', { class: 'small muted' }, 'Your guess'), guessBtns);

      const reqCode = ui.code('', 'Request');
      const resCode = ui.code('', 'Response');
      const rStatus = ui.readout('Status');
      const rSlug = ui.readout('type slug');
      const rScore = ui.readout('Score', '0 of 0');
      const verdict = ui.verdict();

      el.append(
        h('div', { class: 'sim-controls' }, scenarioC.el),
        h('div', { class: 'sim-controls' }, guessT.el, brokenT.el),
        h('div', { class: 'sim-stage' },
          h('div', { class: 'stack' },
            guessRow,
            h('div', { class: 'sim-cols' }, ui.panel('Request', reqCode), ui.panel('Response', resCode)))),
        h('div', { class: 'readouts' }, rStatus.el, rSlug.el, rScore.el),
        verdict.el
      );

      function responseText(p) {
        const corr = corrId();
        const stripped = st.broken && p.mvc;
        const fields = [];
        const f = (k, v) => fields.push('  ' + JSON.stringify(k) + ': ' + JSON.stringify(v));
        if (!stripped) f('type', 'urn:appfleet:problem:' + p.slug);
        f('title', p.title);
        f('status', p.status);
        f('detail', val(p.detail));
        f('instance', val(p.path));
        if (!stripped) f('correlationId', corr);
        if (p.errors) {
          fields.push('  "errors": [\n' + p.errors.map(e =>
            '    { "field": ' + JSON.stringify(e[0]) + ', "message": ' + JSON.stringify(e[1]) + ' }').join(',\n') + '\n  ]');
        }
        const head = ['HTTP/1.1 ' + p.status, 'Content-Type: application/problem+json', 'X-Correlation-Id: ' + corr];
        if (p.retry) head.push('Retry-After: ' + p.retry);
        return head.join('\n') + '\n\n{\n' + fields.join(',\n') + '\n}';
      }

      function guess(code) {
        if (!st.guessMode || st.revealed) return;
        const p = byKey(st.key);
        st.guess = code;
        st.revealed = true;
        st.tried++;
        if (code === p.status) st.right++;
        render();
      }

      function render() {
        const p = byKey(st.key);
        setCode(reqCode, val(p.req));
        const canGuess = st.guessMode && !st.revealed;
        guessBtns.forEach(b => { b.disabled = !canGuess; });
        rScore.set(st.right + ' of ' + st.tried, null);
        if (!st.revealed) {
          setCode(resCode, 'Pick the status you expect under Your guess to see the response.');
          rStatus.set('?');
          rSlug.set('?');
          verdict.clear();
          return;
        }
        setCode(resCode, responseText(p));
        rStatus.set(p.status, null);
        rSlug.set(p.slug, null);
        let text = p.why;
        if (st.broken) {
          text += p.mvc
            ? ' With the check before super, this Spring MVC error has no type and no correlationId; the domain errors still look right, which is how the bug hid.'
            : ' This handler builds its own body, so the broken check does not show here. Try Malformed JSON or Missing field.';
        }
        if (st.guess === null) {
          verdict.set(st.broken && p.mvc ? 'bad' : null, text);
        } else if (st.guess === p.status) {
          verdict.set(st.broken && p.mvc ? 'warn' : 'ok', 'Right, ' + p.status + '. ' + text);
        } else {
          verdict.set('bad', 'Not ' + st.guess + ': it is ' + p.status + '. ' + text);
        }
      }

      render();
    }
  });

  // =====================================================================
  // 5. sp-lazy: lazy loading, open-in-view, connection hold
  // =====================================================================

  AF.register({
    id: 'sp-lazy',
    group: 'spring',
    order: 5,
    title: 'Lazy loading and open-in-view',
    question: 'Why does reading a lazy collection after the service returns either crash or quietly run extra queries?',
    status: 'built',
    slice: 'S2',
    where: [
      'DeploymentService.listAllNaive(), listSummaries()',
      'DeploymentLazyInitializationTest (4 tests)',
      'control-api application.yml: spring.jpa.open-in-view: false',
      'control-api-s2-lazy-initialization.md'
    ],
    idea: [
      'Deployment.tasks is lazy: Hibernate hands back a placeholder and loads it only when touched, through the persistence context that loaded the entity. That context closes when the @Transactional service method returns. Touch the placeholder afterwards, in a controller or while Jackson writes JSON, and Hibernate throws LazyInitializationException.',
      'Spring Boot\'s default, open-in-view, hides this by keeping the persistence context open for the whole web request. The lazy load then runs during serialisation, one query per row, outside any transaction and out of sight of service tests, and the request keeps its database connection until the response is written.',
      'Appfleet sets spring.jpa.open-in-view: false and builds the answer inside the transaction instead. listSummaries() loads tasks with an entity graph and maps each deployment to a DeploymentSummary record, in one statement. Nothing lazy leaves the service, so the controller cannot trigger a query.'
    ],
    terms: [
      ['Persistence context', 'Hibernate\'s session: the set of loaded entities, and the only place a lazy placeholder can load from.'],
      ['open-in-view', 'spring.jpa.open-in-view, on by default: an EntityManager opened per web request and closed after the response.'],
      ['Entity graph', '@EntityGraph(attributePaths = "tasks") on a repository method: fetch tasks in the same query.']
    ],
    tryIt: [
      'Keep List<Deployment> with open-in-view off and press Send request: JSON writing fails with LazyInitializationException.',
      'Switch on open-in-view: true (Boot default) and send again: it works, but count the queries outside a transaction.',
      'Choose List<DeploymentSummary>: one statement, and the connection returns before JSON writing starts.',
      'Raise Slow JSON writing with open-in-view on and watch Connection held grow with it.'
    ],
    breakIt: 'Return Deployment entities from a @Transactional(readOnly = true) method and let the web layer touch getTasks(). With open-in-view off it throws LazyInitializationException; with it on, the bug turns into one hidden query per row and a connection held through serialisation.',
    say: 'With open-in-view off, entities never leave the transaction: the service maps to a record inside it, with an entity graph to avoid N+1, so the web layer cannot trigger lazy loads or hold a connection while JSON is written.',
    quiz: {
      q: 'open-in-view is on, and a controller returns 50 Deployment entities whose tasks are lazy. What happens when Jackson writes the response?',
      options: [
        'Each deployment\'s tasks load during serialisation, one query per row, while the request keeps its connection',
        'LazyInitializationException, because the service\'s transaction has already committed',
        'Nothing loads: Jackson skips collections that are not initialised yet',
        'All tasks load in one batched query, because the persistence context is still open'
      ],
      answer: 0,
      why: 'Open-in-view keeps the persistence context alive, so each placeholder can still load, each with its own query outside any transaction. The exception only appears with open-in-view off, and batching needs @BatchSize or an entity graph, which open-in-view does not add.'
    },
    mount(el, ctx) {
      const st = { ret: 'entity', oiv: false, n: 3, w: 2 };
      const MAX_TICKS = 13;   // 5 fixed ticks + up to 8 for JSON writing

      const retC = ui.choice('Service returns', [
        { value: 'entity', label: 'List<Deployment>' },
        { value: 'record', label: 'List<DeploymentSummary>' }
      ], st.ret, v => { st.ret = v; reset(); });
      const oivT = ui.toggle('open-in-view: true (Boot default)', st.oiv, v => { st.oiv = v; reset(); }, { tone: 'danger' });
      const nS = ui.slider({ label: 'Deployments', min: 1, max: 50, value: st.n, onInput: v => { st.n = v; reset(); } });
      const wS = ui.slider({ label: 'Slow JSON writing', min: 1, max: 8, value: st.w, format: v => v + (v === 1 ? ' tick' : ' ticks'), onInput: v => { st.w = v; reset(); } });
      const sendB = ui.button('Send request', () => guard.start(play), { variant: 'primary' });
      const guard = runGuard(b => { sendB.disabled = b; });

      const rowsBox = h('div', { class: 'stack' });
      const rStmts = ui.readout('Statements');
      const rOutside = ui.readout('Outside a transaction');
      const rOutcome = ui.readout('Outcome');
      const barReq = ui.bar({ label: 'Request', max: MAX_TICKS, format: v => v + ' ticks' });
      const barConn = ui.bar({ label: 'Connection held', max: MAX_TICKS, format: v => v + ' ticks' });
      const verdict = ui.verdict();
      const log = ui.log({ label: 'SQL log', max: 60 });

      el.append(
        h('div', { class: 'sim-controls' }, retC.el, oivT.el, sendB),
        h('div', { class: 'sim-controls' }, nS.el, wS.el),
        h('div', { class: 'sim-stage' },
          h('div', { class: 'stack' },
            rowsBox,
            note('control-api has no list endpoint; DeploymentLazyInitializationTest calls the service directly. This timeline shows what the same call does inside a web request. Ticks are model time, not measurements.'))),
        h('div', { class: 'readouts' }, rStmts.el, rOutside.el, rOutcome.el),
        h('div', { class: 'stack' }, barReq.el, barConn.el),
        verdict.el,
        ui.panel('SQL log', log.el)
      );

      function plan() {
        const ent = st.ret === 'entity';
        const oiv = st.oiv;
        const fail = ent && !oiv;
        const hidden = ent && oiv ? st.n : 0;
        const ctxState = oiv ? 'open' : 'closed';
        const connAfter = oiv ? 'held' : 'free';
        return {
          fail, hidden,
          rows: [
            { name: 'CorrelationIdFilter', sub: 'a filter, before Spring MVC', pc: 'closed', conn: 'free', q: 0, ticks: 1 },
            oiv
              ? { name: 'OpenEntityManagerInViewInterceptor', sub: 'opens an EntityManager for the rest of the request', pc: 'open', conn: 'free', q: 0, ticks: 0 }
              : { name: 'OpenEntityManagerInViewInterceptor', sub: 'not registered: open-in-view is false', skip: true },
            { name: 'Controller', sub: 'calls the service', pc: ctxState, conn: 'free', q: 0, ticks: 1 },
            { name: ent ? 'DeploymentService.listAllNaive()' : 'DeploymentService.listSummaries()',
              sub: '@Transactional(readOnly = true), ' + (ent ? 'findAll()' : 'findAllBy() with the tasks entity graph'),
              pc: 'open', conn: 'held', q: 1, ticks: 2 },
            { name: 'Commit, back in the controller', sub: ent ? 'holds detached Deployment entities' : 'holds DeploymentSummary records',
              pc: ctxState, conn: connAfter, q: 0, ticks: 1 },
            { name: 'Jackson writes JSON', sub: ent ? 'calls getTasks() on every deployment' : 'reads id, status and taskCount from records',
              pc: ctxState, conn: connAfter, q: hidden, ticks: st.w, fail, hiddenRow: hidden > 0 },
            { name: 'Response', sub: fail ? 'an error response instead of the list' : (oiv ? 'EntityManager closed, connection returned' : 'nothing left to close'),
              pc: 'closed', conn: 'free', q: 0, ticks: 0, end: true }
          ]
        };
      }

      let rowEls = [];
      function drawRows(p) {
        AF.clear(rowsBox);
        rowEls = p.rows.map(r => {
          const node = ui.node(r.name, r.sub);
          if (r.skip) AF.tone(node, 'idle');
          const tokens = h('div', { class: 'row', style: 'flex:1 1 18rem' });
          const row = h('div', { class: 'row' }, h('div', { style: 'flex:1 1 14rem' }, node), tokens);
          rowsBox.append(row);
          return { node, tokens };
        });
      }

      function fillTokens(r, re) {
        AF.clear(re.tokens);
        if (r.skip) return;
        re.tokens.append(
          ui.token('context ' + r.pc, r.pc === 'open' ? 'busy' : 'idle'),
          ui.token('connection ' + r.conn, r.conn === 'held' ? 'warn' : 'idle'),
          r.fail ? ui.token('LazyInitializationException', 'bad')
            : r.hiddenRow ? ui.token(r.q + (r.q === 1 ? ' hidden query' : ' hidden queries'), 'bad')
              : ui.token(r.q ? r.q + (r.q === 1 ? ' query' : ' queries') : 'no queries', r.q ? 'busy' : 'idle'));
      }

      function reset() {
        guard.cancel();
        drawRows(plan());
        rStmts.set('—');
        rOutside.set('—');
        rOutcome.set('—');
        barReq.set(0);
        barConn.set(0);
        verdict.clear();
        log.clear();
      }

      async function play(live) {
        const p = plan();
        drawRows(p);
        verdict.clear();
        log.clear();
        let stmts = 0;
        let elapsed = 0;
        let held = 0;
        barReq.set(0);
        barConn.set(0);
        [rStmts, rOutside, rOutcome].forEach(r => r.set('—'));

        for (let i = 0; i < p.rows.length; i++) {
          const r = p.rows[i];
          const re = rowEls[i];
          if (r.skip) continue;
          AF.tone(re.node, 'busy');
          fillTokens(r, re);
          if (r.q === 1 && !r.hiddenRow) {
            stmts++;
            log.add(st.ret === 'entity'
              ? 'select ... from deployment   (findAll, inside the transaction)'
              : 'select ... from deployment left join task   (entity graph, inside the transaction)', 'busy');
          }
          if (r.fail) {
            log.add('getTasks().size() on a detached entity: no session', 'bad');
            AF.tone(re.node, 'bad');
            await wait(ctx, 500);
            if (!ctx.alive || !live()) return;
            elapsed += r.ticks;
            barReq.set(elapsed);
            const last = p.rows.length - 1;
            AF.tone(rowEls[last].node, 'bad');
            fillTokens(p.rows[last], rowEls[last]);
            break;
          }
          if (r.hiddenRow) {
            for (let k = 1; k <= r.q; k++) {
              stmts++;
              log.add('select ... from task where deployment_id = ?   (lazy load for deployment ' + k + ', no transaction)', 'bad');
              rStmts.set(stmts, 'bad');
              await wait(ctx, r.q > 10 ? 30 : 160);
              if (!ctx.alive || !live()) return;
            }
          }
          elapsed += r.ticks;
          if (r.conn === 'held') held += r.ticks;
          barReq.set(elapsed);
          barConn.set(held, held > 2 ? 'warn' : 'ok');
          rStmts.set(stmts, p.hidden ? 'bad' : null);
          await wait(ctx, 250 + 150 * r.ticks);
          if (!ctx.alive || !live()) return;
          AF.tone(re.node, r.hiddenRow ? 'warn' : 'ok');
        }

        barConn.set(held, held > 2 ? 'warn' : 'ok');
        rStmts.set(stmts, p.hidden ? 'bad' : 'ok');
        rOutside.set(p.hidden, p.hidden ? 'bad' : 'ok');
        if (p.fail) {
          rOutcome.set('fails', 'bad');
          verdict.set('bad', "LazyInitializationException: Cannot lazily initialize collection of role 'io.appfleet.control.deployment.Deployment.tasks' with key '" + entityId() + "' (no session). The session closed when the service returned; listAllNaive_touchingTasksOutsideTransaction_throws pins this.");
        } else if (p.hidden) {
          rOutcome.set('200, slowly', 'warn');
          verdict.set('warn', 'It works, which is the problem: ' + p.hidden + (p.hidden === 1 ? ' extra query' : ' extra queries') + ' ran while JSON was written, outside any transaction and invisible to service tests, and the connection stayed out of the pool for ' + held + ' of ' + elapsed + ' ticks.');
        } else if (st.oiv) {
          rOutcome.set('200', 'ok');
          verdict.set('warn', 'Still one statement, but with open-in-view on the request kept its connection until the response was written: ' + held + ' of ' + elapsed + ' ticks. Slow JSON or a slow client keeps a pool connection idle.');
        } else {
          rOutcome.set('200', 'ok');
          verdict.set('ok', 'One statement inside the transaction, nothing lazy left the service, and the connection went back to the pool before JSON writing began. listSummaries_worksOutsideTransaction_inOneStatement proves the single statement.');
        }
      }

      reset();
    }
  });

  // =====================================================================
  // 6. sp-scheduled: @Scheduled on many instances
  // =====================================================================

  AF.register({
    id: 'sp-scheduled',
    group: 'spring',
    order: 6,
    title: 'Scheduled jobs on many instances',
    question: 'When a service runs as three instances, how do you stop a scheduled job from doing the same work three times?',
    status: 'planned',
    slice: 'S6',
    where: [
      '01-CONTROL-API.md, S6: the @Scheduled reaper for stuck deployments',
      '01-CONTROL-API.md, Deliberate bugs: Reaper fires on every instance',
      '03-TASK-SERVICE.md: the SELECT ... FOR UPDATE SKIP LOCKED claim query'
    ],
    idea: [
      '@Scheduled runs a method on a timer inside one JVM. It knows nothing about other copies of the service. Scale control-api to three instances and the planned reaper for stuck deployments fires three times per tick; each run reads the same stuck rows and acts on every one of them.',
      'Postgres offers two fixes. An advisory lock (pg_try_advisory_lock) is a lock on a number the application chooses, with no table behind it: the instance that gets it runs the job, the others skip this tick. A claim query with FOR UPDATE SKIP LOCKED lets every instance run but take different rows, because rows locked by one instance are skipped by the rest.',
      'The advisory lock is simplest when one runner is enough. SKIP LOCKED spreads the work across instances and is the same queue-in-a-table pattern task-service plans for claiming tasks. Both are planned for S6; nothing here is built yet.'
    ],
    terms: [
      ['Advisory lock', 'A Postgres lock on an application-chosen number, not a row. pg_try_advisory_lock returns false at once if another session holds it.'],
      ['FOR UPDATE SKIP LOCKED', 'Locks the selected rows and silently passes over rows another transaction has locked, so concurrent workers never pick the same row.'],
      ['Reaper', 'A periodic job that finds work stuck too long and moves it on, for example a deployment stuck in DEPLOYING.']
    ],
    tryIt: [
      'Switch on Plain @Scheduled, no lock, keep Instances at 3 and press Tick the clock: every stuck row is reaped three times.',
      'Press Reset, switch off Plain @Scheduled, no lock, keep Coordination on Advisory lock and tick: one instance does all the work.',
      'Choose SKIP LOCKED claims, press Reset and tick: the instances split the rows, at most two each.',
      'Set Instances to 1 with SKIP LOCKED claims and tick until no stuck rows are left.'
    ],
    breakIt: 'Leave the reaper as a plain @Scheduled method and scale to three instances: all three fire on the same tick, read the same stuck rows and reap each of them three times, tripling the side effects and colliding on the same writes.',
    say: '@Scheduled is per JVM, so a scaled service needs coordination: a Postgres advisory lock when one runner is enough, or FOR UPDATE SKIP LOCKED claims when the instances should share the rows.',
    quiz: {
      q: 'Three instances run the reaper with FOR UPDATE SKIP LOCKED LIMIT 2, and six rows are stuck. What happens on one tick?',
      options: [
        'Each instance claims two different rows, so all six are reaped once',
        'One instance takes all six; the other two wait for its lock to be released',
        'Each instance reaps the same two rows',
        'The second and third instances fail with a lock timeout'
      ],
      answer: 0,
      why: 'SKIP LOCKED makes each select pass over rows another transaction already holds, so the instances get separate batches without blocking. Waiting is what plain FOR UPDATE does, and one runner taking everything is the advisory-lock approach.'
    },
    mount(el, ctx) {
      const MAX_ROWS = 12;
      const BATCH = 2;
      const st = { instances: 3, coord: 'advisory', noLock: false, rows: [], next: 101, tick: 0, dups: 0 };

      const instS = ui.slider({ label: 'Instances', min: 1, max: 4, value: st.instances, onInput: v => { st.instances = v; guard.cancel(); drawInstances(); } });
      const coordC = ui.choice('Coordination', [
        { value: 'advisory', label: 'Advisory lock' },
        { value: 'skip', label: 'SKIP LOCKED claims' }
      ], st.coord, v => { st.coord = v; guard.cancel(); syncCode(); });
      const noLockT = ui.toggle('Plain @Scheduled, no lock', st.noLock, v => {
        st.noLock = v;
        coordC.el.disabled = v;
        guard.cancel();
        syncCode();
      }, { tone: 'danger' });
      const tickB = ui.button('Tick the clock', () => guard.start(tick), { variant: 'primary' });
      const addB = ui.button('Add stuck rows', () => { guard.cancel(); addRows(3); drawTable(); syncReadouts(); });
      const resetB = ui.button('Reset', () => reset());
      const guard = runGuard(b => { tickB.disabled = b; });

      const tableLane = ui.lane('deployment table', 'stuck rows');
      const tableRow = h('div', { class: 'row' });
      tableLane.body.append(tableRow);
      const instCols = h('div', { class: 'sim-cols' });
      let lanes = [];

      const rTick = ui.readout('Tick', 0);
      const rLeft = ui.readout('Stuck rows left');
      const rReaps = ui.readout('Reaps this tick', 0);
      const rDups = ui.readout('Duplicate reaps', 0);
      const verdict = ui.verdict();
      const log = ui.log({ label: 'Reaper log', max: 60 });
      const code = ui.code('', 'Reaper sketch');
      const coordNote = h('span', { class: 'small muted' });

      el.append(
        h('div', { class: 'sim-controls' }, instS.el, coordC.el, noLockT.el, coordNote),
        h('div', { class: 'sim-controls' }, tickB, addB, resetB),
        h('div', { class: 'sim-stage' }, h('div', { class: 'stack' }, tableLane.el, instCols)),
        h('div', { class: 'readouts' }, rTick.el, rLeft.el, rReaps.el, rDups.el),
        verdict.el,
        h('div', { class: 'sim-cols' }, ui.panel('Reaper log', log.el), ui.panel('S6 sketch, not built', code))
      );

      const mode = () => (st.noLock ? 'none' : st.coord);
      const stuckRows = () => st.rows.filter(r => r.reaps === 0);
      const name = i => 'instance-' + (i + 1);

      function addRows(n) {
        for (let k = 0; k < n; k++) {
          if (st.rows.length >= MAX_ROWS) {
            const idx = st.rows.findIndex(r => r.reaps > 0);
            if (idx < 0) break;
            st.rows.splice(idx, 1);
          }
          st.rows.push({ id: 'D-' + st.next++, reaps: 0 });
        }
      }

      function drawTable() {
        AF.clear(tableRow);
        st.rows.forEach(r => {
          let text = r.id + ' DEPLOYING, stuck';
          let tone = 'warn';
          if (r.reaps === 1) { text = r.id + ' reaped'; tone = 'ok'; }
          if (r.reaps > 1) { text = r.id + ' reaped ×' + r.reaps; tone = 'bad'; }
          tableRow.append(ui.token(text, tone));
        });
        setAside(tableLane, stuckRows().length + ' stuck');
      }

      function drawInstances() {
        AF.clear(instCols);
        lanes = [];
        for (let i = 0; i < st.instances; i++) {
          const lane = ui.lane(name(i), 'waiting');
          lanes.push(lane);
          instCols.append(lane.el);
        }
      }

      function syncCode() {
        const m = mode();
        coordNote.textContent = st.noLock ? 'Coordination is ignored while the lock is removed.' : '';
        if (m === 'none') {
          setCode(code, '// Every instance runs this on every tick\n' +
            '@Scheduled(...)\n' +
            'void reapStuckDeployments() {\n' +
            '    for (Deployment d : findStuck()) {   // every instance gets the same rows\n' +
            '        reap(d);\n' +
            '    }\n' +
            '}');
        } else if (m === 'advisory') {
          setCode(code, '-- One runner per tick\n' +
            'select pg_try_advisory_lock(:reaperLockKey);   -- false: another instance has it, skip\n' +
            '-- ... reap every stuck deployment ...\n' +
            'select pg_advisory_unlock(:reaperLockKey);');
        } else {
          setCode(code, '-- Every instance runs; each claims different rows\n' +
            'select id from deployment\n' +
            " where status = 'DEPLOYING' and updated_at < now() - :stuckAfter\n" +
            ' order by updated_at\n' +
            ' limit ' + BATCH + '\n' +
            ' for update skip locked;');
        }
      }

      function syncReadouts(reapsThisTick) {
        rTick.set(st.tick);
        const left = stuckRows().length;
        rLeft.set(left, left ? 'warn' : 'ok');
        if (reapsThisTick !== undefined) rReaps.set(reapsThisTick);
        rDups.set(st.dups, st.dups ? 'bad' : 'ok');
      }

      function reset() {
        guard.cancel();
        st.rows = [];
        st.next = 101;
        st.tick = 0;
        st.dups = 0;
        addRows(6);
        drawTable();
        drawInstances();
        log.clear();
        verdict.clear();
        rReaps.set(0);
        syncReadouts();
        syncCode();
      }

      async function tick(live) {
        st.tick++;
        const k = st.instances;
        const m = mode();
        const order = [];
        for (let i = 0; i < k; i++) order.push(i);
        for (let i = order.length - 1; i > 0; i--) {           // arrival order varies, for looks only
          const j = Math.floor(Math.random() * (i + 1));
          const t = order[i]; order[i] = order[j]; order[j] = t;
        }
        lanes.forEach(l => { AF.clear(l.body); setAside(l, 'waiting'); });
        const stuck = stuckRows();
        const claimed = new Set();
        let reaps = 0;
        let dupsNow = 0;
        let winner = null;
        log.add('Tick ' + st.tick + ': @Scheduled fires on ' + k + (k === 1 ? ' instance' : ' instances') + ' at the same moment; ' + stuck.length + ' rows are stuck', 'muted');
        syncReadouts(0);

        for (let pos = 0; pos < order.length; pos++) {
          const i = order[pos];
          const lane = lanes[i];
          let mine = [];
          if (m === 'none') {
            mine = stuck;
            setAside(lane, 'ran');
            log.add(name(i) + ' selects the stuck rows: ' + (stuck.length ? stuck.map(r => r.id).join(', ') : 'none'), 'busy');
          } else if (m === 'advisory') {
            if (pos === 0) {
              winner = i;
              mine = stuck;
              setAside(lane, 'holds the lock');
              log.add(name(i) + ': pg_try_advisory_lock returned true, runs the job', 'ok');
            } else {
              setAside(lane, 'skipped');
              lane.body.append(ui.token('skipped: lock held', 'idle'));
              log.add(name(i) + ': pg_try_advisory_lock returned false, skips this tick', 'muted');
            }
          } else {
            mine = stuck.filter(r => !claimed.has(r.id)).slice(0, BATCH);
            mine.forEach(r => claimed.add(r.id));
            setAside(lane, 'claimed ' + mine.length);
            log.add(name(i) + ' claims ' + (mine.length ? mine.map(r => r.id).join(', ') : 'nothing') + '; rows locked by others are skipped', mine.length ? 'busy' : 'muted');
            if (!mine.length) lane.body.append(ui.token('no rows left to claim', 'idle'));
          }
          for (const r of mine) {
            r.reaps++;
            reaps++;
            const dup = r.reaps > 1;
            if (dup) { dupsNow++; st.dups++; }
            lane.body.append(ui.token(r.id + (dup ? ' reaped again' : ' reaped'), dup ? 'bad' : 'ok'));
            if (dup) log.add(name(i) + ' reaps ' + r.id + ' again: duplicate', 'bad');
            drawTable();
            syncReadouts(reaps);
            await wait(ctx, 260);
            if (!ctx.alive || !live()) return;
          }
          await wait(ctx, 200);
          if (!ctx.alive || !live()) return;
        }
        if (m === 'advisory' && winner !== null && stuck.length) log.add(name(winner) + ': pg_advisory_unlock', 'muted');

        drawTable();
        syncReadouts(reaps);
        const left = stuckRows().length;
        if (!stuck.length) {
          verdict.set(null, 'Nothing was stuck on this tick. Press Add stuck rows.');
        } else if (m === 'none') {
          if (k > 1) verdict.set('bad', 'All ' + k + ' instances reaped the same ' + stuck.length + ' rows: ' + dupsNow + ' duplicate reaps on one tick. @Scheduled runs per JVM and knows nothing of the others.');
          else verdict.set('warn', 'One instance, so no duplicates yet. The bug appears the moment the service is scaled: raise Instances, add rows and tick again.');
        } else if (m === 'advisory') {
          verdict.set('ok', name(winner) + ' held the advisory lock and reaped all ' + stuck.length + ' rows' + (k > 1 ? '; the other ' + (k - 1) + ' skipped' : '') + '. One runner per tick and no duplicates, but the work is not shared.');
        } else {
          verdict.set('ok', 'The instances split the rows, at most ' + BATCH + ' each, with no duplicates.' + (left ? ' ' + left + (left === 1 ? ' row waits' : ' rows wait') + ' for the next tick.' : ' Every stuck row was reaped once.'));
        }
      }

      reset();
    }
  });
})();
