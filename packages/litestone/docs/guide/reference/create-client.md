# `createClient` options

`createClient` takes one options object. It needs a schema from one of `path`, `schema` or `parsed`; everything else is optional.

```lite
model Note {
  id   Int    @id
  body String
}
```

```js
const db = await createClient({ path: './schema.lite', db: ':memory:', now: () => new Date('2026-01-01T00:00:00Z') })

await db.note.create({ data: { body: 'hello' } })
if (await db.note.count() !== 1) throw new Error('expected one note')
```

## The options

- `path`, `schema` and `parsed` are the schema as a file path, as text, or as a pre-parsed result
- `db` is the file for the main database, and overrides a declared `database main`
- `databases` is `':memory:'` for every database, or `{ name: { path } }` for one each
- `resolveFrom` anchors a relative `database { path }` to the cwd, the schema file, or a directory
- `access` sets each database to `'readwrite'`, `'readonly'` or `false`, and `readOnly` is the shorthand for all
- `placeModels` puts a named model in a named database for this client only
- `busyTimeout` is the milliseconds to wait for another process's write lock
- `encryptionKey` is the 64-character hex key for `@encrypted` and `@secret`, and `previousEncryptionKeys` are keys it may still read with
- `plugins` takes `GatePlugin`, `FileStorage` and custom plugins
- `claims` declares the principal's per-request claim names beyond the `@@auth` columns
- `untrusted` builds schema text the app did not write, refusing anything that could name a file
- `computed` supplies the functions behind computed fields, or the path of a file exporting them
- `filters` adds a permanent `where` to every read on a model
- `scopes` registers named query fragments per model
- `hooks` runs `before` and `after` functions around reads and writes
- `onEvent` listens for `create`, `update`, `remove` and `change` after commit, and `announce` sets what a bulk write announces
- `onQuery` sees every verb the client runs, and `onLog` and `logContext` enrich audit-trail entries
- `now` is the clock the client reads and writes
- `pluralize` pluralizes snake_case table names
- `policyDebug` logs policy decisions
- `allowChildFkOverride` lets an explicit child value win over the parent's in a nested create

**In depth:** [Getting started § createClient options](../../getting-started.md#createclient-options), [§ Where the database file comes from](../../getting-started.md#where-the-database-file-comes-from), [§ A schema that is data](../../getting-started.md#a-schema-that-is-data)
