#!/usr/bin/env bun
// verbs-rules.test.ts — the second crossing grid, and the one `matrix.test.ts`
// deliberately does not cover.
//
// That grid asks *column kind × operation*. This one asks the question
// underneath it: **does every verb that can reach a row apply every rule that
// guards it?** `makeTable` is one closure whose method bodies each hand-restate
// the rule sequence — `buildPolicyFilter` at eighteen sites, soft-delete
// injection at thirteen — so a rule is added at fifteen call sites and a missed
// one is a silent hole. The precedents are FJS-262 (the cursor and search paths
// applied no filter at all), FJS-216 (a tree read applied nothing past the
// anchor), FJS-671 (a bulk write skipped the whole transitions ladder), and
// FJS-720, which this file found.
//
//     A VERB THAT CAN REACH A ROW MUST APPLY EVERY RULE THAT GUARDS IT.
//
// ─── reading the grid ─────────────────────────────────────────────────────────
//
//   on        the rule applied
//   OFF       the rule did NOT apply — a hole
//   ref       the verb refused by name rather than filtering, which is an
//             answer too where the rule cannot be expressed as a narrowing.
//             `upsert` is the shape: it reads the row, branches, and has one
//             row to be right or wrong about, so it throws where the bulk verb
//             beside it narrows. `upsertMany` × softDelete is the other —
//             `SoftDeletedUniqueError`, because the conflict target matched a
//             row no read returns (FJS-278)
//   -         the verb cannot be formed against this rule (says why)
//   ###:on    known defect FJS-### — asserted STILL BROKEN, so a fix turns this
//             file red and says to promote the cell
//
// ─── why one schema per RULE ──────────────────────────────────────────────────
//
// A fixture carrying every rule at once has the gate refusing everything, and
// every other rule then reports as applied — a refusal that cannot be shown to
// come from the rule it names proves nothing (FJS-351). So each rule gets its
// own schema, arranged the same way: TWO rows, and the rule admits exactly one.
// A verb that applies it sees one and a verb that skips it sees two, whatever
// the verb is.
//
// The verdict is never read off the verb's own return value. A count, a row, a
// boolean and a throw are four vocabularies, and reading them is how a probe
// ends up grading itself — the first cut of this file scored `upsertMany` as
// passing because `count && 2` is 2 for any non-zero count. Every cell asks the
// SYSTEM what the caller could reach or move.
//
// ─── not covered here, and deliberately named ─────────────────────────────────
//
// Field-level rules (@guarded, @allow('read'|'write'), @encrypted) narrow a
// COLUMN rather than a row, so they need a different verdict and a second
// fixture — that is the cost, and it is why they are out rather than an
// oversight. `restore`, `transition` and `search` need a rule-specific fixture
// each (a deleted row, a state machine, an @@fts index that the other four
// schemas would all have to carry). `@@transitions` × the bulk verbs is
// covered, executed, in bulk-transitions.test.ts.
import { describe, test, expect, beforeAll } from 'bun:test'
import { parse }        from '../src/core/parser.js'
import { createClient } from '../src/core/client.js'

// ─── the grid ─────────────────────────────────────────────────────────────────

const GRID = `
rule         | findMany findFirst findUnique findFirstOrThrow findUniqueOrThrow count exists findManyAndCount aggregate groupBy findManyCursor select update upsert remove delete updateMany upsertMany removeMany deleteMany
gate         | on       on        on         on                on                on    on     on               on        on      on             on     on     on     on     on     on         on         on         on
policy       | on       on        on         on                on                on    on     on               on        on      on             on     on     ref    on     on     on         on         on         on
softDelete   | on       on        on         on                on                on    on     on               on        on      on             on     on     ref    on     on     on         ref        on         on
templates    | on       on        on         on                on                on    on     on               on        on      on             on     on     on     on     on     on         on         on         on
globalFilter | on       on        on         on                on                on    on     on               on        on      on             on     on     on     on     on     on         on         on         on
`

// ─── the fixtures ─────────────────────────────────────────────────────────────

const M = (body: string) => `
model Doc {
  id      Int     @id
  title   String
  ownerId String?
  status  String  @default("draft")
  ${body}
}
`

type Rule = {
  schema: string
  rows: Record<string, unknown>[]
  caller: (db: any) => any
  opts?: Record<string, unknown>
  /** the rule refuses rather than narrowing, so an AccessDeniedError IS the pass */
  refuses?: boolean
  soft?: boolean
  tmpl?: boolean
}

const RULES: Record<string, Rule> = {
  // A gate above the caller's level. Every verb must refuse — a gate throws
  // where a policy filters, so `on` here means AccessDeniedError.
  gate: {
    schema: M(`@@gate("5")`),
    rows:   [{ id: 1, title: 'aaa' }, { id: 2, title: 'bbb' }],
    caller: (db) => db.$setAuth({ id: 'u1', role: 'member' }),
    refuses: true,
  },
  // A row policy: row 1 is the caller's, row 2 is somebody else's.
  policy: {
    schema: M(`@@allow('read', ownerId == auth().id)
  @@allow('create', ownerId == auth().id)
  @@allow('update', ownerId == auth().id)
  @@allow('delete', ownerId == auth().id)`),
    rows:   [{ id: 1, title: 'aaa', ownerId: 'u1' }, { id: 2, title: 'bbb', ownerId: 'u2' }],
    caller: (db) => db.$setAuth({ id: 'u1' }),
    opts:   { claims: [] },
  },
  // Soft delete: row 2 is removed.
  softDelete: {
    schema: M(`deletedAt DateTime?
  @@softDelete`),
    rows:   [{ id: 1, title: 'aaa' }, { id: 2, title: 'bbb', deletedAt: '2020-01-01T00:00:00.000Z' }],
    caller: (db) => db,
    soft:   true,
  },
  // A template is a live row in a parallel category.
  templates: {
    schema: M(`@@hasTemplates`),
    rows:   [{ id: 1, title: 'aaa' }, { id: 2, title: 'bbb', isTemplate: true }],
    caller: (db) => db,
    tmpl:   true,
  },
  // The app's own configured filter, applied to every read of the model.
  globalFilter: {
    schema: M(``),
    rows:   [{ id: 1, title: 'aaa', status: 'live' }, { id: 2, title: 'bbb', status: 'gone' }],
    caller: (db) => db,
    opts:   { filters: { doc: { status: 'live' } } },
  },
}

// ─── the verbs ────────────────────────────────────────────────────────────────

/** A read answers how many of the two rows the caller reached. */
const READS: Record<string, (t: any) => Promise<number>> = {
  findMany:          async (t) => (await t.findMany()).length,
  findFirst:         async (t) => (await t.findFirst({ where: { id: 2 } })) ? 2 : 1,
  findUnique:        async (t) => (await t.findUnique({ where: { id: 2 } })) ? 2 : 1,
  findFirstOrThrow:  async (t) => (await t.findFirstOrThrow({ where: { id: 2 } })) ? 2 : 1,
  findUniqueOrThrow: async (t) => (await t.findUniqueOrThrow({ where: { id: 2 } })) ? 2 : 1,
  count:             async (t) => await t.count(),
  exists:            async (t) => (await t.exists({ where: { id: 2 } })) ? 2 : 1,
  findManyAndCount:  async (t) => (await t.findManyAndCount()).total,
  aggregate:         async (t) => (await t.aggregate({ _count: true }))._count,
  groupBy:           async (t) => (await t.groupBy({ by: ['title'], _count: true })).length,
  findManyCursor:    async (t) => { const r = await t.findManyCursor({ limit: 50 }); return r.items.length },
  select:            async (t) => (await t.findMany({ select: { id: true } })).length,
}

/**
 * A write aims at the row the rule hides — alone for a single-target verb, and
 * as one of a pair for a bulk one. `moved` is what the SYSTEM sees afterwards.
 */
const WRITES: Record<string, { aim: 'hidden' | 'both'; gone?: boolean; run: (t: any) => Promise<unknown> }> = {
  update:     { aim: 'hidden', run: (t) => t.update({ where: { id: 2 }, data: { title: 'zzz' } }) },
  upsert:     { aim: 'hidden', run: (t) => t.upsert({ where: { id: 2 }, create: { id: 2, title: 'zzz' }, update: { title: 'zzz' } }) },
  remove:     { aim: 'hidden', gone: true, run: (t) => t.remove({ where: { id: 2 } }) },
  delete:     { aim: 'hidden', gone: true, run: (t) => t.delete({ where: { id: 2 } }) },
  updateMany: { aim: 'both',   run: (t) => t.updateMany({ where: {}, data: { title: 'zzz' } }) },
  upsertMany: { aim: 'both',   run: (t) => t.upsertMany({ data: [{ id: 1, title: 'zzz' }, { id: 2, title: 'zzz' }], conflictTarget: ['id'], update: ['title'] }) },
  removeMany: { aim: 'both',   gone: true, run: (t) => t.removeMany({ where: {} }) },
  deleteMany: { aim: 'both',   gone: true, run: (t) => t.deleteMany({ where: {} }) },
}

// ─── the runner ───────────────────────────────────────────────────────────────

type Cell = { code: 'on' | 'OFF' | 'ref' | '-'; issue?: string }

function parseGrid(text: string) {
  const lines = text.trim().split('\n').filter(Boolean)
  const verbs = lines[0].split('|')[1].trim().split(/\s+/)
  const cells = new Map<string, Cell>()
  for (const line of lines.slice(1)) {
    const [rawRule, rawCells] = line.split('|')
    const rule = rawRule.trim()
    const vals = rawCells.trim().split(/\s+/)
    if (vals.length !== verbs.length)
      throw new Error(`grid row "${rule}" has ${vals.length} cells for ${verbs.length} verbs`)
    vals.forEach((v, i) => {
      const m = v.match(/^(\d+):(on|ref)$/)
      cells.set(`${rule}.${verbs[i]}`, m
        ? { code: m[2] as 'on' | 'ref', issue: `FJS-${m[1]}` }
        : { code: v as Cell['code'] })
    })
  }
  return { verbs, cells }
}

const { verbs, cells } = parseGrid(GRID)

/** What actually happened, in the grid's own vocabulary. */
async function observe(db: any, rule: Rule, verb: string): Promise<Cell['code'] | string> {
  const sys  = db.asSystem()
  const wide = { ...(rule.soft ? { withDeleted: true } : {}), ...(rule.tmpl ? { withTemplates: true } : {}) }
  await sys.doc.deleteMany({ where: {}, ...wide })
  for (const r of rule.rows) await sys.doc.create({ data: r })
  const snap = async () => (await sys.doc.findMany(wide)).map((r: any) => ({ title: r.title, live: !r.deletedAt }))
  const before = await snap()

  try {
    if (READS[verb]) {
      const n = await READS[verb](rule.caller(db).doc)
      // A gate refuses; reaching any row at all means it did not.
      if (rule.refuses) return 'OFF'
      return n === 1 ? 'on' : n === 2 ? 'OFF' : `?${n}`
    }
    const w = WRITES[verb]
    await w.run(rule.caller(db).doc)
    if (rule.refuses) return 'OFF'
    const after = await snap()
    const moved = w.gone
      ? before.filter(r => r.live).length - after.filter(r => r.live).length
      : after.filter(r => r.title === 'zzz').length - before.filter(r => r.title === 'zzz').length
    return w.aim === 'hidden'
      ? (moved === 0 ? 'on' : 'OFF')
      : (moved === 1 ? 'on' : moved === 2 ? 'OFF' : `?${moved}`)
  } catch (e: any) {
    const n = e?.constructor?.name ?? 'thrown'
    if (n === 'AccessDeniedError') return rule.refuses ? 'on' : 'ref'
    if (e?.code === 'NOT_FOUND' || n === 'NotFoundError') return 'on'
    if (n === 'SoftDeletedUniqueError') return 'ref'
    return `!${n}`
  }
}

describe('verbs × rules', () => {
  const clients: Record<string, any> = {}

  beforeAll(async () => {
    for (const [name, rule] of Object.entries(RULES)) {
      const parsed = parse(rule.schema)
      if (!parsed.valid) throw new Error(`${name}: ${parsed.errors.join('; ')}`)
      clients[name] = await createClient({ parsed, db: ':memory:', ...(rule.opts ?? {}) })
    }
  })

  // `VERBS_REPORT=1 bun test test/verbs-rules.test.ts` prints what every cell
  // does right now, in grid shape, ready to paste back. Filling the grid from
  // what one believes the code does is how a grid ends up asserting a wish.
  test.if(!!process.env.VERBS_REPORT)('report', async () => {
    const w = 9
    const out = ['rule         | ' + verbs.map(v => v.slice(0, w - 1).padEnd(w)).join('')]
    for (const [name, rule] of Object.entries(RULES)) {
      const row: string[] = []
      for (const v of verbs) row.push(String(await observe(clients[name], rule, v)).padEnd(w))
      out.push(name.padEnd(12) + ' | ' + row.join(''))
    }
    console.log('\n' + out.join('\n') + '\n')
  }, 60000)

  test('every rule × every verb has a cell', () => {
    const missing: string[] = []
    for (const rule of Object.keys(RULES))
      for (const v of verbs)
        if (!cells.has(`${rule}.${v}`)) missing.push(`${rule}.${v}`)
    expect(missing).toEqual([])
  })

  test('the grid declares no verb the runner cannot perform', () => {
    expect(verbs.filter(v => !READS[v] && !WRITES[v])).toEqual([])
  })

  // The grid's two rows both EXIST, so `upsertMany` there only ever exercises
  // its conflict half. The insert half is a create and is policed by the create
  // policy, which is a different rule and a different failure: planting a row
  // that belongs to somebody else rather than writing to one.
  test('upsertMany × policy — the INSERT half is a create, and is refused like one', async () => {
    const db  = clients.policy
    const sys = db.asSystem()
    await sys.doc.deleteMany({ where: {} })
    await sys.doc.create({ data: { id: 1, title: 'aaa', ownerId: 'u1' } })
    const u1 = db.$setAuth({ id: 'u1' })

    // The control: `create` of the identical payload. A refusal that cannot be
    // shown to come from the rule it names proves nothing (FJS-351).
    await expect(u1.doc.create({ data: { id: 9, title: 'planted', ownerId: 'u2' } }))
      .rejects.toMatchObject({ code: 'ACCESS_DENIED' })

    await expect(u1.doc.upsertMany({
      data: [{ id: 9, title: 'planted', ownerId: 'u2' }],
      conflictTarget: ['id'], update: ['title'],
    })).rejects.toMatchObject({ code: 'ACCESS_DENIED' })

    expect((await sys.doc.findMany()).map((r: any) => r.id)).toEqual([1])

    // …and the acceptance, or the refusal above is about the verb rather than
    // about the policy: the same call for a row the caller may create.
    await u1.doc.upsertMany({
      data: [{ id: 10, title: 'mine', ownerId: 'u1' }],
      conflictTarget: ['id'], update: ['title'],
    })
    expect((await sys.doc.findMany()).map((r: any) => r.id)).toEqual([1, 10])
  })

  test('upsertMany × policy — a LOGGED model, where RETURNING follows the new WHERE', async () => {
    // The grid's models are not logged, so the `_usNeedRows` statement — the one
    // that appends `RETURNING *` after the ON CONFLICT clause — is reached by
    // nothing above. It is the shape most likely to be invalid SQL.
    const { mkdtempSync } = await import('node:fs')
    const { tmpdir }      = await import('node:os')
    const { join }        = await import('node:path')
    const dir = mkdtempSync(join(tmpdir(), 'verbs-logged-'))
    const db  = await createClient({
      parsed: parse(`
database main  { path "${join(dir, 'm.db')}" }
database audit { path "${join(dir, 'a')}/"  driver logger }
model Doc {
  id      Int     @id
  title   String
  ownerId String?
  @@db(main)
  @@log(audit)
  @@allow('read',   ownerId == auth().id)
  @@allow('create', ownerId == auth().id)
  @@allow('update', ownerId == auth().id)
}
`),
      db: ':memory:', claims: [],
    })
    const sys = db.asSystem()
    await sys.doc.create({ data: { id: 1, title: 'mine',   ownerId: 'u1' } })
    await sys.doc.create({ data: { id: 2, title: 'theirs', ownerId: 'u2' } })
    const u1 = db.$setAuth({ id: 'u1' })

    for (const announce of [undefined, 'rows'] as const) {
      const r = await u1.doc.upsertMany({
        data: [{ id: 1, title: 'A' }, { id: 2, title: 'A' }],
        conflictTarget: ['id'], update: ['title'], ...(announce ? { announce } : {}),
      })
      expect({ announce: announce ?? 'default', ...r }).toEqual({ announce: announce ?? 'default', count: 1 })
      const rows = await sys.doc.findMany()
      expect(rows.find((x: any) => x.id === 2).title).toBe('theirs')
    }
    db.$close()
  })

  test('upsertMany counts what it MOVED, not what it was handed', async () => {
    // A batch that reports writing a row it did not write is worse than one
    // that stops — the rule the seal branch beside it already states.
    const db  = clients.policy
    const sys = db.asSystem()
    await sys.doc.deleteMany({ where: {} })
    await sys.doc.create({ data: { id: 1, title: 'aaa', ownerId: 'u1' } })
    await sys.doc.create({ data: { id: 2, title: 'bbb', ownerId: 'u2' } })
    const r = await db.$setAuth({ id: 'u1' }).doc.upsertMany({
      data: [{ id: 1, title: 'zzz' }, { id: 2, title: 'zzz' }],
      conflictTarget: ['id'], update: ['title'],
    })
    expect(r).toEqual({ count: 1 })
  })

  for (const [name, rule] of Object.entries(RULES)) {
    for (const v of verbs) {
      const cell = cells.get(`${name}.${v}`)!
      if (!cell || cell.code === '-') continue
      const label = cell.issue
        ? `${name} × ${v} — STILL BROKEN (${cell.issue}); fixing it means promoting this cell`
        : `${name} × ${v}`
      test(label, async () => {
        expect(await observe(clients[name], RULES[name], v)).toBe(cell.code)
      }, 20000)
    }
  }
})
