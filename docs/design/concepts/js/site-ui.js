/*
 * site-ui.js: content for "How the Appfleet console works" (appfleet-ui-concepts.html), the front-end
 * concepts site. Loaded after core.js and before the lessons and app.js. Every file it names is in
 * web-console/ (the React console).
 */
(function () {
  'use strict';

  AF.GROUPS = [
    { id: 'react', title: 'React and rendering', blurb: 'Components, state and effects: what re-renders, and what runs when.' },
    { id: 'routing', title: 'Routing and navigation', blurb: 'Addresses as state, screens loaded on demand, and who may open what.' },
    { id: 'server-state', title: 'Server state', blurb: 'TanStack Query: a cache of what the server said, kept fresh on purpose.' },
    { id: 'api', title: 'Talking to the API', blurb: 'One fetch wrapper that turns every answer into data or one error shape.' },
    { id: 'quality', title: 'Mocking and testing', blurb: 'The same simulated backend in the browser, in tests and in demos.' },
    { id: 'design', title: 'Design system and access', blurb: 'Tokens, layouts that grow from a phone to 2K, and controls everyone can use.' }
  ];

  AF.site = {
    id: 'ui',
    copy: {
      siteTitle: 'How the Appfleet console works',
      heroTitle: 'Follow one click through the console',
      heroLede: 'Step through a deployment request from the button to the screen. Each stop names the front-end idea at work, and links to a lesson where you can break that idea and watch what happens.',
      heroAside: 'The console is a React app. It runs on simulated APIs, and in hybrid mode sends the calls control-api already supports to a live control-api. Every stop points at real files in web-console/.',
      baysLabel: 'Layers the click passes through',
      stripTitle: 'Deploy billing-api 2.4.0',
      stripSub: 'to qa',
      stripNote: 'The paper strip is the request. It turns blue when the deployment is HEALTHY.',
      layersTitle: 'Lessons, by topic',
      mapTitle: 'How the code is organised',
      mapLede: 'Screens use hooks, hooks use the query cache, the cache calls the API client, and the API client is the only code that calls fetch. Pick a part to see what lives there and the rule it follows.',
      mapDefault: 'cache',
      roadTitle: 'Roadmap',
      roadLede: 'The console is built in phases that follow the backend slices: a screen goes live only after the service it calls is green. Until then it runs on the simulated backend. Status as of 2 October 2026:',
      roadDefault: 'P1',
      roadListLabel: 'Phases in build order',
      stancesTitle: 'Design choices',
      stancesLede: 'Why the console is built the way it is, and the things it deliberately does not do.',
      mappingTitle: 'The same idea, on both sides',
      mappingLede: 'Most rules in the console mirror a rule in the backend. Open a row to see the pair.',
      mappingHead: ['Idea', 'In the backend', 'In the console'],
      mappingMore: 'In the console: ',
      regimeTitle: 'Where should this state live?',
      regimeLede: 'Every piece of state has one right home. Put it in the wrong one and you get stale screens, lost filters or links that open the wrong view. Pick a piece of state.',
      regimeLegend: 'The state',
      regimeDefault: 'server',
      questionsTitle: 'Questions people ask'
    },

    bays: [
      { id: 'user', name: 'You', role: 'Choose, then click Deploy' },
      { id: 'component', name: 'DeployPage', role: 'A React component and its state' },
      { id: 'hooks', name: 'Hooks', role: 'useIdempotentSubmit, useMutation' },
      { id: 'cache', name: 'Query cache', role: 'TanStack Query' },
      { id: 'http', name: 'http.ts', role: 'The only call to fetch' },
      { id: 'network', name: 'MSW or proxy', role: 'Simulated, or sent on to :8081' },
      { id: 'server', name: 'control-api', role: '202, or one error shape' },
      { id: 'screen', name: 'Screen', role: 'Re-render, focus, announce' }
    ],

    stops: [
      { bay: 'user', state: 'draft', tone: 'flight', status: 'built', now: 'Built in web-console, phase P1.',
        title: 'You pick a release and an environment',
        text: 'The deploy screen keeps the choice in the address (?release=…&env=qa), so the link can be shared and Back works. React re-renders the review line from that state. Nothing has been sent yet.',
        tags: ['ui-url-state', 'ui-state'] },
      { bay: 'hooks', state: 'key ready', tone: 'flight', status: 'built', now: 'Built: src/hooks/useIdempotentSubmit.ts.',
        title: 'One key is chosen for this submission',
        text: 'useIdempotentSubmit derives an Idempotency-Key from the inputs. The same inputs keep the same key; changing any input starts a new one. A double click or a retry after a timeout therefore sends the same key.',
        tags: ['ui-idempotent-submit'] },
      { bay: 'component', state: 'submitting', tone: 'flight', status: 'built', now: 'Built: src/features/deploy.',
        title: 'Deploy is pressed, twice by accident',
        text: 'useMutation runs the request and the button is disabled while it is pending. A second click that slips through carries the same key, so the server replays the first answer instead of starting a second deployment.',
        tags: ['ui-forms', 'ui-idempotent-submit'] },
      { bay: 'http', state: 'sending', tone: 'flight', status: 'built', now: 'Built: src/api/http.ts.',
        title: 'http.ts builds the request',
        text: 'Every request gets a fresh X-Correlation-Id. This one also gets the Idempotency-Key header and a JSON body. No screen calls fetch itself, so these rules hold everywhere without anyone remembering them.',
        tags: ['ui-fetch-wrapper'] },
      { bay: 'network', state: 'in flight', tone: 'flight', status: 'built', now: 'Built: src/mocks and proxy.config.ts. Hybrid mode reaches a live control-api.',
        title: 'MSW answers, or the proxy forwards',
        text: 'In mock mode a service worker answers from the simulated backend, which copies control-api\'s rules. In hybrid mode it lets control-api calls through to the Vite proxy, which routes /api/v1/deployments to localhost:8081. Tests use the same handlers in Node.',
        tags: ['ui-msw', 'ui-sim-backend', 'ui-proxy', 'ui-testing'] },
      { bay: 'server', state: '202', tone: 'flight', status: 'built', now: 'The endpoint is built in control-api (S3.3, S3.5).',
        title: '202 Accepted, with a Location',
        text: 'control-api accepts at once and says where to watch: Location /api/v1/tasks/{id}. If staging already has an active deployment, the answer is 409 conflict in the one ProblemDetail shape instead.',
        tags: ['ui-202', 'ui-problem'] },
      { bay: 'http', state: 'accepted', tone: 'flight', status: 'built', now: 'Built: src/api/http.ts and src/lib/errorText.ts.',
        title: 'The answer becomes data, or one error shape',
        text: 'A 2xx becomes data plus the Location and Idempotent-Replayed headers. Anything else becomes an ApiError carrying the ProblemDetail slug, and screens switch on that slug, never on the message text.',
        tags: ['ui-problem', 'ui-fetch-wrapper'] },
      { bay: 'cache', state: 'cached', tone: 'flight', status: 'built', now: 'Built: src/api/keys.ts and src/app/queryClient.ts.',
        title: 'Writes invalidate what they change',
        text: 'On success the mutation invalidates the read-side query keys, and screens showing them refetch. Mutations are never retried automatically; reads retry only on network errors and 5xx.',
        tags: ['ui-invalidation', 'ui-retry', 'ui-query-cache'] },
      { bay: 'screen', state: 'PENDING', tone: 'flight', status: 'built', now: 'Built: src/app/routes.tsx and AppShell.',
        title: 'Follow progress: the next screen loads on demand',
        text: 'Navigating to /deployments/{id} downloads that screen\'s code only now. Focus moves to the new content and the tab title changes, so keyboard and screen-reader users know where they are.',
        tags: ['ui-router', 'ui-focus'] },
      { bay: 'cache', state: 'DEPLOYING', tone: 'flight', status: 'built', now: 'Built: src/hooks/useDeployment.ts and pollInterval.ts.',
        title: 'Polling follows the state machine',
        text: 'useDeployment polls every 2 s while the deployment is PENDING, VALIDATING or DEPLOYING, every 30 s while HEALTHY or DEGRADED, and stops at FAILED or ROLLED_BACK. It pauses while the tab is hidden.',
        tags: ['ui-polling', 'ui-query-cache'] },
      { bay: 'screen', state: 'HEALTHY', tone: 'healthy', status: 'built', now: 'Built: Freshness in src/components/Feedback.tsx.',
        title: 'Reads say how fresh they are',
        text: 'The timeline comes from the read side and carries asOf. Until that mark passes your own write, the screen says "Updating" instead of showing the old state as current.',
        tags: ['ui-invalidation', 'ui-cursor'] },
      { bay: 'screen', state: 'HEALTHY', tone: 'healthy', status: 'built', now: 'Built: src/styles and src/components.',
        title: 'The result is shown in words, not only colour',
        text: 'StatusChip is the only component that colours a status, and it always prints the word. Notices announce themselves to screen readers, and the layout grows from a phone to a 2K monitor.',
        tags: ['ui-tokens', 'ui-a11y', 'ui-responsive', 'ui-guards'] }
    ],

    leaves: [
      [['user', '?release=0192…&env=qa']],
      [['hooks', 'Idempotency-Key 3f9c…']],
      [['component', 'button disabled while pending']],
      [['http', 'X-Correlation-Id 7a1e…'], ['http', 'POST /api/v1/deployments']],
      [['network', 'mock: simulated db'], ['network', 'hybrid: proxy to :8081']],
      [['server', '202, Location /api/v1/tasks/…']],
      [['http', '{ deploymentId, taskId, status }']],
      [['cache', "invalidate ['query', …]"]],
      [['screen', 'DeploymentPage chunk loaded'], ['screen', 'focus on main']],
      [['cache', 'refetchInterval 2000']],
      [['screen', 'asOf caught up']],
      [['screen', 'StatusChip HEALTHY']]
    ],

    mapNodes: [
      { id: 'screens', x: 12, y: 26, name: 'Screens', sub: 'src/features', kind: 'svc', status: 'built',
        role: 'One folder per screen. A screen composes components and calls hooks; it never calls fetch.',
        rows: [['Lives in', 'src/features/<screen>/'], ['Rule', 'Data through api/* functions and qk keys; errors through ErrorNotice']],
        lessons: ['ui-components', 'ui-state', 'ui-forms'] },
      { id: 'components', x: 12, y: 74, name: 'Components', sub: 'src/components', kind: 'svc', status: 'built',
        role: 'Shared building blocks: buttons, tables, notices, form fields, the status chip.',
        rows: [['Lives in', 'src/components/'], ['Rule', 'Colours only from tokens; StatusChip is the only place a status gets a colour']],
        lessons: ['ui-components', 'ui-tokens', 'ui-a11y'] },
      { id: 'hooks', x: 37, y: 26, name: 'Hooks', sub: 'src/hooks', kind: 'svc', status: 'built',
        role: 'Behaviour shared by screens: polling a deployment, cursor lists, one idempotency key per submission.',
        rows: [['Lives in', 'src/hooks/'], ['Rule', 'Policies (how often to poll, when to renew a key) are plain functions with unit tests']],
        lessons: ['ui-polling', 'ui-cursor', 'ui-idempotent-submit', 'ui-effects'] },
      { id: 'permissions', x: 37, y: 74, name: 'Permissions', sub: 'src/auth', kind: 'svc', status: 'built',
        role: 'Who is signed in and what they may do on which team, read from the user record the identity service issues.',
        rows: [['Lives in', 'src/auth/'], ['Rule', 'Check permissions, never role names. Hiding a button is convenience; the API enforces']],
        lessons: ['ui-guards'] },
      { id: 'cache', x: 62, y: 26, name: 'Query cache', sub: 'TanStack Query', kind: 'infra', status: 'built',
        role: 'The browser\'s copy of what the server said, keyed by query keys, refreshed by polling and invalidation.',
        rows: [['Lives in', 'src/app/queryClient.ts, src/api/keys.ts'], ['Rule', 'One key per resource; mutations invalidate exactly what they change']],
        lessons: ['ui-query-cache', 'ui-invalidation', 'ui-retry', 'ui-polling'] },
      { id: 'api', x: 62, y: 74, name: 'API client', sub: 'src/api', kind: 'svc', status: 'built',
        role: 'The only code that calls fetch. Adds correlation and idempotency headers, and turns every error into one ApiError.',
        rows: [['Lives in', 'src/api/http.ts and one file per service'], ['Rule', 'Screens switch on ApiError.type, never on message text']],
        lessons: ['ui-fetch-wrapper', 'ui-problem', 'ui-202'] },
      { id: 'msw', x: 87, y: 26, name: 'MSW', sub: 'simulated backend', kind: 'infra', status: 'built',
        role: 'A service worker that answers requests from a seeded database with a clock. The same handlers run in tests.',
        rows: [['Lives in', 'src/mocks/'], ['Rule', 'Copy the real service\'s rules, including the awkward ones']],
        lessons: ['ui-msw', 'ui-sim-backend', 'ui-testing'] },
      { id: 'proxy', x: 87, y: 74, name: 'Dev proxy', sub: 'Vite, hybrid mode', kind: 'infra', status: 'progress',
        role: 'In hybrid mode, routes each path to the service that owns it, starting with control-api on port 8081.',
        rows: [['Lives in', 'proxy.config.ts'], ['Rule', 'Regex rules for paths that sit under another service\'s prefix come first']],
        lessons: ['ui-proxy', 'ui-types'] }
    ],

    mapEdges: [
      ['screens', 'components'], ['screens', 'hooks'], ['screens', 'permissions'], ['hooks', 'cache'],
      ['permissions', 'cache'], ['cache', 'api'], ['api', 'msw'], ['api', 'proxy'], ['msw', 'proxy']
    ],

    slices: [
      { id: 'P1', name: 'Foundation', week: 'now, on simulated APIs', items: [
        ['built', 'Vite, React, TypeScript strict, React Router, TanStack Query, CSS Modules with tokens', 'ui-router'],
        ['built', 'API client with correlation ids, one error type, idempotency keys', 'ui-fetch-wrapper'],
        ['built', 'Simulated backend in MSW with a clock and control-api\'s rules', 'ui-sim-backend'],
        ['built', 'Shell, permission-aware navigation, guards that answer not found', 'ui-guards'],
        ['built', 'All screens: dashboard, applications, deploy, deployment, sessions, fleet, access, audit'],
        ['built', 'Full-app tests against the same handlers', 'ui-testing']] },
      { id: 'P2', name: 'control-api live', week: 'after S3.7', items: [
        ['built', 'Hybrid mode: built endpoints pass through to localhost:8081', 'ui-proxy'],
        ['planned', 'Types generated from control-api\'s OpenAPI (S3.7)', 'ui-types'],
        ['planned', 'Release list and environments endpoints (backend gaps 1 and 2)']] },
      { id: 'P3', name: 'Identity', week: 'after S4', items: [
        ['planned', 'Sign-in, token refresh, sign-out'],
        ['planned', 'Permissions from the real access token instead of the simulated user', 'ui-guards']] },
      { id: 'P4', name: 'Sessions and fleet', week: 'after S5', items: [
        ['built', 'Screens on simulated node-agent and task-service'],
        ['planned', 'Live node-agent sessions and drain']] },
      { id: 'P5', name: 'Read side', week: 'after S6', items: [
        ['built', 'Dashboard, history and timeline screens with asOf', 'ui-invalidation'],
        ['planned', 'Live query-service reads']] },
      { id: 'P6', name: 'Operations', week: 'after S7', items: [
        ['planned', 'nginx container serving the build with the proxy table'],
        ['planned', 'Browser tests of three flows in CI']] }
    ],

    mappingRows: [
      ['Never do it twice', 'Idempotency-Key stored in Redis (S3.5)', 'useIdempotentSubmit keeps one key per submission', 'ui-idempotent-submit'],
      ['One error shape', 'ProblemDetail from ApiExceptionHandler', 'ApiError and describeError switch on the slug', 'ui-problem'],
      ['Find every step of one request', 'X-Correlation-Id in the log context and Kafka headers', 'http.ts sends one per request; every error links to the audit trail', 'ui-fetch-wrapper'],
      ['Reads may be behind, and say so', 'asOf on query-service responses', 'Freshness shows asOf, and Updating after your own write', 'ui-invalidation'],
      ['Do not confirm what someone may not see', '404 instead of 403 (S4)', 'A forbidden screen renders the not-found page', 'ui-guards'],
      ['Stable pages while rows are added', 'Keyset cursor on time-ordered ids', 'useCursorList with Load older, never page numbers', 'ui-cursor'],
      ['Accept now, work later', '202 Accepted with Location', 'Follow progress, then poll by state', 'ui-202']
    ],

    regimes: {
      server: {
        label: 'The list of deployments',
        pick: 'Server state, in the query cache',
        text: 'The server owns it and other people change it. Keep a cached copy under a query key, refresh it by polling or after your own writes, and never copy it into component state, where it would silently go stale.',
        lessons: ['ui-query-cache', 'ui-invalidation']
      },
      filter: {
        label: 'The status filter on the dashboard',
        pick: 'The address',
        text: 'A filter decides what the screen shows. In the URL it survives a reload, works with Back, and can be sent to a colleague. In component state it disappears the moment someone shares the link.',
        lessons: ['ui-url-state']
      },
      draft: {
        label: 'Text being typed into a form',
        pick: 'Component state',
        text: 'Only this screen cares, and only until submit. useState in the form is enough. Lifting it into a global store adds re-renders and nothing else.',
        lessons: ['ui-state', 'ui-forms']
      },
      derived: {
        label: 'The review line under the form',
        pick: 'Nowhere: compute it',
        text: '"billing-api 2.4.0 to qa, replaces nothing" follows from the choices and the server data. Store it and it can disagree with them; compute it during render and it never can.',
        lessons: ['ui-state']
      },
      role: {
        label: 'The development role switch',
        pick: 'Browser storage',
        text: 'A per-person convenience that should survive a reload but means nothing to the server. localStorage fits, wrapped so the app still works when storage is blocked.',
        lessons: ['ui-guards']
      }
    },

    questions: [
      ['Why TanStack Query and not Redux?', 'Almost all the console\'s state is a copy of server data. A server-state cache handles fetching, caching, polling, retries and invalidation; Redux would make each of those hand-written code. The little client state left fits in components and the URL.', 'ui-query-cache'],
      ['Why mock the network with MSW instead of mocking fetch in each test?', 'MSW answers real HTTP requests, so the app\'s own code path runs unchanged: headers, status codes, error parsing. The same handlers drive the browser demo, the tests and hybrid mode, so they cannot drift apart.', 'ui-msw'],
      ['Why poll instead of WebSockets or server-sent events?', 'No backend service pushes events to browsers yet, and polling a deployment every 2 s is cheap and simple to reason about. The polling policy lives in one hook, so a push channel can replace it later without touching screens.', 'ui-polling'],
      ['Why no optimistic update when you click Deploy?', 'The server is the authority and the answer is "accepted", not "done". Showing HEALTHY before the server says so would be a lie. The screen shows PENDING from the 202, then whatever polling reports.', 'ui-202'],
      ['Why does a forbidden screen say "Page not found"?', 'It matches the API\'s rule: a 404 for things you may not see, so nobody learns what exists by probing. Hiding the screen is convenience; the API enforces the same check.', 'ui-guards'],
      ['Why CSS Modules and not Tailwind?', 'The design came as plain CSS with tokens. Modules keep that CSS, scope class names per file and cost nothing at run time. Every colour still comes from one tokens file.', 'ui-tokens'],
      ['Why hand-written API types?', 'control-api has no OpenAPI document until S3.7. The types mirror the Java records field for field and will be replaced by generated ones then, without changing any screen.', 'ui-types'],
      ['Why TypeScript 6 when 7 exists?', 'The lint tooling (typescript-eslint) supports up to 6.0. Upgrading the compiler alone would break linting, so the console waits for the tools.', 'ui-types']
    ]
  };
})();
