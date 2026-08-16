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

`maxOpen` bounds open connections; the least recently used is closed when the
pool is full. Files are never deleted by eviction. Concurrent `get()` calls for
one cold tenant share a single open — without that, K simultaneous requests on a
deploy restart each ran a full `createClient` and leaked K-1 sets of handles.

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
- **`asSystem()` is the only way across**, which is what a cross-tenant admin
  tier is built on. It is also the only thing that can create a tenant's first
  row before anyone belongs to it.
- **A stated wrong tenant is refused by name** (`AccessDeniedError`), not
  written and then hidden.
- **Raw SQL enforces none of it** — `db.sql` requires `asSystem()` once a schema
  declares access rules, and a raw statement is outside every policy.

### Models that carry no column

They are **not** scoped, and that is sometimes exactly right — a plan table, a
country list, an identity table read across tenants. The parse reports them once
by name:

```
tenancy: 2 model(s) declare no 'workspaceId' and are NOT scoped to a tenant —
Plan, Country. Add the column, or mark each @@tenant(none) to say it spans
tenants on purpose.
```

Three ways to answer it:

```
@@tenant(none)                  // spans tenants deliberately — silences the report
@@tenant(column: "accountId")   // scoped, under a column of its own
workspaceId Int                 // declare the column and it is scoped like the rest
```

A model in a `jsonl` or `logger` database is never scoped — there is no policy
engine there, so a rule would read as enforcement and not be it.

**A model reached only through its parent has no answer yet.** `check(parent)`
delegation is conservative-allow on create (the related row does not exist when
the create policy runs), so generating it would produce a rule that holds for
reads and not for writes. Write it by hand where you need it, and see
[`ISSUES.md`](../../../ISSUES.md) `FJS-282`.

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
