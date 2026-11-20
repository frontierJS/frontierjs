# Gotchas

SQLite and Litestone each do a few things a newcomer does not expect. They are all correct, measured and listed with an example in the full page.

```lite
model User {
  id        Int       @id
  name      String
  deletedAt DateTime?

  @@softDelete
}
```

```js
const u = await db.user.create({ data: { name: 'a' } })
await db.user.remove({ where: { id: u.id } })

const hidden = await db.user.findUnique({ where: { id: u.id } })
const found  = await db.user.findUnique({ where: { id: u.id }, withDeleted: true })
if (hidden !== null || found?.name !== 'a') throw new Error('expected the soft-deleted row to need withDeleted')
```

`remove()` soft-deletes and `findUnique` then hides the row. `delete()` is the physical delete on any model.

## What else it can do

- [`LIKE` and `lower()` fold ASCII only](../../gotchas.md#sqlite-has-no-ilike-and-lower-folds-ascii-only), so `contains: 'émile'` does not match `Émile`
- [`json_extract` returns native types](../../gotchas.md#json_extract-returns-native-types--cast-before-comparing-to-strings), so a number compared to a string matches nothing
- [A lone `Int @id` is `AUTOINCREMENT`](../../gotchas.md#a-lone-int-id-is-autoincrement-and-a-gap-is-normal), and a gap in ids is normal
- [`notIn` and `not` include `NULL` rows](../../gotchas.md#notin-and-not-include-null-rows), unlike plain SQL
- [`Boolean` is stored as `0`/`1`](../../gotchas.md#boolean-is-stored-as-01--coercion-is-automatic) and coerced on read
- [`DateTime` is ISO-8601 text](../../gotchas.md#datetime-is-stored-as-iso-8601-text--comparison-works-arithmetic-needs-care), so comparison works and arithmetic needs care
- [Overlapping deploys on one WAL file](../../gotchas.md#concurrent-deploys-sharing-a-wal-file-can-cause-write-contention) can contend for the write lock
- [`kamal app exec` adds a container](../../gotchas.md#kamal-app-exec-adds-500mb-ram-per-invocation) of memory per invocation
- [`select: false` still reads the row](../../gotchas.md#select-false-still-reads-the-row-on-trail-models) on a `@@trail` model
- [`@sequence` rolls back](../../gotchas.md#sequence-rolls-back-with-its-transaction) with its transaction and reuses the number
- [`Json @encrypted`](../../gotchas.md#json-encrypted-round-trips-and-a-database-written-before-it-did-holds-object-object) round-trips, and an older database may hold `'[object Object]'`
- [The audit trail lags a write](../../gotchas.md#audit-trail-reads-lag-writes-within-a-session) by one event-loop tick
- [A relative `database { path }`](../../gotchas.md#where-a-relative-database--path--lands) resolves against the process directory, not the schema

**In depth:** [Gotchas § Soft delete and findUnique](../../gotchas.md#soft-delete-and-findunique), and the [full list](../../gotchas.md)
