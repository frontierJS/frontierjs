---
title: 02-database
description: A database that predates the framework, with rows already in it
---

## Something you already have

This step writes a SQLite database with no FrontierJS anywhere near it — raw
SQL, `snake_case` columns, a foreign key, a `UNIQUE`, a `CHECK`, a compound
index, a polymorphic pair, and three rows:

```console
CREATE TABLE customers (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  email      TEXT NOT NULL UNIQUE,
  full_name  TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE orders (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  customer_id INTEGER NOT NULL REFERENCES customers(id),
  total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
  status      TEXT NOT NULL DEFAULT 'pending',
  placed_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX orders_by_customer ON orders(customer_id, placed_at);

CREATE TABLE activity_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  subject_type TEXT    NOT NULL,   -- 'customers' | 'orders' | whatever came next
  subject_id   INTEGER NOT NULL,   -- no foreign key: it points at two tables
  action       TEXT    NOT NULL,
  at           TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
);
```

The third table is the one to look at. A pair like `subject_type`/`subject_id`
is in almost every database that has been alive for a few years — an audit
trail, an attachment, a comment that can hang off anything. It has **no foreign
key by construction**, because it points at more than one table, so the database
is not defending it and never was. Step 6 is about what to do with that.

Stand in front of it as if you had inherited it. Nothing below deletes it,
migrates it or rewrites it — the whole lesson is about reading it.

```js
if (!await narrate(context)) return

context.config.__step = 2

const legacy = join(context.config.ws.dir, 'legacy')
const dbFile = join(legacy, 'shop.db')

mkdirSync(legacy, { recursive: true })
if (existsSync(dbFile)) rmSync(dbFile, { force: true })

// Written through bun rather than the sqlite3 binary: a lesson that needed a
// second database tool installed would refuse on a machine that can run
// everything else here. Through a SUBPROCESS rather than an import, because
// `fli` runs on node and `bun:sqlite` cannot be loaded there — the same
// subprocess `probe.sqliteRow` reads with.
if (!await must(context, probe.sqliteExec({
  db:   dbFile,
  name: 'a shop database, made the way a real one is made',
  statements: [
    `CREATE TABLE customers (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      email      TEXT NOT NULL UNIQUE,
      full_name  TEXT,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE orders (
      id          INTEGER PRIMARY KEY AUTOINCREMENT,
      customer_id INTEGER NOT NULL REFERENCES customers(id),
      total_cents INTEGER NOT NULL CHECK (total_cents >= 0),
      status      TEXT NOT NULL DEFAULT 'pending',
      placed_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    'CREATE INDEX orders_by_customer ON orders(customer_id, placed_at)',
    `CREATE TABLE activity_log (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      subject_type TEXT    NOT NULL,
      subject_id   INTEGER NOT NULL,
      action       TEXT    NOT NULL,
      at           TEXT    NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `INSERT INTO customers (email, full_name) VALUES ('ada@example.test', 'Ada Lovelace')`,
    `INSERT INTO orders (customer_id, total_cents, status) VALUES (1, 4250, 'paid')`,
    `INSERT INTO activity_log (subject_type, subject_id, action) VALUES ('orders', 1, 'paid')`,
  ],
}), {
  likely: 'bun could not write there — check the workspace is writable, and that bun is on PATH',
})) return

if (!await must(context, probe.sqliteRow({
  db:     dbFile,
  sql:    'select id, total_cents from orders',
  expect: (rows) => rows.length === 1 && Number(rows[0].total_cents) === 4250,
  name:   'a database with an order already in it',
}), {
  likely: 'the statements ran and the row is not there — the file may be somewhere else',
})) return

log.info('')
log.info(`  ${dbFile}`)
log.info('')

remember(context, '02-database', { legacyDir: legacy, legacyDb: dbFile })
```
