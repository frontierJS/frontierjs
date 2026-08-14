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
- **`{ } Query`** — the Litestone query behind the current view, to copy or send to the REPL

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
