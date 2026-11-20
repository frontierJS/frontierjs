# The client

`createClient` reads the schema and returns the `db` object: one accessor per model, each with the same read and write methods.

A request should use a scoped client, `db.$setAuth(user)`, so row policies and field rules see the current user. The unscoped `db` is for your own code.

```lite
model User { id Int @id  @@auth }  // the principal model: where auth() claims come from

model Note {
  id      Int    @id
  ownerId Int    @default(auth().id)
  body    String

  @@allow(read, ownerId == auth().id)
  @@allow(create, auth() != null)
}
```

```js
const ann = db.$setAuth({ id: 1 })
const bob = db.$setAuth({ id: 2 })

await ann.note.create({ data: { body: 'mine' } })

const annSees = await ann.note.findMany()
const bobSees = await bob.note.findMany()
const system = await db.asSystem().note.findMany() // bypasses policies; use sparingly
if (annSees.length !== 1 || bobSees.length !== 0 || system.length !== 1) throw new Error('policies did not apply')
```

## What else it can do

- Schema source: `path`, `schema` (inline text) or `parsed` (from `parseFile`)
- `db` sets the database file; `:memory:` is a throwaway
- `encryptionKey` for `@encrypted` fields
- `computed` supplies the functions behind `@computed` fields
- `plugins`, `hooks`, `onEvent` and `onQuery` hook into the client
- `filters` applies a default `where` to every read of a model
- `readOnly: true` refuses every write
- `untrusted: true` builds a schema that came from data

**In depth:** [Getting started § createClient options](../../getting-started.md#createclient-options), [§ Auth scoping](../../getting-started.md#auth-scoping)
