# Getting started

Install the package, write a model, and open a client over it. A database file that does not exist yet is created with the schema's tables.

```bash
bun add @frontierjs/litestone
bunx litestone init        # writes schema.lite, litestone.config.js and migrations/
```

`init` writes one model to start from:

```lite
model User {
  id        Int      @id
  email     String   @unique
  name      String?
  createdAt DateTime @default(now())
  deletedAt DateTime?

  @@softDelete
  @@index([email])
}
```

```js
import { createClient } from '@frontierjs/litestone'

const db = await createClient({ path: './schema.lite', db: './development.db' })

const user = await db.user.create({ data: { email: 'alice@example.com', name: 'Alice' } })

const users = await db.user.findMany({ where: { name: 'Alice' }, orderBy: { createdAt: 'desc' }, limit: 20 })

await db.user.update({ where: { id: user.id }, data: { name: 'Alice Smith' } })

await db.user.remove({ where: { id: user.id } }) // soft, because of @@softDelete
if (users.length !== 1) throw new Error('expected one user')
```

## What else it can do

- `bunx litestone migrate create <name>` and `migrate apply` write and run migrations
- `bunx litestone studio` opens a browser UI over your data
- `db: ':memory:'` gives a throwaway database for tests
- `schema: '...'` takes an inline schema string instead of a path
- `litestone.config.js` holds the default database path and other CLI settings

**In depth:** [Getting started § Quick start](../../getting-started.md#quick-start)
