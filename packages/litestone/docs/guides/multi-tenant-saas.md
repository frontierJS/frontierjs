# Guide: Multi-Tenant SaaS App

Build a complete multi-tenant application where each customer gets an isolated SQLite database, with per-tenant encryption and a shared audit trail.

---

## What we're building

A SaaS app with:
- One SQLite file per tenant (full isolation)
- Shared schema across all tenants
- Per-tenant encryption keys
- Row-level policies scoped to the caller
- A global audit trail (not per-tenant)

---

## Schema

The directory the tenant files live in, the registry file, the pool size and
how a request names its tenant are all the schema's, in one `tenancy` block:

```lite
// schema.lite
tenancy {
  strategy database
  dir      "./tenants"
  registry "./tenants-registry.db"
  maxOpen  50
  resolve  header("X-Tenant-Id")
}

database audit {
  path      "./audit/"
  driver    trail
  retention 90d
}

enum Role { admin  member  viewer }

model User {
  id        Int  @id
  email     String     @unique @email @lower
  name      String?    @trim
  role      Role     @default(member)
  apiKey    String?    @secret
  createdAt DateTime @default(now())
  deletedAt DateTime?

  @@softDelete
  @@auth
  @@trail(audit)
  @@allow('read',   id == auth().id || auth().role == 'admin')
  @@allow('update', id == auth().id || auth().role == 'admin')
  @@allow('delete', auth().role == 'admin')
}

model Project {
  id          Int   @id
  name        String
  description String?
  ownerId     Int   @default(auth().id)
  createdAt   DateTime  @default(now())
  deletedAt   DateTime?

  @@softDelete
  @@allow('read',   auth() != null)
  @@allow('create', auth() != null)
  @@allow('update', ownerId == auth().id || auth().role == 'admin')
  @@allow('delete', ownerId == auth().id || auth().role == 'admin')
}
```

`dir` and `registry` are resolved against the schema file's own directory.
`docs/multi-tenancy.md` is the reference — including `strategy row`, which is
one database and a tenant column instead.

---

## Tenant registry

```js
// lib/tenants.js
import { createTenantRegistry } from '@frontierjs/litestone'
import { randomBytes } from 'node:crypto'

// A per-tenant key comes from a KMS or secrets manager; a map stands in for it here.
const vault = new Map()
const keyFor = async tenantId => {
  if (!vault.has(tenantId)) vault.set(tenantId, randomBytes(32).toString('hex'))
  return vault.get(tenantId)
}

export const tenants = await createTenantRegistry({
  path:          './schema.lite',
  // A per-tenant key is a function; a string is the one-key-for-everyone case.
  encryptionKey: keyFor,
})
```

Every `tenancy` option is still accepted here and beats the declaration
(`dir`, `registryDb`, `maxOpen`, `migrationsDir`).

**`get(id)` opens a tenant that exists and throws for one that does not.**
Provisioning is `create(id)` or `getOrCreate(id)`, which writes
`./tenants/<id>.db`, builds the schema in it and records the tenant in the
registry file. `exists(id)`, `list()` and `delete(id)` are the rest of the
registry's surface.

---

## Per-request scoping

```js fragment
// middleware/db.js — Express/Hono/etc
export async function dbMiddleware(req, res, next) {
  const tenantId = req.headers['x-tenant-id'] ?? req.user?.tenantId
  if (!tenantId) return res.status(400).json({ error: 'Missing tenant' })
  if (!tenants.exists(tenantId)) return res.status(404).json({ error: 'No such tenant' })

  // This tenant's database, opened from the pool
  const rawDb = await tenants.get(tenantId)

  // Scope to the authenticated user
  req.db = rawDb.$setAuth(req.user)

  next()
}
```

`tenants.tenantFor({ headers })` answers the id the schema's `resolve` names,
which is what Junction calls per request.

Every query through `req.db` has:
- Row-level policies applied (only returns rows the user is allowed to see)
- `@default(auth().id)` stamped on create
- `@@trail(audit)` entries attributed to `req.user.id`

---

## Routes

What the handlers do, run against one tenant:

```js
import { createTenantRegistry } from '@frontierjs/litestone'
const tenants = await createTenantRegistry({ path: './schema.lite', encryptionKey: process.env.TENANT_KEY ?? 'c'.repeat(64) })

const db    = await tenants.getOrCreate('acme')
const admin = await db.asSystem().user.create({ data: { email: 'Admin@Acme.com', role: 'admin' } })
// → { id: 1, email: 'admin@acme.com', role: 'admin', ... } — @lower applied
const reqDb = db.$setAuth(admin)

// GET /projects
const projects = await reqDb.project.findMany({
  orderBy: { createdAt: 'desc' },
  limit:   20,
  offset:  0,
})
// → only projects the user is allowed to read

// POST /projects
const project = await reqDb.project.create({
  data: {
    name:        'My Project',
    description: null,
    // ownerId: stamped automatically from auth().id
  }
})
// → { id: 1, name: 'My Project', ownerId: 1, ... }

// DELETE /projects/:id
await reqDb.project.remove({ where: { id: project.id } })
// Policy check: only owner or admin can delete
// Soft-deleted — row stays, deletedAt stamped

const [gone] = await db.asSystem().project.findMany({ withDeleted: true })
if (project.ownerId !== admin.id || gone.deletedAt === null || admin.email !== 'admin@acme.com') throw new Error('unexpected')
```

---

## Migrations across all tenants

```bash
# Generate migration
litestone migrate create add-description-field

# Apply to all tenants at once
litestone tenant migrate

# Apply to specific tenants only
litestone tenant migrate --only=acme,beta
```

Or programmatically at deploy time, from a registry built with a
`migrationsDir`:

```js fragment
await tenants.migrate()
```

---

## Audit trail queries

The audit trail is shared across all tenants — the trail database is declared
outside the `tenancy` block, so every tenant's client appends to the same
file. Query it via `asSystem()` on any tenant's client:

```js
import { createTenantRegistry } from '@frontierjs/litestone'
const tenants = await createTenantRegistry({ path: './schema.lite', encryptionKey: process.env.TENANT_KEY ?? 'c'.repeat(64) })

const db    = await tenants.getOrCreate('acme')
const admin = await db.asSystem().user.create({ data: { email: 'admin@acme.com', role: 'admin' } })
await db.$setAuth(admin).user.update({ where: { id: admin.id }, data: { name: 'Ada' } })
await new Promise(r => setImmediate(r))   // an entry lands one tick after its write

const audit = await db.asSystem().auditTrail.findMany({
  where:   { model: 'User', operation: 'update' },
  orderBy: { createdAt: 'desc' },
  limit:   100,
})
// → [{ operation: 'update', model: 'User', records: [1], actorId: 1, ... }]
if (audit.length !== 1 || audit[0].actorId !== admin.id) throw new Error(JSON.stringify(audit))
```

`model` is the model name (`User`, the spelling `$audit({ model })` takes). The entry's
`tenant` column is what tells one tenant's rows from another's in the shared
file; it is filled by `logContext`, which Junction's seam supplies per request.

---

## Tenant provisioning API

```js
import { createTenantRegistry } from '@frontierjs/litestone'
const tenants = await createTenantRegistry({ path: './schema.lite', encryptionKey: process.env.TENANT_KEY ?? 'c'.repeat(64) })

// POST /tenants — behind requireSuperAdmin
const { id, name, adminEmail } = { id: 'beta', name: 'Beta Co', adminEmail: 'owner@beta.example' }

// Creates ./tenants/beta.db, builds the schema, records the tenant
const db = await tenants.create(id, { name })

// Seed initial admin user
await db.asSystem().user.create({
  data: { email: adminEmail, role: 'admin' }
})

if (!tenants.exists(id) || !tenants.list().includes(id)) throw new Error('not registered')
// res.json({ id, name, created: true })
```
