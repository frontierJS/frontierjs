// site/src/data/showroom.js — the showroom's tables, lifted verbatim.
//
// Data, not markup: the island that renders it is small because everything it
// needs to say is here. Kept as its own module rather than inlined so the
// component stays readable and a wording change is a diff in one place.
//
// `lines` on a chip is an index into SCHEMA — which line of the seed that
// derived thing came from — so the two arrays are one table and must move
// together.
//
// `lang` is what the sample is written in, for `@frontierjs/toolbelt/glow`.
// Two of them are transcripts — a command and its output, a query beside the
// SQL it compiled to — so they name both languages and glow merges the rules.

export const SCHEMA = [
  /* 0*/ "model Lead {",
  /* 1*/ "  id        Int        @id",
  /* 2*/ "  name      String     @length(1, 200) @trim",
  /* 3*/ "  email     String     @email @unique @lower",
  /* 4*/ "  status    LeadStatus @default(new)",
  /* 5*/ "  value     Float      @gte(0)",
  /* 6*/ "  ownerId   Int",
  /* 7*/ "  createdAt DateTime   @default(now())",
  /* 8*/ "",
  /* 9*/ "  @@gate(\"0.4.4.5\")",
  /*10*/ "  @@allow('read', ownerId == auth().id)",
  /*11*/ "  @@index([status, createdAt])",
  /*12*/ "  @@log(audit)",
  /*13*/ "}",
]

export const FIELDS = [1,2,3,4,5,6,7]

export const RULES = [2,3,5]

export const CHIPS = [
  // ── Data ──────────────────────────────────────────────────────────────────
  { id:'migration', lang:['sh', 'sql'], realm:'Data', label:'Migration SQL', lines:FIELDS,
    from:'the field list — diffed against the live database',
    blurb:'The schema is the migration source. fli diffs it against the database and writes the SQL; you never hand-write a CREATE TABLE.',
    code:
`$ fli db:migrate

-- migrations/0001_init.sql  (generated)
CREATE TABLE leads (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  name       TEXT    NOT NULL,
  email      TEXT    NOT NULL UNIQUE,
  status     TEXT    NOT NULL DEFAULT 'new',
  value      REAL    NOT NULL DEFAULT 0,
  ownerId    INTEGER NOT NULL,
  createdAt  TEXT    NOT NULL DEFAULT (datetime('now'))
);` },

  { id:'indexes', lang:'sql', realm:'Data', label:'Indexes', lines:[3,11],
    from:'@@index([...]) and @unique',
    blurb:'Indexes are declared beside the data they index, so they travel with the model instead of living in a migration nobody reads.',
    code:
`-- from @@index([status, createdAt])
CREATE INDEX leads_status_createdAt
  ON leads (status, createdAt);

-- from @unique on email
CREATE UNIQUE INDEX leads_email ON leads (email);` },

  { id:'policies', lang:['js', 'sql'], realm:'Data', label:'Row policies', lines:[10],
    from:"@@allow('read', ownerId == auth().id)",
    blurb:'Policies compile into the WHERE clause of every query. Not a filter you remember to apply — a filter no caller can skip.',
    code:
`const db = client.$setAuth(user)   // user.id = 42

await db.lead.findMany({ where: { status: 'active' } })

-- the SQL actually executed:
SELECT * FROM leads
 WHERE status = 'active'
   AND ownerId = 42            -- appended by the policy

// asSystem() is the one documented bypass:
await client.asSystem().lead.findMany()   // no policy applied` },

  { id:'gates', lang:'lite', realm:'Data', label:'Gates', lines:[9],
    from:'@@gate("0.4.4.5")',
    blurb:'One ordinal level per operation, read from the Trust Hierarchy. Read is open, writes need a user, deletes need an admin.',
    code:
`@@gate("0.4.4.5")
//       │ │ │ └── delete : 5  ADMINISTRATOR
//       │ │ └──── update : 4  USER
//       │ └────── create : 4  USER
//       └──────── read   : 0  STRANGER

await db.lead.findMany()          // ✓ anyone
await db.lead.create({ ... })     // ✗ AccessDeniedError unless level >= 4

// Junction maps its session to the same scale:
new GatePlugin({ getLevel: user => user ? LEVELS.USER : LEVELS.STRANGER })` },

  { id:'client', lang:'js', realm:'Data', label:'Typed client', lines:FIELDS,
    from:'the model name and its fields',
    blurb:'model Lead becomes db.lead — PascalCase singular in, camelCase accessor out. Filters, ordering and pagination are typed from the fields.',
    code:
`const hot = await db.lead.findMany({
  where:   { status: 'active', value: { gte: 5000 } },
  orderBy: { createdAt: 'desc' },
  limit:   20,
})

const one = await db.lead.findUnique({ where: { email: 'a@b.co' } })

await db.lead.update({
  where: { id: 7 },
  data:  { status: 'closed' },
})` },

  { id:'types', lang:['sh', 'ts'], realm:'Data', label:'TypeScript types', lines:FIELDS,
    from:'the field list and their nullability',
    blurb:'One command turns the schema into declarations. Separate Create and Update shapes, so generated fields are not required on insert.',
    code:
`$ litestone types ./types.d.ts --audience=client

export interface Lead {
  id:        number
  name:      string
  email:     string
  status:    LeadStatus
  value:     number
  ownerId:   number
  createdAt: string
}

export interface LeadCreate { name: string; email: string; /* … */ }
export interface LeadUpdate { name?: string; email?: string; /* … */ }
export type LeadStatus = 'new' | 'active' | 'closed'` },

  // ── API ───────────────────────────────────────────────────────────────────
  { id:'rest', lang:'js', realm:'API', label:'REST endpoints', lines:[0],
    from:'model: \'lead\' on the service',
    blurb:'Naming the model on a service derives the whole CRUD surface. Six lines of registration, five endpoints.',
    code:
`app.services.register(createService({
  name:  'leads',
  model: 'lead',
}))

GET    /api/leads          find    → { object, data, total }
GET    /api/leads/:id      get
POST   /api/leads          create
PATCH  /api/leads/:id      patch
DELETE /api/leads/:id      remove

GET /api/leads?$limit=20&$offset=40&$orderBy=-createdAt` },

  { id:'validation', lang:'js', realm:'API', label:'Validation', lines:RULES,
    from:'@length, @email, @gte on the fields',
    blurb:'Field rules become 400s at the API edge. Write the constraint once, on the data, and every entry point enforces it.',
    code:
`POST /api/leads
{ "name": "", "email": "not-an-email", "value": -5 }

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

  { id:'auth', lang:'js', realm:'API', label:'Authorization', lines:[9,10],
    from:'@@gate and @@allow — enforced below the service',
    blurb:'The gate becomes 401s and 403s without a guard in the handler. A Litestone denial is normalized into the framework error shape.',
    code:
`POST /api/leads                      → 401  no session
POST /api/leads   (level 4 user)     → 201
DELETE /api/leads/7  (level 4 user)  → 403  needs ADMINISTRATOR

// toFrameworkError() maps across the package boundary:
//   AccessDeniedError → 403 Forbidden
//   ValidationError   → 400 BadRequest  (+ field errors on .data)

// Every response, success or failure, is one shape.` },

  { id:'jsonschema', lang:'js', realm:'API', label:'JSON Schema', lines:FIELDS,
    from:'generateJsonSchema(schema)',
    blurb:'The bridge between realms. Junction validates against it; Sierra ships it to the browser so the UI knows the same rules.',
    code:
`import { generateJsonSchema } from '@frontierjs/litestone'

{
  "Lead": {
    "type": "object",
    "required": ["name", "email"],
    "properties": {
      "name":   { "type": "string", "minLength": 1, "maxLength": 200 },
      "email":  { "type": "string", "format": "email" },
      "status": { "enum": ["new", "active", "closed"], "default": "new" },
      "value":  { "type": "number", "minimum": 0 }
    }
  }
}` },

  { id:'openapi', lang:'js', realm:'API', label:'OpenAPI', lines:[0].concat(FIELDS),
    from:'the registered services and their models',
    blurb:'Mounted automatically. Every registered service contributes its paths, and the models become the component schemas.',
    code:
`app.configure(openapi({ title: 'Leads API', version: '1.0.0' }))

GET /openapi.json

{
  "openapi": "3.1.0",
  "paths": {
    "/api/leads":     { "get": { … }, "post": { … } },
    "/api/leads/{id}": { "get": { … }, "patch": { … }, "delete": { … } }
  },
  "components": { "schemas": { "Lead": { … } } }
}` },

  { id:'events', lang:'js', realm:'API', label:'Live events', lines:[0],
    from:"channel: 'leads' on the service",
    blurb:'One announcement point. Every mutation fans out to the event bus and to the declared channel — no second publish path to forget.',
    code:
`const live = publish(() => app.channel('leads'))

createService({
  name: 'leads', model: 'lead',
  channel: 'leads',
  hooks: { after: { create: [live], patch: [live], remove: [live] } },
})

// → WebSocket subscribers receive:
{ "type": "leads created", "data": { "id": 8, "name": "Acme" } }` },

  // ── UI ────────────────────────────────────────────────────────────────────
  { id:'resource', lang:'js', realm:'UI', label:'Resource + hooks', lines:[0],
    from:'the service name — and the same four phases as the API',
    blurb:'The UI half of the service. Identical hook phases to the API realm, on purpose: learn the pipeline once and it holds on both sides.',
    code:
`const leads = createResource('leads', {
  hooks: {
    around: { all:    [async (ctx, next) => {
      busy = true; await next(); busy = false
    }] },
    before: { create: [ctx => { ctx.data.source = 'web' }] },
    after:  { find:   [ctx => ctx.result.data.forEach(fmt)] },
    error:  { all:    [ctx => toast(ctx.error.message)] },
  },
})

await leads.find({ status: 'active' })
await leads.create({ name: 'Acme', email: 'hi@acme.com' })` },

  { id:'make', lang:'js', realm:'UI', label:'Blank records', lines:[2,3,4,5,7],
    from:'the JSON Schema defaults',
    blurb:'make() builds an empty record shaped by the schema, with declared defaults already applied — the starting value for a create form.',
    code:
`const draft = leads.make()

{
  name:   '',
  email:  '',
  status: 'new',      // from @default(new)
  value:  0,          // from @gte(0)
  // id and createdAt are omitted — the database owns them
}

// bind it straight to inputs, then:
await leads.create(draft)` },

  { id:'liveui', lang:'html', realm:'UI', label:'Live updates', lines:[0],
    from:'the channel the service declared',
    blurb:'The consuming side of the same publish. The resource is a reactive object, so a pushed row re-renders whatever reads it.',
    code:
// NOTE: the sample's closing script tag is written with an escaped slash so it
// does not terminate this very element. It renders normally in the code panel.
`<script>
  const leads = createResource('leads')
  await leads.find()

  leads.subscribe()   // joins the 'leads' channel
<\/script>

<!-- no refresh logic: the list is reactive -->
{#each leads.data as lead}
  <tr><td>{lead.name}</td><td>{lead.status}</td></tr>
{/each}` },

  // ── Direction ─────────────────────────────────────────────────────────────
  { id:'forms', lang:'js', realm:'Soon', label:'Generated forms', lines:RULES, soon:true,
    from:'not built yet — the JSON Schema is already in the browser',
    blurb:'Direction, not a feature. The inputs exist — Sierra already ships the JSON Schema to the client — but nothing renders from it yet.',
    code:
`// PROPOSED — this does not work today.

<Form model="Lead" />

// would derive, from the schema alone:
//   email  → <input type="email" required>
//   name   → maxlength=200
//   status → <select> of the enum
//   value  → <input type="number" min="0">
//   create gate fails → submit disabled, no round trip

// Tracked in IDEAS/framework-shape.md as the #1 gap:
// derivation currently stops at the API boundary.` },

  { id:'offline', lang:'lite', realm:'Soon', label:'Offline-first', lines:FIELDS, soon:true,
    from:'not built yet — but one engine already runs on both sides',
    blurb:'Direction. Litestone is SQLite, so the same schema, queries and gates can run in the browser. Sync and conflict policy are the open design.',
    code:
`// PROPOSED — this does not work today.

model Lead {
  // …
  @@sync(lww)          // conflict policy declared, not hand-rolled
}

// The gate is evaluated locally before queueing, so the user is told
// "you can't do that" with no round trip — and the server re-checks
// on sync. Only possible because authorization lives in the schema.

// Tracked in IDEAS/offline-first-and-release.md.` },
]
