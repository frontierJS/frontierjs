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
  create, apply, appliedMigrations, accept,
} from '../src/core/migrations.js'
import { deriveReleaseSurface, classifyPivot } from '../src/release.js'

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

describe('baseline <file> — a database that is ahead by some files, not all (FJS-4000)', () => {
  // `db push` brought the live database level with file A while file B, written
  // after, has not been applied anywhere. Baselining everything is a lie about
  // B and refuses; applying replays A over its own columns and fails with
  // `duplicate column name`. The claim wanted is "through A".
  const S3 = `
model User {
  id    Int     @id
  email String  @unique
  name  String?
  age   Int?
}
`
  function history() {
    const p  = project(S3)
    const db = p.db()
    create(null, parse(S1), 'init', p.migrations)
    apply(db, p.migrations)
    const a = create(null, parse(S2), 'name', p.migrations)
    const b = create(null, parse(S3), 'age', p.migrations)
    return { p, db, a: a.file ?? a.name, b: b.file ?? b.name }
  }

  it('records the files through the named one and leaves the later ones pending', () => {
    const { p, db } = history()
    const files = (p.migrations && require('node:fs').readdirSync(p.migrations)).sort()
    const [, a, b] = files
    db.run('ALTER TABLE "user" ADD COLUMN "name" TEXT')   // the push of file A

    const r = baseline(db, p.parsed(), p.migrations, { through: a })
    expect(r.ok).toBe(true)
    expect(r.recorded).toEqual([a])

    const applied = apply(db, p.migrations)
    expect(applied.ok ?? true).toBe(true)
    expect(appliedMigrations(db).map((m: any) => m.name)).toEqual([files[0], a, b])
    db.close(); p.cleanup()
  })

  it('records the checksum apply would have', () => {
    const { p, db } = history()
    const files = require('node:fs').readdirSync(p.migrations).sort()
    db.run('ALTER TABLE "user" ADD COLUMN "name" TEXT')
    baseline(db, p.parsed(), p.migrations, { through: files[1] })
    const viaBaseline = appliedMigrations(db).find((m: any) => m.name === files[1]).checksum

    const fresh = new Database(':memory:')
    apply(fresh, p.migrations)
    const viaApply = appliedMigrations(fresh).find((m: any) => m.name === files[1]).checksum
    expect(viaBaseline).toBe(viaApply)
    db.close(); fresh.close(); p.cleanup()
  })

  it('refuses when the database lacks what the named file builds', () => {
    const { p, db } = history()
    const files = require('node:fs').readdirSync(p.migrations).sort()
    const r = baseline(db, p.parsed(), p.migrations, { through: files[1] })   // nothing pushed
    expect(r.ok).toBe(false)
    expect(r.blocked).toBe(true)
    expect(appliedMigrations(db).map((m: any) => m.name)).toEqual([files[0]])
    db.close(); p.cleanup()
  })

  it('names a file that is not in the history, and one already applied', () => {
    const { p, db } = history()
    const files = require('node:fs').readdirSync(p.migrations).sort()
    const missing = baseline(db, p.parsed(), p.migrations, { through: '20990101000000_nope.sql' })
    expect(missing.ok).toBe(false)
    expect(missing.message).toContain('20990101000000_nope.sql')
    const done = baseline(db, p.parsed(), p.migrations, { through: files[0] })
    expect(done.ok).toBe(true)
    expect(done.recorded).toEqual([])
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
      @@label(title)
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

// `FJS-1455`: a fresh clone has the files and no database. That database is
// BEHIND its history, which `migrate dev` must apply, not refuse as drift.
describe('drift against what was APPLIED — a database behind its history', () => {
  it('is clean with pending files, and names them', () => {
    const p  = project(S2)
    const db = p.db()
    create(null, parse(S1), 'init', p.migrations)
    create(null, parse(S2), 'name', p.migrations)
    const drift = driftAgainstLive(db, parse(S2), p.migrations, { appliedOnly: true })
    expect(drift.ok).toBe(true)
    expect(drift.pending).toHaveLength(2)
    db.close(); p.cleanup()
  })

  it('still sees a pushed change past the applied prefix', () => {
    const p  = project(S2)
    const db = p.db()
    create(null, parse(S1), 'init', p.migrations)
    apply(db, p.migrations)
    db.run('ALTER TABLE "user" ADD COLUMN "name" TEXT')
    expect(driftAgainstLive(db, parse(S2), p.migrations, { appliedOnly: true }).ok).toBe(false)
    db.close(); p.cleanup()
  })
})

// ─── An older image on a database it cannot serve (FJS-4110, FJS-D2041) ──────

describe('a recorded migration with no file', () => {
  const journal = (db: Database, name: string) =>
    db.query('SELECT * FROM _litestone_migrations WHERE name = ?').get(name) as any

  function history(header: string) {
    const dir = mkdtempSync(join(tmpdir(), 'ls-orphan-'))
    writeFileSync(join(dir, '20260101000000_first.sql'), 'CREATE TABLE note (id INTEGER PRIMARY KEY, body TEXT);')
    writeFileSync(join(dir, '20260102000000_second.sql'), `${header}ALTER TABLE note DROP COLUMN body;`)
    return dir
  }
  const dropSecond = (dir: string) => rmSync(join(dir, '20260102000000_second.sql'))

  it('refuses at boot when it is a contract, and names the way past', async () => {
    const dir = history('-- Class:     contract\n')
    const db  = new Database(':memory:')
    expect((await apply(db, dir)).failed).toBeUndefined()
    expect(journal(db, '20260102000000_second.sql').class).toBe('contract')

    dropSecond(dir)
    const out = await apply(db, dir)
    expect(out.refused).toBe(true)
    expect(out.failed).toBe('20260102000000_second.sql')
    expect(out.message).toContain('litestone migrate accept 20260102000000_second.sql')
  })

  it('refuses one with no class, which reads as unknown', async () => {
    const dir = history('')
    const db  = new Database(':memory:')
    await apply(db, dir)
    expect(journal(db, '20260102000000_second.sql').class).toBeNull()
    dropSecond(dir)
    expect((await apply(db, dir)).refused).toBe(true)
  })

  it('lets an expand through: the older release still serves it', async () => {
    const dir = history('-- Class:     expand\n')
    const db  = new Database(':memory:')
    await apply(db, dir)
    dropSecond(dir)
    const out = await apply(db, dir)
    expect(out.refused).toBeUndefined()
    expect(out.pending).toBe(0)
  })

  it('accept lets the boot through, keeps the class, and clears when the file comes back', async () => {
    const dir = history('-- Class:     contract\n')
    const db  = new Database(':memory:')
    await apply(db, dir)
    const file = join(dir, '20260102000000_second.sql')
    const text = readFileSync(file, 'utf8')

    expect(accept(db, '20260102000000_second.sql', dir).ok).toBe(false)   // the file is present
    expect(accept(db, '20260109000000_absent.sql', dir).ok).toBe(false)   // no such row

    dropSecond(dir)
    expect(accept(db, '20260102000000_second.sql', dir).ok).toBe(true)
    expect(journal(db, '20260102000000_second.sql').class).toBe('contract')
    expect((await apply(db, dir)).refused).toBeUndefined()

    writeFileSync(file, text)
    await apply(db, dir)
    expect(journal(db, '20260102000000_second.sql').accepted_at).toBeNull()
    dropSecond(dir)
    expect((await apply(db, dir)).refused).toBe(true)
  })

  it('gives a journal written before the class existed its columns, NULL reading as unknown', async () => {
    const dir = history('')
    const db  = new Database(':memory:')
    db.run('CREATE TABLE _litestone_migrations (id INTEGER PRIMARY KEY, name TEXT NOT NULL UNIQUE, applied_at TEXT NOT NULL, checksum TEXT NOT NULL)')
    db.run(`INSERT INTO _litestone_migrations (name, applied_at, checksum) VALUES ('20251231000000_gone.sql', 'then', 'x')`)
    const out = await apply(db, dir)
    expect(out.refused).toBe(true)
    expect(out.failed).toBe('20251231000000_gone.sql')
  })
})

// The class is stamped when the file is authored and graded in classifyPivot's
// words, so the two answers are held together here.
describe('the class a migration is stamped with', () => {
  const before = 'model Note {\n  id Int @id\n  body String?\n  size Int @default(1)\n}\n'
  const cases: [string, string, string][] = [
    ['an optional column added',          'model Note {\n  id Int @id\n  body String?\n  size Int @default(1)\n  extra String?\n}\n', 'expand'],
    ['a defaulted column added',          'model Note {\n  id Int @id\n  body String?\n  size Int @default(1)\n  extra Int @default(0)\n}\n', 'expand'],
    ['a model added',                     before + 'model Tag {\n  id Int @id\n}\n', 'expand'],
    ['a required column added',           'model Note {\n  id Int @id\n  body String?\n  size Int @default(1)\n  extra String\n}\n', 'contract'],
    ['a column removed',                  'model Note {\n  id Int @id\n  size Int @default(1)\n}\n', 'contract'],
    ['a model removed',                   'model Other {\n  id Int @id\n}\n', 'contract'],
    ['a type changed',                    'model Note {\n  id Int @id\n  body Int?\n  size Int @default(1)\n}\n', 'contract'],
    ['an optional column made required',  'model Note {\n  id Int @id\n  body String\n  size Int @default(1)\n}\n', 'contract'],
  ]

  for (const [name, after, grade] of cases) {
    it(`${name} is ${grade}, as classifyPivot says`, () => {
      const dir = mkdtempSync(join(tmpdir(), 'ls-class-'))
      const db  = new Database(':memory:')
      create(db, parse(before), 'first', dir)
      const made = create(db, parse(after), 'second', dir) as any
      expect(made.created).toBe(true)
      expect(readFileSync(made.filePath, 'utf8')).toMatch(new RegExp(`^-- Class: +${grade}$`, 'm'))
      expect(classifyPivot(deriveReleaseSurface(parse(before).schema), deriveReleaseSurface(parse(after).schema)).verdict).toBe(grade)
    })
  }
})
