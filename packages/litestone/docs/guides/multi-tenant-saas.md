# Guide: Multi-Tenant SaaS App

Build a complete multi-tenant application where each customer gets an isolated SQLite database, with per-tenant encryption and shared audit logging.

---

## What we're building

A SaaS app with:
- One SQLite file per tenant (full isolation)
- Shared schema across all tenants
- Per-tenant encryption keys
- Row-level policies scoped to `auth().accountId`
- A global audit log (not per-tenant)

---

## Schema

```prisma
// schema.lite
database audit {
  path      "./audit/"
  driver    logger
  retention 90d
}

enum Role { admin  member  viewer }

model User {
  id        Integer  @id
  email     Text     @unique @email @lower
  name      Text?    @trim
  role      Role     @default(member)
  apiKey    Text?    @secret
  createdAt DateTime @default(now())
  deletedAt DateTime?

  @@softDelete
  @@auth
  @@log(audit)
  @@allow('read',   id == auth().id || auth().role == 'admin')
  @@allow('update', id == auth().id || auth().role == 'admin')
  @@allow('delete', auth().role == 'admin')
}

model Project {
  id          Integer   @id
  name        Text
  description Text?
  ownerId     Integer   @default(auth().id)
  createdAt   DateTime  @default(now())
  deletedAt   DateTime?

  @@softDelete
  @@allow('read',   auth() != null)
  @@allow('create', auth() != null)
  @@allow('update', ownerId == auth().id || auth().role == 'admin')
  @@allow('delete', ownerId == auth().id || auth().role == 'admin')
}
```

---

## Tenant registry

```js
// lib/tenants.js
import { createTenantRegistry } from '@frontierjs/litestone'
import { getEncryptionKey } from './vault.js'

export const tenants = await createTenantRegistry({
  dir:    './tenants/',
  schema: './schema.lite',
  maxOpen: 50,
  encryptionKey: async (tenantId) => getEncryptionKey(tenantId),
  migrationsDir: './migrations',
})
```

`createTenantRegistry` creates tenant databases on first access and applies migrations automatically. `getEncryptionKey` fetches the per-tenant key from your KMS or secrets manager.

---

## Per-request scoping

```js
// middleware/db.js — Express/Hono/etc
export async function dbMiddleware(req, res, next) {
  const tenantId = req.headers['x-tenant-id'] ?? req.user?.tenantId
  if (!tenantId) return res.status(400).json({ error: 'Missing tenant' })

  // Get (or create) this tenant's database
  const rawDb = await tenants.get(tenantId)

  // Scope to the authenticated user
  req.db = rawDb.$setAuth(req.user)

  next()
}
```

Every query through `req.db` has:
- Row-level policies applied (only returns rows the user is allowed to see)
- `@default(auth().id)` stamped on create
- `@@log(audit)` entries attributed to `req.user.id`

---

## Routes

```js
// routes/projects.js
router.get('/', async (req, res) => {
  const projects = await req.db.project.findMany({
    orderBy: { createdAt: 'desc' },
    limit:   req.query.limit ?? 20,
    offset:  req.query.offset ?? 0,
  })
  // → only projects the user is allowed to read
  res.json(projects)
})

router.post('/', async (req, res) => {
  const project = await req.db.project.create({
    data: {
      name:        req.body.name,
      description: req.body.description,
      // ownerId: stamped automatically from auth().id
    }
  })
  // → { id: 1, name: 'My Project', ownerId: 42, ... }
  res.json(project)
})

router.delete('/:id', async (req, res) => {
  await req.db.project.remove({ where: { id: Number(req.params.id) } })
  // Policy check: only owner or admin can delete
  // Soft-deleted — row stays, deletedAt stamped
  res.json({ ok: true })
})
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

Or programmatically at deploy time:

```js
await tenants.migrate()
```

---

## Audit log queries

The audit log is shared across all tenants — query it via `asSystem()`:

```js
const audit = await db.asSystem().auditLogs.findMany({
  where:   { model: 'projects', operation: 'delete' },
  orderBy: { createdAt: 'desc' },
  limit:   100,
})
// → [{ operation: 'delete', model: 'projects', records: [5], actorId: 42, ... }]
```

---

## Tenant provisioning API

```js
router.post('/tenants', requireSuperAdmin, async (req, res) => {
  const { id, name } = req.body

  // Creates ./tenants/<id>.db, applies all migrations
  const db = await tenants.get(id)

  // Seed initial admin user
  await db.asSystem().users.create({
    data: { email: req.body.adminEmail, role: 'admin' }
  })

  res.json({ id, name, created: true })
})
```
