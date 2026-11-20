# Performance

Litestone is built for SQLite's one-writer, many-reader shape, and most tuning is done for you. The levers left are indexes, how much of a row you ask for, and what you let the planner see.

```lite
model Note {
  id         Int       @id
  kind       String
  archivedAt DateTime?

  @@index([kind], where: archivedAt == null)   // a partial index over live notes
}
```

```js
const { sql } = db.$rawDbs.main.query(`SELECT sql FROM sqlite_master WHERE name = 'idx_note_kind'`).get()
if (!/WHERE "archivedAt" IS NULL/.test(sql)) throw new Error(`expected a partial index, got ${sql}`)

await db.note.create({ data: { kind: 'k3' }, select: false })
const slim = await db.note.findMany({ where: { kind: 'k3', archivedAt: null }, select: { id: true } })
if (slim.length !== 1 || 'kind' in slim[0]) throw new Error('expected the narrow read')
```

A partial index is used when the query states its predicate, so filter by the question the index was built for.

## What else it can do

- `@@softDelete` models get partial indexes over live rows automatically
- `findUnique` by primary key and a bare `findMany` run on precomputed statements
- `select: false` on a write skips `RETURNING` and the row parse
- A partial `select` fetches only the columns it names
- `orderBy: { name: { dir: 'asc', nulls: 'last' } }` places nulls without an in-memory sort
- `ANALYZE` runs after every migration, and by hand after a bulk load
- Reads use a separate `query_only` connection, so they never block a write
- `readOnly: true` opens a client that cannot write, and `access` sets it per database
- `$backup` takes a consistent hot snapshot, with `vacuum: true` to compact it
- `litestone doctor` flags unindexed foreign keys, large unindexed tables and stale statistics

**In depth:** [Performance § Hot paths](../../performance.md#hot-paths), [§ Partial indexes](../../performance.md#partial-indexes), [§ select: false](../../performance.md#select-false), [§ Read-only clients](../../performance.md#read-only-clients), [§ $backup](../../performance.md#backup--hot-backups), [§ Doctor](../../performance.md#doctor)
