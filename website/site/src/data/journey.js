// site/src/data/journey.js — one request, seam by seam.
//
// `lane` and `row` are grid coordinates, so STEPS is a LAYOUT as well as a
// list: the connectors are measured from where these land, and reordering the
// array without moving the coordinates draws wires between the wrong boxes.
//
// T maps a step's tone to the colour its segment is drawn in.

export const T = {
  transport: 'var(--color-info)',
  core:      'var(--color-success)',
  data:      'var(--color-warning)',
  sql:       'var(--color-primary)',
  event:     'var(--color-danger)',
}

export const STEPS = [
  { lane:1, row:1,  tone:'transport', t:'HTTP arrives', f:'transport/http.ts',
    what:'The server matches the route and, if an Authorization header is present, resolves it to a session through IAuth.verifySession().',
    why:'This is the only place authentication happens. Everything downstream receives an identity or no identity — never a token to re-check.' },

  { lane:1, row:2,  tone:'transport', t:'bridge.toContext()', f:'transport/bridge.ts',
    what:'The HTTP request becomes a Context: body into ctx.data, path captures into ctx.route, filters into ctx.query.',
    why:'THE transport-to-service boundary. Cross it once and a service never touches a Request object — which is why the same service answers a WebSocket call unchanged.' },

  { lane:1, row:3,  tone:'transport', t:'parseDirectives()', f:'transport/bridge.ts',
    what:'$limit, $offset, $orderBy and $select are split off into ctx.directives, leaving ctx.query as pure filters.',
    why:'The $ prefix is transport syntax and dies here. Nothing past this line sees one, so result-shaping has exactly one parser rather than a convention repeated per handler.' },

  { lane:2, row:2,  tone:'core',      t:'around hooks', f:'core/hooks.ts',
    what:'The outermost pipeline phase opens, wrapping everything that follows — including the failure paths.',
    why:'Because it wraps the errors too, timing and tracing belong here. A before hook cannot see a request that throws in the data layer; an around hook can.' },

  { lane:2, row:3,  tone:'core',      t:'gateAuth()', f:'core/litestone.ts',
    what:'Derived from the model’s @@gate. A request with no session where one is required stops here as a 401.',
    why:'You did not write this check — the schema did. Add a model and its authorization arrives with it, already at the edge.' },

  { lane:2, row:4,  tone:'core',      t:'autoValidate()', f:'core/litestone.ts',
    what:'Derived from the field rules. @email, @length and @gte become a 400 with per-field messages.',
    why:'Still before the database is touched. The rule is stated once, on the field, and every entry point enforces it — including direct calls that never went through HTTP.' },

  { lane:2, row:5,  tone:'core',      t:'before hooks', f:'core/service.ts',
    what:'Your code, finally. Defaults, enrichment, anything that should happen to the data on the way in.',
    why:'Everything above this line was derived. This is the first point where the framework asks you to write something.' },

  { lane:3, row:3,  tone:'data',      t:'ctx.locals.db', f:'core/litestone.ts',
    what:'withLitestoneDb() put a per-request Litestone client here when the app was created, already scoped to the caller.',
    why:'Per-request scoping is what lets gates and policies see the user without a single line of wiring in your service.' },

  { lane:3, row:4,  tone:'data',      t:'$setAuth(user)', f:'litestone/core/client.js',
    what:'The Data-boundary checkpoint. Identity is attached to the client for the rest of this request.',
    why:'One checkpoint, one bypass. asSystem() is the single documented way past it, which makes privileged code searchable rather than scattered.' },

  { lane:3, row:5,  tone:'data',      t:'GatePlugin level check', f:'litestone/plugins/gate.js',
    what:'The same @@gate is enforced a second time, now at the data layer.',
    why:'Not redundancy. The API is one door, and the door is not the lock — a job, a CLI command or a test reaching the same model gets the same answer.' },

  { lane:3, row:6,  tone:'data',      t:'buildReadFilter()', f:'litestone/core/plugin.js',
    what:'@@allow predicates compile into a WHERE fragment, AND-merged with the filters your query already carried.',
    why:'This is why a row policy cannot be forgotten. It is not a filter a caller applies — it is part of the statement, added below every caller.' },

  { lane:3, row:7,  tone:'data',      t:'SQL', f:'litestone/core/query.js',
    what:'One statement, with your filters, the policy and the pagination already folded in.',
    why:'A single round trip. The policy did not become a second query, and pagination did not become a slice in memory.' },

  { lane:2, row:8,  tone:'core',      t:'after hooks', f:'core/service.ts',
    what:'Your code again, on the way out. Shape it, format it, redact it.',
    why:'The symmetry is deliberate: before and after are the same list in reverse, so a transform in and a transform out live next to each other.' },

  { lane:2, row:9,  tone:'core',      t:'wrapResult()', f:'core/envelope.ts',
    what:'THE result envelope, one owner. A list keeps { object, data, total }; a single record unwraps.',
    why:'One module decides the response shape for the whole framework, so a client never has to ask which endpoint wraps and which does not.' },

  { lane:2, row:10, tone:'core',      t:'publishToChannels()', f:'core/service.ts',
    what:'The single announcement point. One mutation fans out to both the event bus and the declared channel.',
    why:'Announcing in one place is what makes realtime reliable. Two publish paths means one of them eventually gets forgotten in a new code path.' },

  { lane:1, row:11, tone:'transport', t:'bridge.toResponse()', f:'transport/bridge.ts',
    what:'Back across the same boundary. A thrown FrameworkError becomes its status code here.',
    why:'Failures cross the boundary the way successes do. A Litestone AccessDeniedError was normalized to 403 on the way, so clients match one contract.' },

  { lane:1, row:12, tone:'transport', t:'HTTP Response', f:'transport/http.ts',
    what:'The response is sent. In the browser, watchProxy() makes the result reactive and whatever reads it re-renders.',
    why:'No refetch, no invalidation key. The Resource is the binding, which is why a pushed row and a returned row update the UI the same way.' },
]

export const NODES = [
  { lane:4, row:7,  t:'SQL executes', s:'row(s) returned' },
  { lane:3, row:10, t:'Channels (WS)', s:'subscribers receive “leads created” — the gate still applies' },
]
