# Multi-Tenancy

**One declaration, in the seed.** A `tenancy { }` block at the top of
`schema.lite` says what a tenant IS, and everything that needs to know — the
registry, the CLI, Studio, Junction's per-request resolution — reads that one
block rather than being told again.

Two strategies, and the choice is about isolation, not about size:

| | `strategy database` | `strategy row` |
| --- | --- | --- |
| Storage | one SQLite file per tenant | one database, a tenant column |
| Isolation | the filesystem | the schema's own row policies |
| Per-tenant encryption key | yes | no |
| Cross-tenant query | `tenants.query(fn)` — fan-out | an ordinary query, `asSystem()` |
| Backup / restore one tenant | copy a file | export rows |
| Cost per tenant | a file, a connection in the LRU pool | a row |

---

## `strategy database` — a file per tenant

```
tenancy {
  strategy database
  dir      "./tenants"                  // where the files live
  registry "./tenants-registry.db"      // the index of who exists
  maxOpen  100                          // LRU connection pool
  key      env("TENANT_KEY")            // optional, one key for every tenant
  resolve  subdomain                    // how a REQUEST names its tenant
}
```

Relative paths resolve against the schema file's own directory, the same rule
`migrations` follows. `dir` and `registry` may be `env("VAR", "./default")`.

```js
import { createTenantRegistry } from '@frontierjs/litestone'

const tenants = await createTenantRegistry({ path: './db/schema.lite' })

const db = await tenants.get('acme')
await db.$setAuth(user).order.findMany()
```

That is the whole call. Every option is still accepted and **beats the
declaration** — `dir`, `registry`, `maxOpen`, `encryptionKey`, `migrationsDir`,
`clientOptions` — which is what makes a test able to point the same schema at a
temporary directory.

**Per-tenant keys stay a function**, because a key comes from a KMS or a vault
and a schema is a file in git:

```js
const tenants = await createTenantRegistry({
  path:          './db/schema.lite',
  encryptionKey: async (tenantId) => kms.getTenantKey(tenantId),
})
```

`key` in the block is the one-key-for-everyone case, read as a value and never
as a path.

### The fleet

```js
await tenants.create('acme', { plan: 'pro' })   // DDL or migrations, then registered
await tenants.getOrCreate('acme')
tenants.list()                                  // ['acme', 'globex']
await tenants.delete('acme')                    // closes, unlinks, deregisters

await tenants.query(db => db.user.count())      // → [{ tenantId, result }]
await tenants.query(fn, { where: { plan: 'pro' }, concurrency: 16, flatten: true })
await tenants.aggregate(db => db.user.count())  // → { total, byTenant }
await tenants.migrate()                         // every tenant, in parallel
await tenants.migrate({ only: ['acme'] })

tenants.meta.get('acme')                        // { plan: 'pro' }
tenants.meta.set('acme', { plan: 'enterprise' })
```

### The connection pool

**`maxOpen` is how many tenants to keep WARM, not a ceiling on open
connections** (`FJS-D172`). Eviction removes the least recently used from the
pool and does **not** close it, because `get()` hands a client to a request that
holds it across every await it makes and the pool is full again by traffic
rather than by that request finishing. Files are never deleted by eviction.
Concurrent `get()` calls for one cold tenant share a single open — without that,
K simultaneous requests on a deploy restart each ran a full `createClient` and
leaked K-1 sets of handles.

**A lease is what lets an eviction close anything.**

```js
const release = tenants.retain(id)
try   { /* the unit of work */ }
finally { release() }
```

Junction's `withTenantDb` does exactly this for every request, so an app on
Junction gets it without writing a line. A client evicted after its last lease
ended is closed immediately; one still leased stays open until the last holder
lets go; and a client from a bare `get()` was never leased, so it is dropped and
bun's finaliser closes it when nothing references it. Releasing twice is a
no-op, so a `finally` is safe on a path that already released.

`tenants.poolStats()` answers `{ pooled, leased, retired, overflows, maxOpen }`.
`retired` is evicted clients not yet collected — the number `openCount` cannot
report. `overflows` counts evictions where **every** slot was in use, which is
the only condition that means this process's concurrent tenant working set is
larger than `maxOpen`; it warns once.

**`tenants.query` and `aggregate` insert COLD.** A fan-out walks every tenant,
so through a plain LRU an admin dashboard evicts the tenants under live traffic.
Cold entries are the eviction victim before any hot one, within a ring sized to
the fan-out's concurrency (capped at half the pool) — Postgres uses a ring
buffer for sequential scans and MySQL midpoint insertion for the same reason.

### JSONL and logger databases are NOT per-tenant

A tenant's file holds every **sqlite** database the schema declares. `jsonl` and
`logger` databases stay schema-global — one audit trail for the fleet — and the
registry says so at startup. Per-tenant audit is an application decision, not a
default.

---

## `strategy row` — a tenant column

```
tenancy {
  strategy row
  column   workspaceId     // the column that holds the tenant
  claim    workspaceId     // where it lives on the principal (default: the column's name)
}

model Project {
  id          Int    @id
  workspaceId Int
  name        String
}
```

Nothing is passed to `createClient` and no registry exists. Every model that
**declares the column** is scoped, and a caller-scoped client is the whole API:

```js
const db   = await createClient({ path: './db/schema.lite', db: './app.db' })
const mine = db.$setAuth(user)          // user.workspaceId decides what exists

await mine.project.findMany()           // only this workspace's rows
await mine.project.create({ data: { name: 'New' } })   // workspaceId stamped
```

### What it desugars into, and why

Each scoped model gains two `@@deny` rules and a stamp — the rules you would
otherwise write on every model by hand:

```
@@deny('read,update,delete', auth().workspaceId == null || workspaceId != auth().workspaceId)
@@deny('create',             auth().workspaceId == null || (workspaceId != null && workspaceId != auth().workspaceId))
workspaceId Int @default(auth().workspaceId)
```

**A deny, never an `@@allow`.** Allows are OR'd within an operation, so adding
one to a model that already declares `@@allow('read', ownerId == auth().id)`
would *widen* its reads to every row in the tenant. Tenancy narrows; `@@deny`
overrides every allow and applies to a model that declares no policy at all.

**Create and read want opposite answers about an absent value.** The create
policy is evaluated before the `@default` stamp is applied, so a create that
omits the column is legitimate — it is about to be filled in. A READ of a row
holding no tenant is not: it belongs to nobody, and it stays invisible to
everyone but `asSystem()`.

Consequences worth stating:

- **Anonymous is not every tenant, it is none of them.** No principal → no
  claim → nothing matches.
- **`asSystem()` means no permission rules, not no scope**, and which of the two
  you get depends on where you reach for it. `db.asSystem()` off the ROOT client
  has no principal, so there is no claim, so nothing is scoped — that is the
  cross-tenant admin tier, and the only thing that can create a tenant's first
  row before anyone belongs to it. `db.$setAuth(user).asSystem()` keeps that
  user's claim: it crosses the gate, `@guarded` and every hand-written policy,
  and it stays inside the tenant it was standing in. That is the client an
  application wants inside a request — a `@@gate("8")` model can be read by
  nothing else, so before this the only client that could read a credential was
  the one that ignored tenancy (`FJS-519`).
- **So reaching for the app-level client inside a request is the wrong reach.**
  `app.data.asSystem()` in a service handler is unscoped by construction,
  because the app client has no principal to take a claim from. The request's
  own client is the one to elevate.
- **A stated wrong tenant is refused by name** (`AccessDeniedError`), not
  written and then hidden.
- **Raw SQL enforces none of it** — `db.sql` requires `asSystem()` once a schema
  declares access rules, and a raw statement is outside every policy.

**A nullable claim column means the row belongs to no tenant — never *every*
tenant.** `workspaceId String?` is legal and scoped like any other, and a row
holding null is reachable through `asSystem()` alone. It is worth stating
because the other reading is the tempting one: a column where null meant
*shared* could not tell a shared row from a stamp that failed to land, so a
leak and a feature would look identical. Sharing is a property of a MODEL and
is declared — `@@tenant(none)`, checked at parse — and a table holding both
kinds is two models wearing one name (`FJS-D141`).

**The DELEGATED form answers the opposite, deliberately.** `@@tenant(via: rel)`
over an OPTIONAL relation compiles to `check(rel)`, which is
`FK IS NULL OR EXISTS (…)` — so a child with no parent is visible to every
tenant rather than to none (`FJS-382`). The two are defensible apart: a column
is the row's own claim, where a null relation is a row nobody has filed yet.
They have not been reconciled, and `verifyTenantIsolation` reports the
delegated case as `unparented` rather than grading it, which is the honest
position for something nobody has settled (`FJS-528`).

### Models that carry no column

They are **not** scoped, and that is sometimes exactly right — a plan table, a
country list, an identity table read across tenants. The parse reports them once
by name:

```
tenancy: 2 model(s) declare no 'workspaceId', hold no relation to a model that
does, and are NOT scoped to a tenant — Plan, Country. Add the column, relate
them to a scoped model, or mark each @@tenant(none) to say it spans tenants on
purpose.
```

Four ways to answer it:

```
@@tenant(none)                  // spans tenants deliberately — silences the report
@@tenant(column: "accountId")   // scoped, under a column of its own
@@tenant(via: order)            // scoped through one named relation, and only that one
workspaceId Int                 // declare the column and it is scoped like the rest
```

A model in a `jsonl` or `logger` database is never scoped — there is no policy
engine there, so a rule would read as enforcement and not be it.

### Scoped through a parent

**A model that holds a foreign key to a scoped one is scoped too, and the rule
is generated.** It is not cross-tenant data — it is the same tenant's data, one
hop away — and the delegation costs it no column of its own:

```
@@deny(read, update, delete, create, !check(<relation>))
```

One deny **per scoped parent**, which is why there is nothing to choose. Denies
are AND'd, so a model with two scoped parents has to satisfy both — the
narrowing answer, and the direction tenancy always takes. `@@tenant(via: rel)`
narrows to a single relation for an app that wants exactly that.

Transitive: a grandchild is scoped once its parent is. A self-relation is
skipped, and so is a parent that is not itself scoped.

`check(rel, 'read')` states the operation rather than inheriting the containing
one — the question is always *is that parent mine*, never *may I create that
parent*, which is what the default would ask on a create.

The report names them:

```
tenancy: 2 model(s) carry no 'workspaceId' and are scoped through a parent —
Deploy (via app), LogLine (via deploy).
```

### A `@unique` is not scoped for you

The desugar guards **reads**. A `@unique` guards **writes**, and nothing above
touches it — so on a scoped model this is unique across the whole installation:

```lite
model Post {
  id          Int    @id
  workspaceId Int
  slug        String @unique      // ← two tenants cannot both hold "launch"
}
```

Two costs, and the second is the sharper one. Tenants collide on values that
should be theirs alone — a slug, an email, an SKU, an order number — and the
refusal carries the value, which tells the second tenant that a row they may not
read exists. That is exactly what `docs/access-control.md` says a refusal must
never do.

The parser reports it, and the test is **transitive**: a unique is per-tenant if
its columns carry the tenant column **or** a key reaching a model that is itself
scoped. Both of these are already correct and are not reported —

```lite
@@unique([workspaceId, slug])     // names the column
@@unique([serverId, name])        // a Server is scoped, so a Volume is
```

— and so is a grandchild, because the check reads the same scoping fixpoint the
delegation above is built on.

Where the global reading is the one you meant — a credential looked up **by** its
value, before anybody knows whose it is; a public subdomain — say so:

```lite
token String @unique(global)
@@unique([hostname], global: true)
```

It changes no DDL and appears in no snapshot. It is a statement to the reader and
to the parser, and it is the difference between a warning you answered and a
warning you learned to scroll past.

---

## How a request names its tenant

```
resolve subdomain              // acme.example.com  → 'acme'
resolve header("X-Tenant-Id")  // the header's value
resolve claim(workspaceId)     // a field on the principal
```

`strategy row` defaults to `claim(<claim>)` — the principal already carries the
answer. `strategy database` has **no default**: which of a host, a header and a
claim names the tenant is a deployment fact nothing can infer, and guessing
would route every request at one tenant in silence.

Applied in one place — `registry.tenantFor({ host, headers, principal })` — so
the API realm asks rather than re-reading the declaration:

```js
import { createApp } from '@frontierjs/junction'

const app = createApp({ tenants })     // instead of createApp({ db })
```

Junction then resolves a tenant per call and puts that tenant's caller-scoped
client on `ctx.locals.db`. Work with no request behind it (a job, a scheduled
sweep) names its tenant explicitly:

```js
await app.service('orders').find({}, { locals: { tenantId: 'acme' } })
```

`db` and `tenants` are alternatives, not a pair — one `ctx.locals.db` cannot be
assigned by two hooks.

Under `strategy row` there is nothing to swap, so `createApp({ db })` is
unchanged. What Junction adds there is a refusal: a **signed-in** caller whose
principal carries no claim, calling a scoped service, gets a 401 naming the
claim instead of an empty list with a 200. Anonymous is left to the gate.

---

## Reading the declaration yourself

```js
db.$tenancy          // on every flavour of client — root, $setAuth, asSystem, $scopedBy
tenants.tenancy      // the same, off a registry
tenants.tenantFor({ host, headers, principal })

import { resolveTenancy, tenantFrom } from '@frontierjs/litestone'
resolveTenancy(parseResult.schema, { schemaPath })
```

`null` when the schema declares no tenancy.

---

## CLI

```bash
litestone tenant list
litestone tenant create <id>
litestone tenant info <id>
litestone tenant delete <id>
litestone tenant migrate [--only=acme,beta] [--concurrency=8]
```

All of it reads the block. `--dir` / `--registry` and a `tenants:` key in
`litestone.config.js` still override, in that order: **flag, then config, then
the schema, then the default**. Run against a `strategy row` schema, the
commands refuse by name rather than creating files nothing will read.

Studio's tenant switcher opens the same directory the CLI writes to, for the
same reason.
