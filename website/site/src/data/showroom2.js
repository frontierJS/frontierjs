// site/src/data/showroom2.js — the walkthrough's acts and steps, verbatim.
//
// A step's `code` is the WHOLE file at that point and `fresh` marks the lines
// that are new since the previous step, so the two are one table: reordering
// steps without moving `fresh` shows the wrong lines lit and nothing errors.
//
// The step's own language comes from `file` — the extension is on screen, so
// deriving it means the label and the highlighting cannot disagree. `rlang` is
// only for the result panel, which is a different language from the file more
// often than not, and defaults to js.

export const ACTS = [
  { id:'Data', name:'Data',  pkg:'@frontierjs/litestone', tone:'primary' },
  { id:'API',  name:'API',   pkg:'@frontierjs/junction',  tone:'info'    },
  { id:'UI',   name:'UI',    pkg:'@frontierjs/sierra',    tone:'success' },
]

export const STEPS = [

  // ═══ Act 1 — Litestone ════════════════════════════════════════════════════
  { act:'Data', title:'Describe the data',
    say:'Everything starts in one file. Model names are PascalCase and singular — always.',
    file:'db/schema.lite',
    code:[
      "model Lead {",
      "  id        Int      @id",
      "  name      String",
      "  email     String",
      "  value     Float",
      "  createdAt DateTime @default(now())",
      "}",
    ],
    fresh:[0,1,2,3,4,5,6],
    rlabel:'You already have a typed client',
    result:
`import { createClient } from '@frontierjs/litestone'

const db = await createClient({ db: 'app.db', schema: './db/schema.lite' })

// model Lead  →  accessor db.lead
await db.lead.create({ data: { name: 'Acme', email: 'hi@acme.com', value: 12000 } })
await db.lead.findMany({ where: { value: { gte: 5000 } }, limit: 20 })` },

  { act:'Data', title:'Constrain it',
    say:'Field rules live on the field. You will not write these checks anywhere else — that is the whole point.',
    file:'db/schema.lite',
    code:[
      "model Lead {",
      "  id        Int      @id",
      "  name      String   @length(1, 200) @trim",
      "  email     String   @email @unique @lower",
      "  value     Float    @gte(0)",
      "  createdAt DateTime @default(now())",
      "}",
    ],
    fresh:[2,3,4],
    rlabel:'Enforced at the data layer',
    result:
`await db.lead.create({ data: { name: '', email: 'nope', value: -5 } })

// ValidationError — nothing was written
{
  name:  'must be between 1 and 200 characters',
  email: 'must be a valid email address',
  value: 'must be >= 0'
}

// @trim and @lower are transforms, applied on the way in.` },

  { act:'Data', title:'Say who may do what',
    say:'One ordinal level per operation, read against the Trust Hierarchy. Read is open; writing needs a user; deleting needs an admin.',
    file:'db/schema.lite',
    code:[
      "model Lead {",
      "  id        Int      @id",
      "  name      String   @length(1, 200) @trim",
      "  email     String   @email @unique @lower",
      "  value     Float    @gte(0)",
      "  createdAt DateTime @default(now())",
      "",
      "  @@gate(\"0.4.4.5\")",
      "}",
    ],
    fresh:[6,7],
    rlabel:'Authorization, below every caller',
    rlang:['js', 'lite'],
    result:
`@@gate("0.4.4.5")
//       │ │ │ └── delete : 5  ADMINISTRATOR
//       │ │ └──── update : 4  USER
//       │ └────── create : 4  USER
//       └──────── read   : 0  STRANGER

const scoped = db.$setAuth(user)      // level comes from GatePlugin

await scoped.lead.findMany()          // ✓ anyone
await scoped.lead.create({ ... })     // ✗ AccessDeniedError below level 4

await db.asSystem().lead.create({...}) // the one documented bypass` },

  { act:'Data', title:'Say which rows',
    say:'Gates are per-operation. Policies are per-row, and they compile into SQL — so this is not a filter a caller can forget.',
    file:'db/schema.lite',
    code:[
      "model Lead {",
      "  id        Int      @id",
      "  name      String   @length(1, 200) @trim",
      "  email     String   @email @unique @lower",
      "  value     Float    @gte(0)",
      "  ownerId   Int",
      "  createdAt DateTime @default(now())",
      "",
      "  @@gate(\"0.4.4.5\")",
      "  @@allow('read', ownerId == auth().id)",
      "}",
    ],
    fresh:[5,9],
    rlabel:'Appended to every query',
    result:
`await db.$setAuth(user).lead.findMany({ where: { value: { gte: 5000 } } })

-- the SQL actually executed (user.id = 42):
SELECT * FROM leads
 WHERE value >= 5000
   AND ownerId = 42        -- from the policy. Not optional.

// There is no code path that skips this, because it is not in a code path.` },

  { act:'Data', title:'Ship the schema',
    say:'The schema is the migration source. fli diffs it against the live database and writes the SQL.',
    file:'db/schema.lite',
    code:[
      "model Lead {",
      "  id        Int      @id",
      "  name      String   @length(1, 200) @trim",
      "  email     String   @email @unique @lower",
      "  value     Float    @gte(0)",
      "  ownerId   Int",
      "  createdAt DateTime @default(now())",
      "",
      "  @@gate(\"0.4.4.5\")",
      "  @@allow('read', ownerId == auth().id)",
      "  @@index([ownerId, createdAt])",
      "  @@log(audit)",
      "}",
    ],
    fresh:[10,11],
    rlabel:'fli db:migrate',
    rlang:['sh', 'sql'],
    result:
`$ fli db:migrate

-- migrations/0001_init.sql  (generated)
CREATE TABLE leads (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  email      TEXT    NOT NULL UNIQUE,
  value      REAL    NOT NULL DEFAULT 0,
  ownerId    INTEGER NOT NULL,
  createdAt  TEXT    NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX leads_ownerId_createdAt ON leads (ownerId, createdAt);

$ litestone types ./types.d.ts     # and TypeScript, from the same file` },

  // ═══ Act 2 — Junction ═════════════════════════════════════════════════════
  { act:'API', title:'Put it on the wire',
    say:'Naming the model on a service derives the whole CRUD surface. This is the entire server.',
    file:'api/server.ts',
    code:[
      "import { createApp, createService } from '@frontierjs/junction'",
      "",
      "const app = createApp({ db, auth, config: { port: 3200, apiPrefix: '/api' } })",
      "",
      "app.services.register(createService({",
      "  name:  'leads',",
      "  model: 'lead',",
      "}))",
      "",
      "await app.start()",
    ],
    fresh:[0,1,2,3,4,5,6,7,8,9],
    rlabel:'Five endpoints, no handlers',
    result:
`GET    /api/leads          find    → { object, data, total }
GET    /api/leads/:id      get
POST   /api/leads          create
PATCH  /api/leads/:id      patch
DELETE /api/leads/:id      remove

// createApp({ db }) also scopes Litestone per request, so the gate and
// the policy you wrote in Act 1 already see the calling user.` },

  { act:'API', title:'The rules became 400s',
    say:'Nothing was added to the server. The field rules from Act 1 are enforced at the edge because the API reads the same schema.',
    file:'api/server.ts',
    code:[
      "import { createApp, createService } from '@frontierjs/junction'",
      "",
      "const app = createApp({ db, auth, config: { port: 3200, apiPrefix: '/api' } })",
      "",
      "app.services.register(createService({",
      "  name:  'leads',",
      "  model: 'lead',",
      "}))",
      "",
      "await app.start()",
    ],
    fresh:[],
    nocode:'No new code this step. This is derived from @length, @email and @gte.',
    rlabel:'POST /api/leads',
    result:
`{ "name": "", "email": "not-an-email", "value": -5 }

→ 400 Bad Request
{
  "name": "BadRequest",
  "code": 400,
  "data": {
    "name":  "must be between 1 and 200 characters",
    "email": "must be a valid email address",
    "value": "must be >= 0"
  }
}` },

  { act:'API', title:'The gate became 401s and 403s',
    say:'Also derived. A Litestone denial is normalized into the framework error shape, so success and failure are one contract.',
    file:'api/server.ts',
    code:[
      "import { createApp, createService } from '@frontierjs/junction'",
      "",
      "const app = createApp({ db, auth, config: { port: 3200, apiPrefix: '/api' } })",
      "",
      "app.services.register(createService({",
      "  name:  'leads',",
      "  model: 'lead',",
      "}))",
      "",
      "await app.start()",
    ],
    fresh:[],
    nocode:'No new code this step. This is derived from @@gate and @@allow.',
    rlabel:'The same gate, over HTTP',
    result:
`GET    /api/leads                     → 200  read is level 0
POST   /api/leads                     → 401  no session
POST   /api/leads      (level 4 user) → 201
DELETE /api/leads/7    (level 4 user) → 403  needs ADMINISTRATOR

// And the row policy still applies — a level 4 user listing leads
// sees only their own, because the WHERE clause says so.` },

  { act:'API', title:'Paginate and sort',
    say:'Transport syntax uses $ prefixes; nothing past the bridge ever sees one. Filters land in ctx.query, shaping lands in ctx.directives.',
    file:'api/server.ts',
    code:[
      "import { createApp, createService } from '@frontierjs/junction'",
      "",
      "const app = createApp({ db, auth, config: { port: 3200, apiPrefix: '/api' } })",
      "",
      "app.services.register(createService({",
      "  name:  'leads',",
      "  model: 'lead',",
      "}))",
      "",
      "await app.start()",
    ],
    fresh:[],
    nocode:'No new code this step. Directives are parsed by the transport bridge.',
    rlabel:'GET /api/leads?value[gte]=5000&$limit=2&$orderBy=-createdAt',
    result:
`{
  "object": "list",
  "data": [
    { "id": 8, "name": "Acme Corp",  "value": 12000 },
    { "id": 5, "name": "Globex Inc", "value":  8500 }
  ],
  "total": 17,
  "limit": 2,
  "offset": 0
}

// A list keeps its envelope; a single record unwraps.` },

  { act:'API', title:'Broadcast changes',
    say:'One announcement point. Every mutation fans out to the event bus and to the declared channel — there is no second publish path to forget.',
    file:'api/server.ts',
    code:[
      "import { createApp, createService, publish } from '@frontierjs/junction'",
      "",
      "const app = createApp({ db, auth, config: { port: 3200, apiPrefix: '/api' } })",
      "const live = publish(() => app.channel('leads'))",
      "",
      "app.services.register(createService({",
      "  name:    'leads',",
      "  model:   'lead',",
      "  channel: 'leads',",
      "  hooks: { after: { create: [live], patch: [live], remove: [live] } },",
      "}))",
      "",
      "await app.start()",
    ],
    fresh:[0,3,7,8],
    rlabel:'Over the WebSocket',
    result:
`// a client subscribed to the 'leads' channel receives:

{ "type": "leads created", "data": { "id": 9, "name": "Initech" } }
{ "type": "leads patched", "data": { "id": 5, "value": 9100  } }
{ "type": "leads removed", "data": { "id": 2 } }

// Same gate applies on the way out — subscribers only get rows
// their policy would have let them read.` },

  // ═══ Act 3 — Sierra ═══════════════════════════════════════════════════════
  { act:'UI', title:'Bind it to a page',
    say:'A route is a file. createResource gives you the service as a reactive object — no fetch, no store wiring.',
    file:'src/routes/leads/index.mesa',
    code:[
      "<script>",
      "  import { createResource } from '@frontierjs/sierra'",
      "",
      "  const leads = createResource('leads')",
      "  await leads.find({ value: { gte: 5000 } })",
      "<\/script>",
      "",
      "<table class=\"table\">",
      "  {#each leads.data as lead}",
      "    <tr><td>{lead.name}</td><td>{lead.value}</td></tr>",
      "  {/each}",
      "</table>",
    ],
    fresh:[0,1,2,3,4,5,6,7,8,9,10,11],
    rlabel:'The file path is the route',
    result:
`src/routes/leads/index.mesa   →   /leads
src/routes/leads/[id].mesa    →   /leads/42
src/routes/_module.mesa       →   the layout wrapping both

// leads.data is reactive. The table re-renders when it changes;
// there is no subscribe-and-setState step to write.` },

  { act:'UI', title:'Step into the pipeline',
    say:'The same four hook phases as the API realm — around, before, after, error — with a Context that mirrors it. Learn the pipeline once.',
    file:'src/routes/leads/index.mesa',
    code:[
      "<script>",
      "  import { createResource } from '@frontierjs/sierra'",
      "",
      "  let busy = false",
      "",
      "  const leads = createResource('leads', {",
      "    hooks: {",
      "      around: { all:    [async (ctx, next) => {",
      "        busy = true; await next(); busy = false",
      "      }] },",
      "      before: { create: [ctx => { ctx.data.source = 'web' }] },",
      "      error:  { all:    [ctx => toast(ctx.error.message)] },",
      "    },",
      "  })",
      "",
      "  await leads.find({ value: { gte: 5000 } })",
      "<\/script>",
    ],
    fresh:[3,5,6,7,8,9,10,11,12,13],
    rlabel:'Identical on both sides of the wire',
    result:
`// UI — src/routes/leads/index.mesa
hooks: { around: {...}, before: {...}, after: {...}, error: {...} }

// API — api/server.ts
hooks: { around: {...}, before: {...}, after: {...}, error: {...} }

// Pipeline, both realms:
//   around:enter → before → [work] → after → around:exit
//                              ↓ on throw
//                            error

// ctx.params is UI-only and never crosses the wire.` },

  { act:'UI', title:'Start a blank one',
    say:'make() builds an empty record shaped by the schema, with its declared defaults already applied. The starting value for a create form.',
    file:'src/routes/leads/index.mesa',
    code:[
      "<script>",
      "  import { createResource } from '@frontierjs/sierra'",
      "",
      "  const leads = createResource('leads')",
      "  await leads.find()",
      "",
      "  let draft = leads.make()",
      "<\/script>",
      "",
      "<form on:submit={() => leads.create(draft)}>",
      "  <input class=\"field\" bind:value={draft.name}  placeholder=\"Name\">",
      "  <input class=\"field\" bind:value={draft.email} placeholder=\"Email\">",
      "  <button class=\"btn\">Add lead</button>",
      "</form>",
    ],
    fresh:[6,9,10,11,12,13],
    rlabel:'Shaped by the same JSON Schema',
    result:
`leads.make()

{
  name:  '',
  email: '',
  value: 0,          // from @gte(0)
  // id, ownerId and createdAt are omitted — the server owns them
}

// The browser has the JSON Schema, so it knows email is an email and
// name maxes at 200. Rendering a full form from it is the next step
// for the framework — see the Vision section.` },

  { act:'UI', title:'Make it live',
    say:'The consuming side of the publish you declared in Act 2. One line, and the table follows the database.',
    file:'src/routes/leads/index.mesa',
    code:[
      "<script>",
      "  import { createResource } from '@frontierjs/sierra'",
      "",
      "  const leads = createResource('leads')",
      "  await leads.find()",
      "",
      "  leads.subscribe()      // joins the 'leads' channel",
      "<\/script>",
      "",
      "<table class=\"table\">",
      "  {#each leads.data as lead}",
      "    <tr><td>{lead.name}</td><td>{lead.value}</td></tr>",
      "  {/each}",
      "</table>",
    ],
    fresh:[6],
    rlabel:'No refresh logic anywhere',
    result:
`// Someone else POSTs a lead. Your table gains a row.

  server  ── create ──▶ channel 'leads'
                            │
                            ▼
  browser ── leads.data ──▶ re-render

// You wrote: one subscribe() call, and channel: 'leads' on the service.
// Everything between them was already there.` },

  { act:'UI', title:'That is the app',
    say:'Three files. Everything else was derived from the first one — and it all traces back to a schema you can read in ten seconds.',
    file:'the whole thing',
    code:[
      "db/schema.lite               13 lines   the seed",
      "api/server.ts                12 lines   the API",
      "src/routes/leads/index.mesa  14 lines   the UI",
      "",
      "# derived, unwritten:",
      "#   migrations + indexes + audit log",
      "#   row policies compiled into SQL",
      "#   five REST endpoints + pagination",
      "#   400s from the field rules",
      "#   401s and 403s from the gate",
      "#   TypeScript types + JSON Schema",
      "#   WebSocket events, both directions",
    ],
    fresh:[4,5,6,7,8,9,10,11],
    rlabel:'Where to go next',
    rlang:'sh',
    result:
`$ npx @frontierjs/cli new my-app

# then read, in this order:
#   ARCHITECT.md    the mental model and the vocabulary
#   PHILOSOPHY.md   the axioms underneath it
#   DECISIONS.md    why things are the way they are

# and the runnable ladder:
#   packages/junction/example/minimal/
#   packages/junction/example/elegant.ts
#   packages/junction/example/fullstack/` },
]
