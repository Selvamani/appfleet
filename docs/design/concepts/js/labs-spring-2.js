/*
 * labs-spring-2.js: more Spring lessons for "How Appfleet works" (group 'spring', orders 7 to 14).
 *
 * One AF.register call per lesson, each with a small simulation built from AF.h and the AF.ui atoms.
 * Facts come from the control-api sources, tests and docs/design as of 2026-10-05. Anything that was not
 * measured in this project is labelled as standard behaviour or illustrative in the UI.
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


  // =====================================================================
  // Spring 11. The SecurityContext and the Authentication
  // =====================================================================
  AF.register({
    id: 'sp-securitycontext',
    group: 'spring',
    order: 11,
    title: 'Who is calling: the SecurityContext and the Authentication',
    question: 'After the token is validated, where does the caller live inside the request, and how do four different classes read it without being passed anything?',
    status: 'built',
    slice: 'S4.1, S4.2, S4.4',
    where: [
      'control-api/src/main/java/io/appfleet/control/web/SecurityConfig.java (apiChain: oauth2ResourceServer jwt, STATELESS)',
      'common-security/src/main/java/io/appfleet/security/AppfleetJwtAuthenticationConverter.java',
      'control-api/.../security/TeamAccess.java and TeamScope.java; ratelimit/RateLimitInterceptor.java (callerKey); deployment/web/DeploymentController.java (actor, idempotency key)',
      'control-api/src/test/java/io/appfleet/control/web/TestAuth.java (tokenFor, tokenWithGlobalPerms)',
      'docs/design/control-api/control-api-s4-2-principal.md and control-api-s4-4-idor.md (section 1 and the tests of section 4)'
    ],
    idea: [
      'Once the resource-server filter has checked the signature, expiry and issuer, Spring Security turns the Jwt into an Authentication and stores it in the SecurityContextHolder. The holder is thread-bound (a ThreadLocal in the default strategy): the filter chain fills it at the start of the request and clears it at the end. That is why any class running on the request thread can call SecurityContextHolder.getContext().getAuthentication() with nothing passed in. The same property is the catch: a new thread, an @Async method or an async dispatch does not see it unless you propagate it (standard Spring behaviour, not measured in Appfleet).',
      'In control-api, SecurityConfig.apiChain uses oauth2ResourceServer with jwt and the AppfleetJwtAuthenticationConverter, and sets SessionCreationPolicy.STATELESS, so there is no HttpSession: every request is authenticated again from its bearer token. The converter builds a JwtAuthenticationToken whose name is the sub claim and whose authorities are the perms list plus the values of every entry of the teams map, flattened with no prefix. Four consumers read the result. DeploymentController takes Authentication as a parameter and passes getName() as the audit actor. RateLimitInterceptor.callerKey() reads the holder for the bucket (and falls back to a shared "anonymous" bucket with a warning). The idempotency key is built as "deployments:" + actor + ":" + the Idempotency-Key header, so two callers cannot collide. TeamAccess reads the raw perms and teams claims from the Jwt held inside the token.',
      'The flattening is the trap. A token with teams {A: [deployment:create], B: [deployment:read]} becomes the two authorities deployment:create and deployment:read, and which team granted which is thrown away, so hasAuthority(...) says yes for an object of any team. S4.3 accepted that on purpose (endpoint-level only); S4.4 showed it was an exploit: the first test deployed team B’s application with team A’s permission and got a 202. The fix did not touch the converter. TeamAccess goes back to the raw claim, which is still on JwtAuthenticationToken.getToken(), and answers per team.'
    ],
    terms: [
      ['SecurityContextHolder', 'A holder for the current SecurityContext. By default it keeps it in a ThreadLocal, so it is visible to code on the same thread and to nobody else.'],
      ['Authentication', 'Who is calling: a name, a set of GrantedAuthority values, and for a JWT the original token. JwtAuthenticationToken is the implementation used here.'],
      ['GrantedAuthority', 'One string the caller holds. Appfleet uses the permission strings as they are ("deployment:create"), with no ROLE_ prefix.'],
      ['STATELESS', 'SessionCreationPolicy.STATELESS: Spring Security never creates or uses an HttpSession, so the context lives for one request.'],
      ['Flattening', 'What the converter does to the teams map: it keeps the permissions and drops the team that granted each. Fine for "may you use this endpoint", wrong for "may you touch this object".']
    ],
    tryIt: [
      'Pick "One team, all permissions" and read the authorities set: five strings, no team. Then read "TeamAccess for team A" and "TeamAccess for team B": allowed for A, denied for B, because the token names only team A.',
      'Pick "Two teams, different permissions". With "Use the flattened authorities for the object check" off, deployment:create works for A only. Switch it on and B’s deployment is accepted too: that is the S4.4 hole.',
      'Pick "Global perms only": the perms claim grants the permission for every team, so both teams are allowed with the real check.',
      'Pick "No teams, no perms": the authorities set is empty and the endpoint answers 403 before any object is loaded (S4.3).',
      'Switch on "Read it on another thread": the holder is empty there. The audit actor and the idempotency key still hold (they came from the controller parameter), but the rate-limit key becomes "anonymous" and TeamAccess denies everything.'
    ],
    breakIt: 'Use "Use the flattened authorities for the object check" with the two-teams or one-team token. The authorities set has no team in it, so the check cannot tell team A from team B and accepts both: S4.4’s exploit tests got a 202 for another team’s application, and CrossTeamMatrixTest and ObjectAuthorizationTest exist so that cannot return. The "Read it on another thread" switch shows the other way the holder can fail you: the data is not gone, it was never on that thread.',
    say: 'After the filter chain validates the JWT, the caller is a JwtAuthenticationToken in a thread-bound SecurityContextHolder with STATELESS sessions, and four classes read it: the controller passes getName() as the audit actor, the rate limiter and idempotency key are scoped by sub, and TeamAccess reads the raw teams claim because the converter flattens permissions and forgets which team granted them, which was the S4.4 hole.',
    quiz: {
      q: 'A token carries teams {A: [deployment:create], B: [deployment:read]}. With only the converter’s authorities and hasAuthority("deployment:create"), what happens when the caller deploys team B’s application?',
      options: [
        'It is refused, because the authority is attached to team A in the Authentication',
        'It is accepted, because the authorities set is just {deployment:create, deployment:read} and the team that granted each was dropped',
        'It is refused with a 403, because deployment:read is not enough to deploy',
        'It fails with a 500, because the converter cannot read a map'
      ],
      answer: 1,
      why: 'The converter flattens the values of the teams map into plain authorities. hasAuthority only asks "is this string in the set", so the caller passes for any team. S4.4 added TeamAccess, which reads the raw teams claim from the Jwt and checks the object’s own team.'
    },
    mount(el, ctx) {
      const ALL5 = ['application:read', 'application:create', 'deployment:create', 'deployment:rollback', 'deployment:read'];
      const SUB = 'user-7f3a';
      const TOKENS = {
        one: { name: 'One team, all permissions', perms: [], teams: { A: ALL5 } },
        two: { name: 'Two teams, different permissions', perms: [], teams: { A: ['deployment:create'], B: ['deployment:read'] } },
        glob: { name: 'Global perms only', perms: ['deployment:create', 'deployment:read'], teams: {} },
        none: { name: 'No teams, no perms', perms: [], teams: {} }
      };
      const PERM = 'deployment:create';

      function scAuthorities(tok) {
        const out = [];
        const add = p => { if (out.indexOf(p) < 0) out.push(p); };
        tok.perms.forEach(add);
        Object.keys(tok.teams).forEach(t => tok.teams[t].forEach(add));
        return out;
      }
      // TeamAccess.allows: perms grants every team; otherwise the teams map decides, per team.
      function scReal(tok, team) {
        if (tok.perms.indexOf(PERM) >= 0) return true;
        return !!(tok.teams[team] && tok.teams[team].indexOf(PERM) >= 0);
      }
      function scFlat(tok) { return scAuthorities(tok).indexOf(PERM) >= 0; }

      const flat = ui.toggle('Use the flattened authorities for the object check', false, update, { tone: 'danger' });
      const thread = ui.toggle('Read it on another thread (illustrative)', false, update, { tone: 'danger' });
      const tok = ui.choice('Token shape', [
        { value: 'one', label: TOKENS.one.name },
        { value: 'two', label: TOKENS.two.name },
        { value: 'glob', label: TOKENS.glob.name },
        { value: 'none', label: TOKENS.none.name }
      ], 'one', update);

      const claimBox = ui.code('', 'Claims in the token');
      const authBox = ui.code('', 'The Authentication Spring builds');
      const authChips = h('div', { class: 'row' });
      const rName = ui.readout('Audit actor (controller)');
      const rRate = ui.readout('Rate-limit key');
      const rIdem = ui.readout('Idempotency key');
      const rA = ui.readout('Deploy to team A');
      const rB = ui.readout('Deploy to team B');
      const rTa = ui.readout('TeamAccess for A / B');
      const verdict = ui.verdict();

      function update() {
        const t = TOKENS[tok.get()];
        const auths = scAuthorities(t);
        const another = thread.get();
        const useFlat = flat.get();

        setCode(claimBox, '{\n  "sub":   "' + SUB + '",\n  "perms": ' + JSON.stringify(t.perms) + ',\n  "teams": ' +
          (Object.keys(t.teams).length ? '{\n' + Object.keys(t.teams).map(k => '    "team-' + k + '": ' + JSON.stringify(t.teams[k])).join(',\n') + '\n  }' : '{}') + '\n}');
        setCode(authBox, 'JwtAuthenticationToken\n  name        = ' + SUB + '        // the sub claim\n  authorities = ' +
          (auths.length ? '{ ' + auths.join(', ') + ' }' : '{ }') + '\n  // perms first, then every value of the teams map; no team kept');
        authChips.replaceChildren(...auths.map(a => ui.token(a, 'ok')), auths.length ? null : ui.token('no authorities', 'idle'));

        rName.set(SUB, 'ok');
        rIdem.set('deployments:' + SUB + ':k-1', 'ok');
        if (another) rRate.set('anonymous (shared bucket)', 'bad'); else rRate.set(SUB, 'ok');

        const decide = team => {
          if (!scFlat(t)) return { text: '403 at the endpoint', tone: 'bad', ok: false, allowed: false };
          let allowed;
          if (another) allowed = false;
          else allowed = useFlat ? true : scReal(t, team);
          return allowed
            ? { text: '202 accepted', tone: 'ok', ok: true, allowed: true }
            : { text: '422 (same as an unknown application)', tone: 'warn', ok: false, allowed: false };
        };
        const a = decide('A');
        const b = decide('B');
        rA.set(a.text, a.tone);
        rB.set(b.text, b.tone);
        const ta = another ? false : (useFlat ? scFlat(t) : scReal(t, 'A'));
        const tb = another ? false : (useFlat ? scFlat(t) : scReal(t, 'B'));
        rTa.set((ta ? 'allowed' : 'denied') + ' / ' + (tb ? 'allowed' : 'denied'), (ta || tb) ? 'ok' : 'warn');

        const wrong = ['A', 'B'].filter(k => scFlat(t) && !scReal(t, k) && useFlat && !another);
        if (another) {
          verdict.set('warn', 'On another thread the holder is empty. The actor and the idempotency key still hold because the controller received Authentication as a parameter before it left the request thread, but callerKey() finds no authentication and uses the shared "anonymous" bucket, and TeamAccess.scopeFor returns no teams. Standard behaviour; the thread switch is illustrative, nothing in control-api starts a thread.');
        } else if (!scFlat(t)) {
          verdict.set('warn', 'No authority "deployment:create", so @PreAuthorize refuses at the endpoint with a 403 before any object is loaded (S4.3). The object check is never reached.');
        } else if (wrong.length) {
          verdict.set('bad', 'The S4.4 hole: the flattened set contains deployment:create, so the object check accepts team ' + wrong.join(' and team ') + ' although the token grants it for ' +
            (Object.keys(t.teams).filter(k => t.teams[k].indexOf(PERM) >= 0).map(k => 'team ' + k).join(', ') || 'no team') + '. In the S4.4 test (permissionHeldForAnotherTeam_doesNotCount) this was a 202 that must be a 422.');
        } else if (useFlat) {
          verdict.set('ok', 'The flattened check happens to give the right answer for this token (the permission is granted for every team it is asked about), but it cannot tell teams apart. Pick the two-teams or one-team token to see it fail.');
        } else {
          verdict.set('ok', 'TeamAccess reads the raw claims from the Jwt and checks the object’s own team: ' + (tok.get() === 'glob' ? 'a perms grant covers every team.' : (a.ok && !b.ok ? 'allowed for team A, denied for team B (422).' : 'each team is judged on its own grant.')));
        }
      }

      el.append(
        controls(tok.el, flat.el, thread.el),
        stage(h('div', { class: 'sim-cols' },
          ui.panel('The token (claims)', claimBox),
          ui.panel('The Authentication', authBox, authChips))),
        readouts(rName, rRate, rIdem, rA, rB, rTa),
        note('The shapes follow TestAuth (tokenFor, tokenForTeams, tokenWithGlobalPerms). The sub, team letters and "k-1" are illustrative. The answers 202, 422 and 403 are the ones recorded in the S4.3 and S4.4 docs; "TeamAccess" here repeats its rule (perms grants every team, otherwise the teams map, per team). ThreadLocal behaviour and async propagation are standard Spring behaviour, not measured in Appfleet.'),
        verdict.el
      );
      update();
    }
  });

  // =====================================================================
  // Spring 12. Method security: @PreAuthorize on a proxy
  // =====================================================================
  AF.register({
    id: 'sp-methodsecurity',
    group: 'spring',
    order: 12,
    title: 'Method security: @PreAuthorize on a proxy',
    question: 'Why is a @PreAuthorize that is written but not enabled worse than none, and which three ways can a protected method still run unprotected?',
    status: 'built',
    slice: 'S4.3',
    where: [
      'control-api/src/main/java/io/appfleet/control/web/SecurityConfig.java (@EnableMethodSecurity)',
      'ApplicationController, DeploymentController, TaskController: eleven @PreAuthorize("hasAuthority(...)") methods',
      'control-api/src/test/java/io/appfleet/control/web/PermissionEnforcementTest.java (27 tests: matrix, meta-test, problem shape, 400-before-403)',
      'ApiExceptionHandler.rethrowSecurity and common-security ProblemAccessDeniedHandler (urn:appfleet:problem:forbidden)',
      'docs/design/control-api/control-api-s4-3-method-security.md, sections 4, 5 and 9'
    ],
    idea: [
      'Method security is a proxy. @EnableMethodSecurity registers an advisor, and Spring wraps each bean that has a @PreAuthorize method in a CGLIB proxy. A call from outside goes through the proxy, which evaluates the SpEL expression against the current Authentication and throws AccessDeniedException before your method body runs. Without the enabling annotation the @PreAuthorize is just metadata that nothing reads, so the code looks protected and is not. That is worse than no annotation, because a reviewer reads it as a guarantee.',
      'Appfleet puts @PreAuthorize("hasAuthority(...)") on each of eleven controller methods and @EnableMethodSecurity on SecurityConfig. It is hasAuthority and never hasRole: hasRole(\'x\') looks for ROLE_x, and the converter adds permissions with no prefix. The S4.3 doc recorded three runs. With no enforcement, 15 of 27 tests were red. With the annotations present but no @EnableMethodSecurity, 14 were red and the only difference was the meta-test, which saw the annotations and passed. With enforcement on, 27 of 27 were green. Four mutations on a scratch copy showed which test catches which mistake: a wrong permission (7 of 27 red), hasRole (2), a deleted annotation (2), and a final method that the proxy cannot override (1: only the behaviour test).',
      'Three things still let a protected method run: the proxy is not there (not enabled, or a final method), the annotation is wrong or missing, or the call never goes through the proxy (self-invocation: one method calling another on this skips the advice; no controller does that today, so no test covers it). Two behaviours to know. A caller who lacks the permission and sends an invalid body gets a 400 first, because Spring binds and validates the arguments before it calls the proxied method (pinned by test 7). And the denial is an AccessDeniedException that ApiExceptionHandler rethrows so the filter chain’s ExceptionTranslationFilter hands it to ProblemAccessDeniedHandler, which writes the 403 problem.'
    ],
    terms: [
      ['@EnableMethodSecurity', 'Turns annotation-based method security on by registering the advisors. Without it @PreAuthorize is ignored.'],
      ['hasAuthority vs hasRole', 'hasAuthority(\'deployment:create\') looks for exactly that string. hasRole(\'deployment:create\') looks for ROLE_deployment:create, which no token carries here.'],
      ['CGLIB proxy', 'A generated subclass of the controller that runs the security advice around each call. A final class or method cannot be overridden, so it is not wrapped.'],
      ['Self-invocation', 'A method calling another method on this. The call does not go through the proxy, so the advice does not run.'],
      ['Meta-test', 'everyApiHandler_declaresOnePermission: checks each handler has hasAuthority(...) and that the set matches the table. It cannot tell whether the annotation is enforced.']
    ],
    tryIt: [
      'Leave the defaults (@EnableMethodSecurity on, "hasAuthority", method not final, "Through the proxy (HTTP)", "Valid body"): 403, the method does not run, 27 of 27 tests green.',
      'Switch "@EnableMethodSecurity" off: the method runs and answers 202. The meta-test stays green and the lab says 14 tests are red, the S4.3 red run 2.',
      'Choose annotation style "hasRole": the lab still answers 403 for the caller who lacks the permission, but the permission-only test and the meta-test catch it, because a correct caller would be refused too.',
      'Switch "Method is final" on: the method runs unprotected and only the behaviour test (test 1) notices.',
      'Choose "Self-invocation" or "Invalid body" and read the status: the first runs unprotected with no recorded test, the second is a 400 before the check.'
    ],
    breakIt: 'Switch "@EnableMethodSecurity" off with the annotation style on "hasAuthority". The code reads as protected, the meta-test passes because every handler declares its permission, and the endpoint accepts a caller who holds nothing. This is the recorded red run 2: only the behaviour tests (1, 3, 4, 5) see it. Add "Method is final" or self-invocation for the quieter ways to get the same result with the switch on.',
    say: 'Method security is a CGLIB proxy created by @EnableMethodSecurity, so a @PreAuthorize that is written but not enabled is ignored: in the S4.3 red runs the meta-test passed while 14 of 27 behaviour tests were red, and a final method, hasRole instead of hasAuthority, or a self-invocation can each run unprotected, which is why the matrix, the meta-test and mutation checks all exist.',
    quiz: {
      q: 'In S4.3 the annotations were on all eleven controller methods but @EnableMethodSecurity was missing. Which test passed anyway, and why?',
      options: [
        'The behaviour test that sends a token without the permission, because 403 is the default',
        'The meta-test everyApiHandler_declaresOnePermission, because it only checks that each handler carries a hasAuthority(...) annotation, not that anything enforces it',
        'The invalid-body test, because validation runs after the security check',
        'None: all 27 tests were red'
      ],
      answer: 1,
      why: 'Run 2 had 14 failures of 27: tests 1 (all eleven rows), 3, 4 and 5. Test 6, the meta-test, was green because the annotations were present. Test 7 was green in both runs: a 400 comes from validation before the proxy is reached.'
    },
    mount(el, ctx) {
      // The permission under test is deployment:create on POST /deployments; the caller holds the other four (TestAuth.tokenWithout).
      // Recorded counts of failing tests out of 27 (S4.3 section 9): key = enabled|style|final, non-self, valid body.
      const RECORDED = {
        'on|hasAuthority|false': { n: 0, src: 'section 9.3: 27 of 27 green' },
        'off|hasAuthority|false': { n: 14, src: 'section 9.2: run 2, annotations without @EnableMethodSecurity' },
        'off|missing|false': { n: 15, src: 'section 9.1: run 1, no enforcement at all' },
        'on|hasAuthority|true': { n: 1, src: 'section 9.4 (d), measured on requestRollback' },
        'on|hasRole|false': { n: 2, src: 'section 9.4 (b), measured on requestRollback' },
        'on|missing|false': { n: 2, src: 'section 9.4 (c), measured on requestRollback' }
      };
      const TESTS = {
        t1: 'test 1 everyOperation_withoutItsPermission_is403 (matrix, 11 rows)',
        t2: 'test 2 everyOperation_withOnlyItsPermission_isNot403 (matrix, 11 rows)',
        t345: 'tests 3, 4, 5 (problem shape, no permissions, role names and wildcards)',
        t6: 'test 6 everyApiHandler_declaresOnePermission (meta-test)'
      };

      const en = ui.toggle('@EnableMethodSecurity', true, update);
      const fin = ui.toggle('Method is final', false, update, { tone: 'danger' });
      const style = ui.choice('Annotation style', [
        { value: 'hasAuthority', label: 'hasAuthority' },
        { value: 'hasRole', label: 'hasRole' },
        { value: 'missing', label: 'Missing' }
      ], 'hasAuthority', update);
      const call = ui.choice('How the method is called', [
        { value: 'http', label: 'Through the proxy (HTTP)' },
        { value: 'self', label: 'Self-invocation' }
      ], 'http', update);
      const body = ui.choice('Request body', [
        { value: 'valid', label: 'Valid body' },
        { value: 'invalid', label: 'Invalid body' }
      ], 'valid', update);

      const nProxy = ui.node('Proxy (CGLIB)', 'security advice');
      const nMethod = ui.node('requestDeployment', 'the method body');
      const nBind = ui.node('Argument binding', '@Valid @RequestBody');
      const caught = h('ul', { class: 'small' });
      const rRuns = ui.readout('Does the method run');
      const rStatus = ui.readout('Status for a caller without deployment:create');
      const rRed = ui.readout('Tests red out of 27');
      const verdict = ui.verdict();

      function update() {
        const enabled = en.get();
        const isFinal = fin.get();
        const st = style.get();
        const viaHttp = call.get() === 'http';
        const valid = body.get() === 'valid';

        const proxied = enabled && !isFinal;
        const annotated = st !== 'missing';
        const exprOk = st === 'hasAuthority';
        const enforced = viaHttp && proxied && annotated;   // hasRole also refuses this caller
        const bound = !viaHttp || valid;                    // an invalid body is a 400 before the proxy is reached

        let runs;
        let status;
        if (!bound) { runs = false; status = '400 (validation first)'; }
        else if (enforced) { runs = false; status = '403 forbidden problem'; }
        else { runs = true; status = '202 accepted: unprotected'; }

        // which recorded tests go red for this configuration (they all call over HTTP with valid bodies)
        const red = [];
        const unprotectedOverHttp = !(proxied && annotated);
        if (unprotectedOverHttp) { red.push(TESTS.t1); red.push(TESTS.t345); }
        if (proxied && annotated && !exprOk) red.push(TESTS.t2);
        if (!annotated || !exprOk) red.push(TESTS.t6);

        AF.tone(nBind, !bound ? 'bad' : 'ok');
        AF.tone(nProxy, !viaHttp ? 'idle' : (proxied ? 'ok' : 'bad'));
        AF.tone(nMethod, runs ? 'bad' : 'idle');
        nProxy.lastChild.textContent = !viaHttp ? 'skipped: this.method()' : (!enabled ? 'not created: not enabled' : (isFinal ? 'cannot override a final method' : (annotated ? 'advice runs' : 'no advice to run')));
        nMethod.lastChild.textContent = runs ? 'body runs' : 'not reached';

        caught.replaceChildren(...(red.length ? red.map(t => h('li', null, t)) :
          [h('li', null, viaHttp ? 'none red: the suite agrees with the code' : 'none: every test calls the endpoint over HTTP')]));

        rRuns.set(runs ? 'yes' : 'no', runs ? 'bad' : 'ok');
        rStatus.set(status, runs ? 'bad' : (bound ? 'ok' : 'warn'));
        const rec = RECORDED[(enabled ? 'on' : 'off') + '|' + st + '|' + isFinal];
        rRed.set(rec ? rec.n + ' of 27 (recorded)' : 'count not recorded (' + red.length + ' kinds of test red)', red.length ? 'bad' : 'ok');

        let msg;
        let tone;
        if (!bound) {
          tone = 'warn';
          msg = 'Invalid body: a 400 comes back and the method never runs, but the permission check did not run either. Spring binds and validates the arguments before it calls the proxied method (test 7 pins this: a caller without the permission learns the validation rules before the 403, and nothing is read or changed).';
        } else if (!viaHttp && proxied && annotated) {
          tone = 'bad';
          msg = 'Self-invocation: this.requestDeployment(...) is a plain Java call on the real object, not on the proxy, so the advice is skipped. No controller does this today (S4.3 risk 3), so no recorded test covers it. Standard Spring behaviour, not measured in Appfleet.';
        } else if (runs) {
          tone = 'bad';
          msg = (!enabled ? 'Written but not enabled: @PreAuthorize is only metadata, nothing reads it.' : isFinal && annotated ? 'A final method cannot be overridden by the CGLIB subclass, so the advice never wraps it.' : !viaHttp ? 'The call skips the proxy.' : 'No annotation, nothing to check.') +
            ' The caller without the permission gets the 202. ' + (rec ? 'Recorded: ' + rec.n + ' of 27 red (' + rec.src + ').' : 'Not a recorded combination: the red groups listed are inferred from what each test checks.');
        } else if (!exprOk) {
          tone = 'warn';
          msg = 'hasRole(\'deployment:create\') looks for ROLE_deployment:create, so this caller is refused (the test that sends the permission-less token stays green) but so would a correct caller be. Only test 2 (token with exactly the permission) and the meta-test see it: 2 of 27 red in mutation (b).';
        } else {
          tone = 'ok';
          msg = 'Enforced: the proxy refuses before the body runs. AccessDeniedException is rethrown by ApiExceptionHandler.rethrowSecurity, translated by the filter chain and written by ProblemAccessDeniedHandler as urn:appfleet:problem:forbidden. 27 of 27 tests green (section 9.3).';
        }
        verdict.set(tone, msg);
      }

      el.append(
        controls(en.el, style.el, fin.el, call.el, body.el),
        stage(h('div', { class: 'sim-cols' },
          ui.panel('One request, left to right', h('div', { class: 'row' }, nBind, nProxy, nMethod)),
          ui.panel('Recorded tests that go red', caught))),
        readouts(rRuns, rStatus, rRed),
        note('The caller holds the other four permissions but not deployment:create (TestAuth.tokenWithout), calling POST /deployments. Counts of red tests are the recorded results of S4.3 section 9 (runs 1 and 2, mutations (b) to (d), the last three measured on the rollback method); the which-tests-go-red list is derived from what each test checks. Self-invocation and the exact behaviour of CGLIB on final methods are standard Spring behaviour that no control-api test exercises directly.'),
        verdict.el
      );
      update();
    }
  });


  // =====================================================================
  // Transaction propagation in the code: REQUIRED, REQUIRES_NEW, MANDATORY
  // =====================================================================
  AF.register({
    id: 'sp-propagation',
    group: 'spring',
    order: 13,
    title: 'Transaction propagation in the code: REQUIRED, REQUIRES_NEW, MANDATORY',
    question: 'The audit row survives a rollback and the outbox row must not: what one attribute makes the difference?',
    status: 'built',
    slice: 'S2, S3.3, S4.5',
    where: [
      'control-api/src/main/java/io/appfleet/control/audit/AuditEventRecorder.java, record: REQUIRES_NEW',
      'control-api/src/main/java/io/appfleet/control/deployment/DeploymentService.java, requestDeployment and requestRollback: plain @Transactional (REQUIRED)',
      'control-api/src/main/java/io/appfleet/control/outbox/OutboxWriter.java, write: MANDATORY (S4.5: called by DeploymentService.requestDeployment and requestRollback, OutboxWriteTest 4 of 4 green)',
      'DeploymentServiceAuditRecordingTest, DeploymentOptimisticLockTest, DeploymentEndpointsTest.concurrentRollbacks_one202_one409_exactlyOneTask, OutboxWriteTest',
      'docs/design/control-api/control-api-s3-3-deployments.md, section 5.2 and Results; control-api-s4-5-outbox.md, decision 1 and risk 7'
    ],
    idea: [
      'Propagation is the answer to one question: when a @Transactional method is called, what should it do about the transaction its caller already has? REQUIRED (the default) joins it, so the work commits or rolls back with the caller. REQUIRES_NEW suspends it and runs in a transaction of its own, which commits when the method returns whatever the caller does later. MANDATORY joins it too, but refuses to run without one and throws IllegalTransactionStateException. The earlier lesson on transaction boundaries showed REQUIRES_NEW and rollbackFor; this one puts the three side by side as they are used in three real classes.',
      'DeploymentService.requestDeployment and requestRollback are plain @Transactional, so REQUIRED: the deployment, the task and everything joined to them stand or fall together. AuditEventRecorder.record is REQUIRES_NEW on purpose, so an audit row survives a rollback. The price is documented in the S3.3 doc, section 5.2: the loser of a concurrent rollback fails at commit with 409 concurrent-modification, after its audit row has already committed, so an orphan ROLLBACK_REQUESTED row is left behind (10 of 10 runs there; DeploymentEndpointsTest expects two audit rows when the loser is concurrent-modification). OutboxWriter.write is MANDATORY for the opposite reason: the outbox row is a command to publish, so it must commit or roll back with the change and never alone (S4.5 decision 1, risk 7). The three annotations are the whole design.',
      'Two traps. Propagation is applied by the Spring proxy, so a call written as this.record(...) inside the same class skips the proxy and the attribute is ignored: REQUIRES_NEW becomes "join the caller" (the deliberately broken createBroken in DeploymentService, whose test is @Disabled) and MANDATORY stops checking anything (the proxy lesson, sp-proxy, explains why). And MANDATORY protects only against a missing transaction: it cannot stop a developer from writing REQUIRES_NEW on the outbox, which is why S4.5 plans a mutation check for exactly that. The S4.5 outbox is in the repo: OutboxWriter is called by both DeploymentService methods and OutboxWriteTest (4 tests, including the racing rollbacks) is green; the mutation to REQUIRES_NEW was shown red (two rows instead of one, 3 of 3 runs).'
    ],
    terms: [
      ['REQUIRED', 'The default. Join the caller’s transaction, or start one if there is none. Shares the caller’s fate.'],
      ['REQUIRES_NEW', 'Suspend the caller’s transaction and run in a new one that commits on return. Survives a later rollback of the caller.'],
      ['MANDATORY', 'Join the caller’s transaction, and throw IllegalTransactionStateException if there is none.'],
      ['Self-invocation', 'A method calling another method of the same object with this. The proxy is bypassed, so @Transactional on the callee is ignored.'],
      ['Orphan audit row', 'An audit row whose business change was rolled back after the audit committed. A documented gap in S3.3, fixed in S6.']
    ],
    tryIt: [
      'Leave "REQUIRES_NEW" for the audit and "MANDATORY" for the outbox, with "The request fails after both writes" on: one audit row stays, no outbox row. That is the repo’s design.',
      'Switch the outbox write to "REQUIRES_NEW": the outbox row survives the failure, so a command would be published for a change that never happened.',
      'Switch the audit write to "REQUIRED": the audit row now rolls back with the request, and the orphan disappears along with the audit trail.',
      'Turn off "Caller has a transaction" with "MANDATORY" selected: the exception appears and no outbox row is written.',
      'Turn on "Call the writers as this.method()": REQUIRES_NEW is ignored and MANDATORY no longer throws.'
    ],
    breakIt: 'Put REQUIRES_NEW on the outbox write, or call it as this.write(...) from inside the same class and then lose the race. The outbox row commits on its own and survives the rollback, so a message is published for a deployment that does not exist. S4.5 plans this as a mutation check: with the write moved to REQUIRES_NEW, the test that races two rollbacks must fail because the loser’s row survives.',
    say: 'Audit is REQUIRES_NEW because it must survive a rollback, accepting the orphan row of a lost race; the outbox write is MANDATORY because it must never commit alone, so calling it without a transaction fails loudly instead of silently breaking the guarantee.',
    quiz: {
      q: 'OutboxWriter.write is @Transactional(propagation = MANDATORY). A new class calls it, through the injected bean, from a method that has no transaction. What happens?',
      options: [
        'It starts its own transaction and commits the row, like REQUIRED',
        'It throws IllegalTransactionStateException before saving anything',
        'It runs without a transaction and the repository save commits on its own',
        'It waits until a transaction exists on the thread'
      ],
      answer: 1,
      why: 'MANDATORY means "there must already be a transaction". Through the proxy, Spring checks that and throws IllegalTransactionStateException. Option 3 is what happens if the call skips the proxy (this.write(...)), which is exactly the silent failure the proxy lesson warns about.'
    },
    mount(el, ctx) {
      // Standard Spring propagation rules; the repo facts are the three annotations and the documented 5.2 gap.
      const audP = ui.choice('Audit write propagation', [
        { value: 'REQUIRED', label: 'REQUIRED' },
        { value: 'REQUIRES_NEW', label: 'REQUIRES_NEW' }
      ], 'REQUIRES_NEW', update);
      const outP = ui.choice('Outbox write propagation', [
        { value: 'REQUIRED', label: 'REQUIRED' },
        { value: 'REQUIRES_NEW', label: 'REQUIRES_NEW' },
        { value: 'MANDATORY', label: 'MANDATORY' }
      ], 'MANDATORY', update);
      const outer = ui.toggle('Caller has a transaction', true, update);
      const fail = ui.toggle('The request fails after both writes (lost optimistic-lock race)', true, update, { tone: 'danger' });
      const self = ui.toggle('Call the writers as this.method() (same class)', false, update, { tone: 'danger' });

      const log = ui.log({ label: 'What each call does' });
      const verdict = ui.verdict();
      const code = ui.code('', 'Model of the service method');
      const rResp = ui.readout('Response');
      const rTask = ui.readout('deployment and task rows');
      const rAud = ui.readout('audit_event rows');
      const rOut = ui.readout('outbox_message rows');
      const rTest = ui.readout('Pinned by');
      const laneAud = ui.lane('audit_event', 'committed rows');
      const laneOut = ui.lane('outbox_message', 'committed rows');

      function propModel() {
        const cfg = { aud: audP.get(), out: outP.get(), outer: outer.get(), fail: fail.get(), self: self.get() };
        const steps = [];
        const eff = p => (cfg.self ? 'NONE' : p);
        let audit = 'none';
        let outbox = 'none';
        let exception = false;

        function write(name, p) {
          if (p === 'NONE') {
            steps.push([name + ': the call skipped the proxy, so the annotation is ignored', 'warn']);
            if (cfg.outer) { steps.push(['INSERT ' + name + ' inside the caller’s transaction, uncommitted', 'busy']); return 'pending'; }
            steps.push(['INSERT ' + name + ', no transaction: the repository’s own transaction commits it at once', 'busy']);
            return 'committed';
          }
          if (p === 'REQUIRES_NEW') {
            if (cfg.outer) steps.push(['caller’s transaction suspended', 'idle']);
            steps.push(['BEGIN; INSERT ' + name + '; COMMIT;   -- REQUIRES_NEW: durable now, whatever happens next', 'ok']);
            if (cfg.outer) steps.push(['caller’s transaction resumed', 'idle']);
            return 'committed';
          }
          if (p === 'MANDATORY') {
            if (cfg.outer) { steps.push(['INSERT ' + name + ' inside the caller’s transaction, uncommitted (MANDATORY: joined)', 'busy']); return 'pending'; }
            steps.push(['IllegalTransactionStateException: No existing transaction found for transaction marked with propagation "mandatory"', 'bad']);
            return 'thrown';
          }
          if (cfg.outer) { steps.push(['INSERT ' + name + ' inside the caller’s transaction, uncommitted (REQUIRED: joined)', 'busy']); return 'pending'; }
          steps.push(['BEGIN; INSERT ' + name + '; COMMIT;   -- REQUIRED with no caller transaction: starts one and commits', 'busy']);
          return 'committed';
        }

        if (cfg.outer) steps.push(['BEGIN   -- requestDeployment (@Transactional, REQUIRED): INSERT deployment, INSERT task', 'busy']);
        else steps.push(['no transaction is open: a test or a plain method is calling the writers directly', 'warn']);
        audit = write('audit_event', eff(cfg.aud));
        outbox = write('outbox_message', eff(cfg.out));
        if (outbox === 'thrown') { exception = true; outbox = 'none'; }

        if (cfg.outer) {
          if (cfg.fail) {
            steps.push(['ROLLBACK   -- the commit fails (ObjectOptimisticLockingFailureException): every row still uncommitted is discarded', 'bad']);
            if (audit === 'pending') audit = 'none';
            if (outbox === 'pending') outbox = 'none';
          } else {
            steps.push(['COMMIT   -- the change and every joined row become durable together', 'ok']);
            if (audit === 'pending') audit = 'committed';
            if (outbox === 'pending') outbox = 'committed';
          }
        } else if (cfg.fail && !exception) {
          steps.push(['the request then fails, but there is no transaction to roll back: the rows above stay', 'warn']);
        }
        return { cfg, steps, audit, outbox, exception };
      }

      function snippet(cfg) {
        const note1 = p => (cfg.self ? '   // this.method(): proxy skipped, annotation ignored' : '   // ' + p);
        const lines = [
          cfg.outer ? '@Transactional                                  // REQUIRED' : '// no @Transactional on the calling method',
          'public DeploymentAccepted requestDeployment(...) {',
          '    deploymentRepository.saveAndFlush(deployment);',
          '    taskRepository.save(task);',
          '    ' + (cfg.self ? 'this.' : 'auditEventRecorder.') + 'record(auditEvent);' + note1('@Transactional(propagation = ' + cfg.aud + ')'),
          '    ' + (cfg.self ? 'this.' : 'outboxWriter.') + 'write(command);' + note1('@Transactional(propagation = ' + cfg.out + ')'),
          cfg.fail ? '    // ... the commit then loses the optimistic-lock race' : '    return accepted;',
          '}'
        ];
        return lines.join('\n');
      }

      function pinned(cfg, m) {
        if (cfg.self && cfg.outer) return 'DeploymentServiceAuditRecordingTest.createBroken (@Disabled: the deliberate bug)';
        if (cfg.outer && cfg.aud === 'REQUIRES_NEW' && cfg.fail && !cfg.self && cfg.out !== 'REQUIRES_NEW') {
          return 'DeploymentServiceAuditRecordingTest.create_auditRowSurvivesRollback; DeploymentEndpointsTest.concurrentRollbacks (2 audit rows)';
        }
        if (cfg.outer && !cfg.fail && cfg.out !== 'REQUIRES_NEW') return 'OutboxWriteTest: one row per accepted request';
        if (cfg.out === 'REQUIRES_NEW' && cfg.fail) return 'S4.5 mutation check (a), planned: the racing-rollbacks test must go red';
        if (m.exception) return 'no test in the repo yet for this exception';
        return 'standard Spring behaviour, no Appfleet test for this combination';
      }

      function update() {
        const m = propModel();
        const cfg = m.cfg;
        setCode(code, snippet(cfg));
        AF.clear(log.el);
        m.steps.forEach(st => log.add(st[0], st[1]));

        const changeCommitted = cfg.outer && !cfg.fail && !m.exception;
        rResp.set(m.exception ? 'IllegalTransactionStateException' : cfg.fail ? 'fails: 409 concurrent-modification' : '202 Accepted', m.exception || cfg.fail ? 'bad' : 'ok');
        rTask.set(!cfg.outer ? 'none: no transaction' : changeCommitted ? '1 (committed)' : '0 (rolled back)', cfg.outer ? (changeCommitted ? 'ok' : 'idle') : 'idle');
        rAud.set(m.audit === 'committed' ? '1' : '0', m.audit === 'committed' ? (changeCommitted ? 'ok' : 'warn') : null);
        rOut.set(m.outbox === 'committed' ? '1' : '0', m.outbox === 'committed' ? (changeCommitted ? 'ok' : 'bad') : null);
        rTest.set(pinned(cfg, m));

        AF.clear(laneAud.body);
        AF.clear(laneOut.body);
        if (m.audit === 'committed') laneAud.body.appendChild(ui.token(changeCommitted ? 'DEPLOYMENT_REQUESTED' : 'DEPLOYMENT_REQUESTED (orphan)', changeCommitted ? 'ok' : 'warn'));
        else laneAud.body.appendChild(h('span', { class: 'small muted' }, 'empty'));
        if (m.outbox === 'committed') laneOut.body.appendChild(ui.token(changeCommitted ? 'DEPLOY command' : 'DEPLOY command (no change behind it)', changeCommitted ? 'ok' : 'bad'));
        else laneOut.body.appendChild(h('span', { class: 'small muted' }, 'empty'));

        const outboxBad = m.outbox === 'committed' && !changeCommitted;
        const auditOrphan = m.audit === 'committed' && !changeCommitted;
        if (m.exception) {
          verdict.set('ok', 'MANDATORY refused to run: IllegalTransactionStateException, and no outbox row was written. A missing transaction is a loud failure, not a silent one.' +
            (m.audit === 'committed' ? ' The audit row, written before it, committed on its own.' : ''));
        } else if (outboxBad && !cfg.outer) {
          verdict.set('bad', 'The outbox row committed on its own with no change behind it. This is the guarantee MANDATORY exists to stop: with this setting nothing complains.');
        } else if (outboxBad) {
          verdict.set('bad', 'The outbox row survived a rolled-back change. A poller would publish a command for a deployment that does not exist. S4.5 forbids this (decision 1, risk 7).');
        } else if (auditOrphan) {
          verdict.set('warn', 'The audit row survived the rollback, as intended, so a lost race leaves an orphan audit row. This is the documented S3.3 gap, fixed in S6 with an AFTER_COMMIT listener. The outbox row rolled back with the change.');
        } else if (changeCommitted) {
          verdict.set('ok', 'No failure: the change, its audit row and (with the outbox wired) its command all committed together.');
        } else {
          verdict.set('ok', 'Everything that joined the caller’s transaction rolled back with it, and nothing was left behind.');
        }
      }

      el.append(
        controls(audP.el, outP.el, outer.el, fail.el, self.el),
        stage(h('div', { class: 'sim-cols' },
          ui.panel('The service method', code),
          ui.panel('What each call does', log.el)),
          h('div', { class: 'sim-cols' }, laneAud.el, laneOut.el)),
        readouts(rResp, rTask, rAud, rOut, rTest),
        note('Standard Spring propagation rules, modelled; the exception text is Spring’s own message. The outbox is in the repo (S4.5): OutboxWriter is called by DeploymentService and OutboxWriteTest is green, and the poller exists (OutboxPollerTest 2 of 2). The 409 and the orphan audit row of a lost race are observed behaviour in S3.3 (Results, 10 of 10 runs).'),
        verdict.el
      );
      update();
    }
  });

  // =====================================================================
  // KafkaTemplate, acks and the idempotent producer
  // =====================================================================
  AF.register({
    id: 'sp-kafka-producer',
    group: 'spring',
    order: 14,
    title: 'KafkaTemplate, acks and the idempotent producer',
    question: 'What does send() really guarantee, and which three settings turn a fire-and-forget send into one you can mark a database row sent for?',
    status: 'progress',
    slice: 'S4.5',
    where: [
      'docs/design/control-api/control-api-s4-5-outbox.md, decisions 5 to 8 and section 5 (the poller is built; its behaviour under failure is not measured yet)',
      'docker-compose.yml: kafka (apache/kafka:3.8.0, one broker) and kafka-init (task.work has 6 partitions, replication factor 1)',
      'control-api/src/main/resources/application.yml: spring.kafka.bootstrap-servers; control-api/pom.xml: spring-kafka',
      'docs/specs/project/03-TASK-SERVICE.md: idempotencyToken "set by control-api, carried end-to-end" and the idempotent consumer',
      'control-api-s4-5-outbox.md, test 13 producerIsConfiguredForReliability and test 10 crashAfterSend_resendsTheMessage (planned)'
    ],
    idea: [
      'KafkaTemplate.send returns at once with a CompletableFuture: the record is only put in a buffer, and a background thread sends it later. So a send() that returns says nothing about delivery. Three things decide what the future eventually means. acks sets who must confirm: 0 nobody (fire and forget), 1 the partition leader, all every in-sync replica. enable.idempotence=true gives the producer an id and numbers each record per partition, so the broker discards a retry of a batch it already wrote and keeps order while retrying. And you must wait for the future (get with a timeout) before you act on it. delivery.timeout.ms and max.block.ms bound how long a send can hang when the broker is down.',
      'Appfleet’s S4.5 design (decisions 5 to 8) uses all three: acks=all, enable.idempotence=true, and a poller that waits for each acknowledgement before it sets sent_at on the outbox row, so a row is marked sent only after the broker has the message. The record key is the deployment id, so every command of one deployment lands in one partition, in order (task.work has 6 partitions in docker-compose.yml). Bounded timeouts make a dead broker fail a poll cycle in seconds. This is designed in control-api-s4-5-outbox.md and not built yet: nothing in control-api uses KafkaTemplate today.',
      'It still gives at-least-once, not exactly-once. Idempotence works inside one producer session: if the process dies after Kafka acknowledged and before the database commit of sent_at, the row is still pending, a new producer with a new id sends it again, and Kafka cannot tell. The design accepts that (S4.5 section 2): consumers deduplicate on idempotencyToken, the Task id (03-TASK-SERVICE.md). One honest limit of the dev setup: compose runs one broker with replication factor 1, so there are no followers and the leader-change case below cannot happen there. Everything in this lab is standard documented Kafka behaviour, not something Appfleet has measured; S4.5 measures it.'
    ],
    terms: [
      ['acks', 'How many brokers must confirm a write: 0 none, 1 the leader, all every in-sync replica (with min.insync.replicas deciding how few may remain).'],
      ['enable.idempotence', 'The producer gets an id and a sequence number per partition, so the broker drops a duplicate retry and keeps order. Valid only within one producer session.'],
      ['delivery.timeout.ms', 'Upper bound on the time from send() until success or failure is reported, retries included. After it, the future fails.'],
      ['max.block.ms', 'How long send() itself may block, for example waiting for metadata when the broker is down.'],
      ['Record key', 'Hashed to pick the partition. The same key always goes to the same partition, which is what keeps one deployment’s commands in order.'],
      ['idempotencyToken', 'A value carried in the command (the Task id) so a consumer can recognise a message it has already processed.']
    ],
    tryIt: [
      'Press "Appfleet S4.5 design" (acks all, idempotence on, wait on) and walk through the four failures: nothing is lost, nothing is reordered, the row is never marked sent early, and the only cost is a duplicate after "Producer crashes after the ack".',
      'Press "Fire and forget" (acks 0, idempotence off, wait off): "Broker restarts mid-send" shows a message that can vanish while the row is already marked sent.',
      'Set "acks" to 1 with "Leader changes": the leader answered and then died, so the acknowledged message is lost. Switch to "all" and it is not.',
      'Keep "acks" 1 or "all", turn "Idempotent producer" off and pick "Broker restarts mid-send": a retried batch can be duplicated. Turn it on and the duplicate goes away.',
      'Turn "Wait for the ack before marking sent" off under "acks" all: the row is marked sent before the broker answered, and an outage that outlasts delivery.timeout.ms is never noticed.'
    ],
    breakIt: 'Mark the row sent as soon as send() returns, without waiting. The future is the only place a failure is reported, and nobody reads it, so a broker that is down longer than delivery.timeout.ms silently loses every message that was already marked sent. Mutation check (c) in S4.5 plans exactly this: markSent before the send must turn the lost-message tests red.',
    say: 'send() is asynchronous, so I use acks=all, enable.idempotence=true and bounded timeouts, wait for the acknowledgement before marking the outbox row sent, and still design consumers to deduplicate on the idempotency token because a crash between the ack and the commit gives at-least-once.',
    quiz: {
      q: 'The poller calls send() and immediately marks the outbox row sent, with acks=all and idempotence on. The broker is down for longer than delivery.timeout.ms. What happens to those messages?',
      options: [
        'They are retried forever by the idempotent producer, so nothing is lost',
        'They are duplicated when the broker returns, because idempotence only reorders',
        'The futures fail after the timeout, but the rows are already marked sent, so the messages are lost for good',
        'send() blocks the poller until the broker returns'
      ],
      answer: 2,
      why: 'Retries stop at delivery.timeout.ms and the failure is reported only on the future. Marking the row sent without waiting for that future means nobody sees the failure. acks=all and idempotence protect a send that the producer is still allowed to retry; they do nothing for a result nobody reads.'
    },
    mount(el, ctx) {
      // Standard documented Kafka producer behaviour. Nothing here is measured in Appfleet.
      const acks = ui.choice('acks', [
        { value: '0', label: '0' },
        { value: '1', label: '1' },
        { value: 'all', label: 'all' }
      ], 'all', update);
      const idem = ui.toggle('Idempotent producer (enable.idempotence)', true, update);
      const fail = ui.choice('Failure injected', [
        { value: 'none', label: 'None' },
        { value: 'restart', label: 'Broker restarts mid-send' },
        { value: 'leader', label: 'Leader changes' },
        { value: 'crash', label: 'Producer crashes after the ack' }
      ], 'restart', update);
      const wait = ui.toggle('Wait for the ack before marking sent', true, update);
      const presetA = ui.button('Appfleet S4.5 design', () => { acks.set('all'); idem.set(true); wait.set(true); update(); }, { small: true });
      const presetB = ui.button('Fire and forget', () => { acks.set('0'); idem.set(false); wait.set(false); update(); }, { small: true, variant: 'quiet' });

      const verdict = ui.verdict();
      const code = ui.code('', 'Producer settings and the poller sketch');
      const rLost = ui.readout('Message can be lost');
      const rDup = ui.readout('Message can be duplicated');
      const rOrder = ui.readout('Messages can be reordered');
      const rEarly = ui.readout('Row marked sent too early');
      const whyBox = h('div', { class: 'small' });

      const yes = (why) => ({ v: 'yes', why });
      const no = (why) => ({ v: 'no', why });
      const maybe = (why) => ({ v: 'maybe', why });

      function evaluate() {
        const a = acks.get();
        const id = idem.get();
        const f = fail.get();
        const w = wait.get();
        const r = { lost: null, dup: null, order: null, early: null };

        // lost
        if (f === 'none') r.lost = no('No failure: the record reaches the broker.');
        else if (a === '0') {
          r.lost = f === 'crash'
            ? (w ? no('The record was written to the socket before the crash; with acks=0 that is all the "ack" means.')
              : yes('The record may still sit in the producer’s buffer when the process dies, and the row is already marked sent.'))
            : yes('acks=0 never reads the broker’s answer: a record sent to a restarting broker or a stale leader just disappears.');
        } else if (f === 'leader') {
          r.lost = a === '1'
            ? yes('The old leader acknowledged, then died before its followers copied the record. The new leader does not have it.')
            : no('acks=all waits for every in-sync replica, so the new leader has the record (assuming min.insync.replicas is at least 2).');
        } else if (f === 'restart') {
          r.lost = w
            ? no('The producer retries inside delivery.timeout.ms; past it the future fails and, because we wait, the row stays pending.')
            : maybe('If the outage outlasts delivery.timeout.ms the future fails, but nobody reads it and the row is already marked sent.');
        } else {
          r.lost = no('The ack was already received before the crash.');
        }

        // duplicated
        if (f === 'none') r.dup = no('A single clean send.');
        else if (f === 'crash') {
          r.dup = w
            ? yes('The row is still pending after the crash, so a new producer sends it again. Its producer id is new, so idempotence cannot recognise it. This is the at-least-once case.')
            : no('The row was marked sent before the crash, so it is not sent again (the price is the loss risk).');
        } else if (a === '0') r.dup = no('With acks=0 there are no errors to retry on.');
        else r.dup = id
          ? no('Producer id and sequence numbers: the broker drops a retry of a batch it already wrote.')
          : yes('The broker wrote the batch but the ack was lost, so the producer retries and the broker stores it twice.');

        // reordered
        if (f === 'none' || f === 'crash' || a === '0') r.order = no(a === '0' && f !== 'none' && f !== 'crash' ? 'No retries happen, so no reordering (the cost is loss).' : 'Nothing is retried.');
        else if (id) r.order = no('With idempotence the broker orders by sequence number, even with several batches in flight.');
        else if (w) r.order = no('Waiting for each ack means one record in flight at a time, so a retry cannot overtake the next record.');
        else r.order = yes('Batch 1 fails and is retried after batch 2 succeeded, because the producer allows up to 5 requests in flight (the default).');

        // marked sent too early
        if (!w) r.early = yes('The row is marked sent as soon as send() returns, before any broker has answered.');
        else if (a === '0') r.early = yes('The future completes once the record is written to the socket. acks=0 never waits for the broker.');
        else if (a === '1') r.early = f === 'leader'
          ? yes('The leader answered, so the row was marked sent, then the leader died before replicating.')
          : no('The leader has it, but only the leader: a leader change would lose it.');
        else r.early = no('Every in-sync replica has the record when the future completes.');
        return r;
      }

      function snippet() {
        const lines = [
          '# producer configuration (S4.5 decision 8; timeout values are chosen when it is built)',
          'acks                = ' + acks.get(),
          'enable.idempotence  = ' + idem.get(),
          'delivery.timeout.ms = <bounded>',
          'max.block.ms        = <bounded>',
          '',
          '// poller sketch of OutboxPoller.cycle (S4.5, in the repo)',
          wait.get()
            ? 'kafkaTemplate.send("task.work", deploymentId, json).get(<timeout>);   // blocks for the ack\nmarkSent(row);'
            : 'kafkaTemplate.send("task.work", deploymentId, json);                  // returns a future nobody reads\nmarkSent(row);'
        ];
        return lines.join('\n');
      }

      const tone = c => (c.v === 'no' ? 'ok' : c.v === 'maybe' ? 'warn' : 'bad');
      const word = c => (c.v === 'no' ? 'no' : c.v === 'maybe' ? 'possible' : 'yes');

      function update() {
        const r = evaluate();
        setCode(code, snippet());
        rLost.set(word(r.lost), tone(r.lost));
        // A duplicate is the accepted at-least-once cost, shown as a warning rather than an error.
        rDup.set(word(r.dup), r.dup.v === 'no' ? 'ok' : 'warn');
        rOrder.set(word(r.order), tone(r.order));
        rEarly.set(word(r.early), tone(r.early));
        AF.clear(whyBox);
        [['Lost', r.lost], ['Duplicated', r.dup], ['Reordered', r.order], ['Marked sent too early', r.early]].forEach(p => {
          whyBox.appendChild(h('p', null, h('b', null, p[0] + ': '), p[1].why));
        });

        const bad = r.lost.v === 'yes' || r.early.v === 'yes' || r.order.v === 'yes';
        const maybeBad = r.lost.v === 'maybe';
        if (bad) {
          verdict.set('bad', 'Not safe to mark a row sent on this setting: ' +
            [r.lost.v === 'yes' ? 'the message can be lost' : null, r.order.v === 'yes' ? 'order can break' : null, r.early.v === 'yes' ? 'the row can be marked sent before the broker has the message' : null].filter(Boolean).join(', ') + '. Standard Kafka behaviour, not measured in Appfleet.');
        } else if (maybeBad) {
          verdict.set('warn', 'A failed send can go unnoticed because nobody waits for the future. Standard Kafka behaviour, not measured in Appfleet.');
        } else if (r.dup.v === 'yes') {
          verdict.set('warn', 'Nothing is lost and order holds, but the message can arrive twice. That is the at-least-once contract of S4.5: consumers deduplicate on idempotencyToken.');
        } else {
          verdict.set('ok', 'No loss, no reordering, no duplicate, and the row is marked sent only once the broker has the message. Standard Kafka behaviour; Appfleet measures it in S4.5.');
        }
      }

      el.append(
        controls(acks.el, idem.el, fail.el, wait.el, presetA, presetB),
        stage(h('div', { class: 'sim-cols' },
          ui.panel('Settings', code),
          ui.panel('Why', whyBox))),
        readouts(rLost, rDup, rOrder, rEarly),
        note('Standard Kafka behaviour; Appfleet measures it in S4.5. Nothing on this page is measured. The poller now exists (OutboxPollerTest 2 of 2: one record per row, in order), but its failure behaviour (dead broker, crash after send) is still to be tested. "Possible" means the outcome depends on timing. The dev compose has one broker with replication factor 1, so "Leader changes" cannot happen there; the lab shows what a replicated cluster does. With min.insync.replicas of 1, acks=all can degrade to the behaviour of acks=1.'),
        verdict.el
      );
      update();
    }
  });


  // ===== Lesson sp-mvc =====
  AF.register({
    id: 'sp-mvc',
    group: 'spring',
    order: 9,
    title: 'From socket to controller and back: the MVC pipeline',
    question: 'Which stage answers a request first: authentication, the rate limiter, validation or the permission check, and how did the order surprise us?',
    status: 'built',
    slice: 'S3, S4.1 to S4.4',
    where: [
      'control-api/src/main/java/io/appfleet/control/web/SecurityConfig.java, WebConfig.java, ApiExceptionHandler.java, CorrelationIdFilter.java',
      'ratelimit/RateLimitInterceptor.java; deployment/web/DeploymentController.java (@Valid, @PreAuthorize, @Min/@Max)',
      'PermissionEnforcementTest.noPermission_withInvalidBody_answer; RateLimitEndpointsTest.unknownRoutes_spendTokens; JwtAuthenticationTest',
      'docs/design/control-api/control-api-s4-3-method-security.md (section 9.3), control-api-s4-1-jwt-validation.md, control-api-s3-6-rate-limiting.md (case 8)'
    ],
    idea: [
      'A request does not go straight to your controller. Tomcat reads the socket and hands a servlet request to a chain of servlet filters (the Spring Security chain is one of them). The last servlet is Spring MVC’s DispatcherServlet, which finds the handler method, runs the HandlerInterceptors’ preHandle, resolves the arguments (@PathVariable, @RequestBody through Jackson, @Valid, @RequestParam with @Min and @Max), and only then calls the controller. If @EnableMethodSecurity is on, the controller is a proxy, so @PreAuthorize runs when the method is called, after the arguments exist. The return value goes through a message converter; an exception goes to a HandlerExceptionResolver such as the @RestControllerAdvice.',
      'In control-api the order is: CorrelationIdFilter (@Order(HIGHEST_PRECEDENCE), so it runs first and stamps X-Correlation-Id), the security chain from SecurityConfig (a missing, expired or bad bearer token is a 401 before anything else), the DispatcherServlet, RateLimitInterceptor (registered in WebConfig for /api/**; it runs after authentication on purpose, so it can key the bucket on the token’s sub), argument resolution, then the @PreAuthorize proxy on DeploymentController, then the method. ApiExceptionHandler turns exceptions into problem+json. Three findings are recorded in the repo. A caller without permission who sends an invalid body gets a 400, not a 403, because Spring validates the body before it calls the proxied method (S4.3 section 9.3, test noPermission_withInvalidBody_answer). Unknown routes under /api spend rate-limit tokens before they become 404 (RateLimitEndpointsTest.unknownRoutes_spendTokens). And the catch-all @ExceptionHandler(Exception.class) turned AccessDeniedException into a 500 until it was told to rethrow the security exceptions (S4.1, found by test 19).',
      'What the pipeline does not do is protect you from your own ordering assumptions. "Authentication first" is true because the security chain is a filter and filters wrap MVC. "Permission before validation" is false because the check is a method proxy and the body is read before the method is called. A permission failure and a validation failure can both be true of one request; the order decides which one the caller sees, and the 400 tells a caller without permission that the endpoint exists and what its body looks like. Appfleet accepted that and pinned it with a test so a change has to be deliberate.'
    ],
    terms: [
      ['Servlet filter', 'Code that wraps the whole request before Spring MVC sees it. The Spring Security chain and CorrelationIdFilter are filters. A filter cannot use the @RestControllerAdvice, so it must write its own problem+json.'],
      ['DispatcherServlet', 'Spring MVC’s front controller. It maps the URL to a handler method, runs interceptors, resolves arguments, calls the method and writes the result.'],
      ['HandlerInterceptor', 'preHandle runs after the handler is chosen and before the arguments are resolved. An exception thrown there goes through the @RestControllerAdvice. RateLimitInterceptor is one.'],
      ['Argument resolution', '@PathVariable and @RequestParam are converted, @RequestBody is read by Jackson, @Valid and @Min/@Max are checked. A failure here is a 400 and the controller body never runs.'],
      ['Method-security proxy', 'With @EnableMethodSecurity the controller bean is wrapped by a proxy that evaluates @PreAuthorize when the method is called, which is after argument resolution.'],
      ['Rethrown security exceptions', 'ApiExceptionHandler has a handler for AccessDeniedException and AuthenticationException that only rethrows, so they escape the catch-all and reach the filter chain’s ProblemAccessDeniedHandler.']
    ],
    tryIt: [
      'Leave the defaults (POST /deployments, Valid token, permission held, Valid body, Full bucket) and read the answer: 202 from the controller. This is DeploymentEndpointsTest.requestDeployment_returns202_andWritesDeploymentTaskAndAudit.',
      'Set Token to "No token", then change Permission, Body and Bucket. Nothing changes: the security chain answers 401 before any of them is looked at.',
      'Set Token to "Valid", Permission to "Not held" and Body to "Invalid ({})". The answer is 400, not 403. Then set Body back to "Valid" and it becomes 403.',
      'Set Bucket to "Empty" with Permission "Not held" and Body "Invalid ({})": the answer is 429. The limiter runs before argument resolution and the permission check. The lab labels this combination as inferred from the order.',
      'Set Route to "Unknown /api/v1/nope" with a Valid token and a Full bucket: 404, and the readout shows a token was spent. Then turn off "Catch-all advice rethrows security exceptions" with Permission "Not held" and a Valid body to see the 500 the S4.1 test caught.'
    ],
    breakIt: 'Turn off "Catch-all advice rethrows security exceptions". @PreAuthorize throws AccessDeniedException inside the controller call, so MVC sees it first, and the @ExceptionHandler(Exception.class) answers 500 internal-error. ProblemAccessDeniedHandler in the filter chain never gets a chance. That is what Appfleet saw in S4.1 before it added the rethrow handler, and a MockMvc slice test would not have shown it because it skips the real filter chain.',
    say: 'A request meets the filters first, so a bad token is a 401 before anything else; then the DispatcherServlet runs the rate-limit interceptor, resolves and validates the arguments, and only then calls the @PreAuthorize proxy, which is why a caller without permission and with an invalid body gets a 400 and why our catch-all advice must rethrow security exceptions.',
    quiz: {
      q: 'A token that lacks deployment:create sends POST /api/v1/deployments with the body {}. The bucket is full. What does control-api answer?',
      options: [
        '403, because the permission check runs before anything reads the body',
        '400 validation-failed, because @Valid runs before the @PreAuthorize proxy is called',
        '401, because a token without the permission is not an authenticated caller',
        '422, because the empty body reaches the service and the service rejects it'
      ],
      answer: 1,
      why: 'Spring resolves and validates the @RequestBody before it calls the proxied controller method, and @PreAuthorize runs inside that call. S4.3 section 9.3 predicted the 400 and PermissionEnforcementTest.noPermission_withInvalidBody_answer pins it.'
    },
    mount(el, ctx) {
      const STAGES = [
        { id: 'corr', name: 'CorrelationIdFilter', sub: 'filter, runs first' },
        { id: 'sec', name: 'Security filter chain', sub: 'bearer token' },
        { id: 'rate', name: 'RateLimitInterceptor', sub: 'preHandle, key = sub' },
        { id: 'args', name: 'Argument resolution', sub: '@RequestBody, @Valid' },
        { id: 'perm', name: '@PreAuthorize proxy', sub: 'method security' },
        { id: 'ctl', name: 'Controller', sub: 'return value, converter' }
      ];
      const ORDER = STAGES.map(x => x.id);
      const PROBLEM = 'urn:appfleet:problem:';

      const route = ui.choice('Route', [
        { value: 'known', label: 'POST /deployments' },
        { value: 'unknown', label: 'Unknown /api/v1/nope' }
      ], 'known', update);
      const token = ui.choice('Token', [
        { value: 'none', label: 'No token' },
        { value: 'expired', label: 'Expired' },
        { value: 'valid', label: 'Valid' }
      ], 'valid', update);
      const perm = ui.choice('Permission', [
        { value: 'held', label: 'deployment:create held' },
        { value: 'missing', label: 'Not held' }
      ], 'held', update);
      const body = ui.choice('Body', [
        { value: 'valid', label: 'Valid' },
        { value: 'invalid', label: 'Invalid ({})' }
      ], 'valid', update);
      const bucket = ui.choice('Bucket', [
        { value: 'full', label: 'Full' },
        { value: 'empty', label: 'Empty' }
      ], 'full', update);
      const rethrow = ui.toggle('Catch-all advice rethrows security exceptions', true, update, { tone: 'danger' });

      const row = h('div', { style: 'display:flex;flex-wrap:wrap;gap:8px;align-items:stretch' });
      const nodes = STAGES.map(st => ui.node(st.name, st.sub));
      nodes.forEach((n, i) => {
        if (i > 0) row.append(h('span', { class: 'muted', style: 'align-self:center', 'aria-hidden': 'true' }, '→'));
        row.append(n);
      });
      const trail = h('p', { class: 'small' });

      const rStage = ui.readout('Answered by');
      const rStatus = ui.readout('Status');
      const rType = ui.readout('Problem type');
      const rSpent = ui.readout('Bucket token spent');
      const verdict = ui.verdict();

      function evidence(r) {
        const t = token.get(), p = perm.get(), b = body.get(), f = bucket.get();
        if (route.get() === 'unknown') {
          if (t === 'valid' && f === 'full') return 'tested: RateLimitEndpointsTest.unknownRoutes_spendTokens and JwtAuthenticationTest.apiPath_withToken_reachesMvc_andReturnsOurProblemShape (both GET).';
          return 'not tested as this combination; it follows from the order of the stages in the code.';
        }
        if (r.status === 500) return 'recorded in S4.1: the catch-all advice turned AccessDeniedException into a 500 and test 19 caught it. This exact combination was not re-run with the rethrow removed.';
        if (t === 'none' && p === 'held' && b === 'valid' && f === 'full') return 'tested: JwtAuthenticationTest.noToken_is401_withProblemShape (on GET /applications).';
        if (t === 'expired' && p === 'held' && b === 'valid' && f === 'full') return 'tested: JwtAuthenticationTest.expired_is401 (on GET /applications).';
        if (t === 'valid' && p === 'held' && b === 'valid' && f === 'full') return 'tested: DeploymentEndpointsTest.requestDeployment_returns202_andWritesDeploymentTaskAndAudit.';
        if (t === 'valid' && p === 'held' && b === 'valid' && f === 'empty') return 'tested: RateLimitEndpointsTest.fourthRequest_is429_withRetryAfter (on GET /applications, same interceptor).';
        if (t === 'valid' && p === 'missing' && b === 'valid' && f === 'full') return 'tested: PermissionEnforcementTest.everyOperation_withoutItsPermission_is403.';
        if (t === 'valid' && p === 'missing' && b === 'invalid' && f === 'full') return 'tested: PermissionEnforcementTest.noPermission_withInvalidBody_answer (S4.3 section 9.3).';
        if (t === 'valid' && p === 'held' && b === 'invalid' && f === 'full') return 'tested: DeploymentEndpointsTest.emptyObject_returns400_listingEveryField.';
        return 'not tested as this combination; it follows from the order of the stages in the code, not from a recorded run.';
      }

      function outcome() {
        const t = token.get(), p = perm.get(), b = body.get(), f = bucket.get();
        const unknown = route.get() === 'unknown';
        if (t !== 'valid') {
          return { at: 'sec', status: 401, type: 'unauthorized', who: 'ProblemAuthenticationEntryPoint', spent: 'no, never reached the interceptor',
            text: (t === 'none' ? 'No token' : 'Expired token') + ': the security chain answers 401 before the interceptor, the arguments or the permission check exist for this request. Permission, body and bucket are never looked at.' };
        }
        if (f === 'empty') {
          return { at: 'rate', status: 429, type: 'rate-limited', who: 'ApiExceptionHandler (RateLimitedException)', spent: 'no, the bucket was already empty',
            text: '429 with Retry-After: the interceptor runs after authentication (so it can key on the sub) and before argument resolution and the permission check. The interceptor throws, and the @RestControllerAdvice writes the problem.' };
        }
        if (unknown) {
          return { at: 'ctl', status: 404, type: 'not-found', who: 'Boot’s resource handler (404)', spent: 'yes, 1 token',
            text: '404, and a token was spent. Boot’s static-resource handler matches /**, so an unknown route still has a handler and the interceptor runs before it answers 404. Appfleet wants that: scanning for endpoints is limited like any other traffic. The arguments and the permission check never run.' };
        }
        if (b === 'invalid') {
          return { at: 'args', status: 400, type: 'validation-failed', who: 'ApiExceptionHandler (MethodArgumentNotValidException)', spent: 'yes, 1 token',
            text: p === 'missing'
              ? '400, not 403: Spring validates the @RequestBody before it calls the proxied method, so the permission check never ran. This is the S4.3 finding. A caller without the permission learns that the endpoint exists and what its body needs.'
              : '400 with an errors list naming each failing field. The body is checked before the controller method, so the service is never called.' };
        }
        if (p === 'missing') {
          if (!rethrow.get()) {
            return { at: 'perm', status: 500, type: 'internal-error', who: 'ApiExceptionHandler (catch-all)', spent: 'yes, 1 token',
              text: '500: @PreAuthorize threw AccessDeniedException inside the controller call, the catch-all @ExceptionHandler(Exception.class) answered, and ProblemAccessDeniedHandler never ran. Turn the rethrow back on to get 403.' };
          }
          return { at: 'perm', status: 403, type: 'forbidden', who: 'ProblemAccessDeniedHandler (filter chain)', spent: 'yes, 1 token',
            text: '403: the arguments were fine, the proxy refused the call, ApiExceptionHandler rethrew the AccessDeniedException and the filter chain’s handler wrote the problem+json.' };
        }
        return { at: 'ctl', status: 202, type: '(none)', who: 'DeploymentController', spent: 'yes, 1 token',
          text: '202 Accepted with a Location header: every stage passed, the service wrote the deployment, task and audit rows, and the message converter wrote DeploymentAccepted as JSON.' };
      }

      function update() {
        const unknown = route.get() === 'unknown';
        perm.el.style.display = body.el.style.display = unknown ? 'none' : '';
        rethrow.el.style.display = unknown ? 'none' : '';
        const r = outcome();
        const idx = ORDER.indexOf(r.at);
        nodes.forEach((n, i) => {
          const st = STAGES[i];
          if (unknown && (st.id === 'args' || st.id === 'perm')) { AF.tone(n, 'idle'); return; }
          if (i < idx) AF.tone(n, 'ok');
          else if (i === idx) AF.tone(n, r.status < 300 ? 'ok' : r.status === 429 ? 'warn' : 'bad');
          else AF.tone(n, 'idle');
        });
        nodes[5].firstChild.textContent = unknown ? 'Resource handler' : 'Controller';
        nodes[5].lastChild.textContent = unknown ? 'static resources, /**' : 'return value, converter';
        trail.textContent = 'Passed: ' + (idx > 0 ? STAGES.slice(0, idx).map(x => x.name).join(', ') : 'nothing') + '. Answered at: ' + STAGES[idx].name + '. Stages after it never ran.';
        const tone = r.status < 300 ? 'ok' : r.status === 429 ? 'warn' : 'bad';
        rStage.set(STAGES[idx].name, tone);
        rStatus.set(String(r.status), tone);
        rType.set(r.type === '(none)' ? '(none)' : PROBLEM + r.type, tone);
        rSpent.set(r.spent, r.spent.indexOf('yes') === 0 ? 'warn' : null);
        verdict.set(tone, r.text + ' Written by ' + r.who + '. Evidence: ' + evidence(r));
      }

      el.append(
        controls(route.el, token.el, perm.el, body.el, bucket.el, rethrow.el),
        stage(row, trail),
        readouts(rStage, rStatus, rType, rSpent),
        note('The lab models POST /api/v1/deployments. Combinations are labelled "tested" only where a test in the repo covers that exact case; the others are inferred from the stage order in the code and say so. Some tests use GET /applications, which passes through the same filter chain and interceptor. Whether a 400 or 403 spends a token follows from the interceptor running first; it is not asserted by a test.'),
        verdict.el
      );
      update();
    }
  });

  // ===== Lesson sp-data =====
  AF.register({
    id: 'sp-data',
    group: 'spring',
    order: 10,
    title: 'Spring Data repositories: from method name to SQL',
    question: 'How does a method name like findByOwnerTeamIdInOrderByIdAsc become SQL, and when do you stop trusting the name and write the query yourself?',
    status: 'built',
    slice: 'S2, S3.4, S4.4',
    where: [
      'control-api/src/main/java/io/appfleet/control/application/ApplicationRepository.java, deployment/DeploymentRepository.java, task/TaskRepository.java, catalogue/BaseImageRepository.java',
      'DeploymentProjectionTest (closed versus open projection), BaseImageLineageTest (findLineage, {h-schema})',
      'docs/design/control-api/control-api-s2-repositories.md, control-api-s2-lineage-and-projection.md, control-api-s2-n-plus-one.md',
      'docs/design/control-api/control-api-s4-4-idor.md, section 9.7 (GET /deployments/{id} is one joined statement)'
    ],
    idea: [
      'A Spring Data repository is an interface. At startup Spring parses each method name with a PartTree: the verb (find...By), then property names (OwnerTeamId), operators (And, In, GreaterThan) and an OrderBy tail. It checks every property against the entity, builds a JPA query, and Hibernate turns that into SQL. Limit, Pageable and Slice are parameters that add the row limit; a Slice asks for one extra row (limit + 1) to know whether another page exists, without a count query. The return type picks the columns: an entity loads every column, a closed interface projection loads only its getters, an open one (with @Value) quietly loads everything again.',
      'Appfleet uses the name wherever it stays readable: findByOwnerTeamIdInOrderByIdAsc and findByIdGreaterThanOrderByIdAsc are the cursor pages, findSliceByDeployment_IdOrderByIdAsc is the offset page, and findByApplication_Id returns DeploymentListView so only four columns are selected. It stops trusting the name in five places. @Query with JPQL when the name would be absurd or the result is one column (findOwnerTeamById, findOwnerIdById). A native query for the recursive lineage, which needs {h-schema} because native SQL is not rewritten by the control schema setting (BaseImageLineageTest first failed with relation "base_image" does not exist). @EntityGraph to load associations in the same statement (findDetailById, findAllBy). @Lock on findLockedById so a rollback bumps the version. And a test that reads the SQL.',
      'The name hides the SQL, so Appfleet reads the SQL: org.hibernate.SQL at DEBUG, with the correlation id in the log line. A name that parses can still be a bad query: it can select too many columns, send 51 statements, or lose a race. And a name that does not parse fails at startup, not at the first call, which is a gift. Spring Data cannot count your statements or tell you an index is missing; those need the tests and EXPLAIN of the other lessons.'
    ],
    terms: [
      ['PartTree', 'Spring Data’s parser for a derived query name: subject (findBy), predicates (Id, GreaterThan, In, And) and ordering (OrderBy...Asc). A property it cannot find fails at startup.'],
      ['Limit and Slice', 'Limit adds a row limit. A Slice fetches size + 1 rows to know if there is a next page and runs no count query; a Page runs one.'],
      ['Closed projection', 'An interface whose getters all match entity properties. Spring Data selects only those columns. An open projection (a @Value getter) loads the whole entity.'],
      ['{h-schema}', 'A Hibernate placeholder in native SQL that expands to the configured default schema. Without it a native query looks in public, not control.'],
      ['@EntityGraph', 'Names the associations to fetch with the entity, as one joined statement, instead of one lazy query per row.'],
      ['Optimistic force increment', 'A lock mode that bumps the entity’s version even if nothing else changed, so two concurrent writers conflict.']
    ],
    tryIt: [
      'Pick "findByOwnerTeamIdInOrderByIdAsc" and read how the name splits into parts. The SQL is a reconstructed shape; the lab says so. Then pick "Alternative" to misspell a property and see the startup failure.',
      'Pick "findSliceByDeployment_Id..." and compare "As written" (1 statement, size + 1 rows) with "Alternative" (a Page adds a count statement).',
      'Pick "findByApplication_Id (projection)": "As written" selects 4 columns, "Alternative" (an open projection) selects 9. Both statements are recorded in the S2 doc.',
      'Pick "findAllBy (@EntityGraph)": 1 statement with the graph, 51 without it. Pick "findDetailById" to see the one joined statement behind GET /deployments/{id}.',
      'Pick "findLineage (native)" and switch to the alternative: without {h-schema} the recorded failure is relation "base_image" does not exist. Pick "findLockedById" for the lost race.'
    ],
    breakIt: 'Choose "findByApplication_Id (projection)" and switch to "Alternative". Adding one @Value getter to DeploymentListView makes the projection open: Spring Data loads the whole entity and projects in memory, the Java still compiles and the result looks the same, and the SQL goes from 4 columns to 9. Only DeploymentProjectionTest, which reads the SQL, noticed; it failed with not to contain release_id, environment_id, version, updated_at.',
    say: 'Spring Data parses the method name into SQL at startup, so I trust it for simple filters and cursor pages, and I switch to @Query, an @EntityGraph or a projection the moment I need one column, a fetch plan or a schema-qualified native query, and I prove each with the SQL log, as we did with DeploymentProjectionTest and the one-statement GET /deployments/{id}.',
    quiz: {
      q: 'DeploymentListView has four getters. Someone adds a fifth with @Value("#{target.id}"). The code compiles and the list endpoint returns the same JSON. What changed?',
      options: [
        'Nothing: Spring Data still selects only the columns the getters name',
        'The projection became open, so Spring Data loads the whole entity and the SELECT grows from 4 columns to 9',
        'The query now needs a second statement for the @Value expression',
        'Startup fails, because a projection cannot contain a SpEL expression'
      ],
      answer: 1,
      why: 'S2 recorded it: the closed projection selects id, status, current_status, created_at; the open one selects every entity column. Only DeploymentProjectionTest, which reads the SQL, catches the change.'
    },
    mount(el, ctx) {
      // src 'recorded' = SQL text recorded in docs/design/control-api. 'shape' = reconstructed shape, not a captured log line.
      const METHODS = {
        owner: {
          name: 'findByOwnerTeamIdInOrderByIdAsc',
          sig: 'List<Application> findByOwnerTeamIdInOrderByIdAsc(Collection<UUID> ownerTeamIds, Limit limit)   // ApplicationRepository, S4.4',
          parts: [['findBy', 'subject: a select'], ['OwnerTeamId', 'property Application.ownerTeamId'], ['In', 'operator: IN (:teamIds)'], ['OrderBy', 'ordering'], ['Id', 'property'], ['Asc', 'ascending'], ['Limit', 'parameter: rows to ask for (page + 1)']],
          base: { sql: 'select a1_0.* from control.application a1_0\n where a1_0.owner_team_id in (?, ?, ?)\n order by a1_0.id\n limit ?          -- 21 for a page of 20 (limit + 1)', stmts: 1, cols: 'every Application column', rows: '21 for a page of 20', src: 'shape', tone: 'ok', text: '1 statement. The name carries the filter, the sort and the cursor’s limit + 1. The column list is abbreviated in this shape; S4.4 section 9.7 records the query as WHERE owner_team_id IN (...) ORDER BY id LIMIT 21 and measures it with and without the V5 index.' },
          alt: { label: 'Misspell a property (findByOwnerIdIn...)', sql: '(no SQL: the application context does not start)', stmts: 0, cols: '-', rows: '-', src: 'standard', tone: 'bad', text: 'Standard Spring Data behaviour, not captured in Appfleet: the PartTree cannot find the property and startup fails with PropertyReferenceException: No property "ownerId" found for type "Application". A derived name is checked when the context starts, not when the method is first called.' }
        },
        slice: {
          name: 'findSliceByDeployment_IdOrderByIdAsc',
          sig: 'Slice<Task> findSliceByDeployment_IdOrderByIdAsc(UUID deploymentId, Pageable pageable)   // TaskRepository, S3.4',
          parts: [['findSliceBy', 'subject: a select returning a Slice (the word Slice is only a readable name)'], ['Deployment_Id', 'property path task.deployment.id, the underscore marks the step'], ['OrderBy', 'ordering'], ['Id', 'property'], ['Asc', 'ascending'], ['Pageable', 'parameter: page number and size']],
          base: { sql: 'select t1_0.* from control.task t1_0\n where t1_0.deployment_id = ?\n order by t1_0.id\n limit ? offset ?   -- size + 1 rows, no count query', stmts: 1, cols: 'every Task column', rows: 'size + 1', src: 'shape', tone: 'ok', text: '1 statement. A Slice fetches size + 1 rows to know hasNext and runs no count. S3.4 decision 4 chose Slice for exactly that. The query text is the form recorded in S3.4 (LIMIT 21 OFFSET 200000); the exact Hibernate rendering was not captured.' },
          alt: { label: 'Return Page instead of Slice', sql: 'select t1_0.* ... limit ? offset ?        -- the page\nselect count(t1_0.id) from control.task t1_0\n where t1_0.deployment_id = ?             -- the extra count', stmts: 2, cols: 'every Task column', rows: 'size, plus a count', src: 'shape', tone: 'warn', text: '2 statements. A Page runs a count(*) on every request. S3.4 measured that count alone for the hot deployment: 21.2 ms without the index, 14.9 ms with it. The SQL here is the shape, not a captured log.' }
        },
        proj: {
          name: 'findByApplication_Id (projection)',
          sig: 'List<DeploymentListView> findByApplication_Id(UUID applicationId)   // DeploymentRepository, S2',
          parts: [['findBy', 'subject: a select'], ['Application_Id', 'property path deployment.application.id; the foreign key column is enough, so no join'], ['return type', 'DeploymentListView, a closed interface of 4 getters: id, status, currentStatus, createdAt']],
          base: { sql: 'select d1_0.id,d1_0.status,d1_0.current_status,d1_0.created_at\nfrom control.deployment d1_0\nwhere d1_0.application_id=?', stmts: 1, cols: '4 columns, no join', rows: 'all rows of the application', src: 'recorded', tone: 'ok', text: '1 statement, 4 columns. Recorded in control-api-s2-lineage-and-projection.md, and DeploymentProjectionTest asserts that release_id, environment_id, version and updated_at are absent.' },
          alt: { label: 'Open projection (@Value getter added)', sql: 'select d1_0.id,d1_0.application_id,d1_0.created_at,d1_0.current_status,d1_0.environment_id,\n       d1_0.release_id,d1_0.status,d1_0.updated_at,d1_0.version\nfrom control.deployment d1_0\nwhere d1_0.application_id=?', stmts: 1, cols: '9 columns (the whole entity)', rows: 'all rows of the application', src: 'recorded', tone: 'bad', text: '1 statement, 9 columns. Recorded fail-first run: DeploymentProjectionTest failed with not to contain release_id, environment_id, version, updated_at. Nothing in the Java changed shape; only the SQL did.' }
        },
        graph: {
          name: 'findAllBy (@EntityGraph tasks)',
          sig: '@EntityGraph(attributePaths = "tasks")\nList<Deployment> findAllBy()   // DeploymentRepository, S2 N+1 drill',
          parts: [['findBy', 'subject: a select, with no criteria after By (all rows)'], ['@EntityGraph', 'attributePaths = "tasks": fetch the lazy collection in the same statement']],
          base: { sql: 'select ... from control.deployment d1_0\n left join control.task t1_0 on d1_0.id=t1_0.deployment_id', stmts: 1, cols: 'deployment and task columns', rows: '50 deployments, 150 tasks', src: 'recorded', tone: 'ok', text: '1 statement (left join, as the doc confirms). Recorded in the S2 N+1 drill: 50 deployments and 150 tasks in one statement.' },
          alt: { label: 'No graph (plain findAll, then touch tasks)', sql: 'select d1_0.id,... from control.deployment d1_0                -- 1 statement\nselect t1_0.deployment_id,t1_0.id,... from control.task t1_0\n where t1_0.deployment_id=?                                       -- x 50', stmts: 51, cols: 'deployment, then task per deployment', rows: '50 + 50 queries', src: 'recorded', tone: 'bad', text: '51 statements. The N+1 baseline of DeploymentNPlusOneTest: one deployment select and 50 identical task selects. See lesson pg-nplusone for the four fixes and their counts.' }
        },
        detail: {
          name: 'findDetailById (@EntityGraph)',
          sig: '@EntityGraph(attributePaths = {"environment", "application"})\nOptional<Deployment> findDetailById(UUID id)   // DeploymentRepository, S3.3',
          parts: [['findDetailBy', 'subject: a select (the word Detail is only a readable name)'], ['Id', 'property: the primary key'], ['@EntityGraph', 'fetch environment and application in the same statement']],
          base: { sql: 'select ... from control.deployment d1_0\n join control.application a1_0 on a1_0.id=d1_0.application_id\n join control.environment e1_0 on e1_0.id=d1_0.environment_id\n where d1_0.id=?', stmts: 1, cols: 'deployment, application, environment columns', rows: '1', src: 'recorded', tone: 'ok', text: '1 statement. S4.4 section 9.7 recorded GET /deployments/{id} as one joined statement, found by following the correlation id in the SQL log.' },
          alt: { label: 'Without the graph (lazy environment)', sql: 'select ... from control.deployment d1_0 where d1_0.id=?\nselect ... from control.environment e1_0 where e1_0.id=?   -- when the response reads the environment name', stmts: 2, cols: 'deployment, then environment', rows: '1 + 1', src: 'standard', tone: 'warn', text: 'About 2 statements. Standard behaviour, not measured in Appfleet: open-in-view is off and the association is lazy, so reading the environment name needs a second query. S3.3 added the graph for exactly this reason.' }
        },
        lineage: {
          name: 'findLineage (native @Query)',
          sig: '@Query(value = """ WITH RECURSIVE lineage ... FROM {h-schema}base_image ... """, nativeQuery = true)\nList<BaseImage> findLineage(UUID baseImageId)   // BaseImageRepository, S1/S2',
          parts: [['@Query', 'the method name is not parsed; the text is the query'], ['nativeQuery = true', 'plain SQL, sent as written (a recursive CTE JPQL cannot express)'], ['{h-schema}', 'expands to the control schema, because native SQL is not rewritten by default_schema'], ['return type', 'List<BaseImage>: every mapped column (including registry) must be selected']],
          base: { sql: 'WITH RECURSIVE lineage AS (\n  SELECT id, name, registry, parent_base_image_id, 0 AS depth\n  FROM control.base_image WHERE id = ?\n  UNION ALL\n  SELECT parent.id, parent.name, parent.registry, parent.parent_base_image_id, lineage.depth + 1\n  FROM control.base_image parent JOIN lineage ON lineage.parent_base_image_id = parent.id)\nSELECT id, name, registry, parent_base_image_id FROM lineage ORDER BY depth', stmts: 1, cols: 'the BaseImage columns', rows: 'the chain, leaf first', src: 'shape', tone: 'ok', text: '1 statement. The source text is in BaseImageRepository with {h-schema}; the expansion to control.base_image is shown as the shape. BaseImageLineageTest is 3 of 3 green.' },
          alt: { label: 'Without {h-schema}', sql: 'ERROR: relation "base_image" does not exist', stmts: 0, cols: '-', rows: '-', src: 'recorded', tone: 'bad', text: 'Recorded: the first run of BaseImageLineageTest errored 3 of 3 with relation "base_image" does not exist, while the save calls in the same tests worked, because Hibernate’s own SQL is schema-qualified and native SQL is not.' }
        },
        owner1: {
          name: 'findOwnerTeamById (one column)',
          sig: '@Query("select d.application.ownerTeamId from Deployment d where d.id = :id")\nOptional<UUID> findOwnerTeamById(@Param("id") UUID id)   // DeploymentRepository, S4.4',
          parts: [['@Query', 'JPQL: the name is free, here it only says what comes back'], ['select d.application.ownerTeamId', 'one scalar: the owning team, reached through the application'], ['Optional<UUID>', 'the return type is the column, not an entity']],
          base: { sql: 'select a1_0.owner_team_id\n  from control.deployment d1_0\n  join control.application a1_0 on a1_0.id=d1_0.application_id\n where d1_0.id=?', stmts: 1, cols: '1 column (owner_team_id)', rows: '0 or 1', src: 'shape', tone: 'ok', text: '1 statement, 1 column. S4.4 section 9.7 describes it as the deployment joined to the application, selecting the owner team only; the text here is the shape. The history endpoints are two statements: this one, then the page of tasks.' },
          alt: { label: 'Load the Deployment, walk to the team', sql: 'select ... from control.deployment d1_0 where d1_0.id=?\nselect ... from control.application a1_0 where a1_0.id=?    -- when .getApplication().getOwnerTeamId() is read', stmts: 2, cols: 'whole deployment, then whole application', rows: '1 + 1', src: 'standard', tone: 'warn', text: 'About 2 statements and far more columns. Standard behaviour, not measured in Appfleet: an entity load takes every column and the lazy application needs its own query. The owner check runs on every read, which is why it is a one-column query.' }
        },
        lock: {
          name: 'findLockedById (@Lock)',
          sig: '@Lock(LockModeType.OPTIMISTIC_FORCE_INCREMENT)\nOptional<Deployment> findLockedById(UUID id)   // DeploymentRepository, S3.3',
          parts: [['findLockedBy', 'subject: a select (Locked is only a readable name)'], ['Id', 'property: the primary key'], ['@Lock', 'OPTIMISTIC_FORCE_INCREMENT: bump version at commit even if the row is otherwise unchanged']],
          base: { sql: 'select ... from control.deployment d1_0 where d1_0.id=?\n-- at commit, even with no other change:\nupdate control.deployment set version=? where id=? and version=?', stmts: 2, cols: 'every Deployment column', rows: '1', src: 'shape', tone: 'ok', text: 'Two statements in the shape shown (statement text not captured). Standard Hibernate behaviour. S3.3 case 16 recorded the outcome: with the lock two concurrent rollbacks give one 202 and one 409 (10 of 10 runs).' },
          alt: { label: 'Remove the @Lock', sql: 'select ... from control.deployment d1_0 where d1_0.id=?\n-- no version bump, so nothing makes the second writer fail', stmts: 1, cols: 'every Deployment column', rows: '1', src: 'recorded', tone: 'bad', text: 'Recorded in S3.3 section 10: with the annotation removed, case 16 failed 5 of 5 runs, [202, 202] instead of [202, 409]. A rollback that only adds a task row changes nothing on the deployment, so only the forced version bump makes the race visible.' }
        }
      };
      const SRC = {
        recorded: 'Recorded in the design docs',
        shape: 'Reconstructed shape, not a captured log',
        standard: 'Standard behaviour, not measured in Appfleet'
      };

      const m = ui.choice('Method', [
        { value: 'owner', label: 'findByOwnerTeamIdInOrderByIdAsc' },
        { value: 'slice', label: 'findSliceByDeployment_Id...' },
        { value: 'proj', label: 'findByApplication_Id (projection)' },
        { value: 'graph', label: 'findAllBy (@EntityGraph)' },
        { value: 'detail', label: 'findDetailById' },
        { value: 'lineage', label: 'findLineage (native)' },
        { value: 'owner1', label: 'findOwnerTeamById' },
        { value: 'lock', label: 'findLockedById' }
      ], 'owner', update);
      const ver = ui.choice('Version', [
        { value: 'base', label: 'As written' },
        { value: 'alt', label: 'Alternative' }
      ], 'base', update);

      const sigBox = ui.code('', 'The repository method');
      const partsBox = h('div', { class: 'stack', style: 'display:flex;flex-wrap:wrap;gap:6px' });
      const altLine = h('p', { class: 'small' });
      const sqlBox = ui.code('', 'The SQL Hibernate sends');
      const rStmts = ui.readout('Statements');
      const rCols = ui.readout('Columns');
      const rRows = ui.readout('Rows asked for');
      const rSrc = ui.readout('SQL source');
      const verdict = ui.verdict();

      function update() {
        const M = METHODS[m.get()];
        const V = ver.get() === 'alt' ? M.alt : M.base;
        setCode(sigBox, M.sig);
        AF.clear(partsBox);
        M.parts.forEach(p => partsBox.append(h('span', { class: 'token', title: p[1] }, p[0] + ' = ' + p[1])));
        altLine.textContent = 'Alternative: ' + M.alt.label + '.';
        setCode(sqlBox, V.sql);
        rStmts.set(V.stmts === 0 ? 'none' : String(V.stmts), V.tone);
        rCols.set(V.cols);
        rRows.set(V.rows);
        rSrc.set(SRC[V.src], V.src === 'recorded' ? 'ok' : 'warn');
        verdict.set(V.tone, V.text);
      }

      el.append(
        controls(m.el, ver.el),
        stage(h('div', { class: 'sim-cols' },
          ui.panel('The name, split by Spring Data', sigBox, partsBox, altLine),
          ui.panel('The SQL Hibernate sends', sqlBox))),
        readouts(rStmts, rCols, rRows, rSrc),
        note('SQL marked "Recorded" is copied from the control-api design docs (captured with org.hibernate.SQL at DEBUG). SQL marked "Reconstructed shape" shows what the method means in SQL; column lists are abbreviated and the exact text was not captured. "Standard behaviour" cases were not measured in Appfleet.'),
        verdict.el
      );
      update();
    }
  });


  // =====================================================================
  // sp-ioc: Beans, injection and the container
  // =====================================================================

  AF.register({
    id: 'sp-ioc',
    group: 'spring',
    order: 7,
    title: 'Beans, injection and the container',
    question: 'Nobody calls new OutboxWriter(), so who builds it, who hands it to DeploymentService, and what breaks when you build it yourself?',
    status: 'built',
    slice: 'S0 to S4.5',
    where: [
      'control-api/src/main/java/io/appfleet/control/outbox/OutboxWriter.java (@Component, one constructor, Propagation.MANDATORY)',
      'deployment/DeploymentService.java (@Service, a constructor with 7 parameters), security/TeamAccess.java (@Component, no dependencies)',
      'idempotency/IdempotencyExecutor.java (shares the one JsonMapper), ratelimit/RateLimitInterceptor.java (@Component), web/WebConfig.java (@Configuration)',
      'web/SecurityConfig.java and web/openapi/OpenApiConfig.java (@Configuration with @Bean methods), ControlApiApplication.java (@SpringBootApplication)'
    ],
    idea: [
      'Spring keeps a container that owns your objects. At startup it scans for classes marked @Component, @Service, @Repository, @RestController or @Configuration (the stereotypes), reads each one’s constructor, works out the order, and builds every object once. A @Configuration class can also publish an object through a @Bean method, which is how SecurityConfig and OpenApiConfig add the ones Spring cannot guess. Spring Data repositories are interfaces with no annotation at all: the container builds an implementation for each one. Each built object is a bean, and the whole set is the application context.',
      'Appfleet uses constructor injection everywhere. OutboxWriter declares OutboxMessageRepository and JsonMapper as constructor parameters and stores them in final fields. Because the class has a single constructor, Spring needs no @Autowired: it reads the parameter types and passes in the matching beans. The same JsonMapper instance also goes into IdempotencyExecutor, because beans are singletons by default: one shared instance per container. That is why services hold no per-request state, only their collaborators. The final fields are the point: the object cannot exist half built, and a test can construct it with plain arguments.',
      'The cost of the container is that only objects it builds get its behaviour. An object made with new is not a bean: no proxy, so no @Transactional and no Propagation.MANDATORY check (see sp-proxy); nothing injected into it; and Spring does not know it exists. If a needed bean is missing, startup fails at once with NoSuchBeanDefinitionException wrapped in UnsatisfiedDependencyException, and Spring Boot prints the parameter that could not be satisfied. If two beans need each other through constructors, the cycle is rejected by default. These are standard Spring behaviours, not measured in Appfleet. One honest note on the repo today: DeploymentService does not take OutboxWriter yet, so the writer is a bean waiting for its caller.'
    ],
    terms: [
      ['Bean', 'An object the container creates, wires and manages. Everything with @Component, @Service, @Repository, @RestController, @Configuration, or returned by a @Bean method.'],
      ['Constructor injection', 'Dependencies arrive as constructor parameters. With one constructor Spring uses it without @Autowired, and the fields can be final.'],
      ['Singleton scope', 'The default: one shared instance per container. Beans must therefore be stateless or thread-safe, because many requests use the same object at once.'],
      ['Dependency graph', 'Which bean needs which. Spring resolves it at startup and builds dependencies first. A missing node or a loop stops the application before it serves anything.'],
      ['Circular dependency', 'A needs B and B needs A through constructors. Spring Boot prohibits it by default (BeanCurrentlyInCreationException) rather than half-building one of them.'],
      ['Not a bean', 'An object made with new. It is never proxied or injected, so @Transactional, @PreAuthorize and friends on it do nothing.']
    ],
    tryIt: [
      'Leave everything on its default and read the startup panel: every bean is created in dependency order and the Spring Data repositories are built before the services that need them.',
      'Under "Remove a bean" choose "JsonMapper": startup fails and the panel shows the Spring Boot message naming the constructor parameter that could not be filled. Choose "None" to restore it.',
      'Under "OutboxWriter is built by" choose "new, by hand". The writer node turns amber ("not a bean"), and the "Caller" choice now shows that Propagation.MANDATORY is never checked, even when you pick "Outside any transaction".',
      'Switch back to "The container" and set "Caller" to "Outside any transaction": the proxy refuses the call with IllegalTransactionStateException.',
      'Switch on "OutboxWriter also needs DeploymentService": the context refuses to start because the two constructors form a loop.'
    ],
    breakIt: 'Choose "new, by hand" and "Outside any transaction". Nothing fails: no error at startup, no error at runtime. The command row is saved by the repository’s own transaction and can commit even though the deployment it belongs to never does. That is exactly what Propagation.MANDATORY exists to forbid, and it only works on a bean.',
    say: 'I let the container build and inject my objects through single constructors with final fields, as singletons, because an object I create with new is not a bean: it skips the proxy, so @Transactional and Propagation.MANDATORY on OutboxWriter would silently do nothing.',
    quiz: {
      q: 'A developer writes new OutboxWriter(repository, json).write(command) inside a controller method that has no transaction. OutboxWriter.write is annotated Propagation.MANDATORY. What happens?',
      options: [
        'IllegalTransactionStateException, because MANDATORY requires an existing transaction',
        'The row is saved with no error: the object is not a bean, so no proxy exists to enforce MANDATORY',
        'NoSuchBeanDefinitionException at startup, because the writer was never registered',
        'BeanCurrentlyInCreationException, because the writer depends on a repository that is still being built'
      ],
      answer: 1,
      why: 'Propagation is enforced by the transaction proxy the container wraps around a bean. An object created with new has no proxy, so the annotation is only a comment, and the repository then saves the row in its own transaction. This is standard Spring behaviour, not measured in Appfleet.'
    },
    mount(el, ctx) {
      // Beans and constructor parameters come from the control-api sources (verified 2026-10-05).
      // The startup messages are the standard Spring Boot failure texts, not captured from Appfleet.
      const iocPkg = {
        JsonMapper: 'tools.jackson.databind.json.JsonMapper',
        OutboxMessageRepository: 'io.appfleet.control.outbox.OutboxMessageRepository',
        DeploymentRepository: 'io.appfleet.control.deployment.DeploymentRepository',
        ApplicationRepository: 'io.appfleet.control.application.ApplicationRepository',
        ReleaseRepository: 'io.appfleet.control.application.ReleaseRepository',
        EnvironmentRepository: 'io.appfleet.control.environment.EnvironmentRepository',
        TaskRepository: 'io.appfleet.control.task.TaskRepository',
        AuditEventRepository: 'io.appfleet.control.audit.AuditEventRepository',
        TeamAccess: 'io.appfleet.control.security.TeamAccess',
        AuditEventRecorder: 'io.appfleet.control.audit.AuditEventRecorder',
        IdempotencyStore: 'io.appfleet.control.idempotency.IdempotencyStore',
        IdempotencyExecutor: 'io.appfleet.control.idempotency.IdempotencyExecutor',
        OutboxWriter: 'io.appfleet.control.outbox.OutboxWriter',
        DeploymentService: 'io.appfleet.control.deployment.DeploymentService'
      };
      const fq = n => iocPkg[n] || n;
      const lower = n => n.charAt(0).toLowerCase() + n.slice(1);

      const verdict = ui.verdict();
      const startBox = ui.code('', 'Startup result');
      const ctorBox = ui.code('', 'DeploymentService constructor');
      const rStart = ui.readout('Startup');
      const rBeans = ui.readout('Beans in the container');
      const rWriter = ui.readout('OutboxWriter instances');
      const rCheck = ui.readout('MANDATORY check');
      const laneInfra = ui.lane('Built by Spring Data or Boot', 'no annotation of ours');
      const laneComp = ui.lane('Components', '@Component / @Service');
      const laneSvc = ui.lane('The consumer', '@Service');

      const remove = ui.choice('Remove a bean', [
        { value: 'none', label: 'None' },
        { value: 'JsonMapper', label: 'JsonMapper' },
        { value: 'OutboxMessageRepository', label: 'OutboxMessageRepository' },
        { value: 'TeamAccess', label: 'TeamAccess' },
        { value: 'OutboxWriter', label: 'OutboxWriter' }
      ], 'none', update);
      const make = ui.choice('OutboxWriter is built by', [
        { value: 'container', label: 'The container' },
        { value: 'new', label: 'new, by hand' }
      ], 'container', update);
      const ask = ui.toggle('DeploymentService asks for OutboxWriter (it does, since S4.5)', true, update);
      const cycle = ui.toggle('OutboxWriter also needs DeploymentService', false, update, { tone: 'danger' });
      const caller = ui.choice('Caller', [
        { value: 'tx', label: 'Inside @Transactional' },
        { value: 'notx', label: 'Outside any transaction' }
      ], 'tx', update);

      function model() {
        const byHand = make.get() === 'new';
        const asks = ask.get();
        const removed = remove.get();
        const repos = ['JsonMapper', 'OutboxMessageRepository', 'DeploymentRepository', 'ApplicationRepository', 'ReleaseRepository', 'EnvironmentRepository', 'TaskRepository', 'AuditEventRepository'];
        const beans = [];
        repos.forEach(n => beans.push({ n, lane: 'infra', kind: n === 'JsonMapper' ? 'auto-configured by Boot' : 'Spring Data interface', deps: [] }));
        beans.push({ n: 'TeamAccess', lane: 'comp', kind: '@Component', deps: [] });
        beans.push({ n: 'AuditEventRecorder', lane: 'comp', kind: '@Service', deps: ['AuditEventRepository'] });
        beans.push({ n: 'IdempotencyStore', lane: 'comp', kind: '@Component', deps: [] });
        beans.push({ n: 'IdempotencyExecutor', lane: 'comp', kind: '@Component', deps: ['IdempotencyStore', 'JsonMapper'] });
        if (!byHand) {
          const wd = ['OutboxMessageRepository', 'JsonMapper'];
          if (cycle.get() && asks) wd.push('DeploymentService');
          beans.push({ n: 'OutboxWriter', lane: 'comp', kind: '@Component', deps: wd });
        }
        const sd = ['DeploymentRepository', 'AuditEventRecorder', 'ApplicationRepository', 'ReleaseRepository', 'EnvironmentRepository', 'TaskRepository', 'TeamAccess'];
        if (asks) {
          if (byHand) { sd.push('OutboxMessageRepository'); sd.push('JsonMapper'); } else sd.push('OutboxWriter');
        }
        beans.push({ n: 'DeploymentService', lane: 'svc', kind: '@Service', deps: sd });
        const present = beans.filter(b => b.n !== removed);
        const have = new Set(present.map(b => b.n));
        let fail = null;
        for (const b of present) {
          const idx = b.deps.findIndex(d => !have.has(d));
          if (idx >= 0) { fail = { type: 'missing', consumer: b.n, index: idx, dep: b.deps[idx] }; break; }
        }
        if (!fail && !byHand && asks && cycle.get() && have.has('OutboxWriter') && have.has('DeploymentService')) fail = { type: 'cycle' };
        return { byHand, asks, removed, beans, present, have, fail, sd };
      }

      function failText(f) {
        if (f.type === 'cycle') {
          return 'APPLICATION FAILED TO START\n\nDescription:\n\nThe dependencies of some of the beans in the application context form a cycle:\n\n┌─────┐\n|  deploymentService\n↑     ↓\n|  outboxWriter\n└─────┘\n\nAction:\n\nRelying upon circular references is discouraged and they are prohibited by default. Update your application to remove the dependency cycle between beans.';
        }
        return 'APPLICATION FAILED TO START\n\nDescription:\n\nParameter ' + f.index + ' of constructor in ' + fq(f.consumer) + ' required a bean of type \'' + fq(f.dep) + '\' that could not be found.\n\nAction:\n\nConsider defining a bean of type \'' + fq(f.dep) + '\' in your configuration.\n\n(underneath: UnsatisfiedDependencyException wrapping NoSuchBeanDefinitionException for bean \'' + lower(f.consumer) + '\')';
      }

      function update() {
        const m = model();
        const ok = !m.fail;
        [laneInfra, laneComp, laneSvc].forEach(l => AF.clear(l.body));
        m.beans.forEach(b => {
          const node = ui.node(b.n, b.kind);
          const gone = b.n === m.removed;
          let tone = 'ok';
          if (gone) tone = 'idle';
          else if (m.fail && m.fail.type === 'missing' && m.fail.consumer === b.n) tone = 'bad';
          else if (m.fail && m.fail.type === 'cycle' && (b.n === 'OutboxWriter' || b.n === 'DeploymentService')) tone = 'bad';
          AF.tone(node, tone);
          if (gone) node.append(h('span', { class: 'node-sub' }, 'removed from the container'));
          (b.lane === 'infra' ? laneInfra : b.lane === 'comp' ? laneComp : laneSvc).body.appendChild(node);
        });
        if (m.byHand) {
          const w = ui.node('OutboxWriter', 'new: not a bean');
          AF.tone(w, 'warn');
          laneComp.body.appendChild(w);
        }

        const sig = m.sd.map((d, i) => '  ' + d + ' ' + lower(d) + (i < m.sd.length - 1 ? ',' : '') + '   // parameter ' + i);
        setCode(ctorBox, 'public DeploymentService(\n' + sig.join('\n') + '\n)' + (m.asks && m.byHand ? '\n// the writer is built inside: new OutboxWriter(outboxMessageRepository, jsonMapper)' : ''));
        const jsonUsers = m.present.filter(b => b.deps.includes('JsonMapper')).map(b => b.n);
        const order = m.present.map(b => b.n);
        setCode(startBox, ok
          ? 'Started ControlApiApplication\nCreated once each, dependencies first:\n  ' + order.join('\n  ') + '\n\nJsonMapper is one instance shared by: ' + (jsonUsers.length ? jsonUsers.join(', ') : 'nobody')
          : failText(m.fail));

        rStart.set(ok ? 'Started' : 'FAILED', ok ? 'ok' : 'bad');
        rBeans.set(m.present.length, ok ? null : 'bad');
        const writerBean = !m.byHand && m.have.has('OutboxWriter');
        rWriter.set(m.byHand ? 'one per new (not shared)' : writerBean ? '1, shared singleton' : 'none', m.byHand ? 'warn' : null);
        rCheck.set(m.byHand ? 'never runs' : writerBean ? 'enforced by the proxy' : 'n/a', m.byHand ? 'bad' : null);

        const inTx = caller.get() === 'tx';
        if (m.fail && m.fail.type === 'cycle') {
          verdict.set('bad', 'The context refuses to start: DeploymentService needs OutboxWriter and OutboxWriter needs DeploymentService, so neither can be built first (BeanCurrentlyInCreationException, standard Spring Boot behaviour). Break the loop by moving what they share into a third bean.');
        } else if (m.fail) {
          verdict.set('bad', 'Startup fails before any request is served: ' + m.fail.consumer + ' needs a bean of type ' + m.fail.dep + ' (parameter ' + m.fail.index + ', counted from 0) and none exists. Which consumer is reported first depends on creation order; the message format is standard Spring Boot, not captured from Appfleet.');
        } else if (m.removed !== 'none' && !m.have.has(m.removed) && !(m.byHand && m.removed === 'OutboxWriter')) {
          verdict.set('ok', 'Started anyway: nothing left in the graph needs ' + m.removed + '. A missing bean only fails when some constructor asks for it.');
        } else if (m.byHand && inTx) {
          verdict.set('warn', 'It works today, but only because the caller happens to be inside a transaction and the repository joins it. The writer is not a bean, so nothing enforces that: Propagation.MANDATORY is ignored. Each caller also needs its own repository and JsonMapper to build one.');
        } else if (m.byHand) {
          verdict.set('bad', 'Silent failure. No proxy, so no MANDATORY check: the row is saved by the repository’s own transaction and commits alone, a command for a deployment that may never commit. No exception anywhere (standard Spring behaviour, not measured in Appfleet).');
        } else if (!m.have.has('OutboxWriter')) {
          verdict.set('ok', 'Started, and there is no OutboxWriter bean. Nothing asks for one today because DeploymentService does not take it yet.');
        } else if (inTx) {
          verdict.set('ok', 'The container built OutboxWriter once and its proxy lets write() join the caller’s transaction. The outbox row commits or rolls back together with the deployment.');
        } else {
          verdict.set('bad', 'IllegalTransactionStateException: "No existing transaction found for transaction marked with propagation \'mandatory\'". This is the safe failure: the proxy refuses a call outside a transaction (standard Spring message).');
        }
      }

      el.append(
        controls(remove.el, make.el, ask.el, cycle.el, caller.el),
        stage(h('div', { class: 'sim-cols' },
          ui.panel('The graph around DeploymentService', h('div', { class: 'sim-cols' }, laneInfra.el, laneComp.el, laneSvc.el)),
          ui.panel('DeploymentService constructor', ctorBox),
          ui.panel('Startup', startBox))),
        readouts(rStart, rBeans, rWriter, rCheck),
        note('The nodes and constructor parameters are read from the control-api sources. The startup messages are the standard Spring Boot texts, not captured from Appfleet. Today DeploymentService has 7 parameters and none is OutboxWriter: the "asks for OutboxWriter" switch shows how it would be wired. Parameter numbers count from 0, as Spring Boot prints them.'),
        verdict.el
      );
      update();
    }
  });

  // =====================================================================
  // sp-config: Typed configuration, profiles and environment variables
  // =====================================================================

  AF.register({
    id: 'sp-config',
    group: 'spring',
    order: 8,
    title: 'Typed configuration, profiles and environment variables',
    question: 'How does APPFLEET_RATELIMIT_CAPACITY=3 on the command line become a validated Java record, and why did a test profile quietly decide whether rate limiting ran?',
    status: 'built',
    slice: 'S0, S3.6, S4.5',
    where: [
      'control-api/src/main/java/io/appfleet/control/config/AppfleetProperties.java (record, @ConfigurationProperties, @Validated, @NotBlank environment)',
      'control-api/src/main/java/io/appfleet/control/ratelimit/RateLimitProperties.java (@DefaultValue, @Positive); ControlApiApplication.java (@EnableConfigurationProperties)',
      'src/main/resources/application.yml, application-local.yml, application-test.yml (rate-limit.enabled: false), application-prod.yml',
      'docs/design/control-api/control-api-s3-6-rate-limiting.md (decision 9, red run: 203 run, 39 failures, 1 error); control-api-s4-2-principal.md section 9 (manual check with APPFLEET_RATELIMIT_CAPACITY=3); RateLimitEndpointsTest (@TestPropertySource)'
    ],
    idea: [
      'Spring Boot gathers settings from many property sources and lets you bind a group of them to a typed object. In Appfleet that object is a record: AppfleetProperties(environment, rateLimit), with RateLimitProperties(enabled, capacity, refillPerSecond) nested inside. @DefaultValue supplies what to use when nothing sets a value (rate limiting on, capacity 60, refill 1.0), and @Validated with @NotBlank and @Positive makes Spring check the result. If validation fails, the application stops at startup, before it listens on port 8081, with the offending property and where its value came from.',
      'The same setting can arrive in several places, and Boot uses a fixed order of precedence: command-line arguments, then OS environment variables, then application-<profile>.yml, then application.yml, then the defaults in the code. Relaxed binding lets one setting be written many ways: appfleet.rate-limit.capacity, appfleet.rateLimit.capacity and the environment variable APPFLEET_RATELIMIT_CAPACITY all bind to the same property. S4.2’s manual check ran the jar on profile local with APPFLEET_RATELIMIT_CAPACITY=3 and saw 200 200 200 429 429. Profiles pick extra files: application-test.yml sets appfleet.rate-limit.enabled to false.',
      'That last file was a decision, not a detail. S3.6 recorded a red run with the limiter switched on for the whole suite: 203 tests run, 39 failures and 1 error in three classes, because the tests share one bucket and get 429s. The test profile turns it off, and RateLimitEndpointsTest turns it back on for itself with @TestPropertySource, which outranks the profile file. Two traps remain: a misspelled name binds nothing and raises no error (APPFLEET_RATE_LIMIT_CAPACITY is read as appfleet.rate.limit.capacity, standard Boot behaviour), and the base application.yml has no appfleet.environment, so with no active profile the @NotBlank check stops startup.'
    ],
    terms: [
      ['@ConfigurationProperties', 'Binds settings under a prefix (here "appfleet") to a typed object. A record gives immutable, constructor-bound settings.'],
      ['Relaxed binding', 'Kebab case, camel case and UPPER_SNAKE environment names that Boot treats as the same property. Dots become underscores in environment names and the dash is dropped.'],
      ['Profile', 'A named set of settings, activated by spring.profiles.active. application-<profile>.yml is loaded on top of application.yml.'],
      ['Precedence', 'When several sources set the same property the highest wins: command line, environment, profile file, base file, then the code’s defaults.'],
      ['Fail fast', 'Validation runs at startup. A bad value stops the application with the property name, the value and its origin, rather than surfacing at the first request.'],
      ['@DefaultValue', 'The value a record component takes when no source sets it. It applies to a nested record too, so appfleet.rate-limit can be absent entirely.']
    ],
    tryIt: [
      'Press "Replay S4.2 manual check": profile local, environment variable APPFLEET_RATELIMIT_CAPACITY set to 3. Capacity 3 wins from the environment layer, and the limiter stays on.',
      'Choose profile "test": enabled becomes false from application-test.yml and the verdict says the limiter is off. Now set "Command line enabled" to "true": the command line outranks the profile file and the verdict shows the S3.6 red-run warning.',
      'Set "Env var name" to APPFLEET_RATE_LIMIT_CAPACITY with a capacity value: the layer turns amber, "no match", and the default 60 stays. No error is raised.',
      'Set "Command line capacity" to 0: startup fails with a @Positive violation naming the property and its origin.',
      'Choose profile "none": the base file has no appfleet.environment, so @NotBlank stops startup.'
    ],
    breakIt: 'Set capacity to 0 on any layer. The record is built from the winning value and then validated, so @Positive rejects it and the application never starts. Without @Validated and @Positive a zero would load happily and the limiter would deny every request, a failure found only by the first caller.',
    say: 'Settings bind to a validated record with defaults, from a fixed precedence of command line, environment, profile file and base file, so a bad value stops startup, and I keep the test profile’s rate-limit switch explicit because S3.6 showed 39 failures and 1 error without it.',
    quiz: {
      q: 'application-test.yml sets appfleet.rate-limit.enabled to false. The app is started with --spring.profiles.active=test and the environment variable APPFLEET_RATELIMIT_ENABLED=true. What is the effective value?',
      options: [
        'false, because a profile file is more specific than the base file and always wins',
        'true, because an environment variable outranks the profile file',
        'The application fails to start, because the two sources conflict',
        'false, because @DefaultValue("true") is only used when the profile is not "test"'
      ],
      answer: 1,
      why: 'Boot resolves each property to the highest source: environment variables beat profile files, which beat application.yml, which beats defaults in code. There is no conflict error. This is standard Spring Boot precedence; the Appfleet tests rely on the same rule when @TestPropertySource outranks application-test.yml.'
    },
    mount(el, ctx) {
      // File contents are the real application*.yml of control-api (2026-10-05). Precedence is standard Spring Boot behaviour.
      // The failure text mirrors Boot's binding report in shape; it was not captured from Appfleet.
      const cfgProfileFile = {
        local: { env: 'local', enabled: null },
        test: { env: 'test', enabled: 'false' },
        prod: { env: 'prod', enabled: null },
        none: null
      };

      const verdict = ui.verdict();
      const layerBox = h('div', { class: 'stack' });
      const failBox = ui.code('', 'Startup result');
      const rProfile = ui.readout('Active profile');
      const rCap = ui.readout('capacity');
      const rEn = ui.readout('enabled');
      const rStart = ui.readout('Startup');

      const profile = ui.choice('Active profile', [
        { value: 'local', label: 'local' },
        { value: 'test', label: 'test' },
        { value: 'prod', label: 'prod' },
        { value: 'none', label: 'none' }
      ], 'local', update);
      const baseCap = ui.choice('application.yml capacity (hypothetical edit)', [
        { value: 'unset', label: 'not set (real file)' },
        { value: '10', label: '10' }
      ], 'unset', update);
      const envCap = ui.choice('Env var capacity', [
        { value: 'unset', label: 'not set' },
        { value: '3', label: '3' },
        { value: '0', label: '0' }
      ], 'unset', update);
      const envEn = ui.choice('Env var enabled', [
        { value: 'unset', label: 'not set' },
        { value: 'true', label: 'true' },
        { value: 'false', label: 'false' }
      ], 'unset', update);
      const envName = ui.choice('Env var name', [
        { value: 'ok', label: 'APPFLEET_RATELIMIT_*' },
        { value: 'bad', label: 'APPFLEET_RATE_LIMIT_*' }
      ], 'ok', update);
      const cmdCap = ui.choice('Command line capacity', [
        { value: 'unset', label: 'not set' },
        { value: '5', label: '5' },
        { value: '0', label: '0' }
      ], 'unset', update);
      const cmdEn = ui.choice('Command line enabled', [
        { value: 'unset', label: 'not set' },
        { value: 'true', label: 'true' },
        { value: 'false', label: 'false' }
      ], 'unset', update);
      const cmdSpell = ui.choice('Command line spelling', [
        { value: 'kebab', label: 'rate-limit' },
        { value: 'camel', label: 'rateLimit' }
      ], 'kebab', update);

      const replay = ui.button('Replay S4.2 manual check', () => {
        profile.set('local'); baseCap.set('unset'); envCap.set('3'); envEn.set('unset'); envName.set('ok');
        cmdCap.set('unset'); cmdEn.set('unset'); cmdSpell.set('kebab');
        update();
      }, { variant: 'primary' });
      const reset = ui.button('Reset', () => {
        profile.set('local'); baseCap.set('unset'); envCap.set('unset'); envEn.set('unset'); envName.set('ok');
        cmdCap.set('unset'); cmdEn.set('unset'); cmdSpell.set('kebab');
        update();
      }, { variant: 'quiet' });

      function layers() {
        const p = profile.get();
        const file = cfgProfileFile[p];
        const sp = cmdSpell.get() === 'camel' ? 'rateLimit' : 'rate-limit';
        const envOk = envName.get() === 'ok';
        const envPrefix = envOk ? 'APPFLEET_RATELIMIT_' : 'APPFLEET_RATE_LIMIT_';
        return [
          { name: 'Command line', cap: cmdCap.get() === 'unset' ? null : cmdCap.get(), en: cmdEn.get() === 'unset' ? null : cmdEn.get(),
            capName: '--appfleet.' + sp + '.capacity', enName: '--appfleet.' + sp + '.enabled', origin: 'Command line argument', matches: true },
          { name: 'Environment variable', cap: envCap.get() === 'unset' ? null : envCap.get(), en: envEn.get() === 'unset' ? null : envEn.get(),
            capName: envPrefix + 'CAPACITY', enName: envPrefix + 'ENABLED', origin: 'System Environment Property', matches: envOk },
          { name: file ? 'application-' + p + '.yml' : 'no profile file', cap: null, en: file ? file.enabled : null,
            capName: '', enName: 'appfleet.rate-limit.enabled', origin: 'class path resource [application-' + p + '.yml]', matches: true },
          { name: 'application.yml', cap: baseCap.get() === 'unset' ? null : baseCap.get(), en: null,
            capName: 'appfleet.rate-limit.capacity', enName: '', origin: 'class path resource [application.yml]', matches: true },
          { name: 'Defaults in the record', cap: '60', en: 'true', capName: '@DefaultValue("60")', enName: '@DefaultValue("true")', origin: 'RateLimitProperties default', matches: true }
        ];
      }

      function pick(list, key) {
        for (const l of list) {
          if (l[key] !== null && l.matches) return l;
        }
        return null;
      }

      function update() {
        const p = profile.get();
        const L = layers();
        const capWin = pick(L, 'cap');
        const enWin = pick(L, 'en');
        const cap = Number(capWin.cap);
        const enabled = enWin.en === 'true';

        AF.clear(layerBox);
        let unmatched = false;
        L.forEach(l => {
          const chip = (key, nameKey, label, win) => {
            if (l[key] === null) return ui.token(label + ' not set', 'idle');
            if (!l.matches) { unmatched = true; return ui.token(label + ' ' + l[key] + ' (' + l[nameKey] + ': no match, ignored)', 'warn'); }
            return ui.token(label + ' ' + l[key] + (win === l ? ' (wins)' : ' (shadowed)'), win === l ? 'ok' : 'idle');
          };
          layerBox.appendChild(h('div', null, h('b', { class: 'small' }, l.name), ' ', chip('cap', 'capName', 'capacity', capWin), ' ', chip('en', 'enName', 'enabled', enWin)));
        });

        const violations = [];
        if (p === 'none') violations.push({ prop: 'appfleet.environment', value: 'null', origin: 'none (no source sets it)', reason: 'must not be blank' });
        if (!(cap > 0)) violations.push({ prop: 'appfleet.rate-limit.capacity', value: '"' + capWin.cap + '"', origin: capWin.origin + (capWin.capName ? ' "' + capWin.capName + '"' : ''), reason: 'must be greater than 0' });

        if (violations.length) {
          setCode(failBox, 'APPLICATION FAILED TO START\n\nDescription:\n\nBinding to target AppfleetProperties failed:\n\n' + violations.map(v => '    Property: ' + v.prop + '\n    Value: ' + v.value + '\n    Origin: ' + v.origin + '\n    Reason: ' + v.reason).join('\n\n') + '\n\nAction:\n\nUpdate your application\'s configuration');
        } else {
          setCode(failBox, 'Started ControlApiApplication on port 8081\n\nAppfleetProperties[\n  environment=' + cfgProfileFile[p].env + ',\n  rateLimit=RateLimitProperties[enabled=' + enabled + ', capacity=' + cap + ', refillPerSecond=1.0]\n]');
        }

        rProfile.set(p === 'none' ? 'none (no file)' : p);
        rCap.set(violations.length && !(cap > 0) ? capWin.cap + ' from ' + capWin.name : cap + ' from ' + capWin.name, !(cap > 0) ? 'bad' : null);
        rEn.set(enabled + ' from ' + enWin.name);
        rStart.set(violations.length ? 'FAILED' : 'Started', violations.length ? 'bad' : 'ok');

        if (violations.length) {
          verdict.set('bad', 'Startup stops before port 8081 opens (fail fast). ' + (p === 'none' && cap > 0 ? 'The base application.yml has no appfleet.environment, so with no profile @NotBlank rejects it (read from the files, not run).' : 'capacity ' + capWin.cap + ' violates @Positive; the report names the property and the source that won (standard Boot behaviour).'));
        } else if (unmatched) {
          verdict.set('warn', 'One of your values matched nothing. APPFLEET_RATE_LIMIT_* is read as appfleet.rate.limit.*, which is not a property of AppfleetProperties, so it is ignored without an error and the next layer wins (standard Boot behaviour, not run in Appfleet).');
        } else if (p === 'test' && enabled) {
          verdict.set('warn', 'Rate limiting is on under the test profile. S3.6 recorded this as the red run: with it enabled for every test, 203 run, 39 failures, 1 error across DeploymentEndpointsTest, IdempotencyEndpointsTest and ApplicationPaginationTest, all 429s from a shared bucket.');
        } else if (!enabled) {
          verdict.set('ok', 'Rate limiting is off: RateLimitInterceptor.preHandle returns true before touching Redis' + (p === 'test' ? '. This is the shipped test profile; RateLimitEndpointsTest switches it back on with @TestPropertySource.' : '.'));
        } else {
          verdict.set('ok', 'Rate limiting is on with a burst of ' + cap + ' requests per caller, then 429' + (cap === 3 && capWin.name === 'Environment variable' ? '. S4.2 section 9 saw exactly this: alice 200 200 200 429 429, bob 200.' : '. The relaxed name that matched is the same property, appfleet.rate-limit.capacity.'));
        }
      }

      el.append(
        controls(profile.el, baseCap.el, envCap.el, envEn.el, envName.el, cmdCap.el, cmdEn.el, cmdSpell.el, replay, reset),
        stage(h('div', { class: 'sim-cols' },
          ui.panel('Sources, highest first', layerBox),
          ui.panel('Binding and validation', failBox))),
        readouts(rProfile, rCap, rEn, rStart),
        note('Profile files are the real ones: only application-test.yml sets rate-limit.enabled (false), and the base file sets no rate-limit key, so the defaults are enabled=true, capacity=60, refill 1.0. The precedence, the relaxed names and the report layout are standard Spring Boot behaviour, not measured in Appfleet. Refill per second has the same rules and is left out.'),
        verdict.el
      );
      update();
    }
  });



  // =====================================================================
  // 15. One thread per request
  // =====================================================================
  AF.register({
    id: 'sp-threads',
    group: 'spring',
    order: 15,
    title: 'One thread per request',
    question: 'Does every REST endpoint get its own thread, how can two requests to the same endpoint race, what happens to a request’s identity when you start a thread of your own, and why is a shared HashMap a bug?',
    status: 'built',
    slice: 'S3.3, S3.5, S4.2, S4.4',
    where: [
      'control-api/src/main/java/io/appfleet/control/web/CorrelationIdFilter.java (MDC put and remove in a finally)',
      'control-api/src/main/java/io/appfleet/control/ratelimit/RateLimitInterceptor.java and security/TeamAccess.java (SecurityContextHolder)',
      'ApplicationEndpointsTest.concurrentCreate_sameName_oneCreated_oneConflict, DeploymentEndpointsTest.concurrentRollbacks_one202_one409_exactlyOneTask',
      'control-api/src/main/resources/application.yml (server.port only: every thread and pool limit is a Spring Boot default)',
      'docs/design/control-api/control-api-s3-3-deployments.md, section 5.2 and Results'
    ],
    idea: [
      'Spring MVC on Tomcat is thread-per-request, not thread-per-endpoint. Tomcat keeps a pool of worker threads (200 by default, standard Spring Boot behaviour; Appfleet sets none). A request takes one free thread, and that thread runs the whole request: the filters, the interceptor, the controller, the service, the database call, and the response. Then it goes back to the pool. Appfleet’s logs show it: the thread column reads nio-8081-exec-2 and nio-8081-exec-10, two different workers of the same pool.',
      'So five clients calling POST /deployments at once run on five threads, and so do two clients calling the same rollback. The controller and the service are singletons that every thread shares, which is why they hold no per-request state. Per-request state lives in ThreadLocals, which is safe only because one request owns one thread for its whole life: the SecurityContextHolder (read by RateLimitInterceptor and TeamAccess), the MDC correlation id (CorrelationIdFilter puts it in and removes it in a finally, because the thread is reused), and the transaction. Two threads on one deployment is a real race: S3.3 recorded one 202 and one 409, decided by the optimistic lock, and the tests recreate it with a CyclicBarrier and two threads.',
      'Three limits follow. A request that blocks (waiting on a dead broker, for example) holds its thread, and when all workers are blocked the next request waits in the queue, which is why every outbound call gets a timeout. Work you hand to your own thread or a CompletableFuture runs on a thread that has none of the ThreadLocals, so it sees no caller. And virtual threads (spring.threads.virtual.enabled) keep the model, one thread per request, but make blocking cheap; Appfleet does not enable them. Finally, because every thread shares the singleton beans, a static or singleton HashMap that two requests read and then write is a race: both read the same value, both write, and one update is lost. A plain HashMap is not thread-safe at all; a ConcurrentHashMap makes each single call atomic but not a read followed by a put, so you use merge or compute; and any in-memory map is private to one instance and lost on restart, which is why Appfleet keeps shared state in Postgres and Redis. Its own red run showed it: a read-modify-write limiter written in Java let concurrent requests read the same token count and failed 6 of 6 runs (S3.6 Results).'
    ],
    terms: [
      ['Thread-per-request', 'The server runs each request start to finish on one worker thread taken from a pool. It is the model of Spring MVC on Tomcat.'],
      ['Worker pool', 'The fixed set of reusable request threads (Tomcat default: 200). When all are busy, new requests queue.'],
      ['ThreadLocal', 'A variable with one value per thread. SecurityContextHolder, the MDC and the current transaction are ThreadLocals, which is why they need no parameter.'],
      ['Singleton bean', 'One instance shared by all threads. It must hold no per-request state.'],
      ['Lost update', 'Two threads read the same value, each writes its change, and the second write overwrites the first. A read followed by a write is not atomic, whatever collection you use.'],
      ['Virtual thread', 'A cheap JVM-managed thread. With spring.threads.virtual.enabled each request gets one, and blocking no longer ties up a scarce platform thread.']
    ],
    tryIt: [
      'Leave "Server" on "Platform threads", set "Requests arriving together" to 8 and "Worker threads" to 2, and read "Waited longest": the requests queue behind two threads.',
      'Switch "What the request does" to "Blocks on a dead broker for the timeout": the same two threads now hold their requests for five ticks each, and the queue grows.',
      'Switch "Server" to "Virtual threads": every request starts at once. Appfleet does not run this; the note says so.',
      'Pick "POST …/rollback on one deployment" with two or more requests: the verdict names the race and the recorded S3.3 outcome (one 202, one 409).',
      'Turn on "Hand the work to your own thread": the worker no longer sees the caller. Read what RateLimitInterceptor and TeamAccess do with no authentication.',
      'In "Shared counter", leave "HashMap: read, then put" with the threads interleaving: two increments give 1. Switch to "ConcurrentHashMap.merge" and then "Redis atomic script", and add the second instance.'
    ],
    breakIt: 'Switch on "Hand the work to your own thread". The request’s SecurityContext, correlation id and transaction stay on the request thread, so the code you handed work to has no authenticated caller: TeamAccess denies, and the rate limiter falls back to the shared anonymous bucket and logs a warning. Both behaviours are in the code; the hand-off itself is not used anywhere in control-api today.',
    say: 'Spring MVC runs each request on one Tomcat worker thread from the start of the filter chain to the response, so singleton services must be stateless, per-request data lives in ThreadLocals like the SecurityContext, two requests to the same endpoint really do race (our optimistic-lock tests use a CyclicBarrier to create exactly that), and anything that blocks holds its thread, which is why every outbound call has a timeout.',
    quiz: {
      q: 'Two clients send POST /deployments/{id}/rollback for the same deployment at the same moment. How does Spring run them?',
      options: [
        'One after the other on the same thread, so there is never a race',
        'On two worker threads at the same time, so the optimistic lock in the database decides which one wins',
        'On two threads, but Spring locks the controller method so only one runs at a time',
        'On one thread per endpoint, so both share the rollback endpoint’s thread'
      ],
      answer: 1,
      why: 'Each request takes its own worker thread and runs concurrently. Spring does not lock controller methods. What serialises the writes is the database: requestRollback loads the deployment with OPTIMISTIC_FORCE_INCREMENT, so the loser fails at commit. S3.3 recorded one 202 and one 409 for two concurrent rollbacks.'
    },
    mount(el, ctx) {
      // Illustrative scheduling model: all requests arrive at tick 0, one tick = one quick request.
      // Facts that are real: thread-per-request, the ThreadLocals named, the log thread names, the S3.3 race outcome for two requests.
      const SERVICE = { quick: 1, slow: 5 };

      const verdict = ui.verdict();
      const rThreads = ui.readout('Threads used');
      const rWait = ui.readout('Waited longest');
      const rDone = ui.readout('All done at');
      const rCtx = ui.readout('Caller visible to the work');
      const lanesBox = h('div', { class: 'stack' });
      const ctxBox = h('div', { class: 'stack' });

      const server = ui.choice('Server', [
        { value: 'platform', label: 'Platform threads' },
        { value: 'virtual', label: 'Virtual threads' }
      ], 'platform', update);
      const pool = ui.slider({ label: 'Worker threads', min: 1, max: 8, value: 3, format: v => String(v), onInput: update });
      const arrive = ui.slider({ label: 'Requests arriving together', min: 1, max: 12, value: 6, format: v => String(v), onInput: update });
      const work = ui.choice('What the request does', [
        { value: 'quick', label: 'Quick: database only' },
        { value: 'slow', label: 'Blocks on a dead broker for the timeout' }
      ], 'quick', update);
      const endpoint = ui.choice('Endpoint', [
        { value: 'read', label: 'GET /applications' },
        { value: 'rollback', label: 'POST …/rollback on one deployment' }
      ], 'read', update);
      const handoff = ui.toggle('Hand the work to your own thread', false, update, { tone: 'danger' });

      function schedule() {
        const n = arrive.get();
        const s = SERVICE[work.get()];
        const virtual = server.get() === 'virtual';
        const free = new Array(virtual ? n : pool.get()).fill(0);
        const rows = [];
        for (let i = 0; i < n; i++) {
          let t = 0;
          if (!virtual) free.forEach((f, k) => { if (f < free[t]) t = k; });
          else t = i;
          const start = free[t];
          free[t] = start + s;
          rows.push({ id: i + 1, lane: t, start, end: start + s });
        }
        return rows;
      }

      function update() {
        const virtual = server.get() === 'virtual';
        pool.el.style.display = virtual ? 'none' : '';
        const rows = schedule();
        const lanes = virtual ? rows.length : pool.get();
        AF.clear(lanesBox);
        for (let l = 0; l < lanes; l++) {
          const mine = rows.filter(r => r.lane === l);
          const title = virtual ? 'virtual thread ' + (l + 1) : 'http-nio-8081-exec-' + (l + 1);
          const lane = ui.lane(title, mine.length ? plural(mine.length, 'request') : 'idle');
          mine.forEach(r => lane.body.appendChild(ui.token('#' + r.id + ' ticks ' + r.start + ' to ' + r.end, r.start > 0 ? 'warn' : 'ok')));
          lanesBox.appendChild(lane.el);
        }
        const used = new Set(rows.map(r => r.lane)).size;
        const wait = Math.max(...rows.map(r => r.start));
        const done = Math.max(...rows.map(r => r.end));
        rThreads.set(String(used), 'ok');
        rWait.set(wait + (wait === 1 ? ' tick' : ' ticks'), wait > 0 ? 'warn' : 'ok');
        rDone.set(done + (done === 1 ? ' tick' : ' ticks'));

        const lost = handoff.get();
        rCtx.set(lost ? 'none' : 'authenticated', lost ? 'bad' : 'ok');
        AF.clear(ctxBox);
        const own = ['SecurityContext (the caller)', 'MDC correlation id', 'Transaction (a database connection)'];
        own.forEach(name => ctxBox.appendChild(h('div', { class: 'small' }, (lost ? 'not on the new thread: ' : 'on the request thread: ') + name)));
        ctxBox.appendChild(h('p', { class: 'muted small' }, lost
          ? 'TeamAccess.allows returns false with no JwtAuthenticationToken (TeamAccessTest, noAuthentication_orANonJwtOne_isDenied). RateLimitInterceptor falls back to the shared anonymous bucket and logs a warning (RateLimitInterceptorTest).'
          : 'RateLimitInterceptor.callerKey and TeamAccess read SecurityContextHolder without being passed anything, because this request owns this thread.'));

        const queued = rows.filter(r => r.start > 0).length;
        let text;
        if (virtual) {
          text = 'Every request starts at tick 0 on its own virtual thread, standard Spring Boot behaviour with spring.threads.virtual.enabled. Appfleet does not enable it and has not measured it; the database connection pool (10 by default) would become the next limit.';
        } else if (queued === 0) {
          text = 'Every request found a free worker and started at once. The pool size here is small on purpose: Tomcat’s default is 200, and Appfleet sets none.';
        } else {
          text = queued + ' of ' + rows.length + ' requests waited for a worker; the longest wait was ' + wait + (wait === 1 ? ' tick.' : ' ticks.') +
            (work.get() === 'slow' ? ' Blocked requests hold their thread, so one slow dependency can occupy the whole pool. That is why the outbox poller waits for Kafka off the request path and every send has a timeout.' : '');
        }
        if (endpoint.get() === 'rollback' && rows.length > 1) {
          const overlap = rows.filter(r => r.start === 0).length;
          text += overlap > 1
            ? ' ' + overlap + ' rollbacks of one deployment run at the same time on different threads: a race. S3.3 recorded one 202 and one 409 for two (concurrentRollbacks_one202_one409_exactlyOneTask); for more than two the same rule applies but was not measured.'
            : ' The rollbacks run one after another here, so no race; they are only safe in general because the optimistic lock decides when they overlap.';
        }
        verdict.set(lost ? 'bad' : (queued ? 'warn' : 'ok'), text);
      }

      // ---- shared mutable state: a static or singleton map read and then written by two threads
      const sMode = ui.choice('Shared counter: two threads add 1 each', [
        { value: 'hashmap', label: 'HashMap: read, then put' },
        { value: 'chm-check', label: 'ConcurrentHashMap: read, then put' },
        { value: 'chm-merge', label: 'ConcurrentHashMap.merge' },
        { value: 'redis', label: 'Redis atomic script' }
      ], 'hashmap', updateShared);
      const sInter = ui.toggle('The two threads interleave', true, updateShared, { tone: 'danger' });
      const sInst = ui.toggle('A second control-api instance serves one of them', false, updateShared);
      const sLog = ui.log({ label: 'Steps of the two threads', max: 12 });
      const rFinal = ui.readout('Final count (expected 2)');
      const sVerdict = ui.verdict();

      function updateShared() {
        const mode = sMode.get();
        const inter = sInter.get();
        const second = sInst.get();
        const inMemory = mode !== 'redis';
        sLog.clear();
        let final;
        let tone;
        let text;
        if (inMemory && second) {
          sLog.add('Instance 1 map: thread A adds 1 (0 to 1)', 'muted');
          sLog.add('Instance 2 map: thread B adds 1 (0 to 1)', 'muted');
          final = '1 and 1';
          tone = 'bad';
          text = 'Each instance has its own map, so neither ever sees 2, whatever collection or locking you use. In-memory state is per JVM, and it is also lost on restart. A shared counter has to live in a shared store.';
        } else if (mode === 'redis') {
          sLog.add('A and B each run the script on Redis; Redis executes one script at a time', 'muted');
          sLog.add('A: 0 to 1, then B: 1 to 2' + (second ? ' (from either instance)' : ''), 'ok');
          final = '2';
          tone = 'ok';
          text = 'Redis runs a Lua script atomically, so the read and the write cannot interleave, from one instance or many. This is what the rate limiter and the idempotency claim use (S3.5, S3.6).';
        } else if (mode === 'chm-merge') {
          sLog.add('A: map.merge(key, 1, Integer::sum): 0 to 1 (atomic for this key)', 'ok');
          sLog.add('B: map.merge(key, 1, Integer::sum): 1 to 2', 'ok');
          final = '2';
          tone = 'ok';
          text = 'merge (like compute and computeIfAbsent) performs the read and the write as one atomic step for that key, so the order of the threads does not matter. Correct within one instance; it does not help across instances.';
        } else if (inter) {
          sLog.add('A reads 0', 'muted');
          sLog.add('B reads 0', 'muted');
          sLog.add('A puts 1', 'muted');
          sLog.add('B puts 1', 'bad');
          final = '1 (lost update)';
          tone = 'bad';
          text = mode === 'hashmap'
            ? 'A plain HashMap is not thread-safe: besides the lost update it gives no visibility guarantee between threads, and concurrent writes can corrupt its internal structure. The fix is not a bigger lock around your code; it is not to share a mutable map between request threads.'
            : 'Every single ConcurrentHashMap call is atomic, but get followed by put is two calls, so another thread slips in between (check-then-act). Use merge, compute or putIfAbsent so the check and the write are one call.';
        } else {
          sLog.add('A reads 0, A puts 1', 'muted');
          sLog.add('B reads 1, B puts 2', 'muted');
          final = '2';
          tone = 'warn';
          text = 'Correct only because the threads happened not to overlap. The code is the same and still wrong: under load the timing changes. Appfleet found this class of bug in its own limiter: a read-modify-write written in Java let concurrent requests read the same token count and failed the concurrency test 6 of 6 runs (S3.6 Results, last report 10 requests answered 200 instead of 3).';
        }
        rFinal.set(final, tone);
        sVerdict.set(tone, text);
      }

      el.append(
        controls(server.el, pool.el, arrive.el),
        controls(work.el, endpoint.el, handoff.el),
        stage(h('div', { class: 'sim-cols' },
          ui.panel('Which thread runs which request', lanesBox),
          ui.panel('What each request carries', ctxBox))),
        readouts(rThreads, rWait, rDone, rCtx),
        note('Illustrative scheduling: every request arrives at tick 0 and a quick request takes one tick. Real in Appfleet: the thread-per-request model, the ThreadLocals above, the thread names in the logs, and the recorded S3.3 race. Standard Spring Boot behaviour, not set or measured here: the default pool of 200, the default connection pool of 10, and virtual threads.'),
        verdict.el,
        h('div', { class: 'h4', style: 'margin-top:1.2rem' }, 'Shared state: what if a static or singleton map is read and written by several threads?'),
        controls(sMode.el, sInter.el, sInst.el),
        stage(h('div', { class: 'sim-cols' }, ui.panel('The two threads', sLog.el), ui.panel('Result', rFinal.el, sVerdict.el))),
        note('The interleaving is a deterministic model of standard Java and Redis behaviour, not a measurement of this map. Measured in Appfleet: the Java read-modify-write limiter failed the concurrency test 6 of 6 runs (S3.6 Results), and the racing-rollback tests of S3.3 and S4.5.')
      );
      update();
      updateShared();
    }
  });

  // @@LESSONS@@
})();
