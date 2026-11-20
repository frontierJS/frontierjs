# Overview

Litestone is a schema-first SQLite layer for Bun. One `.lite` file declares your data, and the tables, types, validation and client all derive from it.

The schema is the single source of truth. A model's shape, who may read it and what happens when a row changes all sit in the same file, so there is nothing to drift. SQLite is the database and Bun's built-in driver runs it, so there is no server to operate and no dependency to install.

```lite
model Post {
  id        Int      @id
  title     String   @length(1, 120)
  published Boolean  @default(false)
  createdAt DateTime @default(now())
}
```

```js
const post = await db.post.create({ data: { title: 'Hello' } })

const drafts = await db.post.findMany({ where: { published: false } })
if (post.published !== false || drafts.length !== 1) throw new Error('unexpected rows')

try { await db.post.create({ data: { title: '' } }) }  // refused: title must be 1 to 120 characters
catch (e) { if (e.name !== 'ValidationError') throw e }
```

The `Post` model gave you the table, the `db.post` accessor, the default values and the length check. Nothing else was written.

## What else it can do

- Row policies, field policies and gates, enforced inside SQL (`@@allow`, `@@deny`, `@@gate`)
- Relations, nested writes and `include`
- Enums, exact money, typed JSON and computed fields
- Encryption, an audit trail and soft delete
- Migrations written from the schema's diff
- Full-text search, vectors, geo points and file storage
- Multiple databases and per-tenant databases

## Where next

- [Getting started](getting-started.md) installs it and runs a first query.
- [`.lite` files](lite-files.md) covers the file itself.
- [The client](the-client.md) covers `createClient` and auth scoping.

**In depth:** [Why Litestone](../../why-litestone.md) and the [README](../../../README.md)
