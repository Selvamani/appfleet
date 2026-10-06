/*
 * labs-security-architecture.js: the Security and Architecture lessons of "How Appfleet works".
 *
 *   Security:      sec-rbac, sec-idor, sec-jwt-anatomy (built, S4.1), sec-jwt   (S4)
 *   Architecture:  ar-split, ar-async, ar-resilience, ar-saga
 *
 * Facts come from docs/specs (SPRING-PROJECT.md, project/01, 02, 03, 06) and
 * docs/design/control-api (control-api-s3-rest.md §3.2, control-api-s3-3-deployments.md).
 * Timings and throughput numbers inside the simulations are models, labelled as such in the UI.
 */
(function () {
  'use strict';

  const h = AF.h;
  const ui = AF.ui;
  const SVGNS = 'http://www.w3.org/2000/svg';

  // ---------------------------------------------------------------------
  // Shared helpers
  // ---------------------------------------------------------------------

  /** Build an SVG element. Colours go through style="fill:var(--...)" so they follow the theme tokens. */
  function svg(tag, attrs, ...kids) {
    const el = document.createElementNS(SVGNS, tag);
    if (attrs) {
      for (const k of Object.keys(attrs)) {
        const v = attrs[k];
        if (v === null || v === undefined || v === false) continue;
        el.setAttribute(k, String(v));
      }
    }
    for (const k of kids) {
      if (k === null || k === undefined || k === false) continue;
      el.appendChild(k instanceof Node ? k : document.createTextNode(String(k)));
    }
    return el;
  }

  /** Small grey note inside a simulation. */
  const note = text => h('p', { class: 'small muted' }, text);

  /** A .node box whose second line can change. Returns { el, set(text, tone) }. */
  function box(label, sub) {
    const subEl = h('span', { class: 'node-sub' }, sub || '');
    const el = h('div', { class: 'node' }, h('span', null, label), subEl);
    return {
      el,
      set(text, tone) { subEl.textContent = text; AF.tone(el, tone || null); }
    };
  }

  /** Show or hide without fighting the display value a class sets (the hidden attribute loses to .stack). */
  const show = (el, on) => { el.style.display = on ? '' : 'none'; };

  /** Step delay that collapses to zero when the reader prefers reduced motion. Logic still runs in order. */
  const pause = (ctx, ms) => AF.sleep(ctx, ctx.reducedMotion ? 0 : ms);

  const uniq = arr => arr.filter((v, i) => arr.indexOf(v) === i);
  const pct = x => Math.round(x * 100) + '%';
  const setText = (codeBlock, text) => { codeBlock.firstChild.textContent = text; };

  /** A segmented "Part" switch for lessons with more than one small simulation. */
  function partSwitch(parts, onSwitch) {
    const ch = ui.choice('Part', parts.map(p => ({ value: p.value, label: p.label })), parts[0].value, v => {
      parts.forEach(p => show(p.el, p.value === v));
      if (onSwitch) onSwitch(v);
    });
    parts.forEach((p, i) => show(p.el, i === 0));
    return ch;
  }

  // =====================================================================
  // Security 1: roles, permissions and team-scoped grants
  // =====================================================================

  const ROLE_ORDER = ['VIEWER', 'DEPLOYER', 'OPERATOR', 'ADMIN'];
  // Each role lists only what it adds; RoleHierarchy supplies the rest.
  const BASE_ROLE_PERMS = {
    VIEWER: ['deployment:read'],
    DEPLOYER: ['deployment:create', 'deployment:rollback'],
    OPERATOR: ['node:drain', 'catalog:publish'],
    ADMIN: ['user:manage', 'audit:read']
  };
  const AUDITOR_PERMS = ['deployment:read', 'audit:read'];
  // The broken version: role names written into the code, one list per action.
  const ROLE_NAME_CODE = {
    'deployment:read': ['VIEWER', 'DEPLOYER', 'OPERATOR', 'ADMIN'],
    'deployment:create': ['DEPLOYER', 'OPERATOR', 'ADMIN'],
    'deployment:rollback': ['DEPLOYER', 'OPERATOR', 'ADMIN'],
    'node:drain': ['OPERATOR', 'ADMIN'],
    'catalog:publish': ['OPERATOR', 'ADMIN'],
    'user:manage': ['ADMIN'],
    'audit:read': ['ADMIN']
  };
  const RBAC_ACTIONS = [
    { value: 'deployment:read', label: 'View deployments' },
    { value: 'deployment:create', label: 'Deploy' },
    { value: 'deployment:rollback', label: 'Roll back' },
    { value: 'node:drain', label: 'Drain a node' },
    { value: 'catalog:publish', label: 'Publish to catalogue' },
    { value: 'user:manage', label: 'Manage users' },
    { value: 'audit:read', label: 'Read audit log' }
  ];
  const RBAC_USERS = [
    { id: 'ana', who: 'application developer' },
    { id: 'raj', who: 'release manager' },
    { id: 'ola', who: 'platform operator' },
    { id: 'sam', who: 'security admin' },
    { id: 'kim', who: 'auditor, joined later' }
  ];
  const impliedRoles = r => {
    const i = ROLE_ORDER.indexOf(r);
    return i < 0 ? [r] : ROLE_ORDER.slice(0, i + 1);
  };
  const teamName = t => (t === '*' ? 'all teams' : t);
  const quoteList = arr => arr.map(r => "'" + r + "'").join(', ');

  AF.register({
    id: 'sec-rbac',
    group: 'security',
    order: 1,
    title: 'Roles, permissions and scoped grants',
    question: 'How do you decide who may do what, on which team, without changing code every time a new kind of user turns up?',
    status: 'planned',
    slice: 'S4',
    where: [
      'docs/specs/project/02-IDENTITY-SERVICE.md, Domain model',
      'docs/specs/SPRING-PROJECT.md, User management and RBAC',
      'docs/specs/project/06-BUSINESS-REQUIREMENTS.md, §2 Who uses it',
      'docs/design/control-api/control-api-s4-3-method-security.md (the control-api side: one permission per endpoint with @PreAuthorize hasAuthority, never a role name; built and closed 2026-10-05; the owner-team check (S4.4), identity-service and role bundles are still planned)'
    ],
    idea: [
      'A permission is one verb on one kind of thing, such as deployment:create or node:drain. A role is a named bundle of permissions, and users hold roles. Code only ever asks whether the caller has permission X, never which role they hold. So an admin can define a new role tomorrow by bundling existing permissions, and nothing is redeployed.',
      'A role hierarchy saves repeating grants: ADMIN includes OPERATOR, which includes DEPLOYER, which includes VIEWER. Grants are also scoped to a team. A release manager can be DEPLOYER on Payments and only VIEWER on Search; a global role is just a grant on all teams.',
      'In Appfleet this lives in identity-service, planned for S4. The personas shaped it: developers are VIEWER, release managers DEPLOYER per team, platform operators OPERATOR, security admins ADMIN. The auditor role was not known on day one, which is exactly why checks use permissions. Users are deactivated, never deleted, so the audit trail stays readable.'
    ],
    terms: [
      ['Permission', 'One allowed verb on one kind of object, for example deployment:rollback. The atom the code checks.'],
      ['Role', 'A named bundle of permissions, such as DEPLOYER. Admins manage roles as data.'],
      ['RoleHierarchy', 'Spring Security bean declaring ADMIN > OPERATOR > DEPLOYER > VIEWER, so a higher role implies the lower ones.'],
      ['Scoped grant', 'A role held on one team rather than everywhere: DEPLOYER on Payments.']
    ],
    tryIt: [
      'With User raj, Action Deploy and On team Payments, read the reasoning. Then switch On team to Search: same person, denied, because raj is only VIEWER there.',
      'Press Add AUDITOR role, pick User kim, then in Grants choose All teams and AUDITOR and press Grant. Ask for Read audit log, then for Deploy.',
      'Turn on Check role names instead of permissions and ask for Read audit log again: the hard-coded list has never heard of AUDITOR.',
      'To make it work without a code change, grant kim ADMIN and ask for Manage users: the shortcut over-grants. Watch Permissions held on this team.'
    ],
    breakIt: 'With checks written against role names, a new AUDITOR role is denied everything until someone edits and redeploys the code, and the usual shortcut, granting ADMIN, hands the auditor user management and deploy rights.',
    say: 'Code checks permissions, never role names, and every grant is scoped to a team, so a new role such as auditor is a data change in identity-service rather than a code change.',
    quiz: {
      q: 'The security team wants a new incident-commander role that may roll back any team\'s deployments but not create them. With Appfleet\'s model, what has to change?',
      options: [
        'A new role row bundling deployment:rollback and deployment:read, granted on all teams; no code changes',
        'A hasRole(\'INCIDENT_COMMANDER\') check added to the rollback endpoint, then a redeploy',
        'Make them OPERATOR, since OPERATOR already includes rollback',
        'Add the role to the RoleHierarchy above ADMIN'
      ],
      answer: 0,
      why: 'Enforcement asks for deployment:rollback, so any role bundling that permission works the moment it is granted. A role-name check needs code for every new role, OPERATOR also brings deploy, node:drain and catalog:publish, and a role above ADMIN would inherit everything.'
    },
    mount(el, ctx) {
      let roles, grants;
      let user = 'raj';
      let action = 'deployment:create';
      let askTeam = 'Payments';
      let grantTeam = 'Payments';
      let grantRole = 'VIEWER';

      function freshModel() {
        roles = {};
        Object.keys(BASE_ROLE_PERMS).forEach(r => { roles[r] = BASE_ROLE_PERMS[r].slice(); });
        grants = [
          { user: 'ana', team: 'Payments', role: 'VIEWER' },
          { user: 'raj', team: 'Payments', role: 'DEPLOYER' },
          { user: 'raj', team: 'Search', role: 'VIEWER' },
          { user: 'ola', team: '*', role: 'OPERATOR' },
          { user: 'sam', team: '*', role: 'ADMIN' }
        ];
      }
      freshModel();

      const log = ui.log({ label: 'Grant changes' });
      const verdict = ui.verdict();
      const rolesRo = ui.readout('Roles that apply', '—');
      const permsRo = ui.readout('Permissions held on this team', '—');
      const codeEl = ui.code('', 'The check that runs');
      const chainEl = h('div', { class: 'stack small' });
      const rolesBody = h('div', { class: 'stack' });
      const usersBody = h('div', { class: 'stack' });
      const roleSlot = h('div');

      const userChoice = ui.choice('User', RBAC_USERS.map(u => ({ value: u.id, label: u.id })), user, v => { user = v; render(); });
      const breakT = ui.toggle('Check role names instead of permissions', false, () => render(), { tone: 'danger' });
      const addRoleBtn = ui.button('Add AUDITOR role', () => {
        if (roles.AUDITOR) return;
        roles.AUDITOR = AUDITOR_PERMS.slice();
        addRoleBtn.disabled = true;
        log.add('Role AUDITOR created as data: deployment:read, audit:read. No code changed, nothing redeployed.', 'ok');
        buildRoleChoice();
        render();
      });
      const resetBtn = ui.button('Reset', () => reset(), { variant: 'quiet' });

      const grantTeamChoice = ui.choice('Team', [
        { value: 'Payments', label: 'Payments' },
        { value: 'Search', label: 'Search' },
        { value: '*', label: 'All teams' }
      ], grantTeam, v => { grantTeam = v; });

      function buildRoleChoice() {
        const names = Object.keys(roles);
        if (names.indexOf(grantRole) < 0) grantRole = 'VIEWER';
        const roleChoice = ui.choice('Role', names.map(r => ({ value: r, label: r })), grantRole, v => { grantRole = v; });
        AF.clear(roleSlot).appendChild(roleChoice.el);
      }
      buildRoleChoice();

      const grantBtn = ui.button('Grant', () => {
        if (grants.some(g => g.user === user && g.team === grantTeam && g.role === grantRole)) {
          log.add(user + ' already holds ' + grantRole + ' on ' + teamName(grantTeam) + '.', 'muted');
          return;
        }
        grants.push({ user, team: grantTeam, role: grantRole });
        log.add('Granted ' + grantRole + ' on ' + teamName(grantTeam) + ' to ' + user + '.', 'ok');
        render();
      }, { variant: 'primary', small: true });
      const revokeBtn = ui.button('Revoke', () => {
        const i = grants.findIndex(g => g.user === user && g.team === grantTeam && g.role === grantRole);
        if (i < 0) {
          log.add(user + ' holds no ' + grantRole + ' on ' + teamName(grantTeam) + ' to revoke.', 'muted');
          return;
        }
        grants.splice(i, 1);
        log.add('Revoked ' + grantRole + ' on ' + teamName(grantTeam) + ' from ' + user + '.', 'warn');
        render();
      }, { small: true });

      const actionChoice = ui.choice('Action', RBAC_ACTIONS, action, v => { action = v; render(); });
      const askTeamChoice = ui.choice('On team', [
        { value: 'Payments', label: 'Payments' },
        { value: 'Search', label: 'Search' }
      ], askTeam, v => { askTeam = v; render(); });

      /** Answer "may user do action on askTeam?" and explain every step. */
      function decide() {
        const steps = [];
        const held = grants.filter(g => g.user === user && (g.team === askTeam || g.team === '*'));
        const names = uniq(held.map(g => g.role));
        if (!held.length) {
          steps.push('1. Grant: ' + user + ' holds no role on ' + askTeam + ' and no global role.');
          steps.push('2. Nothing to expand, so no permissions.');
          return { ok: false, steps, names, perms: [], unknown: [] };
        }
        steps.push('1. Grant: ' + held.map(g => g.role + ' on ' + teamName(g.team)).join(', ') + '.');
        const effective = uniq([].concat(...names.map(impliedRoles)));
        const perms = uniq([].concat(...effective.map(r => roles[r] || [])));
        if (!breakT.get()) {
          steps.push('2. Hierarchy: ' + names.map(r => {
            if (ROLE_ORDER.indexOf(r) < 0) return r + ' sits outside the hierarchy';
            const inc = impliedRoles(r);
            return inc.length > 1 ? r + ' includes ' + inc.slice(0, -1).reverse().join(', ') : r + ' is the lowest role';
          }).join('; ') + '.');
          steps.push('3. Permissions: ' + perms.join(', ') + '.');
          const ok = perms.indexOf(action) >= 0;
          steps.push('4. Needs ' + action + ': ' + (ok ? 'present, so allowed.' : 'missing, so denied.'));
          return { ok, steps, names, perms, unknown: [] };
        }
        const allowed = ROLE_NAME_CODE[action];
        const hit = names.filter(r => allowed.indexOf(r) >= 0);
        const unknown = names.filter(r => ROLE_ORDER.indexOf(r) < 0);
        steps.push('2. Code: hasAnyRole(' + quoteList(allowed) + '). Role data is never read.');
        steps.push('3. Caller roles ' + names.join(', ') + (hit.length ? ' match ' + hit.join(', ') + ', so allowed.' : ' match none of them, so denied.'));
        if (unknown.length) {
          steps.push('4. ' + unknown.join(', ') + ' did not exist when this line was written. Fixing it means editing the check and redeploying, or granting a bigger role.');
        }
        return { ok: hit.length > 0, steps, names, perms, unknown };
      }

      function render() {
        AF.clear(rolesBody);
        rolesBody.appendChild(h('div', { class: 'small muted' }, 'Hierarchy: ADMIN > OPERATOR > DEPLOYER > VIEWER. Each role lists only what it adds.'));
        Object.keys(roles).forEach(r => {
          const inc = impliedRoles(r);
          const sub = ROLE_ORDER.indexOf(r) < 0 ? 'outside the hierarchy' : (inc.length > 1 ? 'plus everything ' + inc[inc.length - 2] + ' has' : 'the lowest role');
          rolesBody.appendChild(h('div', { class: 'node' }, r,
            h('span', { class: 'node-sub' }, sub),
            h('div', { class: 'row', style: 'gap:.3rem;margin-top:.35rem' }, roles[r].map(p => ui.token(p)))));
        });

        AF.clear(usersBody);
        RBAC_USERS.forEach(u => {
          const mine = grants.filter(g => g.user === u.id);
          const n = h('div', { class: 'node' }, u.id,
            h('span', { class: 'node-sub' }, u.who + (u.id === user ? ' (selected)' : '')),
            h('div', { class: 'row', style: 'gap:.3rem;margin-top:.35rem' },
              mine.length ? mine.map(g => ui.token(g.role + ' on ' + teamName(g.team))) : ui.token('no grants', 'idle')));
          if (u.id === user) AF.tone(n, 'busy');
          usersBody.appendChild(n);
        });

        const res = decide();
        AF.clear(chainEl);
        res.steps.forEach(s => chainEl.appendChild(h('div', null, s)));
        setText(codeEl, breakT.get()
          ? '// role names written into the code\n@PreAuthorize("hasAnyRole(' + quoteList(ROLE_NAME_CODE[action]) + ')")'
          : "// one permission atom; roles stay data\n@PreAuthorize(\"hasPermission(#teamId, 'Team', '" + action + "')\")");
        rolesRo.set(res.names.length ? res.names.join(', ') : 'none');
        permsRo.set(res.perms.length + ' of ' + RBAC_ACTIONS.length, res.perms.length === RBAC_ACTIONS.length ? 'warn' : null);

        const verb = RBAC_ACTIONS.find(a => a.value === action).label.toLowerCase();
        if (res.ok) {
          verdict.set('ok', 'Allowed: ' + user + ' may ' + verb + ' on ' + askTeam + '.');
        } else if (res.unknown.length && res.perms.indexOf(action) >= 0) {
          verdict.set('warn', 'Denied, wrongly: ' + res.unknown.join(', ') + ' bundles ' + action + ', but the role-name check has never heard of it.');
        } else {
          verdict.set('bad', 'Denied: ' + user + ' may not ' + verb + ' on ' + askTeam + '.');
        }
      }

      function reset() {
        freshModel();
        user = 'raj'; action = 'deployment:create'; askTeam = 'Payments'; grantTeam = 'Payments'; grantRole = 'VIEWER';
        userChoice.set(user); actionChoice.set(action); askTeamChoice.set(askTeam); grantTeamChoice.set(grantTeam);
        breakT.set(false);
        addRoleBtn.disabled = false;
        buildRoleChoice();
        log.clear();
        log.add('Starting grants restored. kim has none: the auditor role does not exist yet.', 'muted');
        render();
      }

      el.append(
        h('div', { class: 'sim-controls' }, userChoice.el, addRoleBtn, breakT.el, resetBtn),
        h('div', { class: 'sim-stage' },
          h('div', { class: 'sim-cols' },
            ui.panel('Roles are data', rolesBody),
            ui.panel('Grants: user, team, role', grantTeamChoice.el, roleSlot, h('div', { class: 'row' }, grantBtn, revokeBtn), usersBody),
            ui.panel('Ask', actionChoice.el, askTeamChoice.el, codeEl, chainEl))),
        h('div', { class: 'readouts' }, rolesRo.el, permsRo.el),
        verdict.el,
        note('deployment:read and audit:read are added in this model so the viewer and the auditor have something to check. The spec names deployment:create, deployment:rollback, node:drain, catalog:publish and user:manage.'),
        log.el
      );
      log.add('kim, the auditor, has no grants yet: the auditor role was not known on day one.', 'muted');
      render();
    }
  });

  // =====================================================================
  // Security 2: object-level authorization and the IDOR
  // =====================================================================

  const IDOR_APPS = [
    { name: 'payments-api', team: 'Payments' },
    { name: 'payments-web', team: 'Payments' },
    { name: 'search-indexer', team: 'Search' },
    { name: 'search-api', team: 'Search' }
  ];
  const IDOR_CALLERS = {
    raj: { name: 'raj', label: 'raj, DEPLOYER on Payments', token: true, role: 'DEPLOYER', deployTeams: ['Payments'], viewTeams: ['Payments'] },
    ana: { name: 'ana', label: 'ana, VIEWER on Payments', token: true, role: 'VIEWER', deployTeams: [], viewTeams: ['Payments'] },
    anon: { name: 'anonymous', label: 'no token', token: false, role: null, deployTeams: [], viewTeams: [] }
  };
  const IDOR_LAYERS = [
    { name: 'URL security', how: 'SecurityFilterChain: /api/** must be authenticated' },
    { name: 'Method security', how: "@PreAuthorize(\"hasRole('DEPLOYER')\")" },
    { name: 'Object check', how: "hasPermission(#appId, 'Application', 'deploy')" },
    { name: 'Data filter', how: 'list query: WHERE owner_team_id IN (token teams)' }
  ];
  const HTTP_TEXT = { 200: '200 OK', 202: '202 Accepted', 401: '401 Unauthorized', 403: '403 Forbidden', 404: '404 Not Found' };

  AF.register({
    id: 'sec-idor',
    group: 'security',
    order: 2,
    title: 'Object-level checks and the IDOR',
    question: 'How do you stop someone who may deploy their own team\'s applications from deploying another team\'s application just by changing an id in the request?',
    status: 'built',
    slice: 'S4',
    where: [
      'docs/design/control-api/control-api-s4-plan.md, S4.4 (the exploit test first, then the object-level check; built and closed 2026-10-05)',
      'docs/design/control-api/control-api-s4-4-idor.md (built and closed 2026-10-05: the permission must be held for the object\'s own team, a foreign object answers like a missing one, a TeamAccess rule in the services; the exploit was seen red first, then 14 tests, a cross-team matrix and eight mutation checks)',
      'docs/specs/project/01-CONTROL-API.md, S4 (build the IDOR first)',
      'docs/specs/SPRING-PROJECT.md, Enforcement, at three layers',
      'docs/design/control-api/control-api-s3-rest.md §3.2 (404, not 403)',
      'control-api/src/main/java/io/appfleet/control/web/TemporaryOpenSecurityConfig.java'
    ],
    idea: [
      'IDOR, an insecure direct object reference, is the bug where the server checks what kind of user you are but not which object you are touching. hasRole(\'DEPLOYER\') answers "may this person deploy at all?". It never asks "may this person deploy this application?", so a deployer who puts another team\'s applicationId in the body gets through.',
      'The fix is an object-level check. In Appfleet (S4.4) a small TeamAccess rule in the services reads Application.ownerTeamId and compares it with the team-scoped permissions in the caller\'s token; Spring\'s standard hook for the same decision is a custom PermissionEvaluator behind @PreAuthorize("hasPermission(#appId, \'Application\', \'deploy\')"). A foreign object answers like a missing one (404). Authentication is centralised in identity-service; this decision stays in control-api, because only the service that owns the data knows who owns the object.',
      'Appfleet stacks three layers: URL rules in the SecurityFilterChain (coarse), method security with @PreAuthorize, and data-level filtering, where list queries are team-scoped so other teams\' rows are never selected. Each catches something the others miss. A caller without permission on an object gets 404, not 403, so the API never confirms the object exists.'
    ],
    terms: [
      ['IDOR', 'Insecure direct object reference: access decided by role, without checking who owns the specific object.'],
      ['PermissionEvaluator', 'The Spring Security hook behind hasPermission(...). It decides for one object and one action.'],
      ['Data-level filtering', 'Queries that only ever select rows the caller may see, for example WHERE owner_team_id IN (:teams).']
    ],
    tryIt: [
      'With Caller raj and Request Deploy search-indexer, press Send: the Object check answers 404 and the strip shows where it stopped.',
      'Turn on Break it: role check only and press Send again: 202 Accepted. A Payments deployer just deployed Search\'s application.',
      'Pick List applications and send it, then turn on Break it: no data filter and send again: Search rows leak, because the object check has no single id to look at.',
      'Switch Caller to ana and to no token, and turn off URL security or Method security, to see which layer catches what.'
    ],
    breakIt: 'Checking only hasRole(\'DEPLOYER\') lets any deployer act on any team\'s application by changing the id in the body; dropping the team-scoped query lets a list endpoint return every team\'s rows.',
    say: 'A role check answers "may you deploy at all", only an object-level PermissionEvaluator comparing ownerTeamId with the token\'s team claims answers "may you deploy this", and I built the IDOR first to prove it, answering 404 so existence never leaks.',
    quiz: {
      q: 'A deployer on Payments sends POST /api/v1/deployments with Search\'s applicationId. Which layer is the only one that can stop it?',
      options: [
        'The SecurityFilterChain rule for /api/**',
        '@PreAuthorize("hasRole(\'DEPLOYER\')")',
        'The PermissionEvaluator comparing Application.ownerTeamId with the token\'s team claims',
        'The team-scoped list query'
      ],
      answer: 2,
      why: 'The caller is authenticated and really is a DEPLOYER, so the URL rule and the role check both pass. The list query does not run on a POST. Only a check that looks at this application\'s owner sees the mismatch, and it answers 404 so the caller cannot tell the application exists.'
    },
    mount(el, ctx) {
      let busy = false;

      const callerChoice = ui.choice('Caller', Object.keys(IDOR_CALLERS).map(k => ({ value: k, label: IDOR_CALLERS[k].label })), 'raj', () => showRequest());
      const reqChoice = ui.choice('Request', [
        { value: 'payments-api', label: 'Deploy payments-api' },
        { value: 'search-indexer', label: 'Deploy search-indexer' },
        { value: 'list', label: 'List applications' }
      ], 'search-indexer', () => showRequest());
      const sendBtn = ui.button('Send', () => send(), { variant: 'primary' });
      const urlT = ui.toggle('URL security', true);
      const methodT = ui.toggle('Method security', true);
      const breakObj = ui.toggle('Break it: role check only', false, null, { tone: 'danger' });
      const breakData = ui.toggle('Break it: no data filter', false, null, { tone: 'danger' });

      const reqCode = ui.code('', 'Request');
      const boxes = IDOR_LAYERS.map(L => {
        const howEl = h('span', { class: 'node-sub' }, L.how);
        const st = h('span', { class: 'node-sub' }, 'waiting');
        const el2 = h('div', { class: 'node' }, h('span', null, L.name), howEl, st);
        return {
          el: el2,
          how(t) { howEl.textContent = t; },
          set(t, tone) { st.textContent = t; AF.tone(el2, tone || null); }
        };
      });
      const rowsLane = ui.lane('Rows in the response', 'GET /api/v1/applications');
      const statusRo = ui.readout('Response', '—');
      const byRo = ui.readout('Stopped by', '—');
      const rowsRo = ui.readout('Rows returned', '—');
      const verdict = ui.verdict();
      const log = ui.log({ label: 'Requests sent' });

      function showRequest() {
        const c = IDOR_CALLERS[callerChoice.get()];
        const r = reqChoice.get();
        const auth = c.token ? 'Authorization: Bearer <' + c.name + "'s access token>" : '(no Authorization header)';
        setText(reqCode, r === 'list'
          ? 'GET /api/v1/applications?limit=20\n' + auth
          : 'POST /api/v1/deployments\n' + auth + '\n{ "applicationId": "<' + r + ' id>", "releaseId": "<release id>", "environment": "staging" }');
        boxes[1].how(r === 'list' ? "@PreAuthorize(\"hasRole('VIEWER')\")" : "@PreAuthorize(\"hasRole('DEPLOYER')\")");
        show(rowsLane.el, r === 'list');
      }

      /** Walk the four layers for one request. Pure: returns what each layer did and the response. */
      function evaluate(c, r, L) {
        const layers = [];
        let stop = null;
        const isList = r === 'list';
        const app = isList ? null : IDOR_APPS.find(a => a.name === r);
        const unreached = { text: 'not reached', tone: 'idle' };

        if (!L.url) layers.push({ text: 'off', tone: 'idle' });
        else if (!c.token) { layers.push({ text: 'stopped it: no token, 401', tone: 'bad' }); stop = { status: 401, by: 'URL security' }; }
        else layers.push({ text: 'passed: token signature valid', tone: 'ok' });

        const need = isList ? 'VIEWER' : 'DEPLOYER';
        if (stop) layers.push(unreached);
        else if (!L.method) layers.push({ text: 'off', tone: 'idle' });
        else if (!c.token) { layers.push({ text: 'stopped it: anonymous caller, 401', tone: 'bad' }); stop = { status: 401, by: 'Method security' }; }
        else if (ROLE_ORDER.indexOf(c.role) < ROLE_ORDER.indexOf(need)) { layers.push({ text: 'stopped it: ' + c.role + ' is not ' + need + ', 403', tone: 'bad' }); stop = { status: 403, by: 'Method security' }; }
        else layers.push({ text: 'passed: caller is ' + c.role, tone: 'ok' });

        if (stop) layers.push(unreached);
        else if (!L.object) layers.push({ text: 'removed: role check only', tone: 'idle' });
        else if (isList) layers.push({ text: 'not applicable: a list has no single id', tone: 'idle' });
        else if (c.deployTeams.indexOf(app.team) >= 0) layers.push({ text: 'passed: owner ' + app.team + ' is in the token', tone: 'ok' });
        else { layers.push({ text: 'stopped it: owner ' + app.team + ' is not in the token, 404', tone: 'bad' }); stop = { status: 404, by: 'Object check' }; }

        if (stop) layers.push(unreached);
        else if (!L.data) layers.push({ text: 'removed: the query returns every row', tone: 'idle' });
        else if (!isList) layers.push({ text: 'not applicable: no list query', tone: 'idle' });
        else layers.push({ text: 'filtered to ' + (c.viewTeams.length ? c.viewTeams.join(', ') : 'no teams'), tone: 'ok' });

        if (stop) {
          let text;
          if (stop.status === 401) {
            text = '401 from ' + stop.by + ': no token, no entry.' + (stop.by === 'Method security' ? ' With URL security off, the method check still demands an authenticated caller.' : ' The coarse layer handles the easy case.');
          } else if (stop.status === 403) {
            text = '403 from Method security: ' + c.name + ' is not a DEPLOYER on any team. Saying so is safe, because it reveals nothing about any application.';
          } else {
            text = '404 from the Object check: ' + app.team + ' owns ' + app.name + ', and ' + c.name + "'s token carries deploy rights on " + (c.deployTeams.join(', ') || 'no team') + ' only. 404, not 403, so the response does not even confirm the application exists.';
          }
          return { layers, status: stop.status, by: stop.by, rows: null, tone: 'ok', text };
        }

        if (!isList) {
          if (c.deployTeams.indexOf(app.team) >= 0) {
            return { layers, status: 202, by: 'nothing, allowed', rows: null, tone: 'ok', text: '202 Accepted, Location /api/v1/tasks/{id}: ' + c.name + ' deploys an application their own team owns. Every layer agreed.' };
          }
          let text;
          if (!c.token) {
            text = 'No checks at all: 202 Accepted for a caller with no token. This is control-api today: TemporaryOpenSecurityConfig permits /api/** until S4.';
          } else if (c.role === 'DEPLOYER') {
            text = 'IDOR: 202 Accepted for ' + app.name + ', owned by ' + app.team + '. The role check asked "is ' + c.name + ' a DEPLOYER?" and the answer is yes, on Payments. Nothing asked who owns ' + app.name + '.';
          } else {
            text = 'Broken authorization: 202 Accepted although ' + c.name + ' is only a ' + c.role + '. With method security and the object check gone, nothing asked whether ' + c.name + ' may deploy at all.';
          }
          return { layers, status: 202, by: 'nothing', rows: null, tone: 'bad', text };
        }

        const rows = L.data ? IDOR_APPS.filter(a => c.viewTeams.indexOf(a.team) >= 0) : IDOR_APPS.slice();
        const leaked = rows.filter(a => c.viewTeams.indexOf(a.team) < 0);
        if (leaked.length) {
          return { layers, status: 200, by: 'nothing', rows, leaked, tone: 'bad', text: '200 OK with ' + leaked.length + ' rows from teams the caller cannot see. The object check guards one id at a time and never runs on a list; only the team-scoped query keeps those rows out.' };
        }
        if (!rows.length) {
          return { layers, status: 200, by: 'Data filter', rows, leaked, tone: 'ok', text: '200 OK with an empty list: the caller belongs to no team, so the scoped query selects nothing.' };
        }
        return { layers, status: 200, by: 'Data filter', rows, leaked, tone: 'ok', text: '200 OK with ' + rows.length + ' rows, all from ' + c.viewTeams.join(', ') + '. The team-scoped query never selected the others.' };
      }

      async function send() {
        if (busy) return;
        busy = true;
        sendBtn.disabled = true;
        const c = IDOR_CALLERS[callerChoice.get()];
        const r = reqChoice.get();
        const res = evaluate(c, r, { url: urlT.get(), method: methodT.get(), object: !breakObj.get(), data: !breakData.get() });
        boxes.forEach(b => b.set('waiting', null));
        verdict.clear();
        statusRo.set('…');
        byRo.set('…');
        rowsRo.set('—');
        AF.clear(rowsLane.body);
        for (let i = 0; i < boxes.length; i++) {
          boxes[i].set('checking', 'busy');
          await pause(ctx, 380);
          if (!ctx.alive) return;
          boxes[i].set(res.layers[i].text, res.layers[i].tone);
        }
        statusRo.set(HTTP_TEXT[res.status], res.tone);
        byRo.set(res.by);
        if (res.rows) {
          rowsRo.set(res.rows.length, res.leaked.length ? 'bad' : 'ok');
          AF.clear(rowsLane.body).appendChild(h('div', { class: 'row', style: 'gap:.35rem' },
            res.rows.length ? res.rows.map(a => {
              const leak = res.leaked.indexOf(a) >= 0;
              return ui.token(a.name + ', ' + a.team + (leak ? ', leaked' : ''), leak ? 'bad' : 'ok');
            }) : ui.token('empty list', 'idle')));
        }
        verdict.set(res.tone, res.text);
        const what = r === 'list' ? 'GET /api/v1/applications' : 'POST /api/v1/deployments (' + r + ')';
        log.add(c.name + '  ' + what + '  ' + HTTP_TEXT[res.status] + ', stopped by ' + res.by, res.tone === 'bad' ? 'bad' : 'ok');
        busy = false;
        sendBtn.disabled = false;
      }

      el.append(
        h('div', { class: 'sim-controls' }, callerChoice.el, reqChoice.el, sendBtn),
        h('div', { class: 'sim-controls' }, urlT.el, methodT.el, breakObj.el, breakData.el),
        h('div', { class: 'sim-stage' },
          h('div', { class: 'stack' },
            reqCode,
            h('div', { class: 'sim-cols' }, boxes.map(b => b.el)),
            rowsLane.el)),
        h('div', { class: 'readouts' }, statusRo.el, byRo.el, rowsRo.el),
        verdict.el,
        note('Planned for S4. Ids are shown as names for readability. Today control-api runs TemporaryOpenSecurityConfig, which permits /api/** with no checks at all.'),
        log.el
      );
      showRequest();
    }
  });

  // =====================================================================
  // Security 3: JWT, refresh rotation, revocation
  // =====================================================================

  const JWT_SPAN = 20; // minutes on the model clock

  function jwtTokens(strategy) {
    if (strategy === 'short') return [[0, 5, 'jti-1'], [5, 10, 'jti-2'], [10, 15, 'jti-3'], [15, 20, 'jti-4']];
    return [[0, 15, 'jti-1'], [15, 20, 'jti-2']];
  }
  /** Minute at which the revoked permission stops working. A refresh in the same minute as the revocation already sees it. */
  function jwtUntil(strategy, R) {
    if (strategy === 'expiry') return 15;
    if (strategy === 'deny') return R;
    return Math.ceil(R / 5) * 5;
  }

  // ---------------------------------------------------------------------
  // sec-jwt-anatomy: what is inside a JWT and what a service checks before it trusts one (S4.1)
  // ---------------------------------------------------------------------

  /** One row per request shape. Offsets are seconds from now. sig: ok | wrong-key | tampered | hmac-public | none. */
  const ANATOMY_SCENARIOS = [
    { id: 'ok', label: 'A valid token', scheme: 'bearer', parses: true, alg: 'RS256', sig: 'ok', exp: 840, nbf: 0, iss: 'appfleet-identity', aud: ['appfleet'],
      note: 'Signed by identity-service, 14 minutes left, right issuer and audience.' },
    { id: 'skew30', label: 'Expired 30 seconds ago', scheme: 'bearer', parses: true, alg: 'RS256', sig: 'ok', exp: -30, nbf: 0, iss: 'appfleet-identity', aud: ['appfleet'],
      note: 'Inside the 60 second clock-skew allowance, so it still passes.' },
    { id: 'skew90', label: 'Expired 90 seconds ago', scheme: 'bearer', parses: true, alg: 'RS256', sig: 'ok', exp: -90, nbf: 0, iss: 'appfleet-identity', aud: ['appfleet'],
      note: 'Beyond the allowance.' },
    { id: 'expired', label: 'Expired an hour ago', scheme: 'bearer', parses: true, alg: 'RS256', sig: 'ok', exp: -3600, nbf: 0, iss: 'appfleet-identity', aud: ['appfleet'],
      note: 'A leaked old token.' },
    { id: 'notyet', label: 'Not valid yet (nbf in an hour)', scheme: 'bearer', parses: true, alg: 'RS256', sig: 'ok', exp: 4500, nbf: 3600, iss: 'appfleet-identity', aud: ['appfleet'],
      note: 'Issued for later.' },
    { id: 'iss', label: 'Wrong issuer', scheme: 'bearer', parses: true, alg: 'RS256', sig: 'ok', exp: 840, nbf: 0, iss: 'evil-idp', aud: ['appfleet'],
      note: 'Signed with the right key but claims another issuer.' },
    { id: 'aud', label: 'Wrong audience', scheme: 'bearer', parses: true, alg: 'RS256', sig: 'ok', exp: 840, nbf: 0, iss: 'appfleet-identity', aud: ['other-service'],
      note: 'A token meant for another service.' },
    { id: 'wrongkey', label: 'Signed with another key', scheme: 'bearer', parses: true, alg: 'RS256', sig: 'wrong-key', exp: 840, nbf: 0, iss: 'appfleet-identity', aud: ['appfleet'],
      note: 'Everything looks right except who signed it.' },
    { id: 'tamper', label: 'Payload changed after signing', scheme: 'bearer', parses: true, alg: 'RS256', sig: 'tampered', exp: 840, nbf: 0, iss: 'appfleet-identity', aud: ['appfleet'],
      note: 'One character of the payload edited, for example a second team added.' },
    { id: 'hs256', label: 'HS256, signed with the public key as the secret', scheme: 'bearer', parses: true, alg: 'HS256', sig: 'hmac-public', exp: 840, nbf: 0, iss: 'appfleet-identity', aud: ['appfleet'],
      note: 'The algorithm-confusion attack: the public key is public, so anyone can use it as an HMAC secret.' },
    { id: 'none', label: 'alg none, no signature', scheme: 'bearer', parses: true, alg: 'none', sig: 'none', exp: 840, nbf: 0, iss: 'appfleet-identity', aud: ['appfleet'],
      note: 'An unsigned token with a valid-looking payload.' },
    { id: 'malformed', label: 'Bearer not-a-jwt', scheme: 'bearer', parses: false, alg: null, sig: 'none', exp: 0, nbf: 0, iss: null, aud: [],
      note: 'Not three base64url parts.' },
    { id: 'basic', label: 'Authorization: Basic ...', scheme: 'basic', parses: false, alg: null, sig: 'none', exp: 0, nbf: 0, iss: null, aud: [],
      note: 'A different scheme.' },
    { id: 'missing', label: 'No Authorization header', scheme: 'none', parses: false, alg: null, sig: 'none', exp: 0, nbf: 0, iss: null, aud: [],
      note: 'Nothing sent.' }
  ];

  const ANATOMY_SKEW = 60;

  /** The seven checks, in order. pass(s, trustAlg) says whether the request gets through that check. */
  const ANATOMY_STEPS = [
    { label: '1. A Bearer token is present', logged: 'no Bearer token in the Authorization header',
      pass: s => s.scheme === 'bearer' },
    { label: '2. It parses as three base64url parts', logged: 'the token is not a JWT',
      pass: s => s.parses },
    { label: '3. The algorithm is RS256 (pinned)', logged: 'unsupported algorithm',
      pass: (s, trust) => trust || s.alg === 'RS256' },
    { label: '4. The signature verifies with the public key', logged: 'Signed JWT rejected: invalid signature',
      pass: (s, trust) => {
        if (s.alg === 'RS256') return s.sig === 'ok';
        if (!trust) return false;                       // never reached: step 3 stopped it
        return s.alg === 'HS256' ? s.sig === 'hmac-public' : s.alg === 'none';   // trusting the header: the attacker picks the check
      } },
    { label: '5. exp and nbf allow it (60 s skew)', logged: 'Jwt expired / used before its nbf',
      pass: s => s.exp > -ANATOMY_SKEW && s.nbf <= ANATOMY_SKEW },
    { label: '6. iss is appfleet-identity', logged: 'The iss claim is not valid',
      pass: s => s.iss === 'appfleet-identity' },
    { label: '7. aud contains appfleet', logged: 'The aud claim is not valid',
      pass: s => s.aud.indexOf('appfleet') >= 0 }
  ];

  function anatomyRun(s, trustAlg) {
    const passed = [];
    for (let i = 0; i < ANATOMY_STEPS.length; i++) {
      if (!ANATOMY_STEPS[i].pass(s, trustAlg)) return { passed, stoppedAt: i };
      passed.push(i);
    }
    return { passed, stoppedAt: -1 };
  }

  AF.register({
    id: 'sec-jwt-anatomy',
    group: 'security',
    order: 3,
    title: 'Inside a JWT: what a service checks before it trusts one',
    question: 'What is in a JWT, and which checks must a service run, in which order, before it believes who the caller is?',
    status: 'built',
    slice: 'S4.1',
    where: [
      'common-security/src/main/java/io/appfleet/security/JwtSecurityAutoConfiguration.java (the decoder: RS256 pinned, timestamp, issuer and audience validators)',
      'common-security/src/main/java/io/appfleet/security/AppfleetJwtAuthenticationConverter.java (claims to authorities, sub as the name)',
      'common-security/src/main/java/io/appfleet/security/ProblemAuthenticationEntryPoint.java and ProblemAccessDeniedHandler.java (401 and 403 as problems)',
      'control-api/src/test/java/io/appfleet/control/web/JwtAuthenticationTest.java (one test per row of the lab) and common-security/src/test/java/io/appfleet/security/testing/TestJwt.java',
      'docs/design/control-api/control-api-s4-1-jwt-validation.md'
    ],
    idea: [
      'A JWT is three base64url parts joined by dots: a header (the algorithm), a payload of claims, and a signature over the first two. The payload is only encoded, not encrypted, so anyone holding the token can read it. The signature is what makes it trustworthy: it proves identity-service wrote exactly these claims.',
      'The registered claims do the checking. iss says who issued it, sub whom it is about (the user id), aud which service it is for, exp and nbf when it is valid, jti its unique id. Appfleet adds teams, a map of team id to permissions. Authentication only establishes who the caller is; what they may do is decided later, from teams, per endpoint and per object.',
      'A service must run the checks in a fixed order and stop at the first failure: a Bearer token is present, it parses, the algorithm is the one expected, the signature verifies with the public key, the time window holds, the issuer is right, the audience is right. Pinning the algorithm matters most. If the service believes the token\'s own alg header, an attacker sets HS256 and signs with the public key, which everyone has, or sets none and sends no signature.',
      'Every failure answers 401 with the same body. The reason is logged on the server and never returned, because a caller who learns which check failed learns what to fix. The one allowed signal is the WWW-Authenticate header: a missing token gets a bare Bearer, a rejected one adds error="invalid_token" (RFC 6750). Spring\'s own entry point also adds error_description, which names the failure, so Appfleet writes the header itself.'
    ],
    terms: [
      ['Claim', 'One field of the payload, such as sub or exp.'],
      ['sub', 'Subject: the user the token is about. In Appfleet a user id UUID, and the name of the authenticated principal.'],
      ['Algorithm confusion', 'Tricking a verifier into using a different algorithm than intended, such as HS256 with the public key as the HMAC secret.'],
      ['Clock skew', 'An allowance (60 seconds here) for two machines disagreeing about the time.'],
      ['401 and 403', '401: we do not know who you are. 403: we know, and you may not do this.']
    ],
    tryIt: [
      'Pick each token in turn and press Check. Watch which of the seven checks stops it and note that the response body never changes.',
      'Compare Expired 30 seconds ago (passes) with Expired 90 seconds ago (stops at check 5): that is the 60 second skew.',
      'Turn on Trust the token\'s alg header, then check the HS256 and alg none tokens: they now get in as a forged caller.',
      'Turn on Return the reason to the client and check a bad token: the response now tells an attacker which check to get past next.'
    ],
    breakIt: 'Build the decoder from whatever the token\'s alg header says, and an attacker needs no key at all: HS256 signed with the public key, or alg none, both authenticate. Return the failure reason and every 401 becomes a hint.',
    say: 'A JWT is a signed set of claims. The service verifies it locally with the issuer\'s public key, checks in order that the scheme, structure, pinned algorithm, signature, time window, issuer and audience are all right, and answers every failure with the same 401 while logging the reason privately. Authentication says who; authorization is a separate decision.',
    quiz: {
      q: 'A service builds its decoder from the RSA public key and pins RS256. An attacker sends a token whose header says HS256, signed with HMAC using the public key bytes as the secret. What happens?',
      options: [
        'It is accepted, because the HMAC verifies against the key the service holds',
        'It is rejected at the algorithm check: the service only accepts RS256, whatever the header claims',
        'It is accepted only if the exp claim is in the future',
        'It is rejected because HMAC keys must be 512 bits'
      ],
      answer: 1,
      why: 'The service decides the algorithm, not the token. HS256 never reaches signature verification, so the attack fails. The public key is public: with a verifier that trusts the header, it is also a valid HMAC secret, which is why the pin matters. It is also why RSA, not a shared HMAC secret, suits several services: with HMAC every verifier could mint tokens too.'
    },
    mount(el, ctx) {
      let leak = false;
      let trust = false;

      const picker = h('select', { class: 'select', 'aria-label': 'Token to send' },
        ANATOMY_SCENARIOS.map(s => h('option', { value: s.id }, s.label)));
      const pickerLabel = h('label', { class: 'muted' }, 'Token ', picker);
      const trustTg = ui.toggle('Trust the token\'s alg header', false, v => { trust = v; clearResult(); }, { tone: 'danger' });
      const leakTg = ui.toggle('Return the reason to the client', false, v => { leak = v; clearResult(); }, { tone: 'danger' });
      const checkBtn = ui.button('Check', () => check(), { variant: 'primary' });

      const noteEl = h('p', { class: 'muted' }, '');
      const decoded = h('div', { class: 'stack' });
      const stepNodes = ANATOMY_STEPS.map(st => ui.node(st.label));
      const stepsEl = h('div', { class: 'stack' }, stepNodes);

      const statusRo = ui.readout('Response', '—');
      const stoppedRo = ui.readout('Stopped at', '—');
      const headerRo = ui.readout('WWW-Authenticate', '—');
      const callerRo = ui.readout('Caller', '—');
      const verdict = ui.verdict();
      const bodyEl = h('div', { class: 'stack' });
      const log = ui.log({ label: 'What the service logs (server side only)' });

      function scenario() { return ANATOMY_SCENARIOS.find(s => s.id === picker.value); }

      function payloadText(s) {
        if (s.scheme !== 'bearer' || !s.parses) return '(nothing to decode)';
        const rel = n => (n >= 0 ? 'in ' + n + ' s' : -n + ' s ago');
        const teams = s.sig === 'tampered' ? '{ team-A: [deployment:create], team-B: [deployment:create] }  <- edited' : '{ team-A: [deployment:create] }';
        return [
          '{ "iss": "' + s.iss + '",',
          '  "sub": "6dbd964a-2f76-4e85-8feb-580441de88f4",',
          '  "aud": ' + JSON.stringify(s.aud) + ',',
          '  "exp": ' + rel(s.exp) + (s.nbf > 0 ? ',  "nbf": ' + rel(s.nbf) : '') + ',',
          '  "teams": ' + teams + ' }'
        ].join('\n');
      }

      function headerText(s) {
        if (s.scheme === 'none') return 'Authorization: (absent)';
        if (s.scheme === 'basic') return 'Authorization: Basic dXNlcjpwYXNz';
        if (!s.parses) return 'Authorization: Bearer not-a-jwt';
        return '{ "alg": "' + s.alg + '", "typ": "JWT" }  .  payload  .  ' +
          (s.sig === 'none' ? '(no signature)' : s.sig === 'ok' ? 'signature by identity-service' : s.sig === 'wrong-key' ? 'signature by another RSA key' : s.sig === 'hmac-public' ? 'HMAC, secret = the public key' : 'signature of the original payload');
      }

      function paintToken() {
        const s = scenario();
        noteEl.textContent = s.note;
        AF.clear(decoded);
        decoded.append(ui.panel('Header and signature', ui.code(headerText(s), 'Token header')), ui.panel('Payload (readable by anyone)', ui.code(payloadText(s), 'Token payload')));
      }

      function clearResult() {
        stepNodes.forEach(n => AF.tone(n, 'idle'));
        statusRo.set('—');
        stoppedRo.set('—');
        headerRo.set('—');
        callerRo.set('—');
        verdict.clear();
        AF.clear(bodyEl);
      }

      function problemBody(reason) {
        const detail = leak ? reason : 'Authentication required';
        return ui.code('HTTP 401  application/problem+json\n{ "type": "urn:appfleet:problem:unauthorized",\n  "title": "Unauthorized", "status": 401,\n  "detail": "' + detail + '",\n  "correlationId": "..." }', 'Response body');
      }

      function check() {
        const s = scenario();
        const r = anatomyRun(s, trust);
        AF.clear(bodyEl);
        stepNodes.forEach((n, i) => {
          if (r.stoppedAt === -1 || i < r.stoppedAt) AF.tone(n, 'ok');
          else if (i === r.stoppedAt) AF.tone(n, 'bad');
          else AF.tone(n, 'idle');
        });
        if (r.stoppedAt === -1) {
          const forged = s.sig === 'hmac-public' || s.sig === 'none';
          statusRo.set('200', forged ? 'bad' : 'ok');
          stoppedRo.set('nothing', forged ? 'bad' : 'ok');
          headerRo.set('none');
          callerRo.set(forged ? 'forged' : 'user 6dbd...', forged ? 'bad' : 'ok');
          log.add('accepted: sub 6dbd964a, authorities [deployment:create]', forged ? 'warn' : 'ok');
          verdict.set(forged ? 'bad' : 'ok', forged
            ? 'A forged token authenticated. The service believed the header\'s algorithm, so the attacker chose a check they could satisfy. Turn the switch off and check again.'
            : 'Authenticated: the principal is the sub, and the authorities are the permissions from teams. Whether this user may deploy to team-A\'s application is a separate decision.');
          return;
        }
        const step = ANATOMY_STEPS[r.stoppedAt];
        const header = s.scheme === 'bearer' ? 'Bearer error="invalid_token"' + (leak ? ', error_description="' + step.logged + '"' : '') : 'Bearer';
        statusRo.set('401', 'bad');
        stoppedRo.set('check ' + (r.stoppedAt + 1), 'bad');
        headerRo.set(header, leak ? 'bad' : null);
        callerRo.set('none', 'bad');
        bodyEl.append(problemBody(step.logged));
        log.add('401: ' + step.logged, 'warn');
        verdict.set(leak ? 'warn' : 'ok', leak
          ? 'Stopped at check ' + (r.stoppedAt + 1) + ', and the response now says why. The caller knows exactly which check to get past next.'
          : 'Stopped at check ' + (r.stoppedAt + 1) + '. The caller sees the same 401 body for every failure; only the server log knows the reason.');
      }

      picker.addEventListener('change', () => { paintToken(); clearResult(); });

      el.append(
        h('div', { class: 'sim-controls' }, pickerLabel, checkBtn, trustTg.el, leakTg.el),
        noteEl,
        h('div', { class: 'sim-cols' }, h('div', { class: 'stack' }, decoded), h('div', { class: 'stack' }, ui.panel('The service checks, in order', stepsEl))),
        h('div', { class: 'readouts' }, statusRo.el, stoppedRo.el, headerRo.el, callerRo.el),
        verdict.el,
        bodyEl,
        log.el
      );
      paintToken();
      clearResult();
      verdict.set(null, 'Pick a token and press Check.');
    }
  });

  AF.register({
    id: 'sec-jwt',
    group: 'security',
    order: 4,
    title: 'Tokens, rotation and revocation',
    question: 'How can every service trust a caller without asking the login service on every request, and still cut off access quickly when a role is revoked?',
    status: 'progress',
    slice: 'S4',
    where: [
      'docs/design/control-api/control-api-s4-1-jwt-validation.md (the control-api side: RS256 with a configured public key, validators, the algorithm-confusion test, 401 and 403 as problems; built and closed 2026-10-03; identity-service, refresh rotation and the denylist are still planned)',
      'common-security/src/main/java/io/appfleet/security/ (JwtSecurityAutoConfiguration, AppfleetJwtAuthenticationConverter, ProblemAuthenticationEntryPoint, ProblemAccessDeniedHandler) and src/test/java/.../testing/ (TestKeys, TestJwt)',
      'docs/specs/project/02-IDENTITY-SERVICE.md, Token design',
      'docs/specs/project/02-IDENTITY-SERVICE.md, Security hardening',
      'docs/specs/project/06-BUSINESS-REQUIREMENTS.md, FR-3.3 and NFR-6'
    ],
    idea: [
      'identity-service signs each access token with an RSA private key (RS256) and publishes the public key at /.well-known/jwks.json, tagged with a kid so keys can rotate. Every other service verifies the signature itself, so no network call sits on the request path. With a shared HMAC secret every verifier could also mint tokens; with RSA only identity-service can.',
      'The price of local checks is revocation: a signed token stays valid until it expires. Access tokens live at most 15 minutes and carry sub, jti and a compact team-scoped permissions claim, kept under about 1 KB because it rides in a header. To cut access sooner, put the jti on a Redis denylist with a TTL of the token\'s remaining life, or keep expiry short.',
      'Refresh tokens are one-time use and chained by a family id. A consumed refresh token coming back means someone copied it, so the whole family is revoked. Logins check BCrypt at cost 12, which makes identity-service CPU-bound, and repeated failures in a sliding window (Redis INCR + EXPIRE) lock the account with 423 and Retry-After, behind one uniform error message.',
      'What building the verifying side found (S4.1): the validator list is the security, so each one needs a test that fails without it (issuer, audience, timestamp, and a decoder that wrongly accepts HS256 with the public key as the secret). The 401 header can leak the reason: Spring\'s bearer entry point adds error_description, so the entry point writes the header itself from the error code only. A catch-all @ExceptionHandler(Exception.class) swallows AccessDeniedException into a 500 before the filter chain can answer 403, so security exceptions are rethrown. And configuration slips (a property under the wrong YAML key, a directory with a leading space) pass every unit test and show only in the application.'
    ],
    terms: [
      ['jti', 'JWT id: a unique id per token, and the key of a denylist entry.'],
      ['JWKS', 'JSON Web Key Set: the published public keys, each with a kid, that services use to verify signatures.'],
      ['Token family', 'All refresh tokens descended from one login. Reuse of any consumed member revokes them all.'],
      ['NFR-6', 'Access revocation must take effect in under 5 minutes.']
    ],
    tryIt: [
      'In Revocation, set Revoke at minute, pick Wait for expiry (15 min token) and press Play: the old token keeps deploying to Search until minute 15.',
      'Switch Strategy to Denylist by jti, then to Short expiry (5 min) + rotation, and compare Window with the 5-minute NFR-6 line.',
      'In Refresh rotation, press Client refreshes, then Attacker replays stolen token: the whole family is revoked. Press Reset, turn on Break it: refresh tokens never rotate and try again.',
      'In Identity-service down, turn on Stop identity-service and press Send request. Then turn on Break it: call identity-service on every request and send again.'
    ],
    breakIt: 'Without rotation a stolen refresh token mints access tokens for as long as it lives and nobody notices; without a denylist or short expiry, a revoked DEPLOYER keeps deploying until a 15-minute token runs out, missing NFR-6.',
    say: 'Services verify RS256 tokens locally against the JWKS public key, so identity-service can be down and requests still authorize; revocation inside NFR-6\'s 5 minutes comes from a jti denylist in Redis or short-lived tokens with one-time refresh rotation, where replaying a consumed refresh token revokes the whole family.',
    quiz: {
      q: 'A DEPLOYER\'s role on Search is revoked at minute 2 of a 15-minute access token. Services validate tokens locally and there is no denylist. When does the old token stop working on Search?',
      options: [
        'Immediately, because identity-service updates its role table',
        'At minute 15, when the token expires',
        'On the next request, because control-api re-reads the JWKS',
        'Never, until the user logs out'
      ],
      answer: 1,
      why: 'Local validation checks the signature and expiry, and the permissions are baked into the token. JWKS only carries public keys, not roles. So without a denylist the old permission lives until expiry, 13 more minutes, which misses NFR-6.'
    },
    mount(el, ctx) {
      // ---------------- part 1: revocation timeline ----------------
      let runA = 0;
      let playing = false;
      let playhead = null;
      let xOf = m => m;

      const revokeSl = ui.slider({ label: 'Revoke at minute', min: 1, max: 14, value: 3, onInput: () => { stopPlay(); drawA(); } });
      const strategy = ui.choice('Strategy', [
        { value: 'expiry', label: 'Wait for expiry (15 min token)' },
        { value: 'deny', label: 'Denylist by jti' },
        { value: 'short', label: 'Short expiry (5 min) + rotation' }
      ], 'expiry', () => { stopPlay(); drawA(); });
      const playBtn = ui.button('Play', () => play(), { variant: 'primary' });
      const chartWrap = h('div', { style: 'max-width:760px' });
      const revokedRo = ui.readout('Revoked at', '—');
      const untilRo = ui.readout('Old token works until', '—');
      const windowRo = ui.readout('Window', '—');
      const worstRo = ui.readout('Worst case', '—');
      const costRo = ui.readout('Per request', '—');
      const verdictA = ui.verdict();
      const logA = ui.log({ label: 'Requests on the timeline' });

      function drawA() {
        const R = revokeSl.get();
        const st = strategy.get();
        const until = jwtUntil(st, R);
        const X0 = 124;
        const X1 = 628;
        const x = m => X0 + (X1 - X0) * m / JWT_SPAN;
        xOf = x;
        const g = svg('svg', {
          class: 'chart', viewBox: '0 0 640 170', role: 'img',
          'aria-label': 'Timeline: DEPLOYER on Search revoked at minute ' + R + '; the old permission keeps working until minute ' + until + '.'
        });
        g.appendChild(svg('text', { x: 0, y: 46 }, 'Access tokens'));
        g.appendChild(svg('text', { x: 0, y: 96 }, 'Deploy to Search'));
        jwtTokens(st).forEach(t => {
          const carries = t[0] < R;
          g.appendChild(svg('rect', {
            x: x(t[0]) + 1, y: 30, width: x(t[1]) - x(t[0]) - 2, height: 24, rx: 3,
            style: carries ? 'fill:var(--ok-wash);stroke:var(--ok)' : 'fill:var(--idle-wash);stroke:var(--rail)'
          }));
          if (x(t[1]) - x(t[0]) > 44) g.appendChild(svg('text', { x: x(t[0]) + 6, y: 46 }, t[2] + (carries ? '' : ', no Search')));
        });
        if (st === 'deny') {
          g.appendChild(svg('rect', { x: x(R) + 1, y: 30, width: x(15) - x(R) - 2, height: 24, rx: 3, style: 'fill:var(--bad-wash);stroke:var(--bad)' }));
          if (x(15) - x(R) > 110) g.appendChild(svg('text', { x: x(R) + 6, y: 46 }, 'jti-1 denylisted, TTL ' + (15 - R) + ' min'));
        }
        const seg = (a, b, style, label) => {
          if (b <= a) return;
          g.appendChild(svg('rect', { x: x(a) + 1, y: 80, width: x(b) - x(a) - 2, height: 24, rx: 3, style }));
          if (x(b) - x(a) > 64) g.appendChild(svg('text', { x: x(a) + 6, y: 96 }, label));
        };
        seg(0, R, 'fill:var(--ok-wash);stroke:var(--ok)', '202, role held');
        seg(R, until, 'fill:var(--bad-wash);stroke:var(--bad)', '202 after revoke');
        seg(until, JWT_SPAN, 'fill:var(--idle-wash);stroke:var(--rail)', '404');
        g.appendChild(svg('line', { x1: x(R), x2: x(R), y1: 20, y2: 112, style: 'stroke:var(--bad);stroke-width:2' }));
        g.appendChild(svg('text', { x: x(R) + 3, y: 16 }, 'revoked'));
        if (R + 5 <= JWT_SPAN) {
          g.appendChild(svg('line', { x1: x(R + 5), x2: x(R + 5), y1: 24, y2: 120, style: 'stroke:var(--warn);stroke-width:1.5;stroke-dasharray:4 3' }));
          g.appendChild(svg('text', { x: x(R + 5) + 3, y: 128 }, 'NFR-6 limit'));
        }
        [0, 5, 10, 15, 20].forEach(m => g.appendChild(svg('text', { x: x(m), y: 160, 'text-anchor': 'middle' }, 'min ' + m)));
        playhead = svg('line', { x1: x(0), x2: x(0), y1: 22, y2: 112, style: 'stroke:var(--signal);stroke-width:3;display:none' });
        g.appendChild(playhead);
        AF.clear(chartWrap).appendChild(g);

        const win = until - R;
        revokedRo.set('minute ' + R);
        untilRo.set('minute ' + until);
        windowRo.set(win + ' min', win < 5 ? 'ok' : 'bad');
        worstRo.set(st === 'expiry' ? '15 min' : st === 'deny' ? 'about 0' : 'just under 5 min', st === 'expiry' ? 'bad' : 'ok');
        costRo.set(st === 'deny' ? '1 Redis lookup' : '0 network calls', st === 'deny' ? 'warn' : 'ok');
        if (st === 'expiry') {
          verdictA.set('bad', win >= 5
            ? 'NFR-6 missed: the revoked DEPLOYER keeps deploying to Search for ' + win + ' minutes, until jti-1 expires at minute 15.'
            : win + ' min this time, only because the revocation came late in the token\'s life. The worst case is 15 minutes, so NFR-6 (under 5 min) is not met.');
        } else if (st === 'deny') {
          verdictA.set('ok', 'Cut off at once: from minute ' + R + ' control-api finds jti-1 on the Redis denylist and answers 404. The entry expires with the token (TTL ' + (15 - R) + ' min). Cost: a Redis lookup on every request, so validation is no longer purely local.');
        } else {
          verdictA.set('ok', 'Cut off at minute ' + until + (win === 0 ? ', the same minute' : '') + ': the next refresh issues a token without DEPLOYER on Search. Worst case just under 5 minutes, which meets NFR-6 with no lookup per request. Cost: a refresh every 5 minutes, which is why rotation and theft detection matter.');
        }
      }

      function setPlayhead(m) {
        if (!playhead) return;
        playhead.setAttribute('x1', xOf(m));
        playhead.setAttribute('x2', xOf(m));
        playhead.style.display = '';
      }

      function stopPlay() {
        runA++;
        playing = false;
        playBtn.disabled = false;
        if (playhead) playhead.style.display = 'none';
      }

      async function play() {
        if (playing) return;
        const id = ++runA;
        playing = true;
        playBtn.disabled = true;
        const R = revokeSl.get();
        const st = strategy.get();
        const until = jwtUntil(st, R);
        const toks = jwtTokens(st);
        logA.clear();
        for (let m = 0; m < JWT_SPAN; m++) {
          setPlayhead(m);
          const tok = toks.find(t => m >= t[0] && m < t[1]);
          if (m === R) logA.add('min ' + m + '  admin revokes DEPLOYER on Search from raj' + (st === 'deny' ? '; ' + tok[2] + ' goes on the denylist, TTL ' + (15 - R) + ' min' : ''), 'warn');
          if (m > 0 && tok[0] === m) logA.add('min ' + m + '  ' + (st === 'short' ? '' : 'jti-1 expires; ') + 'client refreshes and gets ' + tok[2] + (m >= R ? ', without DEPLOYER on Search' : ''), 'muted');
          if (m < R) logA.add('min ' + m + '  ' + tok[2] + '  deploy search-indexer: 202', 'ok');
          else if (m < until) logA.add('min ' + m + '  ' + tok[2] + '  deploy search-indexer: 202, the token still says DEPLOYER on Search', 'bad');
          else logA.add('min ' + m + '  ' + tok[2] + '  deploy search-indexer: 404, ' + (st === 'deny' && tok[2] === 'jti-1' ? 'jti-1 is on the denylist' : 'the token has no deploy right on Search'), 'muted');
          await pause(ctx, 240);
          if (!ctx.alive || id !== runA) return;
        }
        setPlayhead(JWT_SPAN);
        playing = false;
        playBtn.disabled = false;
      }

      const partA = h('div', { class: 'stack' },
        h('div', { class: 'sim-controls' }, revokeSl.el, strategy.el, playBtn),
        h('div', { class: 'sim-stage' }, chartWrap),
        note('Model clock in minutes. Play runs 20 minutes in about 5 seconds; each minute the client tries to deploy search-indexer with its current token.'),
        h('div', { class: 'readouts' }, revokedRo.el, untilRo.el, windowRo.el, worstRo.el, costRo.el),
        verdictA.el,
        logA.el
      );

      // ---------------- part 2: refresh rotation ----------------
      let fam, chain, clientHolds, attackerHolds, attackerMinted, detected;
      function freshFamily() {
        fam = { revoked: false };
        chain = [{ name: 'r1', state: 'active' }];
        clientHolds = 'r1';
        attackerHolds = 'r1';
        attackerMinted = 0;
        detected = false;
      }
      freshFamily();

      const noRotate = ui.toggle('Break it: refresh tokens never rotate', false, v => resetFamily('Rotation ' + (v ? 'switched off' : 'switched on') + '. New login: family fam-1 starts with r1.'), { tone: 'danger' });
      const clientBtn = ui.button('Client refreshes', () => present('client'), { variant: 'primary' });
      const attackBtn = ui.button('Attacker replays stolen token', () => present('attacker'), { variant: 'danger' });
      const resetB = ui.button('Reset', () => resetFamily('New login: family fam-1 starts with r1.'), { variant: 'quiet' });
      const chainRow = h('div', { class: 'row', style: 'gap:.4rem' });
      const famRo = ui.readout('Family fam-1', '—');
      const clientRo = ui.readout('Client', '—');
      const mintedRo = ui.readout('Access tokens minted by the attacker', 0);
      const verdictB = ui.verdict();
      const logB = ui.log({ label: 'Refresh requests' });

      function present(who) {
        const name = who === 'client' ? clientHolds : attackerHolds;
        const label = who === 'client' ? 'Client' : 'Attacker';
        if (fam.revoked) {
          logB.add(label + ' presents ' + name + ': 401, family fam-1 is revoked. Log in again.', 'muted');
          renderB();
          return;
        }
        if (noRotate.get()) {
          if (who === 'attacker') attackerMinted++;
          logB.add(label + ' presents ' + name + ': new access token. ' + name + ' stays valid and nothing is recorded.', who === 'attacker' ? 'bad' : 'ok');
          renderB();
          return;
        }
        const tok = chain.find(t => t.name === name);
        if (tok.state === 'used') {
          fam.revoked = true;
          detected = true;
          chain.forEach(t => { t.state = 'revoked'; });
          logB.add(label + ' presents ' + name + ', which was already used. Reuse means a copy exists: revoke the whole family fam-1.', 'warn');
          renderB();
          return;
        }
        tok.state = 'used';
        const next = 'r' + (chain.length + 1);
        chain.push({ name: next, state: 'active' });
        if (who === 'client') clientHolds = next;
        else { attackerHolds = next; attackerMinted++; }
        logB.add(label + ' presents ' + name + ': new access token and ' + next + '. ' + name + ' is now used.', who === 'attacker' ? 'bad' : 'ok');
        renderB();
      }

      function renderB() {
        AF.clear(chainRow);
        chain.forEach(t => {
          const holders = [];
          if (clientHolds === t.name) holders.push('client');
          if (attackerHolds === t.name) holders.push('attacker');
          const tone = t.state === 'active' ? 'ok' : t.state === 'revoked' ? 'bad' : 'idle';
          chainRow.appendChild(ui.token(t.name + ' ' + t.state + (holders.length ? ', ' + holders.join(' and ') : ''), tone));
        });
        famRo.set(fam.revoked ? 'revoked' : 'active', fam.revoked ? 'bad' : 'ok');
        clientRo.set(fam.revoked ? 'must log in again' : 'logged in', fam.revoked ? 'warn' : 'ok');
        mintedRo.set(attackerMinted, attackerMinted ? 'bad' : null);
        if (noRotate.get()) {
          if (attackerMinted) verdictB.set('bad', 'The attacker has minted ' + attackerMinted + ' access token' + (attackerMinted > 1 ? 's' : '') + ' with r1 and nothing looks wrong. Without rotation there is no "used" state, so reuse cannot be detected.');
          else verdictB.set(null, 'No rotation: r1 works every time, for whoever holds it.');
        } else if (detected) {
          verdictB.set('ok', 'Theft detected: a consumed refresh token came back. Family fam-1 is revoked, so the attacker\'s tokens die along with the client\'s, and the client logs in again.');
        } else if (attackerMinted) {
          verdictB.set('warn', 'The attacker used the stolen r1 first and got ' + attackerHolds + '. The client still holds r1, now used, so the next client refresh exposes the theft.');
        } else if (chain.length > 1) {
          verdictB.set('ok', 'Normal rotation: each refresh uses up the old token. The attacker\'s copy of r1 is now a consumed token, and presenting it will revoke the family.');
        } else {
          verdictB.set(null, 'An attacker has quietly copied r1. Refresh as the client, or replay as the attacker.');
        }
      }

      function resetFamily(msg) {
        freshFamily();
        logB.clear();
        logB.add(msg, 'muted');
        renderB();
      }

      const partB = h('div', { class: 'stack' },
        h('div', { class: 'sim-controls' }, clientBtn, attackBtn, noRotate.el, resetB),
        h('div', { class: 'sim-stage' }, h('div', { class: 'stack' }, h('div', { class: 'small muted' }, 'Refresh token chain for family fam-1, oldest first'), chainRow)),
        h('div', { class: 'readouts' }, famRo.el, clientRo.el, mintedRo.el),
        verdictB.el,
        logB.el
      );

      // ---------------- part 3: identity-service down ----------------
      let idDown = false;
      let busyC = false;
      let okCount = 0;
      let failCount = 0;
      let loginFails = 0;

      const stopId = ui.toggle('Stop identity-service', false, v => {
        idDown = v;
        logC.add(v ? 'identity-service stopped.' : 'identity-service started.', v ? 'warn' : 'ok');
        paintC();
      });
      const introspect = ui.toggle('Break it: call identity-service on every request', false, () => paintC(), { tone: 'danger' });
      const sendC = ui.button('Send request', () => sendReq(), { variant: 'primary' });
      const loginC = ui.button('Log in', () => login());
      const clientBox = box('client', 'holds access token jti-9 (kid k1, 15 min)');
      const apiBox = box('control-api', '');
      const idBox = box('identity-service', '');
      const okRo = ui.readout('API requests authorized', 0);
      const failRo = ui.readout('API requests failed', 0);
      const loginRo = ui.readout('Logins failed', 0);
      const callsRo = ui.readout('Calls to identity per request', 0);
      const verdictC = ui.verdict();
      const logC = ui.log({ label: 'Requests to control-api and identity-service' });

      function paintC() {
        clientBox.set('holds access token jti-9 (kid k1, 15 min)', null);
        apiBox.set(introspect.get() ? 'asks identity-service about every token' : 'verifies RS256 with public key k1, cached from /.well-known/jwks.json', null);
        idBox.set(idDown ? 'DOWN' : 'UP: signs tokens, serves JWKS, handles login and refresh', idDown ? 'bad' : 'ok');
        callsRo.set(introspect.get() ? 1 : 0, introspect.get() ? 'warn' : 'ok');
        okRo.set(okCount, okCount ? 'ok' : null);
        failRo.set(failCount, failCount ? 'bad' : null);
        loginRo.set(loginFails, loginFails ? 'warn' : null);
      }

      async function sendReq() {
        if (busyC) return;
        busyC = true;
        sendC.disabled = true;
        paintC();
        clientBox.set('sends GET /api/v1/deployments/{id}', 'busy');
        await pause(ctx, 250);
        if (!ctx.alive) return;
        apiBox.set('checking the token', 'busy');
        await pause(ctx, 250);
        if (!ctx.alive) return;
        clientBox.set('holds access token jti-9 (kid k1, 15 min)', null);
        if (introspect.get()) {
          idBox.set(idDown ? 'DOWN: no answer' : 'answering a token check', idDown ? 'bad' : 'busy');
          await pause(ctx, 250);
          if (!ctx.alive) return;
          if (idDown) {
            failCount++;
            apiBox.set('cannot reach identity-service', 'bad');
            logC.add('GET /api/v1/deployments/{id}: 503 service-unavailable. control-api could not reach identity-service to check the token.', 'bad');
            verdictC.set('bad', 'Every request now depends on identity-service. One service down has taken authorization down everywhere.');
          } else {
            okCount++;
            apiBox.set('authorized after a round trip', 'warn');
            logC.add('GET /api/v1/deployments/{id}: 200, after a network call to identity-service on the request path.', 'warn');
            verdictC.set('warn', 'It works, but every request now pays a network call to identity-service and fails whenever it does.');
          }
        } else {
          okCount++;
          apiBox.set('authorized locally', 'ok');
          logC.add('GET /api/v1/deployments/{id}: 200. Signature checked with cached key k1; expiry and team permissions read from the token. Calls to identity-service: 0.', 'ok');
          verdictC.set('ok', idDown
            ? 'identity-service is down and the request still authorized: validation is local, using the public key control-api already holds.'
            : 'Authorized locally with the public key. identity-service took no part.');
        }
        okRo.set(okCount, okCount ? 'ok' : null);
        failRo.set(failCount, failCount ? 'bad' : null);
        idBox.set(idDown ? 'DOWN' : 'UP: signs tokens, serves JWKS, handles login and refresh', idDown ? 'bad' : 'ok');
        busyC = false;
        sendC.disabled = false;
      }

      function login() {
        if (idDown) {
          loginFails++;
          logC.add('POST /api/v1/auth/login: fails, identity-service is down. New logins and refreshes wait for it; tokens already issued keep working until they expire.', 'warn');
          verdictC.set('warn', 'Logins need identity-service. Requests that carry an existing token do not.');
        } else {
          logC.add('POST /api/v1/auth/login: 200. BCrypt cost 12 check, then a new access token signed with the private key.', 'ok');
          verdictC.set('ok', 'Logged in. Only identity-service signs; every other service only verifies.');
        }
        loginRo.set(loginFails, loginFails ? 'warn' : null);
      }

      const partC = h('div', { class: 'stack' },
        h('div', { class: 'sim-controls' }, stopId.el, introspect.el, sendC, loginC),
        h('div', { class: 'sim-stage' }, h('div', { class: 'sim-cols' }, clientBox.el, apiBox.el, idBox.el)),
        h('div', { class: 'readouts' }, okRo.el, failRo.el, loginRo.el, callsRo.el),
        verdictC.el,
        logC.el
      );

      const parts = partSwitch([
        { value: 'a', label: 'Revocation', el: partA },
        { value: 'b', label: 'Refresh rotation', el: partB },
        { value: 'c', label: 'Identity-service down', el: partC }
      ], v => { if (v !== 'a') stopPlay(); });

      el.append(h('div', { class: 'sim-controls' }, parts.el), partA, partB, partC);
      drawA();
      resetFamily('Logged in: family fam-1 starts with r1. An attacker has copied r1.');
      paintC();
      verdictC.set(null, 'Send a request, then stop identity-service and send another.');
    }
  });

  // =====================================================================
  // Architecture 1: five services, five bottlenecks
  // =====================================================================

  const SPLIT = {
    'identity-service': {
      bound: 'CPU: BCrypt at cost 12 is slow on purpose',
      scaleOn: 'CPU %, login rate',
      knob: { label: 'CPU cores', min: 1, max: 8, step: 1, value: 4, fmt: v => v + (v === 1 ? ' core' : ' cores') },
      cap(k) { return k * 10; },
      tput(n, k) { return Math.min(n * 10, this.cap(k)); },
      capName(k) { return k + ' CPU cores: extra instances queue for the same cores'; },
      idle: 'waiting for CPU'
    },
    'control-api': {
      bound: 'Request rate and database writes',
      scaleOn: 'RPS, p99 latency',
      knob: { label: 'DB connection pool', min: 5, max: 40, step: 5, value: 10, fmt: v => v + ' connections' },
      cap(k) { return 100 * k / (k + 20); },
      tput(n, k) { return Math.min(n * 10, this.cap(k)); },
      capName(k) { return 'the DB connection pool (' + k + ' connections), not instances. Doubling the pool does not double the ceiling'; },
      idle: 'waiting for a connection'
    },
    'task-service': {
      bound: 'Queue depth',
      scaleOn: 'Kafka consumer lag',
      knob: { label: 'Partitions on task.work', min: 1, max: 12, step: 1, value: 6, fmt: v => String(v) },
      cap(k) { return k * 10; },
      tput(n, k) { return Math.min(n * 10, this.cap(k)); },
      capName(k) { return k + ' partitions on task.work: consumer ' + (k + 1) + ' gets no partition and sits idle'; },
      idle: 'idle, no partition'
    },
    'node-agent': {
      bound: 'Number of nodes',
      scaleOn: 'nodes per agent',
      knob: { label: 'Nodes', min: 1, max: 8, step: 1, value: 4, fmt: v => String(v) },
      cap(k) { return k * 10; },
      tput(n, k) { return Math.min(n * 10, this.cap(k)); },
      capName(k) { return k + ' nodes: leases are 1:1 with nodes, so agent ' + (k + 1) + ' holds no lease'; },
      idle: 'no lease'
    },
    'query-service': {
      bound: 'Read rate',
      scaleOn: 'RPS, cache hit ratio',
      knob: { label: 'Cache hit ratio', min: 0, max: 95, step: 5, value: 50, fmt: v => v + '%' },
      cap(k) { return Math.min(25 / (1 - k / 100), 60); },
      tput(n, k) { return Math.min(n * 10, this.cap(k)); },
      capName(k) {
        return 25 / (1 - k / 100) < 60
          ? 'Postgres reads on cache misses: raise the hit ratio, then add read replicas'
          : 'Redis itself, then read replicas';
      },
      idle: 'waiting on the cache or database'
    }
  };

  AF.register({
    id: 'ar-split',
    group: 'architecture',
    order: 1,
    title: 'Five services, five bottlenecks',
    question: 'Why split Appfleet into five services instead of one, and what tells you where to draw the lines?',
    status: 'planned',
    slice: 'S4–S7',
    where: [
      'docs/specs/SPRING-PROJECT.md, Scalability: why five services',
      'docs/specs/SPRING-PROJECT.md, The five services',
      'docs/specs/project/00-BUILD-GUIDE.md (task.work has 6 partitions)',
      'docs/specs/project/03-TASK-SERVICE.md'
    ],
    idea: [
      'Adding instances helps only while instances are the scarce thing. Every service eventually runs into something else: CPU cores, database connections, Kafka partitions, physical nodes, a cache. Past that point more instances cost money and add no throughput, and the curve goes flat. The useful question is not "does it scale" but "what stops it".',
      'Appfleet is split so each service hits a different wall. identity-service is CPU-bound on BCrypt. control-api is bound by request rate and database writes, capped by the connection pool. task-service follows queue depth, capped by partitions (task.work has 6). node-agent holds one lease per node. query-service follows read rate, capped by Redis, then read replicas.',
      'Independent scaling works because the services are stateless: JWTs are verified locally, so any instance can serve any request. The project starts as one service and splits slice by slice, the strangler pattern, and each split needs a different bottleneck or failure behaviour to justify it. If two services had the same bottleneck, they should be one service.'
    ],
    terms: [
      ['Bottleneck', 'The resource that runs out first. Adding anything else does not raise throughput.'],
      ['Stateless service', 'Keeps no per-user state in memory, so any instance can serve any request and instances come and go freely.'],
      ['Strangler pattern', 'Grow a system by extracting pieces from the running one, one at a time, keeping it working at every step.']
    ],
    tryIt: [
      'Pick task-service and move Instances from 1 to 8: the bars stop growing at 6, and the verdict names the cap, 6 partitions on task.work.',
      'Raise Partitions on task.work to 8 and watch the flat part move.',
      'Pick control-api and raise Instances: past a point only DB connection pool moves the ceiling, and doubling it does not double the ceiling.',
      'Pick query-service and slide Cache hit ratio from 0% to 90%: the cap moves from Postgres reads to Redis.'
    ],
    breakIt: 'Scale the wrong thing, such as more control-api instances when the connection pool is the limit or a seventh task-service consumer on six partitions, and you pay for idle instances while throughput stays flat.',
    say: 'Each Appfleet service is bound by a different resource: CPU for identity, the DB pool for control-api, partitions for task-service, nodes for node-agent, cache and Redis for query-service. That is why they are separate; if two shared a bottleneck they would be one service.',
    quiz: {
      q: 'task-service runs 6 instances against task.work with 6 partitions, and consumer lag keeps growing. What actually raises throughput?',
      options: [
        'Add a 7th and an 8th instance',
        'Raise the HikariCP pool size on task-service',
        'Add control-api instances so commands are accepted faster',
        'Increase the partition count on task.work, then add consumers'
      ],
      answer: 3,
      why: 'In a consumer group each partition is read by one consumer, so a 7th consumer gets no partition and sits idle. More partitions raise the ceiling; then more consumers can use it. More control-api instances would only add to the backlog.'
    },
    mount(el, ctx) {
      const knobs = {};
      Object.keys(SPLIT).forEach(k => { knobs[k] = SPLIT[k].knob.value; });
      let key = 'task-service';

      const svcChoice = ui.choice('Service', Object.keys(SPLIT).map(k => ({ value: k, label: k })), key, v => { key = v; buildKnob(); render(); });
      const instSl = ui.slider({ label: 'Instances', min: 1, max: 8, value: 4, onInput: () => render() });
      const knobSlot = h('div');
      const chartWrap = h('div', { style: 'max-width:680px' });
      const instRow = h('div', { class: 'row', style: 'gap:.35rem' });
      const tputRo = ui.readout('Throughput (relative)', '—');
      const gainRo = ui.readout('Added by the last instance', '—');
      const capRo = ui.readout('Ceiling', '—');
      const profile = h('div', { class: 'stack small' });
      const verdict = ui.verdict();
      const fmt = v => String(Math.round(v));

      function buildKnob() {
        const k = SPLIT[key].knob;
        const sl = ui.slider({ label: k.label, min: k.min, max: k.max, step: k.step, value: knobs[key], format: k.fmt, onInput: v => { knobs[key] = v; render(); } });
        AF.clear(knobSlot).appendChild(sl.el);
      }

      function render() {
        const S = SPLIT[key];
        const k = knobs[key];
        const n = instSl.get();
        const t = i => S.tput(i, k);
        const cur = t(n);
        const gain = n > 1 ? cur - t(n - 1) : cur;
        const cap = S.cap(k);

        // chart: one bar per instance count, dashed line for perfect linear scaling, dashed cap line
        const L = 46, B = 196, T = 20, W = 560, colW = (W - L - 8) / 8, ymax = 80;
        const y = v => B - (B - T) * v / ymax;
        const knee = [1, 2, 3, 4, 5, 6, 7, 8].find(i => t(i) < i * 10 - 0.01);
        const g = svg('svg', {
          class: 'chart', viewBox: '0 0 560 232', role: 'img',
          'aria-label': 'Throughput of ' + key + ' for 1 to 8 instances. ' + (knee ? 'Growth stops being linear at ' + knee + ' instances.' : 'Linear across all 8 instances with this setting.')
        });
        [0, 20, 40, 60, 80].forEach(v => {
          g.appendChild(svg('line', { x1: L, x2: W, y1: y(v), y2: y(v), style: 'stroke:var(--line)' }));
          g.appendChild(svg('text', { x: L - 6, y: y(v) + 4, 'text-anchor': 'end' }, v));
        });
        for (let i = 1; i <= 8; i++) {
          const v = t(i);
          const bx = L + (i - 1) * colW + 6;
          const style = i === n ? 'fill:var(--signal)' : i < n ? 'fill:var(--strip-blue);stroke:var(--rail)' : 'fill:var(--idle-wash);stroke:var(--rail)';
          g.appendChild(svg('rect', { x: bx, y: y(v), width: colW - 12, height: B - y(v), style }));
          g.appendChild(svg('text', { x: bx + (colW - 12) / 2, y: B + 15, 'text-anchor': 'middle' }, i));
        }
        const pts = [1, 2, 3, 4, 5, 6, 7, 8].map(i => (L + (i - 1) * colW + colW / 2).toFixed(1) + ',' + y(i * 10).toFixed(1)).join(' ');
        g.appendChild(svg('polyline', { points: pts, style: 'fill:none;stroke:var(--muted);stroke-width:1.5;stroke-dasharray:4 4' }));
        if (cap < ymax) {
          g.appendChild(svg('line', { x1: L, x2: W, y1: y(cap), y2: y(cap), style: 'stroke:var(--bad);stroke-width:1.5;stroke-dasharray:7 4' }));
          g.appendChild(svg('text', { x: W - 4, y: y(cap) - 5, 'text-anchor': 'end' }, 'ceiling ' + fmt(cap)));
        }
        g.appendChild(svg('text', { x: L, y: 12 }, 'throughput (relative units); dashed grey: perfectly linear'));
        g.appendChild(svg('text', { x: (L + W) / 2, y: 228, 'text-anchor': 'middle' }, 'instances'));
        AF.clear(chartWrap).appendChild(g);

        // instances
        AF.clear(instRow);
        const full = Math.min(n, Math.floor(cur / 10 + 1e-6));
        const partial = cur / 10 - full;
        for (let i = 1; i <= n; i++) {
          if (i <= full) instRow.appendChild(ui.token('#' + i + ' working', 'ok'));
          else if (i === full + 1 && partial > 0.05) instRow.appendChild(ui.token('#' + i + ' partly used', 'warn'));
          else instRow.appendChild(ui.token('#' + i + ' ' + S.idle, 'idle'));
        }

        tputRo.set(fmt(cur) + ' of ' + (n * 10));
        gainRo.set('+' + fmt(gain), gain < 0.01 ? 'bad' : gain < 9.99 ? 'warn' : 'ok');
        capRo.set(cap >= ymax ? 'beyond 8 instances' : fmt(cap));

        AF.clear(profile);
        profile.appendChild(h('div', null, h('b', null, 'Bound by: '), S.bound));
        profile.appendChild(h('div', null, h('b', null, 'Scale on: '), S.scaleOn));
        profile.appendChild(h('div', null, h('b', null, 'Capped by: '), S.capName(k)));

        if (n === 1) {
          verdict.set('ok', 'One instance. Slide Instances up and watch where the bars stop growing.');
        } else if (gain < 0.01) {
          verdict.set('bad', 'Instance ' + n + ' adds nothing. Capped by ' + S.capName(k) + '.');
        } else if (gain < 9.99) {
          verdict.set('warn', 'Instance ' + n + ' adds only ' + fmt(gain) + ' of a full 10: at the ceiling, ' + S.capName(k) + '.');
        } else {
          verdict.set('ok', 'Still linear: instance ' + n + ' adds a full share. ' + (cap >= ymax ? 'With this setting the ceiling lies beyond 8 instances.' : 'The ceiling is ' + fmt(cap) + ', reached at ' + Math.ceil(cap / 10 - 1e-6) + ' instances.'));
        }
      }

      buildKnob();
      el.append(
        h('div', { class: 'sim-controls' }, svcChoice.el),
        h('div', { class: 'sim-controls' }, instSl.el, knobSlot),
        h('div', { class: 'sim-stage' }, h('div', { class: 'stack' }, chartWrap, instRow)),
        h('div', { class: 'readouts' }, tputRo.el, gainRo.el, capRo.el),
        profile,
        verdict.el,
        note('Illustrative model: each instance can do 10 units of work, and the ceilings follow the "what caps it" column in SPRING-PROJECT.md. These are not measurements; S7 is where the real curves get measured.')
      );
      render();
    }
  });

  // =====================================================================
  // Architecture 2: 202 Accepted and bounded queues
  // =====================================================================

  AF.register({
    id: 'ar-async',
    group: 'architecture',
    order: 2,
    title: 'Accept now, work later',
    question: 'How do you answer a deployment request in milliseconds when the deployment itself takes much longer, without letting a burst of requests exhaust memory?',
    status: 'progress',
    slice: 'S3.3, S6, S7',
    where: [
      'control-api/src/main/java/io/appfleet/control/deployment/web/DeploymentController.java',
      'docs/design/control-api/control-api-s3-3-deployments.md',
      'docs/specs/project/03-TASK-SERVICE.md, Bounded execution',
      'docs/specs/SPRING-PROJECT.md, Scalability (backpressure, load shedding)'
    ],
    idea: [
      'If an HTTP request waits for the work, the caller waits as long as the slowest step, and every waiting request holds a thread. The alternative: record the intent, answer 202 Accepted with a Location to poll, and let workers do the job in the background. The answer is fast because it only covers writing a row.',
      'Built in S3.3: POST /api/v1/deployments writes the deployment and a DEPLOY task, then answers 202 with Location /api/v1/tasks/{id}, and the client polls GET /api/v1/tasks/{id}. NFR-2 asks for accepted p99 under 500 ms, which is only reachable because the answer does not wait for the deployment.',
      'Planned for S6 and S7: the background queue must be bounded. The usual default executor queue is unbounded, so under sustained overload it grows until the heap runs out and the instance dies. A bounded queue with CallerRunsPolicy makes the submitting thread do the work, which slows intake; load shedding answers 429 so callers back off and retry later.'
    ],
    terms: [
      ['202 Accepted', 'The request was valid and recorded; the work happens later. Location says where to check on it.'],
      ['Backpressure', 'A full stage slows down or refuses the stage before it, instead of buffering without limit.'],
      ['CallerRunsPolicy', 'When the executor queue is full, the thread that submitted the task runs it itself, which slows the submitter.'],
      ['Load shedding', 'Refusing excess work early, here with 429 and Retry-After, to protect the work already accepted.']
    ],
    tryIt: [
      'Pick Synchronous: request waits and press Start: even at 1 per second every response takes at least 2,000 ms.',
      'Switch Mode to 202 + background queue and raise Arrival rate above the capacity of 2 per second: responses stay fast while the queue fills to 40.',
      'With the queue full, compare When the queue is full: CallerRunsPolicy against Shed with 429.',
      'Turn on Break it: unbounded queue at a high arrival rate and watch Heap used climb until the instance crashes, then press Reset.'
    ],
    breakIt: 'With an unbounded executor queue, overload never pushes back: queued items pile up in the heap until OutOfMemoryError kills the instance and everything it held in memory.',
    say: 'POST /deployments answers 202 with a Location to poll, so acceptance stays under NFR-2\'s 500 ms p99 whatever the deployment takes, and the background work runs on a bounded executor that pushes back with CallerRunsPolicy or sheds with 429 instead of growing until the heap runs out.',
    quiz: {
      q: 'Arrivals exceed worker capacity for ten minutes. Which setup degrades gracefully?',
      options: [
        'An unbounded queue, so no request is ever rejected',
        'More HTTP threads, so requests wait inside the server',
        'A bounded queue that sheds with 429 and Retry-After once full',
        'Synchronous handling, so each caller sees its own result'
      ],
      answer: 2,
      why: 'Overload has to go somewhere. An unbounded queue turns it into heap growth and a crash; more threads or synchronous handling turn it into waiting and timeouts. A bounded queue keeps memory flat and tells callers to come back later.'
    },
    mount(el, ctx) {
      const A = { workS: 2, workers: 4, queueMax: 40, acceptMs: 30, tickMs: 125, dt: 0.5, heapBase: 30, heapPer: 0.22, serverQueue: 100 };
      let s;
      let timer = null;

      function fresh() {
        s = {
          t: 0, acc: 0, queue: [], waiting: [], completed: 0, rejected: 0, callerRuns: 0, resp: [],
          heap: A.heapBase, crashed: false, next: 0, overflowAt: -10,
          workers: Array.from({ length: A.workers }, () => ({ job: null, left: 0 }))
        };
      }
      fresh();

      const modeChoice = ui.choice('Mode', [
        { value: 'sync', label: 'Synchronous: request waits' },
        { value: 'async', label: '202 + background queue' }
      ], 'async', () => {
        fresh();
        startBtn.disabled = false;
        log.add('Mode changed: counters reset.', 'muted');
        render();
      });
      const rateSl = ui.slider({ label: 'Arrival rate', min: 1, max: 10, value: 1, format: v => v + ' per second' });
      const policy = ui.choice('When the queue is full', [
        { value: 'caller', label: 'CallerRunsPolicy' },
        { value: 'shed', label: 'Shed with 429' }
      ], 'shed');
      const unbounded = ui.toggle('Break it: unbounded queue', false, v => {
        log.add(v ? 'Queue bound removed: nothing will push back.' : 'Queue bounded at 40 again.', v ? 'bad' : 'ok');
        render();
      }, { tone: 'danger' });
      const startBtn = ui.button('Start', () => { if (timer) stop(); else start(); }, { variant: 'primary' });
      const resetBtn = ui.button('Reset', () => { stop(); fresh(); startBtn.disabled = false; log.clear(); render(); }, { variant: 'quiet' });

      const queueLane = ui.lane('Background queue', 'in memory');
      const workLane = ui.lane('Workers', '4 threads, 2 s per deployment');
      const workerBoxes = s.workers.map((w, i) => box('worker ' + (i + 1), 'idle'));
      workerBoxes.forEach(b => workLane.body.appendChild(b.el));
      const p99Ro = ui.readout('p99 response (last 100)', '—');
      const queueRo = ui.readout('Queue length', 0);
      const rejRo = ui.readout('Rejected', 0);
      const callerRo = ui.readout('Ran on the caller thread', 0);
      const doneRo = ui.readout('Completed', 0);
      const capRo = ui.readout('Capacity', '2 per second');
      const heapBar = ui.bar({ label: 'Heap used', max: 100, value: A.heapBase, format: v => Math.round(v) + '%' });
      const verdict = ui.verdict();
      const log = ui.log({ label: 'Executor events' });

      function start() {
        if (s.crashed || timer) return;
        timer = ctx.interval(tick, A.tickMs);
        startBtn.textContent = 'Pause';
      }
      function stop() {
        if (timer) clearInterval(timer);
        timer = null;
        startBtn.textContent = 'Start';
      }

      function arrive(sync) {
        const job = { id: ++s.next, t: s.t };
        if (sync) {
          if (s.waiting.length >= A.serverQueue) { s.rejected++; s.overflowAt = s.t; }
          else s.waiting.push(job);
          return;
        }
        if (unbounded.get() || s.queue.length < A.queueMax) {
          s.queue.push(job);
          s.resp.push(A.acceptMs + Math.round(AF.rand(0, 8)));
          return;
        }
        s.overflowAt = s.t;
        if (policy.get() === 'caller') {
          s.callerRuns++;
          s.completed++;
          s.resp.push(A.acceptMs + A.workS * 1000);
        } else {
          s.rejected++;
        }
      }

      function tick() {
        if (s.crashed) return;
        const sync = modeChoice.get() === 'sync';
        s.t += A.dt;
        s.workers.forEach(w => {
          if (!w.job) return;
          w.left -= A.dt;
          if (w.left <= 1e-9) {
            s.completed++;
            if (sync) s.resp.push(Math.round((s.t - w.job.t) * 1000));
            w.job = null;
          }
        });
        s.acc += rateSl.get() * A.dt;
        const n = Math.floor(s.acc + 1e-9);
        s.acc -= n;
        for (let i = 0; i < n; i++) arrive(sync);
        const src = sync ? s.waiting : s.queue;
        s.workers.forEach(w => { if (!w.job && src.length) { w.job = src.shift(); w.left = A.workS; } });
        if (s.resp.length > 100) s.resp.splice(0, s.resp.length - 100);
        s.heap = A.heapBase + (sync ? 0 : s.queue.length * A.heapPer);
        if (s.heap >= 100) {
          s.heap = 100;
          s.crashed = true;
          stop();
          startBtn.disabled = true;
          log.add('OutOfMemoryError: Java heap space. The instance died with ' + s.queue.length + ' queued deployments in memory.', 'bad');
        }
        render();
      }

      function p99() {
        if (!s.resp.length) return null;
        const sorted = s.resp.slice().sort((a, b) => a - b);
        return sorted[Math.ceil(0.99 * sorted.length) - 1];
      }

      function render() {
        const sync = modeChoice.get() === 'sync';
        const q = sync ? s.waiting : s.queue;
        queueLane.title.firstChild.textContent = sync ? 'Requests waiting inside the server' : 'Background queue';
        workLane.title.firstChild.textContent = sync ? 'Request threads doing the work' : 'Workers';
        AF.clear(queueLane.body).appendChild(h('div', { class: 'row', style: 'gap:.3rem' },
          q.length ? q.slice(0, 24).map(j => ui.token('d-' + j.id, 'busy')) : ui.token('empty', 'idle'),
          q.length > 24 ? ui.token('+' + (q.length - 24) + ' more', 'warn') : null));
        s.workers.forEach((w, i) => workerBoxes[i].set(w.job ? 'busy: d-' + w.job.id + ', ' + w.left.toFixed(1) + ' s left' : 'idle', w.job ? 'busy' : 'idle'));

        const p = p99();
        p99Ro.set(p === null ? '—' : p + ' ms', p === null ? null : p < 500 ? 'ok' : 'bad');
        const bounded = !sync && !unbounded.get();
        queueRo.set(q.length + (sync ? '' : bounded ? ' of 40' : ', no limit'), !sync && !bounded && q.length > A.queueMax ? 'bad' : null);
        rejRo.set(s.rejected, s.rejected ? 'warn' : null);
        callerRo.set(s.callerRuns, s.callerRuns ? 'warn' : null);
        doneRo.set(s.completed);
        heapBar.set(s.heap, s.heap >= 85 ? 'bad' : s.heap >= 60 ? 'warn' : null);

        const full = s.t - s.overflowAt < 1;
        if (s.crashed) {
          verdict.set('bad', 'OutOfMemoryError: the unbounded queue grew until the heap ran out, and the instance died holding ' + s.queue.length + ' queued deployments. Press Reset.');
        } else if (s.t === 0) {
          verdict.set(null, 'Pick a mode and press Start.');
        } else if (sync) {
          verdict.set('bad', 'Every caller waits for the deployment itself, at least 2,000 ms, so NFR-2 (accepted p99 under 500 ms) is out of reach.' + (s.waiting.length > 8 ? ' ' + s.waiting.length + ' requests are waiting inside the server.' : ''));
        } else if (!bounded && q.length > A.queueMax) {
          verdict.set('bad', 'Unbounded queue: ' + q.length + ' items and growing, heap at ' + Math.round(s.heap) + '%. Nothing pushes back, so this ends in OutOfMemoryError.');
        } else if (bounded && full && policy.get() === 'caller') {
          verdict.set('warn', 'Queue full at 40: extra work runs on the caller\'s own thread, so those callers wait about 2 s and intake slows. Heap stays flat.');
        } else if (bounded && full) {
          verdict.set('warn', 'Queue full at 40: extra requests get 429 with Retry-After at once. Heap stays flat, and accepted requests still answer in about 30 ms.');
        } else {
          verdict.set('ok', '202 Accepted in about 30 ms with Location /api/v1/tasks/{id}. The queue holds ' + q.length + '.');
        }
      }

      el.append(
        h('div', { class: 'sim-controls' }, modeChoice.el, startBtn, resetBtn),
        h('div', { class: 'sim-controls' }, rateSl.el, policy.el, unbounded.el),
        h('div', { class: 'sim-stage' }, h('div', { class: 'sim-cols' }, queueLane.el, workLane.el)),
        h('div', { class: 'readouts' }, p99Ro.el, queueRo.el, rejRo.el, callerRo.el, doneRo.el, capRo.el),
        heapBar.el,
        verdict.el,
        note('Built in S3.3: 202 + Location /api/v1/tasks/{id}. Planned for S6 and S7: the bounded executor, CallerRunsPolicy and load shedding. Illustrative model: 4 workers, 2 s per deployment, a queue of 40, a clock running 4 times faster than real time.'),
        log.el
      );
      render();
    }
  });

  // =====================================================================
  // Architecture 3: resilience on inter-service calls, graceful shutdown
  // =====================================================================

  AF.register({
    id: 'ar-resilience',
    group: 'architecture',
    order: 3,
    title: 'Timeouts, breakers, bulkheads and shutdown',
    question: 'How do you stop one slow or failing dependency from taking down the services that call it, and how do you shut an instance down without losing work?',
    status: 'planned',
    slice: 'S7',
    where: [
      'docs/specs/SPRING-PROJECT.md, Slice 7 (resilience on inter-service calls)',
      'docs/specs/SPRING-PROJECT.md, Scalability (graceful shutdown, readiness vs liveness)',
      'docs/specs/project/03-TASK-SERVICE.md, Bounded execution',
      'docs/specs/project/06-BUSINESS-REQUIREMENTS.md, NFR-7 and NFR-10'
    ],
    idea: [
      'A call to a slow dependency holds a thread for as long as it waits. With no timeout, threads pile up behind it until none are left, and calls to healthy dependencies fail too: a cascade. A timeout caps the wait. A circuit breaker counts failures and, past a threshold, opens: calls fail fast without being sent, and after a pause a few trial calls decide whether to close.',
      'A bulkhead gives each dependency its own small pool, so one slow dependency can only use up its own threads. Retries use exponential backoff with jitter, so callers do not retry in lockstep. S7 plans all four on every inter-service call, to meet NFR-10: degrade, don\'t cascade.',
      'Shutdown is a failure you cause yourself. On SIGTERM a graceful instance first reports not ready, so it gets no new work, then lets in-flight tasks finish or releases their claims for another instance. Liveness asks "should this be restarted?", readiness asks "should this get traffic?". NFR-7 asks for zero lost tasks on deploy or scale-down.'
    ],
    terms: [
      ['Circuit breaker', 'CLOSED passes calls, OPEN fails them fast, HALF_OPEN lets a few trial calls through to test recovery.'],
      ['Bulkhead', 'A separate resource pool per dependency, so one cannot drain the others.'],
      ['Readiness and liveness', 'Readiness: may this instance receive traffic now. Liveness: is it alive, or should it be restarted.']
    ],
    tryIt: [
      'In Dependencies, press Start, then set Dependency A to Slow with every switch off: the shared pool fills and B\'s success rate falls, although B is healthy.',
      'Turn on Timeout (1 s), then Circuit breaker, and watch the breaker go OPEN, HALF_OPEN and OPEN again in the log; then try Bulkhead on its own.',
      'Set Dependency A to Down and compare Circuit breaker on and off; then set it back to Healthy and watch the breaker close.',
      'In Shutdown, press Send SIGTERM. Press Reset, turn on Break it: no graceful shutdown and send it again.'
    ],
    breakIt: 'Without a timeout or bulkhead, a dependency that turns slow eats every thread and calls to the healthy dependency start failing too; without graceful shutdown, SIGTERM kills claimed tasks mid-flight.',
    say: 'Every inter-service call gets a timeout, retry with backoff and jitter, a circuit breaker and its own bulkhead, so a slow dependency degrades one feature instead of cascading; on SIGTERM an instance drops readiness, then finishes or releases its claimed tasks so none are lost.',
    quiz: {
      q: 'Dependency A is slow but never returns an error, and there is no timeout. Why does turning on only the circuit breaker not help?',
      options: [
        'The breaker counts failures, and a call that just waits never fails, so it never opens',
        'Circuit breakers only work with Kafka consumers',
        'The breaker needs a bulkhead before it can measure anything',
        'The breaker opens, but OPEN still sends the calls'
      ],
      answer: 0,
      why: 'A breaker trips on failures (and, where configured, on slow-call rates). With no timeout, a hanging call is not a failure yet, so a failure-counting breaker stays CLOSED while threads pile up. A timeout turns waiting into a failure the breaker can count.'
    },
    mount(el, ctx) {
      // ---------------- part 1: dependencies ----------------
      const R = { tick: 100, pool: 20, bulk: 10, timeout: 1000, slow: 8000, fast: 50, refused: 100, win: 10, open: 3000, trials: 3, stats: 5000, samples: 60 };
      let s;
      let timer = null;
      const freshBreaker = () => ({ state: 'CLOSED', window: [], openedAt: 0, trialsLeft: 0, results: [] });
      function fresh() { s = { now: 0, tickNo: 0, inflight: [], events: [], br: freshBreaker(), samples: [] }; }
      fresh();

      const stamp = () => 't=' + (s.now / 1000).toFixed(1) + ' s';
      const depChoice = ui.choice('Dependency A', [
        { value: 'healthy', label: 'Healthy' },
        { value: 'slow', label: 'Slow' },
        { value: 'down', label: 'Down' }
      ], 'healthy', v => {
        logD.add(stamp() + '  dependency A is now ' + (v === 'slow' ? 'slow: 8 s per call' : v === 'down' ? 'down: connection refused' : 'healthy'), v === 'healthy' ? 'ok' : 'warn');
      });
      const timeoutT = ui.toggle('Timeout (1 s)', false, v => logD.add(stamp() + (v ? '  timeout on: calls to A give up after 1 s' : '  timeout off: calls wait as long as A takes'), 'muted'));
      const breakerT = ui.toggle('Circuit breaker', false, v => {
        s.br = freshBreaker();
        logD.add(stamp() + (v ? '  breaker on A, CLOSED: opens at 50% failures over the last 10 calls' : '  breaker off'), 'muted');
        renderD();
      });
      const bulkT = ui.toggle('Bulkhead', false, v => {
        logD.add(stamp() + (v ? '  bulkhead on: 10 threads for A, 10 for B' : '  bulkhead off: one shared pool of 20'), 'muted');
        renderD();
      });
      const startBtn = ui.button('Start', () => { if (timer) stopD(); else startD(); }, { variant: 'primary' });
      const resetD = ui.button('Reset', () => {
        stopD();
        fresh();
        depChoice.set('healthy');
        timeoutT.set(false); breakerT.set(false); bulkT.set(false);
        logD.clear();
        renderD();
      }, { variant: 'quiet' });

      const sharedBar = ui.bar({ label: 'Shared pool', max: R.pool, format: v => v + ' of 20 threads' });
      const aBar = ui.bar({ label: 'Pool for A', max: R.bulk, format: v => v + ' of 10 threads' });
      const bBar = ui.bar({ label: 'Pool for B', max: R.bulk, format: v => v + ' of 10 threads' });
      const chartWrap = h('div', { style: 'max-width:760px' });
      const brRo = ui.readout('Breaker on A', 'off');
      const aRo = ui.readout('A calls succeeded (5 s)', '—');
      const bRo = ui.readout('B calls succeeded (5 s)', '—');
      const rejRo = ui.readout('Rejected, no free thread (5 s)', 0);
      const verdictD = ui.verdict();
      const logD = ui.log({ label: 'Breaker and dependency events' });

      function startD() {
        if (timer) return;
        timer = ctx.interval(tick, R.tick);
        startBtn.textContent = 'Pause';
      }
      function stopD() {
        if (timer) clearInterval(timer);
        timer = null;
        startBtn.textContent = 'Start';
      }

      const used = dep => s.inflight.filter(c => c.dep === dep).length;
      const free = dep => (bulkT.get() ? R.bulk - used(dep) : R.pool - s.inflight.length);
      const ev = (dep, kind) => s.events.push({ t: s.now, dep, kind });

      function toOpen(why) {
        const from = s.br.state;
        s.br.state = 'OPEN';
        s.br.openedAt = s.now;
        s.br.window = [];
        logD.add(stamp() + '  breaker ' + from + ' → OPEN: ' + why + '. Calls to A now fail fast.', 'bad');
      }
      function toHalfOpen() {
        s.br.state = 'HALF_OPEN';
        s.br.trialsLeft = R.trials;
        s.br.results = [];
        logD.add(stamp() + '  breaker OPEN → HALF_OPEN after 3 s: letting ' + R.trials + ' trial calls through.', 'warn');
      }
      function toClosed() {
        s.br = freshBreaker();
        logD.add(stamp() + '  breaker HALF_OPEN → CLOSED: ' + R.trials + ' trial calls succeeded.', 'ok');
      }
      function record(ok, trial) {
        const br = s.br;
        if (br.state === 'HALF_OPEN') {
          if (!trial) return;
          br.results.push(ok);
          if (!ok) toOpen('a trial call failed');
          else if (br.results.length >= R.trials) toClosed();
          return;
        }
        if (br.state !== 'CLOSED') return;
        br.window.push(ok);
        if (br.window.length > R.win) br.window.shift();
        const fails = br.window.filter(x => !x).length;
        if (br.window.length >= R.win && fails / R.win >= 0.5) toOpen(fails + ' of the last ' + R.win + ' calls failed');
      }

      function callA() {
        let trial = false;
        if (breakerT.get()) {
          if (s.br.state === 'OPEN') { ev('A', 'fast'); return; }
          if (s.br.state === 'HALF_OPEN') {
            if (s.br.trialsLeft <= 0) { ev('A', 'fast'); return; }
            trial = true;
          }
        }
        if (free('A') <= 0) { ev('A', 'reject'); return; }
        if (trial) s.br.trialsLeft--;
        const dep = depChoice.get();
        let dur;
        let ok;
        if (dep === 'healthy') { dur = R.fast; ok = true; }
        else if (dep === 'slow') {
          if (timeoutT.get()) { dur = R.timeout; ok = false; } else { dur = R.slow; ok = true; }
        } else { dur = R.refused; ok = false; }
        s.inflight.push({ dep: 'A', end: s.now + dur, ok, trial });
      }
      function callB() {
        if (free('B') <= 0) { ev('B', 'reject'); return; }
        s.inflight.push({ dep: 'B', end: s.now + R.fast, ok: true, trial: false });
      }

      function stats(dep) {
        const r = { total: 0, ok: 0, fail: 0, reject: 0, fast: 0 };
        s.events.forEach(e => { if (e.dep === dep) { r.total++; r[e.kind]++; } });
        return r;
      }

      function tick() {
        s.now += R.tick;
        s.tickNo++;
        const done = s.inflight.filter(c => c.end <= s.now);
        s.inflight = s.inflight.filter(c => c.end > s.now);
        done.forEach(c => {
          ev(c.dep, c.ok ? 'ok' : 'fail');
          if (c.dep === 'A' && breakerT.get()) record(c.ok, c.trial);
        });
        if (breakerT.get() && s.br.state === 'OPEN' && s.now - s.br.openedAt >= R.open) toHalfOpen();
        // one call to A and one to B every 100 ms (20 per second), order alternating so neither always wins a freed thread
        if (s.tickNo % 2) { callA(); callB(); } else { callB(); callA(); }
        s.events = s.events.filter(e => e.t > s.now - R.stats);
        if (s.tickNo % 5 === 0) {
          const a = stats('A');
          const b = stats('B');
          s.samples.push({ a: a.total ? a.ok / a.total : null, b: b.total ? b.ok / b.total : null, br: breakerT.get() ? s.br.state : 'off' });
          if (s.samples.length > R.samples) s.samples.shift();
          drawChart();
        }
        renderD();
      }

      function drawChart() {
        const X0 = 44, X1 = 592, Y0 = 18, Y1 = 98, N = R.samples;
        const step = (X1 - X0) / (N - 1);
        const x = i => X0 + step * i;
        const y = v => Y1 - (Y1 - Y0) * v;
        const g = svg('svg', { class: 'chart', viewBox: '0 0 600 150', role: 'img', 'aria-label': 'Share of calls to A and B that succeeded over the last 30 seconds, with the breaker state as a band underneath.' });
        g.appendChild(svg('line', { x1: X0, x2: X1, y1: Y0, y2: Y0, style: 'stroke:var(--line)' }));
        g.appendChild(svg('line', { x1: X0, x2: X1, y1: Y1, y2: Y1, style: 'stroke:var(--line)' }));
        g.appendChild(svg('text', { x: X0 - 6, y: Y0 + 4, 'text-anchor': 'end' }, '100%'));
        g.appendChild(svg('text', { x: X0 - 6, y: Y1 + 4, 'text-anchor': 'end' }, '0%'));
        const off = N - s.samples.length;
        const path = k => {
          let d = '';
          let pen = false;
          s.samples.forEach((p, i) => {
            if (p[k] === null) { pen = false; return; }
            d += (pen ? 'L' : 'M') + x(i + off).toFixed(1) + ' ' + y(p[k]).toFixed(1) + ' ';
            pen = true;
          });
          return d;
        };
        const dA = path('a');
        const dB = path('b');
        if (dB) g.appendChild(svg('path', { d: dB, style: 'fill:none;stroke:var(--ok);stroke-width:2.5' }));
        if (dA) g.appendChild(svg('path', { d: dA, style: 'fill:none;stroke:var(--bad);stroke-width:2;stroke-dasharray:5 3' }));
        const bandFill = { CLOSED: 'var(--ok-wash)', OPEN: 'var(--bad-wash)', HALF_OPEN: 'var(--warn-wash)', off: 'var(--idle-wash)' };
        s.samples.forEach((p, i) => {
          g.appendChild(svg('rect', { x: x(i + off) - step / 2, y: 108, width: step + 0.5, height: 12, style: 'fill:' + bandFill[p.br] }));
        });
        g.appendChild(svg('text', { x: X0 - 6, y: 118, 'text-anchor': 'end' }, 'breaker'));
        g.appendChild(svg('text', { x: X0, y: 140 }, 'Solid: B succeeded. Dashed: A succeeded. Band: breaker state, named in the readout above. Last 30 s.'));
        AF.clear(chartWrap).appendChild(g);
      }

      function renderD() {
        const bulk = bulkT.get();
        show(sharedBar.el, !bulk);
        show(aBar.el, bulk);
        show(bBar.el, bulk);
        sharedBar.set(s.inflight.length, s.inflight.length >= R.pool ? 'bad' : null);
        aBar.set(used('A'), used('A') >= R.bulk ? 'bad' : null);
        bBar.set(used('B'), used('B') >= R.bulk ? 'bad' : null);
        const a = stats('A');
        const b = stats('B');
        const brState = breakerT.get() ? s.br.state : 'off';
        brRo.set(brState, { CLOSED: 'ok', OPEN: 'bad', HALF_OPEN: 'warn', off: null }[brState]);
        aRo.set(a.total ? pct(a.ok / a.total) : '—', a.total ? (a.ok / a.total >= 0.9 ? 'ok' : 'bad') : null);
        bRo.set(b.total ? pct(b.ok / b.total) : '—', b.total ? (b.ok / b.total >= 0.9 ? 'ok' : 'bad') : null);
        rejRo.set(a.reject + b.reject, a.reject + b.reject ? 'warn' : null);
        const dep = depChoice.get();
        if (!s.now) {
          verdictD.set(null, 'Press Start, then make Dependency A slow or down.');
        } else if (b.total && b.ok / b.total < 0.9) {
          verdictD.set('bad', 'Cascade: B is healthy, yet only ' + pct(b.ok / b.total) + ' of its calls succeed, because calls to A hold the shared threads.');
        } else if (dep !== 'healthy') {
          const bText = b.total ? pct(b.ok / b.total) : 'all';
          if (breakerT.get() && s.br.state === 'OPEN') verdictD.set('ok', 'Degraded, not cascading: the breaker is OPEN, so calls to A fail fast without taking a thread, and B succeeds ' + bText + '.');
          else verdictD.set('ok', 'Degraded, not cascading: A is ' + dep + ' and its calls suffer, but B still succeeds ' + bText + '.');
        } else {
          verdictD.set('ok', 'Both dependencies healthy.');
        }
      }

      const partDeps = h('div', { class: 'stack' },
        h('div', { class: 'sim-controls' }, startBtn, depChoice.el, resetD),
        h('div', { class: 'sim-controls' }, timeoutT.el, breakerT.el, bulkT.el),
        h('div', { class: 'sim-stage' }, h('div', { class: 'stack' }, sharedBar.el, aBar.el, bBar.el, chartWrap)),
        h('div', { class: 'readouts' }, brRo.el, aRo.el, bRo.el, rejRo.el),
        verdictD.el,
        note('Illustrative model: 20 calls per second split evenly between A and B, 50 ms when healthy, 8 s when A is slow, a 1 s timeout, and a breaker that opens at 50% failures over 10 calls, waits 3 s, then tries 3 calls. The breaker counts failures and timeouts, not slowness.'),
        logD.el
      );

      // ---------------- part 2: graceful shutdown ----------------
      const TASKS = [['t-41', 1.5], ['t-42', 3], ['t-43', 4.5], ['t-44', 7.5], ['t-45', 9]];
      const GRACE = 6;
      let tasks = [];
      let sdBusy = false;
      let sdDone = false;
      let sdId = 0;

      const noGrace = ui.toggle('Break it: no graceful shutdown', false, null, { tone: 'danger' });
      const sigBtn = ui.button('Send SIGTERM', () => sigterm(), { variant: 'danger' });
      const sdReset = ui.button('Reset', () => resetSd(), { variant: 'quiet' });
      const readyRo = ui.readout('Readiness', 'UP');
      const liveRo = ui.readout('Liveness', 'UP');
      const finRo = ui.readout('Finished', 0);
      const relRo = ui.readout('Claim released', 0);
      const lostRo = ui.readout('Lost', 0);
      const taskList = h('div', { class: 'stack' });
      const otherLane = ui.lane('task-service-2', 'picks up released and new work');
      const verdictS = ui.verdict();
      const logS = ui.log({ label: 'Shutdown events' });

      function paintTask(t) {
        const words = {
          running: t.left.toFixed(1) + ' s of work left, claimed',
          finished: 'finished',
          released: 'claim released, back to QUEUED',
          lost: 'lost: killed mid-flight'
        };
        const tones = { running: 'busy', finished: 'ok', released: 'warn', lost: 'bad' };
        t.fill.style.width = (t.state === 'finished' ? 0 : Math.max(0, t.left) / 9 * 100) + '%';
        AF.tone(t.fill, tones[t.state]);
        t.out.textContent = words[t.state];
      }

      function counts() {
        const c = st => tasks.filter(t => t.state === st).length;
        finRo.set(c('finished'), c('finished') ? 'ok' : null);
        relRo.set(c('released'), c('released') ? 'warn' : null);
        lostRo.set(c('lost'), c('lost') ? 'bad' : 'ok');
      }

      function resetSd() {
        sdId++;
        sdBusy = false;
        sdDone = false;
        sigBtn.disabled = false;
        noGrace.el.disabled = false;
        AF.clear(taskList);
        tasks = TASKS.map(([id, left]) => {
          const fill = h('div', { class: 'bar-fill' });
          const out = h('output', null, '');
          const row = h('div', { class: 'bar' }, h('span', null, id), h('div', { class: 'bar-track' }, fill), out);
          taskList.appendChild(row);
          const t = { id, left, state: 'running', fill, out };
          paintTask(t);
          return t;
        });
        AF.clear(otherLane.body);
        readyRo.set('UP', 'ok');
        liveRo.set('UP', 'ok');
        counts();
        logS.clear();
        logS.add('task-service-1 holds claims on 5 running tasks.', 'muted');
        verdictS.set(null, 'Five tasks are claimed and running on task-service-1. Send SIGTERM.');
      }

      async function sigterm() {
        if (sdBusy || sdDone) return;
        sdBusy = true;
        sigBtn.disabled = true;
        noGrace.el.disabled = true;
        const id = ++sdId;
        logS.add('SIGTERM sent to task-service-1 with 5 claimed tasks in flight.', 'warn');
        if (noGrace.get()) {
          tasks.forEach(t => { t.state = 'lost'; paintTask(t); });
          readyRo.set('gone', 'bad');
          liveRo.set('gone', 'bad');
          logS.add('No shutdown handling: the process exits at once. 5 tasks die mid-flight, their claims held by an instance that no longer exists.', 'bad');
          logS.add('Exit after 0 s: 0 finished, 0 released, 5 lost.', 'bad');
          verdictS.set('bad', 'Lost 5 of 5 in-flight tasks. NFR-7 asks for zero lost work on deploy or scale-down.');
          counts();
          sdBusy = false;
          sdDone = true;
          return;
        }
        readyRo.set('DOWN', 'warn');
        logS.add('Readiness DOWN: no new work is routed here. Liveness stays UP, so nothing restarts the instance while it drains.', 'busy');
        let t = 0;
        let offered = false;
        while (t < GRACE - 1e-9) {
          await pause(ctx, 160);
          if (!ctx.alive || id !== sdId) return;
          t += 0.5;
          tasks.forEach(k => {
            if (k.state !== 'running') return;
            k.left -= 0.5;
            if (k.left <= 1e-9) {
              k.left = 0;
              k.state = 'finished';
              logS.add('t=' + t.toFixed(1) + ' s  ' + k.id + ' finished', 'ok');
            }
            paintTask(k);
          });
          if (!offered && t >= 1) {
            offered = true;
            otherLane.body.appendChild(ui.token('t-46 new', 'ok'));
            logS.add('t=' + t.toFixed(1) + ' s  new task t-46 goes to task-service-2: this instance is not ready', 'muted');
          }
          counts();
        }
        tasks.forEach(k => {
          if (k.state !== 'running') return;
          k.state = 'released';
          paintTask(k);
          otherLane.body.appendChild(ui.token(k.id + ' requeued', 'warn'));
          logS.add('t=' + GRACE.toFixed(1) + ' s  grace period over: ' + k.id + ' releases its claim, back to QUEUED', 'warn');
        });
        readyRo.set('stopped', null);
        liveRo.set('stopped', null);
        logS.add('Exit after ' + GRACE + ' s: 3 finished, 2 released, 0 lost.', 'ok');
        verdictS.set('ok', 'Zero lost tasks: three finished inside the grace period and two released their claims, so task-service-2 runs them. That is NFR-7.');
        counts();
        sdBusy = false;
        sdDone = true;
      }

      const partShut = h('div', { class: 'stack' },
        h('div', { class: 'sim-controls' }, sigBtn, noGrace.el, sdReset),
        h('div', { class: 'sim-stage' }, h('div', { class: 'sim-cols' },
          ui.panel('task-service-1', taskList),
          otherLane.el)),
        h('div', { class: 'readouts' }, readyRo.el, liveRo.el, finRo.el, relRo.el, lostRo.el),
        verdictS.el,
        note('Illustrative model: a 6 s grace period and task lengths chosen so that some finish and some must release their claims.'),
        logS.el
      );

      const parts = partSwitch([
        { value: 'deps', label: 'Dependencies', el: partDeps },
        { value: 'shut', label: 'Shutdown', el: partShut }
      ], v => { if (v !== 'deps') stopD(); });

      el.append(h('div', { class: 'sim-controls' }, parts.el), partDeps, partShut);
      drawChart();
      renderD();
      resetSd();
    }
  });

  // =====================================================================
  // Architecture 4: rollback as a saga, compared with 2PC
  // =====================================================================

  const SAGA_STEPS = [
    { id: 'reserve', label: 'Reserve node', comp: 'Release node', left: 'node still reserved' },
    { id: 'pull', label: 'Pull image', comp: 'Remove image', left: 'image left on the node' },
    { id: 'start', label: 'Start container', comp: 'Stop container', left: 'container still running' },
    { id: 'switch', label: 'Switch traffic', comp: 'Switch traffic back', left: 'traffic on the new container' },
    { id: 'health', label: 'Health check', comp: null, left: null }
  ];
  const STATUS_TONE = { PENDING: 'busy', VALIDATING: 'busy', DEPLOYING: 'busy', HEALTHY: 'ok', DEGRADED: 'warn', ROLLED_BACK: 'warn', FAILED: 'bad' };

  AF.register({
    id: 'ar-saga',
    group: 'architecture',
    order: 4,
    title: 'Rollback as a saga',
    question: 'How do you undo a deployment that spans several services when no single transaction covers them all?',
    status: 'planned',
    slice: 'S6',
    where: [
      'docs/specs/SPRING-PROJECT.md, Slice 6 (Saga: rollback as compensating actions)',
      'docs/specs/project/01-CONTROL-API.md, The Deployment state machine',
      'docs/design/control-api/control-api-s3-3-deployments.md §3 (rollback records intent)',
      'control-api/src/main/java/io/appfleet/control/deployment/DeploymentService.java'
    ],
    idea: [
      'A saga splits one long operation into local steps, each committed on its own by the service that owns it. Every step has a compensating action that undoes it in business terms: release the node, stop the container, switch traffic back. When a step fails, the compensations of the steps already done run in reverse order.',
      'The alternative, two-phase commit, asks every participant to prepare and hold its locks until a coordinator says commit or abort. Locks then span services, the coordinator becomes a single point of failure that can leave participants stuck, and Kafka does not join XA transactions. So Appfleet plans rollback as a saga, in S6.',
      'Today, built in S3.3, POST /api/v1/deployments/{id}/rollback checks that the state machine allows ROLLED_BACK (only from HEALTHY or DEGRADED), records a ROLLBACK task and answers 202 without changing the status. The status moves to ROLLED_BACK only when that task completes, which is the saga\'s job.'
    ],
    terms: [
      ['Saga', 'A sequence of local transactions, each with a compensating action, run forward and undone in reverse on failure.'],
      ['Compensating action', 'A new action that undoes an earlier committed step in business terms. Not a database rollback.'],
      ['Two-phase commit (2PC)', 'Prepare everywhere, then commit everywhere. Atomic, but participants hold locks until the coordinator decides.']
    ],
    tryIt: [
      'Keep Mode Saga, leave Fail at on Health check and press Run: traffic switches, the check fails, and compensations run in reverse until the status reads ROLLED_BACK.',
      'Set Fail at to Start container and run again: two compensations, and the deployment ends FAILED, never HEALTHY.',
      'Set Fail at to None, run, then press POST rollback: 202 first with the status still HEALTHY, then the saga undoes each step.',
      'Switch Mode to Two-phase commit, turn on Coordinator crashes after the votes and run: every participant stays prepared, holding its lock, until you press Restart coordinator.'
    ],
    breakIt: 'Skip the compensations and a failed deployment leaves a reserved node, a pulled image and a running container behind; in 2PC, a coordinator crash leaves every participant holding its lock with nobody to tell it what to do.',
    say: 'Rollback is a saga: each deployment step is a local transaction with a compensating action, run in reverse on failure, because two-phase commit would hold locks across services, hinge on one coordinator, and Kafka cannot join an XA transaction anyway.',
    quiz: {
      q: 'The health check fails after traffic has switched to the new container. In the saga, what happens next?',
      options: [
        'The database rolls back all five steps in one transaction',
        'Compensations run in reverse: switch traffic back, stop the container, remove the image, release the node',
        'Compensations run in the original order, starting with releasing the node',
        'Nothing until a coordinator decides commit or abort'
      ],
      answer: 1,
      why: 'Each step already committed locally, so there is nothing for a database rollback to undo. Compensations run newest first, so traffic leaves the new container before it is stopped, and the node is released last.'
    },
    mount(el, ctx) {
      const D = 450;
      let busy = false;
      let stuck = false;
      let runId = 0;
      let status = 'PENDING';
      let locks = 0;
      let heldMs = 0;
      let committed = [];   // saga steps whose local transaction committed and has not been compensated

      const modeChoice = ui.choice('Mode', [
        { value: 'saga', label: 'Saga' },
        { value: '2pc', label: 'Two-phase commit' }
      ], 'saga', () => { applyMode(); resetBoard(); });
      const failChoice = ui.choice('Fail at', [{ value: 'none', label: 'None' }].concat(SAGA_STEPS.map(st => ({ value: st.id, label: st.label }))), 'health');
      const skipT = ui.toggle('Break it: skip compensations', false, null, { tone: 'danger' });
      const crashT = ui.toggle('Coordinator crashes after the votes', false, null, { tone: 'danger' });
      const runBtn = ui.button('Run', () => run(), { variant: 'primary' });
      const rbBtn = ui.button('POST rollback', () => rollback());
      const restartBtn = ui.button('Restart coordinator', () => restartCoord());
      const resetBtn = ui.button('Reset', () => resetBoard(), { variant: 'quiet' });

      const boxes = SAGA_STEPS.map(st => box(st.label, 'waiting'));
      const coord = box('Coordinator', 'idle');
      const pathRow = h('div', { class: 'row', style: 'gap:.35rem' });
      const statusRo = ui.readout('Deployment status', 'PENDING');
      const locksRo = ui.readout('Locks held across services', 0);
      const heldRo = ui.readout('Lock time', '0.0 s');
      const leftRo = ui.readout('Left behind', 'nothing');
      const verdict = ui.verdict();
      const log = ui.log({ label: 'Saga steps' });

      ctx.interval(() => {
        if (locks > 0) {
          heldMs += 250;
          heldRo.set((heldMs / 1000).toFixed(1) + ' s', stuck ? 'bad' : 'warn');
        }
      }, 250);

      const alive = id => ctx.alive && id === runId;

      function setStatus(st) {
        status = st;
        statusRo.set(st, STATUS_TONE[st]);
        if (pathRow.childNodes.length) pathRow.appendChild(h('span', { class: 'muted' }, '→'));
        pathRow.appendChild(ui.token(st, STATUS_TONE[st]));
      }
      function releaseLocks() {
        locks = 0;
        locksRo.set(0, null);
      }
      function buttons() {
        const saga = modeChoice.get() === 'saga';
        runBtn.disabled = busy || stuck;
        rbBtn.disabled = busy || !saga || !(status === 'HEALTHY' || status === 'DEGRADED');
        restartBtn.disabled = !stuck;
      }
      function applyMode() {
        const saga = modeChoice.get() === 'saga';
        show(skipT.el, saga);
        show(rbBtn, saga);
        show(crashT.el, !saga);
        show(restartBtn, !saga);
        show(coord.el, !saga);
      }
      function clearBoard() {
        boxes.forEach(b => b.set('waiting', null));
        coord.set('idle', null);
        AF.clear(pathRow);
        releaseLocks();
        heldMs = 0;
        heldRo.set('0.0 s', null);
        leftRo.set('nothing', null);
        verdict.clear();
        log.clear();
        committed = [];
        setStatus('PENDING');
      }
      function resetBoard() {
        runId++;
        busy = false;
        stuck = false;
        clearBoard();
        log.add('Ready. Pick where it fails and press Run.', 'muted');
        buttons();
      }

      async function compensate(id, idxs) {
        for (let j = idxs.length - 1; j >= 0; j--) {
          const i = idxs[j];
          boxes[i].set('compensating: ' + SAGA_STEPS[i].comp.toLowerCase(), 'busy');
          await pause(ctx, D);
          if (!alive(id)) return false;
          boxes[i].set('compensated: ' + SAGA_STEPS[i].comp.toLowerCase(), 'warn');
          log.add('Compensation: ' + SAGA_STEPS[i].comp + '.', 'warn');
        }
        return true;
      }

      async function runSaga(id, fail) {
        log.add('POST /api/v1/deployments answered 202; the saga runs as the DEPLOY task executes.', 'muted');
        setStatus('VALIDATING');
        await pause(ctx, D);
        if (!alive(id)) return;
        setStatus('DEPLOYING');
        const done = [];
        let failedAt = -1;
        for (let i = 0; i < SAGA_STEPS.length; i++) {
          const st = SAGA_STEPS[i];
          boxes[i].set('running', 'busy');
          await pause(ctx, D);
          if (!alive(id)) return;
          if (st.id === fail) {
            failedAt = i;
            boxes[i].set('failed', 'bad');
            log.add(st.label + ' failed.', 'bad');
            break;
          }
          boxes[i].set(st.comp ? 'done, committed locally' : 'passed', 'ok');
          log.add(st.comp ? st.label + ': committed in its own local transaction. Undo: ' + st.comp.toLowerCase() + '.' : st.label + ': passed.', 'ok');
          if (st.comp) done.push(i);
        }
        committed = done.slice();
        if (failedAt < 0) {
          setStatus('HEALTHY');
          verdict.set('ok', 'HEALTHY. No lock outlived its own step: each step committed and moved on. Press POST rollback to undo it the S3.3 way.');
          return;
        }
        const live = SAGA_STEPS[failedAt].id === 'health';
        if (live) {
          setStatus('DEGRADED');
          log.add('Traffic already reached the new container, so the deployment is DEGRADED.', 'warn');
        }
        if (skipT.get()) {
          const left = done.map(i => SAGA_STEPS[i].left);
          leftRo.set(left.length ? left.length + ' resources' : 'nothing', left.length ? 'bad' : null);
          if (!live) setStatus('FAILED');
          log.add('No compensations ran. Left behind: ' + (left.join(', ') || 'nothing') + '.', left.length ? 'bad' : 'muted');
          if (!left.length) verdict.set('warn', 'Nothing had committed yet, so skipping compensations changes nothing here. Pick a later step.');
          else if (live) verdict.set('bad', 'DEGRADED and stuck: nothing undoes the steps, so the failing container keeps serving traffic. Left behind: ' + left.join(', ') + '.');
          else verdict.set('bad', 'FAILED, but dirty: ' + left.join(', ') + '. Nothing will clean them up.');
          return;
        }
        if (done.length) log.add('Compensating, newest step first.', 'warn');
        const ok = await compensate(id, done);
        if (!ok) return;
        committed = [];
        setStatus(live ? 'ROLLED_BACK' : 'FAILED');
        if (live) verdict.set('ok', 'ROLLED_BACK: ' + done.length + ' compensations ran in reverse, traffic first and the node last.');
        else if (!done.length) verdict.set('ok', 'FAILED at the first step. Nothing had committed, so there was nothing to compensate.');
        else verdict.set('ok', 'FAILED, cleanly: ' + done.length + ' compensation' + (done.length === 1 ? '' : 's') + ' undid the steps that had committed. A deployment that never became healthy ends FAILED, not ROLLED_BACK.');
      }

      async function run2pc(id, fail) {
        setStatus('VALIDATING');
        await pause(ctx, D);
        if (!alive(id)) return;
        setStatus('DEPLOYING');
        coord.set('phase 1: PREPARE sent', 'busy');
        boxes[4].set('runs after the commit', 'idle');
        log.add('Coordinator sends PREPARE to the four participants.', 'busy');
        let no = -1;
        for (let i = 0; i < 4; i++) {
          boxes[i].set('preparing', 'busy');
          await pause(ctx, D);
          if (!alive(id)) return;
          if (SAGA_STEPS[i].id === fail) {
            no = i;
            boxes[i].set('votes NO', 'bad');
            log.add(SAGA_STEPS[i].label + ' votes NO.', 'bad');
            break;
          }
          locks++;
          locksRo.set(locks, 'warn');
          boxes[i].set('prepared: lock held, waiting', 'warn');
          log.add(SAGA_STEPS[i].label + ' votes YES and holds its lock until the decision.', 'warn');
        }
        if (no >= 0) {
          await pause(ctx, D);
          if (!alive(id)) return;
          coord.set('phase 2: ABORT', 'warn');
          for (let i = 0; i < no; i++) boxes[i].set('aborted: lock released', 'idle');
          for (let i = no + 1; i < 4; i++) boxes[i].set('never prepared', 'idle');
          releaseLocks();
          setStatus('FAILED');
          log.add('Coordinator decides ABORT. Nothing was committed, so nothing needs compensating.', 'ok');
          verdict.set('ok', 'FAILED with nothing to undo: that is the strength of 2PC. The cost: ' + (no === 0 ? 'had any participant prepared, it would have held its lock' : no + ' participant' + (no === 1 ? '' : 's') + ' held locks across services') + ' while the votes came in.');
          return;
        }
        await pause(ctx, D);
        if (!alive(id)) return;
        if (crashT.get()) {
          coord.set('crashed before deciding', 'bad');
          for (let i = 0; i < 4; i++) boxes[i].set('prepared: lock held, in doubt', 'bad');
          log.add('Coordinator crashes after the votes, before recording a decision. Participants may not commit or abort on their own.', 'bad');
          verdict.set('bad', 'Stuck: four participants are prepared and holding locks, waiting for a coordinator that is gone. Anything else that needs this node or route waits too. Press Restart coordinator.');
          stuck = true;
          return;
        }
        coord.set('phase 2: COMMIT', 'ok');
        for (let i = 0; i < 4; i++) boxes[i].set('committed, lock released', 'ok');
        releaseLocks();
        log.add('All voted YES. Coordinator decides COMMIT and every participant releases its lock.', 'ok');
        boxes[4].set('running', 'busy');
        await pause(ctx, D);
        if (!alive(id)) return;
        if (fail === 'health') {
          boxes[4].set('failed', 'bad');
          setStatus('DEGRADED');
          log.add('Health check fails after the commit. 2PC has no undo for committed work.', 'bad');
          verdict.set('warn', 'DEGRADED: the transaction already committed, so undoing it needs compensating actions anyway. 2PC only covers failures before the commit.');
          return;
        }
        boxes[4].set('passed', 'ok');
        setStatus('HEALTHY');
        verdict.set('ok', 'HEALTHY, committed atomically. The price: locks across services for the whole vote, one coordinator everyone depends on, and Kafka cannot take part because it does not join XA transactions.');
      }

      async function run() {
        if (busy || stuck) return;
        const id = ++runId;
        clearBoard();
        busy = true;
        buttons();
        const fail = failChoice.get();
        if (modeChoice.get() === 'saga') await runSaga(id, fail);
        else await run2pc(id, fail);
        if (!alive(id)) return;
        busy = false;
        buttons();
      }

      async function rollback() {
        if (busy || modeChoice.get() !== 'saga' || !(status === 'HEALTHY' || status === 'DEGRADED')) return;
        const id = ++runId;
        busy = true;
        buttons();
        const before = status;
        log.add('POST /api/v1/deployments/{id}/rollback: 202 Accepted, Location /api/v1/tasks/{taskId}.', 'busy');
        log.add('A ROLLBACK task is recorded as PENDING. Status stays ' + before + ': nothing has been undone yet (built in S3.3).', 'muted');
        verdict.set('busy', '202 Accepted, status still ' + before + '. The 202 promises a rollback; it does not claim one happened.');
        await pause(ctx, D * 2);
        if (!alive(id)) return;
        log.add('ROLLBACK task RUNNING: the saga compensates every committed step, newest first (planned for S6).', 'busy');
        const ok = await compensate(id, committed);
        if (!ok) return;
        committed = [];
        setStatus('ROLLED_BACK');
        leftRo.set('nothing', null);
        log.add('ROLLBACK task SUCCEEDED. Status ' + before + ' → ROLLED_BACK.', 'ok');
        verdict.set('ok', 'ROLLED_BACK, set only when the task finished. Traffic went back first and the node was released last.');
        busy = false;
        buttons();
      }

      function restartCoord() {
        if (!stuck) return;
        stuck = false;
        coord.set('recovered: no decision in its log, so ABORT', 'warn');
        for (let i = 0; i < 4; i++) boxes[i].set('aborted: lock released', 'idle');
        log.add('Coordinator restarts, finds no decision in its log and aborts. Locks were held for ' + (heldMs / 1000).toFixed(1) + ' s.', 'warn');
        releaseLocks();
        setStatus('FAILED');
        verdict.set('warn', 'Recovered by aborting. Until the coordinator came back, every participant was blocked, and so was everything that needed those locks.');
        busy = false;
        buttons();
      }

      el.append(
        h('div', { class: 'sim-controls' }, modeChoice.el, failChoice.el),
        h('div', { class: 'sim-controls' }, runBtn, rbBtn, restartBtn, skipT.el, crashT.el, resetBtn),
        h('div', { class: 'sim-stage' },
          h('div', { class: 'stack' },
            coord.el,
            h('div', { style: 'display:grid;grid-template-columns:repeat(auto-fit,minmax(9rem,1fr));gap:.6rem' }, boxes.map(b => b.el)),
            h('div', { class: 'small muted' }, 'Status path'),
            pathRow)),
        h('div', { class: 'readouts' }, statusRo.el, locksRo.el, heldRo.el, leftRo.el),
        verdict.el,
        note('Planned for S6, except the 202 rollback request, built in S3.3. Illustrative model: step timings are not measurements. In saga mode each step commits locally, so no lock outlives its own step.'),
        log.el
      );
      applyMode();
      resetBoard();
    }
  });

  AF.register({
    id: 'sec-openapi',
    group: 'security',
    order: 5,
    title: 'Security in the OpenAPI document',
    question: 'How does the generated API description say that every call needs a token and a permission, and who may read the description itself?',
    status: 'built',
    slice: 'S4.6',
    where: [
      'control-api/src/main/java/io/appfleet/control/web/openapi/OpenApiConfig.java (bearerAuth scheme, global security item, WWW-Authenticate header)',
      'control-api/src/main/java/io/appfleet/control/web/openapi/ErrorResponseCustomizer.java (global 401 and 403, x-required-permission)',
      'control-api/src/main/java/io/appfleet/control/web/SecurityConfig.java (appfleet.docs.public)',
      'OpenApiContractTest (tests 1 to 6 of S4.6), DocsExposureTest',
      'docs/design/control-api/control-api-s4-6-openapi-security.md'
    ],
    idea: [
      'The document declares one scheme, bearerAuth (HTTP bearer, JWT), and one global requirement that names it, so no operation can be listed as public by mistake. Every operation also lists 400, 401, 403 and 429 as answers, and the 401 response documents the WWW-Authenticate header that ProblemAuthenticationEntryPoint sets. Swagger UI draws its Authorize button from the scheme.',
      'The permission of each operation is not typed into the document. ErrorResponseCustomizer reads it from @PreAuthorize("hasAuthority(...)") and writes it as x-required-permission and as one sentence in the description, so the document cannot say a permission the code does not enforce. If a handler has no @PreAuthorize in the expected form, the customizer throws and /v3/api-docs answers 500. Measured 2026-10-06: with one @PreAuthorize removed, 14 of 14 OpenApiContractTest tests turned red while the application still started.',
      'Who may read the document is a property, appfleet.docs.public. It is true locally, because Swagger UI fetches the JSON with a plain browser request that cannot carry a token, and false in prod, where the JSON needs any valid token and the UI is off. Measured: with the property false, a request without a token to /v3/api-docs got 401 with application/problem+json and WWW-Authenticate: Bearer, and a request with any valid token got 200. A test of this must use real HTTP: the MockMvc in WebIntegrationTest does not run the security chain, and with the property false it still answered 200.'
    ],
    terms: [
      ['Security scheme', 'A named way to authenticate, declared once under components.securitySchemes. bearerAuth means "send Authorization: Bearer <token>".'],
      ['Global security requirement', 'A top-level list that applies to every operation unless the operation overrides it. A contract test checks that none does.'],
      ['x-required-permission', 'An extension field, not part of the OpenAPI standard. Appfleet fills it from @PreAuthorize so the two cannot drift.'],
      ['appfleet.docs.public', 'Whether the OpenAPI JSON and Swagger UI paths are open (true) or need a valid token (false).']
    ],
    tryIt: [
      'Choose "Local" and "No token": the document is served, the UI works.',
      'Choose "Prod" and "No token": 401 in the problem shape. Choose "Prod" and "Any valid token": 200.',
      'Choose "Prod" with "MockMvc test": a test that uses MockMvc reports 200 and would pass for the wrong reason.'
    ],
    breakIt: 'Remove one @PreAuthorize from a controller. The document answers 500 and every contract test that reads it fails. Measured on a scratch copy: 14 of 14.',
    say: 'The OpenAPI document declares one bearer scheme with a global requirement and lists 401 and 403 on every operation, the permission of each operation is read from @PreAuthorize so it cannot drift, and in prod the document itself needs a token, which I proved with a real HTTP test because MockMvc skips the security chain.',
    quiz: {
      q: 'A test sets appfleet.docs.public=false and uses MockMvc to GET /v3/api-docs with no token. It gets 200. What does that show?',
      options: [
        'The property is ignored by Spring Security',
        'MockMvc in this project does not run the security filter chain, so the test cannot prove the rule',
        'The document is public in every profile',
        'The token is optional for GET requests'
      ],
      answer: 1,
      why: 'Measured 2026-10-06: the same configuration answered 401 over real HTTP (RANDOM_PORT and HttpClient) and 200 through MockMvc.'
    },
    mount(el) {
      const verdict = ui.verdict();
      const profile = ui.choice('Profile', [
        { value: 'local', label: 'Local (public = true)' },
        { value: 'prod', label: 'Prod (public = false)' }
      ], 'local', render);
      const caller = ui.choice('Caller', [
        { value: 'none', label: 'No token' },
        { value: 'valid', label: 'Any valid token' },
        { value: 'mock', label: 'MockMvc test, no token' }
      ], 'none', render);

      function render() {
        const p = profile.get(), c = caller.get();
        if (p === 'local') {
          verdict.set('ok', c === 'mock'
            ? '200. Correct here, but only because the document is open; this test proves nothing about prod.'
            : '200: the document is open, so Swagger UI can fetch it. Measured by JwtAuthenticationTest.docsPathsAreOpen.');
        } else if (c === 'valid') {
          verdict.set('ok', '200: any valid token is enough, no particular permission. Measured by DocsExposureTest.');
        } else if (c === 'mock') {
          verdict.set('bad', '200 through MockMvc, which skips the security chain: a false pass. Measured 2026-10-06; use real HTTP.');
        } else {
          verdict.set('ok', '401, application/problem+json, WWW-Authenticate: Bearer. Measured by DocsExposureTest.');
        }
      }

      el.append(
        h('div', { class: 'sim-controls' }, profile.el, caller.el),
        h('div', { class: 'sim-stage' }, h('div', { class: 'stack' })),
        note('Illustrative model of one decision. Every verdict is backed by a test run on 2026-10-06 (DocsExposureTest, JwtAuthenticationTest.docsPathsAreOpen, and the MockMvc finding).'),
        verdict.el
      );
      render();
    }
  });

})();
