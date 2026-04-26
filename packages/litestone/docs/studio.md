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
