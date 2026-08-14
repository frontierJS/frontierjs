# Studio

Studio is Litestone's browser UI. Launch it with:

```bash
bunx litestone studio            # http://localhost:5001
bunx litestone studio --port=3000
```

## Panels

### Browse

Paginated table viewer for every model. Features:
- Row-by-row editing directly in the table
- Soft-delete toggle — switch between live rows, deleted rows, and all rows
- Database filter pills for multi-database schemas
- Pagination with configurable page size
- **`🎲 Random`** — generate one plausible row from the schema, parents included
- **`{ } Query`** — the Litestone query behind the current view, to copy or send to the REPL

#### `🎲 Random`

The Testing realm's own generator (`factoryFrom` + `withParents`) pointed at the live
database — no factory class to write, the schema is the definition.

**One click can write to several tables.** A generated row has to satisfy its own
required foreign keys, so `withParents()` walks the chain: one `App` on basecamp
creates an Account, Workspace, Project and Environment first. The toast names every
table it touched, because a button that silently writes six tables is how a scratch
database stops being one.

**It runs as the principal the sidebar selects**, so a refusal is the gate working
rather than the button failing. On basecamp, generating as an unprivileged principal
answers `"Account.create" requires SYSTEM access (use asSystem())` — a true answer
about the schema. With no principal selected Studio is already `asSystem()`, which is
why the default click succeeds.

When a gate does refuse, the toast carries a **Retry as system** button. The
escalation is offered and never taken for you, the refusal is shown in full first,
and the row that results says `(as system)` so the grid cannot quietly disagree with
the principal in the sidebar. The offer appears only for an access refusal —
discriminated on `AccessDeniedError`, not on the wording of the message — because a
validation failure has no such retry.

Each click seeds the generator from a counter, so rows differ and known field names
draw real words (`omar.lindqvist734001@example.org`) rather than filler. Hidden on
`jsonl`/`logger` models, and refused by name at the endpoint too; `--readonly` blocks
it like every other mutating control.

#### Pinning a parent

Open any row's detail drawer and press **📌 Pin**. Every row generated afterwards
reuses that row as its parent instead of creating one, **at every depth of the
chain** — pin one Account and an afternoon of clicking stays inside it rather than
sprouting a tenant per click. Active pins show as chips in the toolbar; `✕` removes
one.

```
without a pin   1× account, 1× workspace, 1× project, 1× environment, 1× app, 1× deployment
with Account    1× workspace, 1× project, 1× environment, 1× app, 1× deployment
```

Studio holds only the id. The server re-reads the row **through the same client it is
about to write with**, so a pin cannot hand a principal a row its own policy hides —
an unreadable pin is refused by name rather than silently ignored. Underneath it is
`withParents({ pins })`, documented in `docs/testing.md`.

Verified by `bench/studio-factory.mjs` (endpoint) and `bench/studio-factory-click.mjs`
(the button, in a real browser).

#### `{ } Query`

Browse builds a real query object on every load. The button shows it:

```js
await db.asSystem().product.findMany({
  where: { OR: [{ name: { contains: 'wid' } }, { sku: { contains: 'wid' } }] },
  orderBy: [{ name: 'desc' }, { id: 'asc' }],
  limit: 50
})
```

**The client is part of what it emits**, because it is part of the query — the same
arguments through a different client return different rows. A view browsed with no
principal selected emits `db.asSystem()`; one browsed as a user emits
`db.$setAuth(user)` and names which user stood behind it. *Send to REPL* drops the
client instead, because the REPL binds `db` from the same auth selector and stating
one there would scope the call twice.

Two things it does not carry. The search box is not a per-field filter — it matches
every searchable String field, every numeric field when the text parses as a number,
and a date prefix on `DateTime`, so the `where` is an `OR` across the model rather
than the one condition you might expect. And cursor paging is left out: the query
describes page one of the same filter and sort, which the drawer says when you are
past it.

Verified by `bench/studio-query-view.mjs`, which executes the emitted source and
compares its rows against the grid's.

### SQL Query

Raw SQL editor with:
- Syntax highlighting
- Results grid with column sorting
- Multiple result sets (UNION, multiple statements)
- Runs against the read connection — safe to use in production

### Schema

Interactive ER diagram:
- Draggable nodes, auto-layout
- Color-coded by database
- Auto-generated models (FTS5 tables, audit models) badged distinctly
- Click any model to jump to its Browse view

### Migrations

- Applied/pending status per database
- Live schema diff showing exactly what's changed
- Per-migration SQL viewer

### Schema Advisor

Index analysis across the schema and the live database: foreign keys with no leading
index, `@@softDelete` models with no index on `deletedAt`, declared indexes a
migration has not built yet, and large tables carrying only a primary key.

An issue that has one states its **Fix in the schema** — a button that writes
`@@index([col])` into the right model in `schema.lite`, keeping the block's
indentation and sitting with the other `@@` attributes. It parses the result before
saving and refuses a duplicate. **It does not create the index**: the schema now
says something the database does not, so the toast says `migrate to create it` and
offers the Migrations panel, and the advisor keeps reporting the issue until a
migration runs, which is the truth rather than a stale read.

The raw `CREATE INDEX` is still shown for a database you cannot redeploy, but the
schema is the better route: **a migration only drops what litestone named**
(`idx_<table>_<cols>`), so an index created by hand under another name survives
every later migration.

**Why index a foreign key at all**, measured on 50k rows:

| | no index | index |
| --- | --- | --- |
| 2,000 lookups by the FK | 4,023 ms | 56 ms |
| cascade-delete 200 parents | 656 ms | 8 ms |
| insert 50,000 children | 31 ms | 53 ms |
| database size | 0.86 MB | 1.40 MB |

The cost is real but small; the win is two orders of magnitude. Note the direction:
reading the **parent** from the child (`include({ environment: true })`) resolves by
primary key and was never affected. What scans is everything starting from the other
side — the parent's `hasMany`, a `where` on the FK column, and `ON DELETE CASCADE`.

### Stats

Per-database health dashboard:
- Page size, WAL mode, cache size
- Row counts per model
- Database file size
- WAL checkpoint status

### REPL

Interactive Litestone query REPL:
- Full ORM API available (`db.user.findMany(...)`)
- Autocomplete on model names and methods
- History (up/down arrows)
- **SQL log** — shows the actual SQL + params for every expression executed
- Timing per query

### schema.lite

Live schema editor:
- Syntax highlighting for `.lite` DSL
- Debounced validation (600ms) — error tray shows parse errors in real time
- Ctrl+S to save to disk

### Transform (dev tool)

Anonymize/shard pipeline runner:
- Load a transform config
- Preview output before executing
- Download anonymized database

### Performance

- Schema advisor: suggests missing indexes, flags FK columns without indexes
- Query analyzer: paste any SQL to see `EXPLAIN QUERY PLAN`

## Acting-as picker

Select any user from your `@@auth` model to browse with row-level policies enforced. Useful for testing what a specific user can see.

## Production use

Studio reads from the read connection — safe to run against production databases. It does not bypass any policies or access control. The raw SQL editor runs with the system context (no policy filtering) — consider restricting access in production.

```bash
# Host on the server, not localhost
kamal app exec --no-interactive -- litestone studio --port=5001
```

> Note: Running Studio via `kamal app exec` spawns a new container — if your SQLite file is on the host, use the host directly to avoid WAL contention.
