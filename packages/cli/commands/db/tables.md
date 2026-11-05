---
title: db:tables
description: List all sqlite tables, with their sizes or row counts
alias: db-tables
examples:
  - fli db:tables
  - fli db:tables --size
  - fli db:tables --counts
  - fli db:tables --counts --size
  - fli db:tables --test
flags:
  test:
    char: t
    type: boolean
    description: Query the test database
    defaultValue: false
  size:
    char: s
    type: boolean
    description: Show table sizes in KB instead of schemas
    defaultValue: false
  counts:
    char: c
    type: boolean
    description: Show each table's row count, largest first, empty tables dimmed
    defaultValue: false
---

<script>
import { Database } from 'bun:sqlite'

// Every user table, counted. Litestone's own `_`-prefixed tables and sqlite's
// are left out, as the --size listing leaves them. A table that cannot be
// counted (a virtual table whose module is not loaded) is reported as null
// rather than failing the whole listing.
const countTables = (file, { withSize }) => {
  const db = new Database(file, { readonly: true })
  try {
    const names = db.query(`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite\_%' ESCAPE '\\' AND name NOT LIKE '\\_%' ESCAPE '\\'`).all().map(r => r.name)
    const sizes = withSize ? sizesKb(db) : {}
    return names.map(name => ({
      name,
      rows: countRows(db, name),
      kb:   sizes[name] ?? null,
    })).sort((a, b) => (b.rows ?? -1) - (a.rows ?? -1) || a.name.localeCompare(b.name))
  } finally {
    db.close()
  }
}

const countRows = (db, name) => {
  try { return db.query(`SELECT count(*) AS n FROM "${name.replaceAll('"', '""')}"`).get().n }
  catch { return null }
}

const sizesKb = db => {
  try {
    return Object.fromEntries(db.query('SELECT name, SUM(pgsize) / 1024 AS kb FROM dbstat GROUP BY name').all().map(r => [r.name, r.kb]))
  } catch { return {} }
}
</script>

```js
const { full } = resolveDb($, flag)

if (flag.counts) {
  if (!existsSync(full)) {
    log.error(`No database at ${full}`)
    return
  }
  const { plural } = await import(resolve(global.fliRoot, 'core/text.js'))
  const rows  = countTables(full, { withSize: flag.size })
  const width = Math.max(...rows.map(r => r.name.length), 5)
  const full_ = rows.filter(r => r.rows)

  echo('')
  for (const r of rows) {
    const n    = r.rows == null ? '?' : r.rows.toLocaleString()
    const size = flag.size && r.kb != null ? chalk`  {dim ${r.kb} KB}` : ''
    echo(r.rows
      ? chalk`  {bold ${r.name.padEnd(width)}}  {cyan ${n.padStart(9)}}${size}`
      : chalk`  {dim ${r.name.padEnd(width)}  ${n.padStart(9)}}${size}`)
  }
  echo(chalk`\n  {bold ${plural(full_.length, 'table')}} {dim with data of ${rows.length}}\n`)
  return
}

if (flag.size) {
  const sql = `"SELECT name, (SUM(pgsize)/1024) AS size_KB FROM dbstat WHERE name NOT LIKE '\\_%' ESCAPE '\\' GROUP BY name ORDER BY (SUM(pgsize)/1024) DESC;"`
  $.exec({ command: `sqlite3 ${full} ${sql}`, dry: flag.dry })
} else {
  $.exec({ command: `sqlite3 ${full} '.schema'`, dry: flag.dry })
}
```
