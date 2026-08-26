// site/src/data/showroom3.js — the ripple: one change, and what moved.
//
// A change's `diff` is [kind, line] pairs and `hits` is what that change
// reached across the three realms — including the ones it deliberately did NOT
// reach, which is half the argument, so a hit with `moved: false` is content
// rather than an omission.
//
// HOPS is the request's path through the seams, in order. It is not
// interactive and is here only because it is data.

export const BASE = [
  "model Lead {",
  "  id        Int      @id",
  "  name      String   @length(1, 200) @trim",
  "  email     String   @email @unique @lower",
  "  value     Float    @gte(0)",
  "  ownerId   Int",
  "  createdAt DateTime @default(now())",
  "",
  "  @@gate(\"0.4.4.5\")",
  "}",
]

export const CHANGES = [
  {
    id: 'field', label: 'Add a field',
    diff: [
      ['ctx',"  value     Float    @gte(0)"],
      ['add',"  company   String?  @trim @length(1, 120)"],
      ['ctx',"  ownerId   Int"],
    ],
    hits: [
      { realm:'Data', what:'Migration',    moved:1, note:'<code>ALTER TABLE leads ADD COLUMN company TEXT</code> — diffed, not hand-written.' },
      { realm:'Data', what:'TypeScript',   moved:1, note:'<code>company?: string</code> on <code>Lead</code>, <code>LeadCreate</code> and <code>LeadUpdate</code>.' },
      { realm:'API',  what:'Validation',   moved:1, note:'Optional, but trimmed and length-checked when present. A 400 you did not write.' },
      { realm:'API',  what:'OpenAPI',      moved:1, note:'The <code>Lead</code> component schema gains the property automatically.' },
      { realm:'API',  what:'Endpoints',    moved:0, note:'Same five routes. A field is not a route.' },
      { realm:'UI',   what:'make()',       moved:1, note:'<code>leads.make()</code> now returns a <code>company</code> key, ready to bind.' },
    ],
  },
  {
    id: 'rule', label: 'Tighten a rule',
    diff: [
      ['ctx',"  email     String   @email @unique @lower"],
      ['del',"  value     Float    @gte(0)"],
      ['add',"  value     Float    @gte(100) @lte(1000000)"],
      ['ctx',"  ownerId   Int"],
    ],
    hits: [
      { realm:'API',  what:'Validation',   moved:1, note:'<code>value: 50</code> now 400s with "must be >= 100". One edit, every entry point.' },
      { realm:'Data', what:'Direct writes',moved:1, note:'<code>db.lead.create()</code> rejects it too — the rule is on the data, not the route.' },
      { realm:'API',  what:'JSON Schema',  moved:1, note:'<code>minimum: 100</code>, <code>maximum: 1000000</code> — shipped to the browser.' },
      { realm:'Data', what:'Migration',    moved:0, note:'No schema change. The column is unchanged; only the rule moved.' },
      { realm:'Data', what:'TypeScript',   moved:0, note:'Still <code>value: number</code>. Types carry shape, not range.' },
      { realm:'UI',   what:'Form bounds',  moved:1, note:'The browser has the same JSON Schema, so the constraint is known client-side.' },
    ],
  },
  {
    id: 'gate', label: 'Close the front door',
    diff: [
      ['ctx',"  createdAt DateTime @default(now())"],
      ['ctx',""],
      ['del',"  @@gate(\"0.4.4.5\")"],
      ['add',"  @@gate(\"4.4.4.5\")"],
    ],
    hits: [
      { realm:'API',  what:'HTTP',         moved:1, note:'<code>GET /api/leads</code> flips from <code>200</code> to <code>401</code>. No handler edited.' },
      { realm:'Data', what:'Direct reads', moved:1, note:'<code>db.lead.findMany()</code> throws below level 4. The API is not the only door being locked.' },
      { realm:'API',  what:'Live events',  moved:1, note:'Channel subscribers are held to the same level — the gate applies on the way out.' },
      { realm:'Data', what:'asSystem()',   moved:0, note:'Still bypasses, by design. It is the one documented escape and it stays explicit.' },
      { realm:'API',  what:'Endpoints',    moved:0, note:'The routes still exist. They answer 401 instead of 200 — a different thing from vanishing.' },
      { realm:'UI',   what:'Resource',     moved:1, note:'<code>leads.find()</code> now needs a session; the error hook sees a 401 to react to.' },
    ],
  },
  {
    id: 'policy', label: 'Add a row policy',
    diff: [
      ['ctx',"  @@gate(\"0.4.4.5\")"],
      ['add',"  @@allow('read',   ownerId == auth().id)"],
      ['add',"  @@allow('update', ownerId == auth().id)"],
    ],
    hits: [
      { realm:'Data', what:'Every query',  moved:1, note:'<code>AND ownerId = ?</code> is compiled into the WHERE clause. Not a filter a caller applies.' },
      { realm:'API',  what:'List results', moved:1, note:'<code>GET /api/leads</code> returns only yours — and <code>total</code> counts only yours.' },
      { realm:'API',  what:'HTTP',         moved:1, note:"Patching someone else's row is a <code>403</code>, from the data layer up." },
      { realm:'API',  what:'Live events',  moved:1, note:'Subscribers stop receiving rows the policy would not have let them read.' },
      { realm:'Data', what:'Migration',    moved:0, note:'Policies are query-time, not schema-time. Nothing to migrate.' },
      { realm:'UI',   what:'Code',         moved:0, note:'Not one line changes. The UI was never the thing enforcing this.' },
    ],
  },
  {
    id: 'rename', label: 'Rename the model',
    diff: [
      ['del',"model Lead {"],
      ['add',"model Opportunity {"],
      ['ctx',"  id        Int      @id"],
      ['ctx',"  name      String   @length(1, 200) @trim"],
    ],
    hits: [
      { realm:'Data', what:'Accessor',     moved:1, note:'<code>db.lead</code> becomes <code>db.opportunity</code>. PascalCase singular in, camelCase out.' },
      { realm:'Data', what:'Migration',    moved:1, note:'A table rename is diffed like any other change — review it before applying.' },
      { realm:'Data', what:'TypeScript',   moved:1, note:'The interface is renamed, so every stale reference is a compile error rather than a runtime surprise.' },
      { realm:'API',  what:'Service',      moved:1, note:'One key: <code>model: \'opportunity\'</code>. That is the whole server-side edit.' },
      { realm:'API',  what:'URL',          moved:0, note:'<code>/api/leads</code> is unchanged — the service <em>name</em> is not the model name. Renaming your data does not break your clients.' },
      { realm:'UI',   what:'Resource',     moved:0, note:'<code>createResource(\'leads\')</code> still resolves. It binds to the service, not the table.' },
    ],
  },
]

export const HOPS = [
  { r:'a', name:'HTTP arrives', where:'transport/http.ts',
    say:'The server matches a route. If an Authorization header is present, IAuth.verifySession(token) resolves it to a session — the inbound auth bridge.' },
  { r:'a', name:'bridge.toContext()', where:'transport/bridge.ts',
    say:'THE transport-to-service boundary. The HTTP request becomes a Context: body to ctx.data, path captures to ctx.route, filters to ctx.query.' },
  { r:'a', name:'parseDirectives()', where:'transport/bridge.ts',
    say:'$limit and $orderBy are split off into ctx.directives. The $ prefix is transport syntax and nothing past this line ever sees one.' },
  { r:'a', name:'around hooks', where:'core/hooks.ts',
    say:'The outermost pipeline phase wraps everything that follows, including the failure paths. Timing and tracing live here.' },
  { r:'a', name:'gateAuth()', where:'core/litestone.ts',
    say:'Derived from the model @@gate. No session where one is required stops here as a 401, before any query is built.' },
  { r:'a', name:'autoValidate()', where:'core/litestone.ts',
    say:'Derived from the field rules. @email, @length and @gte become a 400 with per-field messages — still before the database is touched.' },
  { r:'a', name:'before hooks', where:'core/service.ts',
    say:'Your code, finally. Defaults, enrichment, anything that should happen to the data on the way in.' },
  { r:'d', name:'ctx.locals.db', where:'core/litestone.ts',
    say:'withLitestoneDb() put a per-request Litestone client here at createApp({ db }) time, already scoped to the caller.' },
  { r:'d', name:'$setAuth(user)', where:'litestone/core/client.js',
    say:'The Data-boundary checkpoint. Everything past this point knows who is asking — and asSystem() is the single documented way around it.' },
  { r:'d', name:'GatePlugin level check', where:'litestone/plugins/gate.js',
    say:'The same @@gate, enforced a second time at the data layer. Not redundancy — the API is one door, and the door is not the lock.' },
  { r:'d', name:'buildReadFilter()', where:'litestone/core/plugin.js',
    say:'@@allow predicates become a WHERE fragment, AND-merged with your own. This is why a policy cannot be skipped by a forgetful caller.' },
  { r:'d', name:'SQL', where:'litestone/core/query.js',
    say:'One statement, with your filters, the policy, and the pagination already folded in. Then the row comes back.' },
  { r:'a', name:'after hooks', where:'core/service.ts',
    say:'Your code again, on the way out. Shape it, format it, redact it.' },
  { r:'a', name:'wrapResult()', where:'core/envelope.ts',
    say:'THE result envelope, one owner. A list keeps { object, data, total }; a single record unwraps. Nothing else in the framework decides this.' },
  { r:'a', name:'publishToChannels()', where:'core/service.ts',
    say:'The single announcement point. One mutation, fanned out to both the event bus and the declared channel — there is no second path to forget.' },
  { r:'u', name:'WebSocket frame', where:'transport/channels.ts',
    say:'Subscribers receive "leads created". The gate still applies on the way out, so nobody is pushed a row they could not have fetched.' },
  { r:'a', name:'bridge.toResponse()', where:'transport/bridge.ts',
    say:'Back across the same boundary. A thrown FrameworkError becomes its status code here; a Litestone AccessDeniedError was normalized to 403 on the way.' },
  { r:'u', name:'The resource updates', where:'sierra/junction/index.js',
    say:'watchProxy() makes the result reactive, so whatever reads it re-renders. That seam — not a fetch call — is where the UI actually binds.' },
]
