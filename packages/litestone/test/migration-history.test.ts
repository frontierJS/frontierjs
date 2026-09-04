// The migration history as a first-class thing to compare against — `FJS-D123`.
//
// The defect this closes (`FJS-345`, `FJS-388`): the development workflow wrote
// tables and the deploy workflow applied files, and nothing joined them. `db
// push` writes tables and no file; the container runs `migrate apply`, which
// runs files. A model added through push was in the developer's database and in
// no file, so the image was missing it.
//
// The root was that ONE comparison did two jobs. `create()` diffed the schema
// against the LIVE database, which a pushed database already matches — so
// `migrate create` answered *already in sync* exactly when a migration was most
// needed, and the deploy's refusal pointed at the command that had just
// declined to write one. A closed loop with no way out from inside the tool.
//
// So there is a SHADOW — the files replayed into memory — and two comparisons:
//
//   schema <-> shadow   what migration is missing   (create, the deploy guard)
//   shadow <-> live     has somebody changed the db (drift, baseline)
//
// The suite holds both, and the thing that must never come back: a deploy that
// reports success over a database the app cannot use.

import { describe, it, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { Database } from 'bun:sqlite'
import { parse } from '../src/core/parser.js'
import { generateDDL } from '../src/core/ddl.js'
import { splitStatements } from '../src/core/migrate.js'
import {
  buildShadow, historyGap, driftAgainstLive, baseline,
  create, apply, appliedMigrations,
} from '../src/core/migrations.js'

const S1 = `
model User {
  id    Int    @id
  email String @unique
}
`
const S2 = `
model User {
  id    Int     @id
  email String  @unique
  name  String?
}
`

function project(schemaSrc: string) {
  const dir = mkdtempSync(join(tmpdir(), 'ls-hist-'))
  const migrations = join(dir, 'migrations')
  mkdirSync(migrations, { recursive: true })
  return {
    dir,
    migrations,
    parsed: (src = schemaSrc) => parse(src),
    db: () => new Database(join(dir, 'app.db')),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  }
}

// `db push` in one line — build the declared schema straight into a database,
// writing no migration file. What every generator tells a developer to run.
function push(db: any, src: string) {
  for (const stmt of splitStatements(generateDDL(parse(src).schema)))
    if (!stmt.startsWith('PRAGMA')) db.run(stmt + ';')
}

describe('the shadow — what the FILES build', () => {
  it('is empty for a directory with no migrations', () => {
    const p = project(S1)
    const shadow = buildShadow(p.migrations)
    expect(shadow.ok).toBe(true)
    expect(Object.keys(shadow.schema).filter(k => !k.startsWith('__'))).toEqual([])
    p.cleanup()
  })

  it('is built by replaying the files, not by reading the schema', () => {
    const p = project(S1)
    create(null, p.parsed(), 'init', p.migrations)
    const shadow = buildShadow(p.migrations)
    expect(shadow.ok).toBe(true)
    expect(shadow.schema.user).toBeDefined()
    expect(shadow.schema.user.columns.map((c: any) => c.name)).toEqual(['id', 'email'])
    p.cleanup()
  })

  it('refuses to answer for a history holding a JS migration', () => {
    // A JS migration runs against a Litestone client and can change the schema
    // through sys.sql, so replaying only the SQL would answer a confident diff
    // over a shadow missing part of its history — the silent wrongness this
    // ruling removes. `unknown` is a third answer, not a flavor of `ok`.
    const p = project(S1)
    create(null, p.parsed(), 'init', p.migrations)
    writeFileSync(join(p.migrations, '20990101000000_data_fix.js'), 'export function up() {}', 'utf8')
    const shadow = buildShadow(p.migrations)
    expect(shadow.ok).toBe(false)
    expect(shadow.reason).toBe('js-migrations')
    expect(shadow.files).toEqual(['20990101000000_data_fix.js'])
    p.cleanup()
  })
})

describe('migrate create diffs against the HISTORY, not the live database', () => {
  it('writes the delta a pushed database hides — the closed loop of FJS-388', () => {
    const p  = project(S2)
    const db = p.db()
    // History at S1, applied.
    create(null, parse(S1), 'init', p.migrations)
    apply(db, p.migrations)
    // Developer pushes a column. It is in their database and in no file.
    db.run('ALTER TABLE "user" ADD COLUMN "name" TEXT')

    // The old comparison answered "already in sync" here, because the live
    // database matched the schema. The history did not.
    const r = create(db, parse(S2), 'addname', p.migrations)
    expect(r.created).toBe(true)
    expect(r.summary).toContain('name')
    db.close(); p.cleanup()
  })

  it('writes nothing when the history already builds the schema', () => {
    const p = project(S1)
    create(null, p.parsed(), 'init', p.migrations)
    const again = create(null, p.parsed(), 'again', p.migrations)
    expect(again.created).toBe(false)
    expect(readdirSync(p.migrations).length).toBe(1)
    p.cleanup()
  })

  it('needs no database at all', () => {
    // Which is what lets the identical question be asked before an image is
    // built, by `fli deploy:doctor` and by CI.
    const p = project(S1)
    const r = create(null, p.parsed(), 'init', p.migrations)
    expect(r.created).toBe(true)
    p.cleanup()
  })
})

describe('the deploy guard is schema-granular', () => {
  it('catches a missing COLUMN, which the table-name check passed', () => {
    // Measured before the fix: history at User{id,email}, a pushed `name`
    // column, and apply answered `1 migration applied`, exit 0, over a table
    // with no `name`. A column add is the common change after week one.
    const p = project(S2)
    create(null, parse(S1), 'init', p.migrations)
    const gap = historyGap(parse(S2), p.migrations)
    expect(gap.ok).toBe(false)
    expect(gap.pending).toBe(true)
    expect(gap.summary).toContain('name')
    p.cleanup()
  })

  it('catches a missing TABLE', () => {
    const p = project(S1)
    const gap = historyGap(parse(S1), p.migrations)
    expect(gap.ok).toBe(false)
    p.cleanup()
  })

  it('passes when the history builds the schema', () => {
    const p = project(S1)
    create(null, p.parsed(), 'init', p.migrations)
    expect(historyGap(p.parsed(), p.migrations).ok).toBe(true)
    p.cleanup()
  })

  it('answers `unknown` rather than ok or not-ok when it cannot tell', () => {
    const p = project(S1)
    create(null, p.parsed(), 'init', p.migrations)
    writeFileSync(join(p.migrations, '20990101000000_data_fix.js'), 'export function up() {}', 'utf8')
    const gap = historyGap(p.parsed(), p.migrations)
    expect(gap.unknown).toBe(true)
    expect(gap.ok).toBeUndefined()
    p.cleanup()
  })
})

describe('drift — shadow against the live database', () => {
  it('sees a pushed change that no file describes', () => {
    const p  = project(S2)
    const db = p.db()
    create(null, parse(S1), 'init', p.migrations)
    apply(db, p.migrations)
    db.run('ALTER TABLE "user" ADD COLUMN "name" TEXT')
    const drift = driftAgainstLive(db, parse(S2), p.migrations)
    expect(drift.ok).toBe(false)
    expect(drift.drifted).toBe(true)
    db.close(); p.cleanup()
  })

  it('is clean for a database built by applying the history', () => {
    const p  = project(S1)
    const db = p.db()
    create(null, p.parsed(), 'init', p.migrations)
    apply(db, p.migrations)
    expect(driftAgainstLive(db, p.parsed(), p.migrations).ok).toBe(true)
    db.close(); p.cleanup()
  })
})

describe('baseline — record as applied without running', () => {
  it('records a history a pushed database already satisfies', async () => {
    // The population this exists for: an app developed entirely through
    // `db push`, holding a correct database and no history to say so.
    const p  = project(S1)
    const db = p.db()
    push(db, S1)
    create(null, p.parsed(), 'catchup', p.migrations)

    const r = baseline(db, p.parsed(), p.migrations)
    expect(r.ok).toBe(true)
    expect(r.recorded.length).toBe(1)
    expect(appliedMigrations(db).map((m: any) => m.name)).toEqual(r.recorded)
    db.close(); p.cleanup()
  })

  it('refuses to record a lie', async () => {
    // One wrong baseline is a database reporting a complete history and
    // missing a column — the exact failure this ruling exists to make
    // impossible, so the claim is checked before it is written.
    const p  = project(S1)
    const db = p.db()
    create(null, p.parsed(), 'init', p.migrations)   // database still empty

    const r = baseline(db, p.parsed(), p.migrations)
    expect(r.ok).toBe(false)
    expect(r.blocked).toBe(true)
    expect(appliedMigrations(db).length).toBe(0)
    db.close(); p.cleanup()
  })

  it('runs nothing — a baselined migration leaves the data alone', async () => {
    const p  = project(S1)
    const db = p.db()
    push(db, S1)
    db.run(`INSERT INTO "user" ("id","email") VALUES (1,'a@b.c')`)
    create(null, p.parsed(), 'catchup', p.migrations)
    baseline(db, p.parsed(), p.migrations)
    expect(db.query('SELECT COUNT(*) AS n FROM "user"').get().n).toBe(1)
    db.close(); p.cleanup()
  })

  it('is a no-op when everything is already recorded', async () => {
    const p  = project(S1)
    const db = p.db()
    create(null, p.parsed(), 'init', p.migrations)
    apply(db, p.migrations)
    const r = baseline(db, p.parsed(), p.migrations)
    expect(r.ok).toBe(true)
    expect(r.recorded).toEqual([])
    db.close(); p.cleanup()
  })
})

describe('a generated migration builds what the schema builds', () => {
  // `generateMigrationSQL`'s new-table branch emitted the table plus
  // `generateIndexDDL(model, false, …)`, and the explicit `false` defeated that
  // function's own `softDelete ?? isSoftDelete(model)`. So a migration built a
  // @@softDelete model with no `deletedAt` index and no partial clause on the
  // others, and a @@fts model with no FTS table and no triggers — a deployed
  // app searching a table that does not exist. The history/schema comparison is
  // what made it visible; nothing else compared the two.
  const RICH = `
    model Doc {
      id        Int       @id
      title     String
      body      String
      updatedAt DateTime  @updatedAt
      deletedAt DateTime?
      @@softDelete
      @@index([title])
      @@fts([title, body])
    }
  `

  it('emits the FTS table and the soft-delete index, and no stamp trigger', () => {
    const p = project(RICH)
    create(null, parse(RICH), 'init', p.migrations)
    const sql = readFileSync(join(p.migrations, readdirSync(p.migrations)[0]), 'utf8')

    expect(sql).toContain('"doc_fts"')
    expect(sql).toContain('doc_fts_insert')
    expect(sql).toContain('"idx_doc_deletedAt"')
    expect(sql).toContain('WHERE "deletedAt" IS NULL')
    // `FJS-531` — the client stamps `@updatedAt`, so a migration writes no
    // trigger for it and an existing one is dropped rather than restated.
    expect(sql).not.toContain('"doc_updatedAt"')
    p.cleanup()
  })

  it('leaves no gap between the history and the schema it came from', () => {
    const p = project(RICH)
    create(null, parse(RICH), 'init', p.migrations)
    expect(historyGap(parse(RICH), p.migrations).ok).toBe(true)
    p.cleanup()
  })

  it('builds a database a push would build', () => {
    const p       = project(RICH)
    const applied = p.db()
    create(null, parse(RICH), 'init', p.migrations)
    apply(applied, p.migrations)

    const pushed = new Database(':memory:')
    push(pushed, RICH)

    const names = (d: any) => d.query(
      `SELECT name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' AND name NOT LIKE '_litestone%' ORDER BY name`
    ).all().map((r: any) => r.name)

    expect(names(applied)).toEqual(names(pushed))
    applied.close(); pushed.close(); p.cleanup()
  })
})
