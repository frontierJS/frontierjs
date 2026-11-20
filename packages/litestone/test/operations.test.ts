// A rename reaches the database as a RENAME, not a drop plus an add (`FJS-D603`).
//
// The diff is a name-set diff, so `title` leaving and `heading` arriving is two
// unrelated events and the rebuild that follows copies only the columns the two
// tables share. The values went with the old name — 3 of 3 in the measurement
// that raised this. The operation is stated when the migration is CREATED, and
// every test below reads the VALUES after apply, because a clean compile of the
// file proves nothing about what the rows kept.

import { describe, it, expect } from 'bun:test'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from 'fs'
import { join, resolve } from 'path'
import { tmpdir } from 'os'
import { Database } from 'bun:sqlite'
import { parse } from '../src/core/parser.js'
import { create, apply, renameCandidates, listMigrationFiles, migrationStatements } from '../src/core/migrations.js'
import {
  parseRenameFlag, readOperations, resolveOperations, askRenames,
} from '../src/core/operations.js'

const CLI = resolve(import.meta.dir, '..', 'src', 'tools', 'cli.js')

const V1 = `model Post { id Int @id  title String  views Int @default(0) }`
const V2 = `model Post { id Int @id  heading String  views Int @default(0) }`
const RENAME = { op: 'rename', model: 'Post', from: 'title', to: 'heading' }

function lab() {
  const dir = mkdtempSync(join(tmpdir(), 'ls-ops-'))
  mkdirSync(join(dir, 'migrations'))
  return { dir, migrations: join(dir, 'migrations'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

/** The schema V1 built and applied, with `rows` in it. */
async function populated(src = V1, rows = 3) {
  const l = lab()
  const db = new Database(':memory:')
  create(db, parse(src), 'init', l.migrations)
  await apply(db, l.migrations)
  for (let i = 1; i <= rows; i++) db.run(`INSERT INTO post (title, views) VALUES ('t${i}', ${i * 10})`)
  return { ...l, db }
}

const latest = (dir: string) => readFileSync(join(dir, listMigrationFiles(dir).at(-1)!), 'utf8')

describe('rename — the values stay', () => {
  it('writes ALTER TABLE … RENAME COLUMN, no rebuild and no loss box, and the rows keep their values', async () => {
    const p = await populated()
    const r = create(p.db, parse(V2), 'rename', p.migrations, { operations: [RENAME] })
    expect(r.created).toBe(true)
    expect(r.loss).toEqual([])
    expect(r.operations).toHaveLength(1)

    const sql = latest(p.migrations)
    expect(sql).toContain('ALTER TABLE "post" RENAME COLUMN "title" TO "heading";')
    expect(sql).not.toContain('DESTRUCTIVE')
    expect(sql).not.toContain('post__new')
    expect(sql).toContain('-- Operations:')
    expect(sql).toContain('rename Post.title → heading')

    const res = await apply(p.db, p.migrations)
    expect(res.applied.at(-1)!.ok).toBe(true)
    expect(p.db.query('SELECT id, heading, views FROM post ORDER BY id').all()).toEqual([
      { id: 1, heading: 't1', views: 10 },
      { id: 2, heading: 't2', views: 20 },
      { id: 3, heading: 't3', views: 30 },
    ])

    // The history now builds the schema: nothing more to write.
    expect(create(p.db, parse(V2), 'again', p.migrations).created).toBe(false)
    p.cleanup()
  })

  it('without the operation the same edit still deletes the values — the box is what stops it', async () => {
    const p = await populated()
    const r = create(p.db, parse(V2), 'rename', p.migrations)
    expect(r.loss).toEqual([{ table: 'post', columns: ['title'], renameTo: 'heading' }])
    expect(latest(p.migrations)).toContain('--rename Post.title=heading')
    p.cleanup()
  })

  it('carries the values through a rebuild another change forces', async () => {
    const p = await populated()
    // A default changing is a rebuild; the rename has to have happened before it.
    const V3 = `model Post { id Int @id  heading String  views Int @default(5)  note String? }`
    const r = create(p.db, parse(V3), 'rename+', p.migrations, { operations: [RENAME] })
    expect(r.created).toBe(true)
    const sql = latest(p.migrations)
    expect(sql.indexOf('RENAME COLUMN')).toBeLessThan(sql.indexOf('post__new'))
    expect(sql).not.toContain('DESTRUCTIVE')

    await apply(p.db, p.migrations)
    expect(p.db.query('SELECT heading, views FROM post ORDER BY id').all()).toEqual([
      { heading: 't1', views: 10 }, { heading: 't2', views: 20 }, { heading: 't3', views: 30 },
    ])
    p.cleanup()
  })

  it('moves an index on the column with it', async () => {
    const p = await populated(`model Post { id Int @id  title String  views Int @default(0)  @@index([title]) }`)
    const r = create(p.db, parse(`model Post { id Int @id  heading String  views Int @default(0)  @@index([heading]) }`), 'r', p.migrations, { operations: [RENAME] })
    expect(r.created).toBe(true)
    await apply(p.db, p.migrations)
    const idx = p.db.query(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='post' AND sql LIKE '%heading%'`).all()
    expect(idx.length).toBe(1)
    expect(create(p.db, parse(`model Post { id Int @id  heading String  views Int @default(0)  @@index([heading]) }`), 'again', p.migrations).created).toBe(false)
    p.cleanup()
  })

  it('names the COLUMN a mapped field sits in', async () => {
    const p = await populated()
    const r = create(p.db, parse(`model Post { id Int @id  heading String @map("head_col")  views Int @default(0) }`), 'r', p.migrations, { operations: [RENAME] })
    expect(r.created).toBe(true)
    expect(latest(p.migrations)).toContain('RENAME COLUMN "title" TO "head_col"')
    await apply(p.db, p.migrations)
    expect(p.db.query('SELECT head_col FROM post ORDER BY id').all().map((x: any) => x.head_col)).toEqual(['t1', 't2', 't3'])
    p.cleanup()
  })

  it('a rename alone, with nothing else changed, still writes a file', async () => {
    const p = await populated()
    const r = create(p.db, parse(V2), 'only', p.migrations, { operations: [RENAME] })
    expect(r.created).toBe(true)
    expect(r.summary).toContain('rename Post.title → heading')
    p.cleanup()
  })
})

describe('rename — refused by name before a file is written', () => {
  const refuse = async (op: any, src = V2) => {
    const p = await populated()
    const before = listMigrationFiles(p.migrations).length
    const r = create(p.db, parse(src), 'x', p.migrations, { operations: [op] })
    expect(listMigrationFiles(p.migrations).length).toBe(before)
    p.cleanup()
    return r
  }

  it('a model the schema does not declare', async () => {
    const r = await refuse({ ...RENAME, model: 'Nope' })
    expect(r.blocked).toBe(true)
    expect(r.message).toContain('no model Nope')
  })

  it('a new name no field holds', async () => {
    const r = await refuse({ ...RENAME, to: 'nothing' })
    expect(r.message).toContain('declares no stored field `nothing`')
  })

  it('an old name the schema still declares — that would be a second column', async () => {
    const r = await refuse(RENAME, `model Post { id Int @id  title String  heading String  views Int @default(0) }`)
    expect(r.message).toContain('still declares `title`')
  })

  it('an old name the history does not have', async () => {
    const r = await refuse({ ...RENAME, from: 'ghost' })
    expect(r.message).toContain('no column post.ghost')
  })

  it('an operation litestone does not write', async () => {
    const r = await refuse({ op: 'split', model: 'Post', from: 'title', to: 'heading' })
    expect(r.message).toContain("'split' is not an operation litestone writes. It writes: rename, backfill")
  })

  it('a column named by two operations', () => {
    const r = resolveOperations(parse(V2), 'main', [RENAME, { ...RENAME, from: 'name' }])
    expect(r.ok).toBe(false)
    expect((r as any).message).toContain('named by two operations')
  })

  it('a name that is not an identifier never reaches SQL', () => {
    const r = resolveOperations(parse(V2), 'main', [{ ...RENAME, from: 'title" TO "x"; DROP TABLE post; --' }])
    expect(r.ok).toBe(false)
  })
})

describe('the flag and the document', () => {
  it('--rename is Model.oldColumn=newField', () => {
    expect(parseRenameFlag('Issue.description=brief')).toEqual({ op: 'rename', model: 'Issue', from: 'description', to: 'brief' })
    expect(() => parseRenameFlag('description=brief')).toThrow('Model.oldColumn=newField')
    expect(() => parseRenameFlag('Issue.description>brief')).toThrow('Model.oldColumn=newField')
  })

  it('the document is { operations: [...] } and refuses an unknown op by position', () => {
    expect(readOperations({ operations: [RENAME] })).toEqual([RENAME])
    expect(() => readOperations([RENAME])).toThrow('{ "operations"')
    expect(() => readOperations({ operations: [RENAME, { op: 'split' }] })).toThrow("operations[1]: 'split'")
  })
})

describe('the prompt', () => {
  it('guesses one dropped and one arrived column of the same type, and no more', async () => {
    const p = await populated()
    expect(renameCandidates(parse(V2), p.migrations)).toEqual([
      { model: 'Post', table: 'post', from: 'title', to: 'heading', field: 'heading', type: 'TEXT' },
    ])
    // Two strings out, two in: which is which is not a guess.
    expect(renameCandidates(parse(`model Post { id Int @id  a String  b String  views Int @default(0) }`), p.migrations)).toEqual([])
    // A different type is not the same column.
    expect(renameCandidates(parse(`model Post { id Int @id  heading Int  views Int @default(0) }`), p.migrations)).toEqual([])
    p.cleanup()
  })

  it('a yes becomes a rename operation and a no (or nothing) leaves the box', async () => {
    const p = await populated()
    const guesses = renameCandidates(parse(V2), p.migrations)
    expect(await askRenames(guesses, async () => 'y')).toEqual([RENAME])
    expect(await askRenames(guesses, async () => 'yes')).toEqual([RENAME])
    expect(await askRenames(guesses, async () => '')).toEqual([])
    expect(await askRenames(guesses, async () => 'n')).toEqual([])
    p.cleanup()
  })

  it('does not ask again about a column an operation already settled', async () => {
    const p = await populated()
    expect(renameCandidates(parse(V2), p.migrations, { operations: [RENAME] })).toEqual([])
    p.cleanup()
  })
})

// ─── the CLI ──────────────────────────────────────────────────────────────────

function project() {
  const dir = mkdtempSync(join(tmpdir(), 'ls-ops-cli-'))
  mkdirSync(join(dir, 'migrations'))
  writeFileSync(join(dir, 'litestone.config.js'), `export default { schema: './schema.lite', migrations: './migrations', db: './t.db' }\n`)
  const schema = (src: string) => writeFileSync(join(dir, 'schema.lite'), src + '\n')
  const cli = (args: string[]) => {
    const r = Bun.spawnSync(['bun', CLI, ...args], { cwd: dir, stdin: 'ignore' })
    return { out: r.stdout.toString() + r.stderr.toString(), exit: r.exitCode }
  }
  const rows = () => {
    const db = new Database(join(dir, 't.db'))
    try { return db.query('SELECT * FROM post ORDER BY id').all() } finally { db.close() }
  }
  const seed = () => {
    schema(V1)
    expect(cli(['migrate', 'create', 'init']).exit).toBe(0)
    expect(cli(['migrate', 'apply']).exit).toBe(0)
    const db = new Database(join(dir, 't.db'))
    for (let i = 1; i <= 3; i++) db.run(`INSERT INTO post (title, views) VALUES ('t${i}', ${i})`)
    db.close()
    schema(V2)
  }
  return { dir, schema, cli, rows, seed, migrations: join(dir, 'migrations'), cleanup: () => rmSync(dir, { recursive: true, force: true }) }
}

describe('migrate create — the CLI', () => {
  it('--rename Model.old=new writes the rename and apply keeps the values', () => {
    const p = project()
    p.seed()
    const made = p.cli(['migrate', 'create', 'rename', '--rename', 'Post.title=heading'])
    expect(made.exit).toBe(0)
    expect(latest(p.migrations)).toContain('RENAME COLUMN "title" TO "heading"')
    expect(p.cli(['migrate', 'apply']).exit).toBe(0)
    expect(p.rows()).toEqual([
      { id: 1, heading: 't1', views: 1 }, { id: 2, heading: 't2', views: 2 }, { id: 3, heading: 't3', views: 3 },
    ])
    p.cleanup()
  })

  it('--rename=Model.old=new is the same flag', () => {
    const p = project()
    p.seed()
    expect(p.cli(['migrate', 'create', 'rename', '--rename=Post.title=heading']).exit).toBe(0)
    expect(latest(p.migrations)).toContain('RENAME COLUMN')
    p.cleanup()
  })

  it('--operations reads the document an author wrote', () => {
    const p = project()
    p.seed()
    writeFileSync(join(p.dir, 'ops.json'), JSON.stringify({ operations: [RENAME] }))
    expect(p.cli(['migrate', 'create', 'rename', '--operations', 'ops.json']).exit).toBe(0)
    expect(p.cli(['migrate', 'apply']).exit).toBe(0)
    expect(p.rows().map((r: any) => r.heading)).toEqual(['t1', 't2', 't3'])
    p.cleanup()
  })

  it('migrate dev takes the flag too, and creates and applies in one call', () => {
    const p = project()
    p.seed()
    const r = p.cli(['migrate', 'dev', 'rename', '--rename', 'Post.title=heading'])
    expect(r.exit).toBe(0)
    expect(p.rows().map((x: any) => x.heading)).toEqual(['t1', 't2', 't3'])
    p.cleanup()
  })

  it('a malformed flag stops the run and writes nothing', () => {
    const p = project()
    p.seed()
    const before = readdirSync(p.migrations).length
    const r = p.cli(['migrate', 'create', 'rename', '--rename', 'title=heading'])
    expect(r.exit).not.toBe(0)
    expect(r.out).toContain('Model.oldColumn=newField')
    expect(readdirSync(p.migrations).length).toBe(before)
    p.cleanup()
  })

  it('a refused operation exits nonzero with the reason', () => {
    const p = project()
    p.seed()
    const r = p.cli(['migrate', 'create', 'rename', '--rename', 'Post.ghost=heading'])
    expect(r.exit).not.toBe(0)
    expect(r.out).toContain('no column post.ghost')
    p.cleanup()
  })

  it('with no terminal and no flag it asks nothing and leaves the box', () => {
    const p = project()
    p.seed()
    expect(p.cli(['migrate', 'create', 'rename']).exit).toBe(0)
    expect(latest(p.migrations)).toContain('DESTRUCTIVE')
    expect(p.cli(['migrate', 'apply']).exit).not.toBe(0)
    p.cleanup()
  })

  // A pseudo-terminal, because the prompt is for a person and is silent without one.
  const typed = async (p: ReturnType<typeof project>, answer: string) => {
    let out = ''
    let sent = false
    const proc = Bun.spawn(['bun', CLI, 'migrate', 'create', 'rename'], {
      cwd: p.dir,
      terminal: { cols: 120, rows: 30, data(t: any, d: Uint8Array) {
        out += new TextDecoder().decode(d)
        if (!sent && /\[y\/N\]/.test(out)) { sent = true; t.write(answer + '\n') }
      } },
    })
    await proc.exited
    return { out, asked: sent }
  }

  it('on a terminal it asks, and a yes writes the rename', async () => {
    const p = project()
    p.seed()
    const r = await typed(p, 'y')
    expect(r.asked).toBe(true)
    expect(r.out).toContain('Post.title is gone and heading (TEXT) is new')
    expect(latest(p.migrations)).toContain('RENAME COLUMN "title" TO "heading"')
    expect(p.cli(['migrate', 'apply']).exit).toBe(0)
    expect(p.rows().map((x: any) => x.heading)).toEqual(['t1', 't2', 't3'])
    p.cleanup()
  })

  it('on a terminal a no leaves the box, and apply refuses the file', async () => {
    const p = project()
    p.seed()
    const r = await typed(p, 'n')
    expect(r.asked).toBe(true)
    expect(latest(p.migrations)).toContain('DESTRUCTIVE')
    expect(p.cli(['migrate', 'apply']).exit).not.toBe(0)
    p.cleanup()
  })
})

describe('the file replays', () => {
  it('a created rename is plain statements a fresh database replays to the same schema', async () => {
    const p = await populated()
    create(p.db, parse(V2), 'rename', p.migrations, { operations: [RENAME] })
    const fresh = new Database(':memory:')
    for (const f of listMigrationFiles(p.migrations))
      for (const stmt of migrationStatements(join(p.migrations, f))) fresh.run(stmt + ';')
    expect(fresh.query(`PRAGMA table_info(post)`).all().map((c: any) => c.name)).toEqual(['id', 'heading', 'views'])
    p.cleanup()
  })
})

// A new required column has no value for the rows already there: a rebuild's
// copy names only the columns the old table shares, and the file is written
// BLOCKED (`FJS-D428`). A backfill is the value (`FJS-D683`), and every test
// reads the rows after apply.
describe('backfill — the rows already there take a value', () => {
  const COMPANY = `model Company { id Int @id  name String }`
  const JOB_V1 = `${COMPANY}\nmodel Job { id Int @id  title String }`
  const JOB_V2 = `${COMPANY}\nmodel Job { id Int @id  title String  companyId Int  company Company @relation(fields: [companyId], references: [id]) }`
  const JOB_STATUS = `${COMPANY}\nmodel Job { id Int @id  title String  status String }`

  async function jobs(companies: string[] = ['Acme', 'Globex']) {
    const l = lab()
    const db = new Database(':memory:')
    create(db, parse(JOB_V1), 'init', l.migrations)
    await apply(db, l.migrations)
    for (const c of companies) db.run(`INSERT INTO company (name) VALUES ('${c}')`)
    for (let i = 1; i <= 3; i++) db.run(`INSERT INTO job (title) VALUES ('j${i}')`)
    return { ...l, db }
  }

  it('without one, the required link is written BLOCKED and apply refuses it', async () => {
    const p = await jobs()
    create(p.db, parse(JOB_V2), 'link', p.migrations)
    expect(latest(p.migrations)).toContain('rebuild BLOCKED')
    const res = await apply(p.db, p.migrations)
    expect(res.refused).toBe(true)
    p.cleanup()
  })

  it('`first` links every existing row to the first parent row, through the rebuild', async () => {
    const p = await jobs()
    const op = { op: 'backfill', model: 'Job', field: 'companyId', first: 'Company' }
    const r = create(p.db, parse(JOB_V2), 'link', p.migrations, { operations: [op] })
    expect(r.created).toBe(true)
    const sql = latest(p.migrations)
    expect(sql).not.toContain('BLOCKED')
    expect(sql).toContain('backfill Job.companyId ← the first Company row')
    expect(sql).toContain('(SELECT "id" FROM "company" ORDER BY rowid LIMIT 1)')

    const res = await apply(p.db, p.migrations)
    expect(res.applied.at(-1)!.ok).toBe(true)
    expect(p.db.query('SELECT id, title, companyId FROM job ORDER BY id').all()).toEqual([
      { id: 1, title: 'j1', companyId: 1 }, { id: 2, title: 'j2', companyId: 1 }, { id: 3, title: 'j3', companyId: 1 },
    ])
    expect(create(p.db, parse(JOB_V2), 'again', p.migrations).created).toBe(false)
    p.cleanup()
  })

  it('`first` skips a trashed parent row', async () => {
    const SOFT = `model Company { id Int @id  name String  deletedAt DateTime?  @@softDelete }`
    const l = lab()
    const db = new Database(':memory:')
    create(db, parse(`${SOFT}\nmodel Job { id Int @id  title String }`), 'init', l.migrations)
    await apply(db, l.migrations)
    db.run(`INSERT INTO company (name, deletedAt) VALUES ('Gone', '2026-01-01T00:00:00.000Z')`)
    db.run(`INSERT INTO company (name) VALUES ('Live')`)
    for (let i = 1; i <= 3; i++) db.run(`INSERT INTO job (title) VALUES ('j${i}')`)
    const op = { op: 'backfill', model: 'Job', field: 'companyId', first: 'Company' }
    create(db, parse(`${SOFT}\nmodel Job { id Int @id  title String  companyId Int  company Company @relation(fields: [companyId], references: [id]) }`), 'link', l.migrations, { operations: [op] })
    expect((await apply(db, l.migrations)).applied.at(-1)!.ok).toBe(true)
    expect(db.query('SELECT DISTINCT companyId FROM job').all()).toEqual([{ companyId: 2 }])
    l.cleanup()
  })

  it('`value` gives every existing row the constant', async () => {
    const p = await jobs()
    const op = { op: 'backfill', model: 'Job', field: 'companyId', value: 2 }
    expect(create(p.db, parse(JOB_V2), 'link', p.migrations, { operations: [op] }).created).toBe(true)
    expect(latest(p.migrations)).toContain('backfill Job.companyId ← 2')
    await apply(p.db, p.migrations)
    expect(p.db.query('SELECT companyId FROM job ORDER BY id').all()).toEqual([{ companyId: 2 }, { companyId: 2 }, { companyId: 2 }])
    p.cleanup()
  })

  it('a column ADD COLUMN cannot take becomes the rebuild that copies the value in', async () => {
    const p = await jobs()
    const op = { op: 'backfill', model: 'Job', field: 'status', value: "it's open" }
    expect(create(p.db, parse(JOB_STATUS), 'status', p.migrations, { operations: [op] }).created).toBe(true)
    const sql = latest(p.migrations)
    expect(sql).not.toContain('BLOCKED')
    expect(sql).toContain(`'it''s open'`)
    expect((await apply(p.db, p.migrations)).applied.at(-1)!.ok).toBe(true)
    expect(p.db.query('SELECT status FROM job').all().map((r: any) => r.status)).toEqual(["it's open", "it's open", "it's open"])
    expect(p.db.query(`SELECT "notnull" FROM pragma_table_info('job') WHERE name = 'status'`).get()).toEqual({ notnull: 1 })
    p.cleanup()
  })

  it('an optional column added by ALTER is filled by an UPDATE after it', async () => {
    const p = await jobs()
    const src = `${COMPANY}\nmodel Job { id Int @id  title String  note String? }`
    const op = { op: 'backfill', model: 'Job', field: 'note', value: 'imported' }
    create(p.db, parse(src), 'note', p.migrations, { operations: [op] })
    expect(latest(p.migrations)).toContain(`UPDATE "job" SET "note" = 'imported';`)
    await apply(p.db, p.migrations)
    expect(p.db.query('SELECT note FROM job').all().map((r: any) => r.note)).toEqual(['imported', 'imported', 'imported'])
    p.cleanup()
  })

  it('`first` over an empty parent refuses at apply, naming the operation, and the rows stay', async () => {
    const p = await jobs([])
    const op = { op: 'backfill', model: 'Job', field: 'companyId', first: 'Company' }
    expect(create(p.db, parse(JOB_V2), 'link', p.migrations, { operations: [op] }).created).toBe(true)
    const res = await apply(p.db, p.migrations)
    const last = res.applied.at(-1) as any
    expect(last?.ok ?? false).toBe(false)
    expect(JSON.stringify(res)).toContain('backfill Job.companyId first Company: Company has no rows')
    expect(p.db.query('SELECT title FROM job ORDER BY id').all()).toEqual([{ title: 'j1' }, { title: 'j2' }, { title: 'j3' }])
    p.cleanup()
  })

  it('`first` over an empty parent and an empty table applies — nothing needed a value', async () => {
    const l = lab()
    const db = new Database(':memory:')
    create(db, parse(JOB_V1), 'init', l.migrations)
    create(db, parse(JOB_V2), 'link', l.migrations, { operations: [{ op: 'backfill', model: 'Job', field: 'companyId', first: 'Company' }] })
    const res = await apply(db, l.migrations)
    expect(res.applied.every((a: any) => a.ok)).toBe(true)
    l.cleanup()
  })

  it('is refused by name before a file is written', async () => {
    const p = await jobs()
    const msg = (op: any, src = JOB_V2) => {
      const r = create(p.db, parse(src), 'x', p.migrations, { operations: [op] })
      expect(r.created).toBeFalsy()
      return r.message
    }
    const B = { op: 'backfill', model: 'Job', field: 'companyId' }
    expect(msg(B)).toContain('states one source')
    expect(msg({ ...B, value: 1, first: 'Company' })).toContain('states one source')
    expect(msg({ ...B, value: null })).toContain('a string, a finite number or a boolean')
    expect(msg({ ...B, first: 'Nope' })).toContain('no model Nope')
    expect(msg({ ...B, first: 'Job' })).toContain('links to Company, not Job')
    expect(msg({ ...B, field: 'ghost', value: 1 })).toContain('no stored field `ghost`')
    expect(msg({ ...B, field: 'title', value: 'x' })).toContain('already has job.title')
    expect(msg({ ...B, first: 'Company" ; DROP TABLE job; --' })).toContain('`first` is the name')
    expect(listMigrationFiles(p.migrations)).toHaveLength(1)
    p.cleanup()
  })

  it('the document carries it, and --operations writes it', () => {
    const doc = { operations: [{ op: 'backfill', model: 'Job', field: 'companyId', first: 'Company' }] }
    expect(readOperations(doc)).toEqual(doc.operations)
  })
})
