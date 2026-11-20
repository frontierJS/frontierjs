# Multi-tenancy

A `tenancy { }` block says what a tenant is, once, in the schema: a column on shared tables (`strategy row`) or a SQLite file per customer (`strategy database`). Isolation is enforced at the Data boundary, not in handlers.

```lite
tenancy {
  strategy row
  column   workspaceId     // the column that holds the tenant
}

model User { id Int @id  @@auth }

model Project {
  id          Int    @id
  workspaceId Int
  name        String
}
```

```js
const mine   = db.$setAuth({ id: 1, workspaceId: 10 })
const theirs = db.$setAuth({ id: 2, workspaceId: 20 })

const made = await mine.project.create({ data: { id: 1, name: 'New' } })   // workspaceId stamped
await theirs.project.create({ data: { id: 2, name: 'Theirs' } })

const rows = await mine.project.findMany()
if (made.workspaceId !== 10 || rows.length !== 1) throw new Error('expected the stamp and the scope')
```

Every model that declares the column is scoped to the caller's claim, reads, writes and creates alike, with no policy written by hand.

## What else it can do

- `claim` names where the tenant lives on the principal, when it differs from the column
- `strategy database` gives each tenant its own file, opened through `createTenantRegistry`
- A registry creates, lists, deletes and migrates the fleet, and `query` fans a read across every tenant
- `maxOpen` keeps an LRU pool of tenant connections warm
- Per-tenant encryption keys come from a function, so the key can live in a vault
- `place` puts a tenant's file in a named directory, such as one per region
- `resolve` says how a request names its tenant: a subdomain or a header
- `@@tenant(none)` declares a model shared by every tenant, and `@@tenant(via: ...)` scopes one through its parent
- `asSystem()` off the root client is the cross-tenant admin tier; off a scoped client it stays inside the tenant
- A stated wrong tenant is refused by name rather than written and hidden
- A SQLite audit trail lives inside each tenant's own file and moves with its place

**In depth:** [Multi-tenancy § `strategy row`](../../multi-tenancy.md#strategy-row--a-tenant-column), [§ `strategy database`](../../multi-tenancy.md#strategy-database--a-file-per-tenant), [§ How a request names its tenant](../../multi-tenancy.md#how-a-request-names-its-tenant), [Guide: Multi-tenant SaaS](../../guides/multi-tenant-saas.md)
