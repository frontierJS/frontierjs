// src/testdb.js — the migrated-database template every test copies from
//
// Applying DDL is the per-test cost once a schema is more than a few models,
// and it produces the same bytes every time. So it is done once per schema per
// process and every test after the first gets a file copy instead — which in
// SQLite is the whole of "isolated database per test".
//
// Encore reached the same shape: a template database with migrations already
// applied, cloned per test and dropped at the end. The difference is that here
// the clone is `copyFileSync`.
//
// Keyed on the schema TEXT, because the DDL is a pure function of it. Two
// clients differing only in plugins, encryption key or seed share a template
// legitimately — none of that reaches a CREATE TABLE.
//
// Never imported by production code.

import { generateDDL, generateDDLForDatabase } from './core/ddl.js'
import { splitStatements }                     from './core/migrate.js'
import { migrationStatements }                 from './core/migrations.js'
import { openDatabase }                        from './core/engine.js'
import { mkdirSync, copyFileSync, existsSync, rmSync, readdirSync, statSync } from 'fs'
import { join, resolve }                       from 'path'
import { tmpdir }                              from 'os'

// schemaText → { dir, files: { dbName: filename } }. Per process: a bun test
// file is its own process, so nothing here is shared across parallel files.
const templates = new Map()

let cleanupRegistered = false

function registerCleanup() {
  if (cleanupRegistered) return
  cleanupRegistered = true
  // One listener for every template this process built. Registering per
  // template hits the max-listeners warning on a suite with many schemas.
  process.on('exit', () => {
    for (const { dir } of templates.values()) {
      try { rmSync(dir, { recursive: true, force: true }) } catch {}
    }
  })
}

function applyDDL(file, ddl) {
  const raw = openDatabase(file)
  raw.run('PRAGMA journal_mode = WAL')
  raw.run('PRAGMA foreign_keys = ON')
  for (const stmt of splitStatements(ddl))
    if (!stmt.startsWith('PRAGMA')) raw.run(stmt)
  // Fold the WAL back into the .db before it is used as a source. A copy that
  // takes the main file and leaves its -wal behind is a database missing every
  // table created since the last checkpoint.
  raw.run('PRAGMA wal_checkpoint(TRUNCATE)')
  raw.close()
}

// ─── Migration replay ────────────────────────────────────────────────────────
//
// `migrations` may be a directory, a single .sql file, or an array of either.
//
// A directory contributes every .sql it holds, sorted by filename. That is
// deliberately looser than `listMigrationFiles`, which only matches litestone's
// own generated `<14-digit>_<label>.sql` — a hand-written `001_initial.sql` is a
// real migration a person means to replay, and a template that silently skipped
// it would produce an empty database and a wall of "no such table".
//
// A .js migration is refused rather than skipped: it is handed a client and can
// do anything, and a template is built against a raw connection.

// Litestone's own generated name. Only used to warn — the replay stays loose.
const MIGRATION_FILE  = /^(\d{14})_([a-z0-9_]+)\.sql$/
const warnedUnmatched = new Set()

function migrationFilesFor(migrations, dbName) {
  const entries = Array.isArray(migrations) ? migrations : [migrations]
  const out     = []

  for (const entry of entries) {
    const abs = resolve(entry)
    if (!existsSync(abs)) throw new Error(`createTestEnv: no migrations at ${abs}`)

    if (!statSync(abs).isDirectory()) { out.push(abs); continue }

    // Multi-database schemas keep one subdirectory per database. A schema with
    // one database keeps them flat, so the subdirectory is preferred and the
    // directory itself is the fallback.
    const perDb = join(abs, dbName)
    const from  = existsSync(perDb) && statSync(perDb).isDirectory() ? perDb : abs

    for (const f of readdirSync(from).sort()) {
      if (f.endsWith('.js')) throw new Error(
        `createTestEnv: ${join(from, f)} is a JS migration. Those are handed a Litestone ` +
        `client and cannot be replayed into a template — apply it in the \`data\` hook instead.`
      )
      if (f.endsWith('.sql')) {
        // Replayed here, refused by `migrate apply` — say so once, or the suite
        // is green against a database the deploy will never build (FJS-193).
        if (!MIGRATION_FILE.test(f) && !warnedUnmatched.has(f)) {
          warnedUnmatched.add(f)
          console.warn(
            `createTestEnv: replaying ${f}, which \`litestone migrate apply\` will NOT apply — ` +
            `a migration is named <14-digit timestamp>_<lower_snake_label>.sql. ` +
            `Rename it, or a deploy runs against an empty database.`
          )
        }
        out.push(join(from, f))
      }
    }
  }

  return out
}

function applyMigrations(file, files) {
  const raw = openDatabase(file)
  raw.run('PRAGMA journal_mode = WAL')
  raw.run('PRAGMA foreign_keys = OFF')     // migrations arrive in file order, not dependency order
  for (const path of files)
    for (const stmt of migrationStatements(path)) raw.run(stmt + ';')
  raw.run('PRAGMA foreign_keys = ON')
  raw.run('PRAGMA wal_checkpoint(TRUNCATE)')
  raw.close()
}

function buildTemplate(schema, schemaText, migrations) {
  const dir = join(tmpdir(), `litestone-template-${process.pid}-${templates.size}`)
  mkdirSync(dir, { recursive: true })

  const declared = schema.databases ?? []
  const files    = {}

  // With `migrations`, the template is what the committed files produce, not
  // what the schema would generate. That is the point: every test then runs
  // against the database a deploy actually creates, and the two drifting apart
  // becomes something a test can see.
  const build = (file, dbName, ddl) => migrations
    ? applyMigrations(file, migrationFilesFor(migrations, dbName))
    : applyDDL(file, ddl)

  if (declared.some(d => !d.driver || d.driver === 'sqlite')) {
    for (const d of declared) {
      if (d.driver === 'jsonl' || d.driver === 'trail') continue
      files[d.name] = `${d.name}.db`
      build(join(dir, files[d.name]), d.name, generateDDLForDatabase(schema, d.name))
    }
  } else {
    files.main = 'main.db'
    build(join(dir, files.main), 'main', generateDDL(schema))
  }

  const template = { dir, files }
  templates.set(templateKey(schemaText, migrations), template)
  registerCleanup()
  return template
}

// Two envs share a template only when both the schema and the migration source
// match — a template built from DDL is not the one built from migration files.
//
// The separator is written as an ESCAPE. A literal NUL byte here makes the file
// binary to grep, ripgrep and every tool that skips binary files, so this
// module answered no repo-wide search at all — it was the one place holding a
// `new Database()` that a survey of nine files did not see.
function templateKey(schemaText, migrations) {
  return `${schemaText}\x00${migrations ? JSON.stringify(migrations) : ''}`
}

// ─── cloneInto ───────────────────────────────────────────────────────────────
//
// Lays a fresh, migrated database out in `dir` and answers what to hand
// createClient: the main file's path, and the `databases` overrides that keep a
// declared `database` block from reopening the app's real file.
//
// Returns { path, dbOverrides }.

export function cloneInto(dir, schema, schemaText, migrations = null) {
  const template = templates.get(templateKey(schemaText, migrations))
    ?? buildTemplate(schema, schemaText, migrations)

  const declared    = schema.databases ?? []
  const dbOverrides = {}
  const path        = join(dir, 'test.db')

  for (const d of declared) {
    dbOverrides[d.name] = {
      path: (d.driver === 'jsonl' || d.driver === 'trail')
        ? join(dir, d.name) + '/'
        : (d.name === 'main' ? path : join(dir, `${d.name}.db`)),
    }
  }

  for (const [dbName, file] of Object.entries(template.files)) {
    const dest = declared.length ? dbOverrides[dbName].path : path
    copyFileSync(join(template.dir, file), dest)
    // A checkpointed template leaves no -wal, but a source that was read while
    // another connection held one does. Copy it rather than assume.
    const wal = join(template.dir, `${file}-wal`)
    if (existsSync(wal)) copyFileSync(wal, `${dest}-wal`)
  }

  return { path, dbOverrides }
}

// Test hook: forget every template so the next call rebuilds. Only useful for
// asserting that the cache is doing anything.
export function _resetTemplates() {
  for (const { dir } of templates.values()) rmSync(dir, { recursive: true, force: true })
  templates.clear()
}
