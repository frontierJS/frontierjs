#!/usr/bin/env bun
// matrix.test.ts — the crossing matrix.
//
// Every defect found in the 2026-08-11/12 sweep was a CROSSING: two features
// that each work alone, whose intersection nobody owned and nobody tested. An
// enum that is also an array. An array reached by a `where`. An array given a
// `@default`. A bulk write over rows of different shapes. Feature-by-feature
// tests cannot find these, because each feature passes its own suite.
//
// So the crossings are declared here as a grid — one cell per (column kind ×
// operation) — under a single invariant:
//
//     NO CELL MAY SILENTLY RETURN A WRONG ANSWER.
//
// A cell is supported, or it is refused by name. Silence is the only outcome
// that is never acceptable, because it is the one a caller cannot see.
//
// ─── reading the grid ─────────────────────────────────────────────────────────
//
//   ok        the operation works and returns the right answer
//   ref       the operation is refused, and the message NAMES THE FIELD
//   -         the operation cannot be formed for this kind (says why, below)
//   ###:tgt   known defect FJS-### — the cell does neither today, and `tgt`
//             (`ok` or `ref`) is what it should do
//
// A `###:tgt` cell asserts the defect is STILL THERE. Fix the defect and this
// file goes red, naming the cell and telling you to promote it — the same
// ratchet as the typecheck baselines, and the reason a fix cannot quietly leave
// the grid stale.
//
// Every declared kind × every declared op must have a cell. A missing one fails
// rather than being skipped, so adding a column kind means answering the
// question for all twelve operations, and adding an operation means answering it
// for all fourteen kinds. That is the whole point: the matrix makes a crossing
// somebody's job.
//
// ─── not covered here, and deliberately named ─────────────────────────────────
//
// Relation kinds (`belongsTo`/`hasMany`/implicit m2m/`@from`), `@edge`,
// `@sequence`, `File`, and the cursor/window/FTS operations are NOT in the grid
// yet. They are not passing — they are unasked. Adding a row is cheap; a silent
// gap here would be the exact failure this file exists to prevent.
//
// The relation kinds and `@from` need a SECOND model, so they need a second
// fixture and a second expectation table — that is the cost, and it is why they
// are still out rather than an oversight.
//
// `@version` is out for a different reason and it is not a column kind at all:
// declaring one makes every update on the model carry a revision, so a `rev`
// column here would change what every other row's `update` cell means. It is a
// model-wide semantic and belongs in a fixture of its own.
//
// `File` needs a `FileStorage`, which is I/O this fixture has none of.

import { describe, test, expect, beforeAll } from 'bun:test'
import { parse }        from '../src/core/parser.js'
import { createClient } from '../src/core/client.js'

// ─── the fixture ──────────────────────────────────────────────────────────────
//
// One model carrying every column kind, and exactly two rows: A holds every
// kind's `a` value, B holds every kind's `b` value. So for any kind, "the rows
// matching A's value" is [A] — which is what makes one expectation table work
// across fourteen different types.

const SCHEMA = `
enum Tag { alpha beta }

type Address { city String  state String }

model Cell {
  id    Int      @id @default(autoincrement())
  text  String
  num   Int      @default(0)
  rate  Float    @default(0)
  price Int      @money(USD)
  flag  Boolean  @default(false)
  when  DateTime
  words String[] @default("[]")
  nums  Int[]    @default("[]")
  tag   Tag
  tags  Tag[]    @default("[]")
  meta  Json?
  addr  Json     @type(Address)
  enc   String?  @encrypted
  encs  String?  @encrypted(deterministic: true)
  hsh   String?  @hashed
  lock  String?  @guarded
  sys   String?  @system
  tmp   String?  @transient
  comp  String?  @computed
  gen   String   @generated("upper(text)")
}
`

const D1 = new Date('2024-01-01T00:00:00.000Z')
const D2 = new Date('2024-06-01T00:00:00.000Z')

const ROW_A = {
  text: 'alpha', num: 7, rate: 1.5, price: 1000, flag: true,  when: D1,
  words: ['x', 'y'], nums: [1, 2], tag: 'alpha', tags: ['alpha'],
  meta: { tier: 3 }, addr: { city: 'NYC', state: 'NY' },
  enc: 'e-alpha', encs: 's-alpha', hsh: 'h-alpha',
  lock: 'l-alpha', sys: 'y-alpha',
}
const ROW_B = {
  text: 'beta',  num: 9, rate: 2.5, price: 2000, flag: false, when: D2,
  words: ['z'],      nums: [3],    tag: 'beta',  tags: ['beta'],
  meta: { tier: 4 }, addr: { city: 'LA', state: 'CA' },
  enc: 'e-beta',  encs: 's-beta',  hsh: 'h-beta',
  lock: 'l-beta',  sys: 'y-beta',
}

// The fixture is seeded through `asSystem()`, because two of its columns are
// server-owned and a caller cannot write them — the rows are the GIVEN, not the
// assertion. The create operations run on the kind's own client and therefore
// need a payload a caller could legally send, which is the fixture minus those
// columns; `createSt` adds the kind's own field back, which for a server-owned
// kind IS the question being asked.
const CALLER_WRITABLE = Object.fromEntries(
  Object.entries(ROW_A).filter(([k]) => k !== 'lock' && k !== 'sys'))

// ─── the kinds ────────────────────────────────────────────────────────────────
//
// `a`/`b` are the two rows' values. `sub` is a substring of `a` that is not a
// substring of `b` (for `contains`) — given even for kinds where a substring is
// a category error, because *what happens when you ask* is the question.
// `elem` is a member of `a` (for `has`). `ascIds` is the id order this column
// sorts into ascending, stated by hand — asserting a sort against a value the
// same code computed would prove nothing. `write` is a third legal value, used
// by the update operations.
//
// `inOp`/`bare` override the operand shape where the default (`[a]`) would ask
// something meaningless: on an array column the bare array IS the list of
// elements, so wrapping it again asks about an array of arrays.
//
// `system: true` reads through `asSystem()`. `@encrypted` implies `@guarded`
// (encryption.md), so any other client is testing the guard rather than the
// encryption, and every cell would say `guarded` instead of what it means.

const KINDS: Record<string, any> = {
  text:      { field: 'text',  a: 'alpha', b: 'beta', sub: 'lph', ascIds: [1, 2], write: 'gamma' },
  int:       { field: 'num',   a: 7,       b: 9,      sub: '7',   ascIds: [1, 2], write: 11 },
  bool:      { field: 'flag',  a: true,    b: false,  sub: 'tru', ascIds: [2, 1], write: false },
  datetime:  { field: 'when',  a: D1,      b: D2,     sub: '2024-01', ascIds: [1, 2], write: new Date('2025-01-01T00:00:00.000Z') },
  array:     { field: 'words', a: ['x', 'y'], b: ['z'], elem: 'x', sub: 'x', inOp: ['x', 'y'], bare: ['x', 'y'], write: ['q'] },
  intArray:  { field: 'nums',  a: [1, 2],  b: [3],     elem: 1,   sub: '1', inOp: [1, 2],     bare: [1, 2],     write: [8] },
  enum:      { field: 'tag',   a: 'alpha', b: 'beta', sub: 'lph', ascIds: [1, 2], write: 'beta' },
  enumArray: { field: 'tags',  a: ['alpha'], b: ['beta'], elem: 'alpha', sub: 'alph', inOp: ['alpha'], bare: ['alpha'], write: ['beta'] },
  json:      { field: 'meta',  a: { tier: 3 }, b: { tier: 4 }, sub: 'tier',  write: { tier: 5 } },
  typedJson: { field: 'addr',  a: { city: 'NYC', state: 'NY' }, b: { city: 'LA', state: 'CA' }, sub: 'NYC',
               write: { city: 'SF', state: 'CA' } },
  encrypted: { field: 'enc',   a: 'e-alpha', b: 'e-beta', sub: 'alph', write: 'e-gamma', system: true },
  encDet:    { field: 'encs',  a: 's-alpha', b: 's-beta', sub: 'alph', write: 's-gamma', system: true },
  hashed:    { field: 'hsh',   a: 'h-alpha', b: 'h-beta', sub: 'alph', write: 'h-gamma', system: true, verifyByMatch: true },
  float:     { field: 'rate',  a: 1.5,     b: 2.5,    sub: '1.5', ascIds: [1, 2], write: 3.5 },
  money:     { field: 'price', a: 1000,    b: 2000,   sub: '100', ascIds: [1, 2], write: 3000 },
  guarded:   { field: 'lock',  a: 'l-alpha', b: 'l-beta', sub: 'alph', ascIds: [1, 2], write: 'l-gamma' },
  system:    { field: 'sys',   a: 'y-alpha', b: 'y-beta', sub: 'alph', ascIds: [1, 2], write: 'y-gamma' },
  transient: { field: 'tmp',   a: 't-alpha', b: 't-beta', sub: 'alph', ascIds: [1, 2], write: 't-gamma' },
  computed:  { field: 'comp',  a: 'ALPHA', b: 'BETA', sub: 'LPH', write: 'ZZZ' },
  generated: { field: 'gen',   a: 'ALPHA', b: 'BETA', sub: 'LPH', ascIds: [1, 2], write: 'ZZZ' },
}

// ─── the operations ───────────────────────────────────────────────────────────
//
// Each returns whatever the client answered; the runner classifies. `expect`
// is what a correct answer looks like, so a cell marked `ok` is checked for the
// right ANSWER and not merely for not throwing — a query that returns nothing is
// exactly the failure this file is about.

const OPS: Record<string, any> = {
  whereEq:  { run: (db, k) => db.cell.findMany({ where: { [k.field]: k.a } }),
              want: () => [1] },
  whereIn:  { run: (db, k) => db.cell.findMany({ where: { [k.field]: { in: k.inOp ?? [k.a] } } }),
              want: () => [1] },
  whereNot: { run: (db, k) => db.cell.findMany({ where: { [k.field]: { not: k.a } } }),
              want: () => [2] },
  contains: { run: (db, k) => db.cell.findMany({ where: { [k.field]: { contains: k.sub } } }),
              want: () => [1] },
  bareArr:  { run: (db, k) => db.cell.findMany({ where: { [k.field]: k.bare ?? [k.a] } }),
              want: () => [1] },
  hasOp:    { run: (db, k) => db.cell.findMany({ where: { [k.field]: { has: k.elem } } }),
              want: () => [1] },
  orderBy:  { run: (db, k) => db.cell.findMany({ orderBy: { [k.field]: 'asc' } }),
              want: (k) => k.ascIds },

  // Shape ops. A column's value must come back in ONE shape whatever asked for
  // it — `findMany` parses an array column, so `groupBy`/`_max` must too, or a
  // caller's `.length` means different things down different paths.
  //
  // `distinct` was a column here and is not one any more: it is a boolean, the
  // whole-row `SELECT DISTINCT`, so it names no field and the grid's question —
  // does an operation that NAMES this column refuse or answer — cannot be put to
  // it (FJS-935). Its cells said `ok` for nineteen of twenty kinds against a
  // fixture of exactly two rows, which is the answer an ignored argument gives.
  groupBy:  { run: (db, k) => db.cell.groupBy({ by: [k.field], _count: true }), shape: true },
  aggMax:   { run: (db, k) => db.cell.aggregate({ _max: { [k.field]: true } }), shape: 'max' },

  update:   { run: (db, k) => db.cell.update({ where: { id: 1 }, data: { [k.field]: k.write } }),
              wrote: true },
  updMany:  { run: (db, k) => db.cell.updateMany({ where: { id: 1 }, data: { [k.field]: k.write } }),
              wrote: true },

  // Create is where the read-only kinds differ from each other, and until this
  // column existed the grid could not see any of it: a caller STATING a column
  // the server owns and a caller OMITTING one the model requires are two
  // different refusals, and neither is an update.
  createSt: { run: (db, k) => db.cell.create({ data: { ...CALLER_WRITABLE, [k.field]: k.write } }),
              created: true },
  createOm: { run: (db, k) => {
                const data: any = { ...CALLER_WRITABLE }
                delete data[k.field]
                return db.cell.create({ data })
              }, createdOm: true },

  // A projection must answer what a full read answers. Anything else means a
  // column's value depends on how it was asked for, which is the same failure
  // `distinct`/`groupBy`/`aggMax` are here to catch one layer down.
  select:   { run: (db, k) => db.cell.findMany({ where: { id: 1 }, select: { [k.field]: true } }),
              sel: true },

  delWhere: { run: (db, k) => db.cell.deleteMany({ where: { [k.field]: k.a } }), deleted: true },
}

// ─── the grid ─────────────────────────────────────────────────────────────────
//
// Filled from what the code ACTUALLY does, not from what it should do — every
// cell below was run. A cell carrying an id is a defect that is open in
// ISSUES.md; a cell carrying `ref` is refused today and stays refused.

const GRID = `
kind      | whereEq  whereIn  whereNot contains bareArr  hasOp    orderBy  groupBy  aggMax   update   updMany  createSt createOm select   delWhere
text      | ok       ok       ok       ok       ok       ref      ok       ok       ok       ok       ok       ok       ref      ok       ok
int       | ok       ok       ok       ok       ok       ref      ok       ok       ok       ok       ok       ok       ok       ok       ok
bool      | ok       ok       ok       ref      ok       ref      ok       ok       ok       ok       ok       ok       ok       ok       ok
datetime  | ok       ok       ok       ok       ok       ref      ok       ok       ok       ok       ok       ok       ref      ok       ok
array     | ok       ok       ok       ref      ok       ok       ref      ok       ref      ok       ok       ok       ok       ok       ok
intArray  | ok       ok       ok       ref      ok       ok       ref      ok       ref      ok       ok       ok       ok       ok       ok
enum      | ok       ok       ok       ok       ok       ref      ok       ok       ok       ok       ok       ok       ref      ok       ok
enumArray | ok       ok       ok       ref      ok       ok       ref      ok       ref      ok       ok       ok       ok       ok       ok
json      | ref      ref      ref      ref      ref      ref      ref      ok       ref      ok       ok       ok       ok       ok       ref
typedJson | ok       ref      ref      ref      ref      ref      ref      ok       ref      ok       ok       ok       ref      ok       ok
encrypted | ref      ref      ref      ref      ref      ref      ref      ok       ref      ok       ok       ok       ok       ok       ref
encDet    | ok       ok       ok       ref      ok       ref      ref      ok       ref      ok       ok       ok       ok       ok       ok
hashed    | ok       ok       ok       ref      ok       ref      ref      ref      ref      ok       ok       ok       ok       ref      ok
float     | ok       ok       ok       ok       ok       ref      ok       ok       ok       ok       ok       ok       ok       ok       ok
money     | ok       ok       ok       ok       ok       ref      ok       ok       ok       ok       ok       ok       ref      ok       ok
guarded   | ref      ref      ref      ref      ref      ref      ref      ref      ref      ref      ref      ref      ok       ok       ref
system    | ok       ok       ok       ok       ok       ref      ok       ok       ok       ref      ref      ref      ok       ok       ok
transient | ref      ref      ref      ref      ref      ref      ref      ref      ref      ref      ref      ref      ok       ref      ref
computed  | ref      ref      ref      ref      ref      ref      ref      ref      ref      ref      ref      ref      ok       ok       ref
generated | ok       ok       ok       ok       ok       ref      ok       ok       ok       ref      ref      ref      ok       ok       ok
`

// ─── runner ───────────────────────────────────────────────────────────────────

type Cell = { code: 'ok' | 'ref' | '-', issue?: string }

function parseGrid(text: string): { ops: string[], cells: Map<string, Cell> } {
  const lines = text.trim().split('\n').map(l => l.trim()).filter(Boolean)
  const ops   = lines[0].split('|')[1].trim().split(/\s+/)
  const cells = new Map<string, Cell>()
  for (const line of lines.slice(1)) {
    const [rawKind, rawCells] = line.split('|')
    const kind = rawKind.trim()
    const vals = rawCells.trim().split(/\s+/)
    if (vals.length !== ops.length)
      throw new Error(`grid row "${kind}" has ${vals.length} cells for ${ops.length} operations`)
    vals.forEach((v, i) => {
      const m = v.match(/^(\d+):(ok|ref)$/)
      cells.set(`${kind}.${ops[i]}`, m
        ? { code: m[2] as 'ok' | 'ref', issue: `FJS-${m[1]}` }
        : { code: v as 'ok' | 'ref' | '-' })
    })
  }
  return { ops, cells }
}

// What actually happened, reduced to the only two questions the invariant asks:
// did it refuse, and if it did not, was the answer right.
async function observe(root: any, kind: any, op: any): Promise<{ threw?: string, ok: boolean, saw: any }> {
  const db = kind.system ? root.asSystem() : root
  let raw: any
  try {
    raw = await op.run(db, kind)
  } catch (e: any) {
    return { threw: e.message, ok: false, saw: e.message }
  }

  if (op.want) {
    const ids = (raw ?? []).map((r: any) => r.id)
    return { ok: JSON.stringify(ids) === JSON.stringify(op.want(kind)), saw: ids }
  }
  if (op.rows)  return { ok: (raw ?? []).length === op.rows, saw: (raw ?? []).length }
  if (op.shape) {
    // The value must come back in the shape a row read gives it.
    const rowShape = (await db.cell.findMany({ where: { id: 1 } }))[0][kind.field]
    const got      = op.shape === 'max' ? raw?._max?.[kind.field]
                                        : (raw ?? []).map((r: any) => r[kind.field])[0]
    const same     = typeof got === typeof rowShape &&
                     (typeof got !== 'object' || Array.isArray(got) === Array.isArray(rowShape))
    return { ok: same, saw: got }
  }
  if (op.wrote) {
    // A @hashed column cannot be read back — that IS the column. So the write is
    // verified the only way the column can be probed at all: match the new value.
    // Reading it back and finding `undefined` would score every write as failed,
    // and asserting `undefined` would score a write that never happened as passed.
    if (kind.verifyByMatch) {
      const hit = await db.cell.findFirst({ where: { [kind.field]: kind.write } })
      return { ok: hit?.id === 1, saw: hit?.id ?? null }
    }
    const back = (await db.cell.findMany({ where: { id: 1 } }))[0]?.[kind.field]
    const want = kind.write instanceof Date ? kind.write.toISOString() : kind.write
    return { ok: JSON.stringify(back) === JSON.stringify(want), saw: back }
  }
  if (op.created) {
    if (kind.verifyByMatch) {
      const hit = await db.cell.findFirst({ where: { [kind.field]: kind.write } })
      return { ok: !!hit && hit.id > 2, saw: hit?.id ?? null }
    }
    const back = raw?.[kind.field]
    const want = kind.write instanceof Date ? kind.write.toISOString() : kind.write
    return { ok: JSON.stringify(back) === JSON.stringify(want), saw: back }
  }
  if (op.createdOm) return { ok: typeof raw?.id === 'number', saw: raw?.id ?? raw }
  if (op.sel) {
    const full = (await db.cell.findMany({ where: { id: 1 } }))[0]?.[kind.field]
    const got  = (raw ?? [])[0]?.[kind.field]
    return { ok: JSON.stringify(got) === JSON.stringify(full), saw: got }
  }
  if (op.deleted) {
    const left = (await db.cell.findMany({})).map((r: any) => r.id)
    return { ok: JSON.stringify(left) === JSON.stringify([2]), saw: left }
  }
  return { ok: true, saw: raw }
}

// The two rows are put back exactly as declared before every cell, through
// `asSystem()` — see CALLER_WRITABLE. A write op mutates row 1, and a later
// cell reading a mutated row would grade a fixture the grid was not filled from.
async function seed(root: any) {
  const sys = root.asSystem()
  await sys.cell.deleteMany({})
  await sys.cell.create({ data: { ...ROW_A } })
  await sys.cell.create({ data: { ...ROW_B } })
}

const { ops, cells } = parseGrid(GRID)

describe('crossing matrix', () => {
  let db: any

  beforeAll(async () => {
    const parsed = parse(SCHEMA)
    if (!parsed.valid) throw new Error(parsed.errors.join('\n'))
    db = await createClient({
      parsed, db: ':memory:',
      encryptionKey: 'a'.repeat(64),
      computed: { Cell: { comp: (row: any) => row.text?.toUpperCase() ?? null } },
    })
  })

  // `MATRIX_REPORT=1 bun test test/matrix.test.ts` prints what every cell does
  // right now, in grid shape, ready to paste back. Filling the grid by hand from
  // what one believes the code does is how a grid ends up asserting a wish.
  //   ok   right answer   ref  refused, names the field
  //   raw  refused, does NOT name the field (a refusal nobody can act on)
  //   bad  answered, wrong answer
  test.if(!!process.env.MATRIX_REPORT)('report', async () => {
    const w = 9
    const out = ['kind      | ' + ops.map(o => o.padEnd(w)).join('')]
    for (const [kindName, kind] of Object.entries(KINDS)) {
      const row: string[] = []
      for (const opName of ops) {
        await seed(db)
        const r = await observe(db, kind, OPS[opName])
        row.push((r.threw ? (r.threw.includes(kind.field) ? 'ref' : 'raw') : (r.ok ? 'ok' : 'bad')).padEnd(w))
      }
      out.push(kindName.padEnd(9) + ' | ' + row.join(''))
    }
    console.log('\n' + out.join('\n') + '\n')
  })

  test('every kind × every operation has a cell', () => {
    const missing: string[] = []
    for (const kind of Object.keys(KINDS))
      for (const op of ops)
        if (!cells.has(`${kind}.${op}`)) missing.push(`${kind}.${op}`)
    expect(missing).toEqual([])
  })

  test('the grid declares no operation the runner cannot perform', () => {
    expect(ops.filter(o => !OPS[o])).toEqual([])
  })

  for (const [kindName, kind] of Object.entries(KINDS)) {
    for (const opName of ops) {
      const cell = cells.get(`${kindName}.${opName}`)!
      const op   = OPS[opName]
      if (!cell || cell.code === '-') continue

      const label = `${kindName} × ${opName}`

      test(`${label} — ${cell.issue ?? cell.code}`, async () => {
        await seed(db)

        const r = await observe(db, kind, op)

        // Whatever else is true, a refusal has to name the field — a raw SQLite
        // message ("malformed JSON") is a refusal nobody can act on.
        const refusedByName = !!r.threw && r.threw.includes(kind.field)
        const behaves = cell.code === 'ok' ? r.ok && !r.threw : refusedByName

        if (!cell.issue) {
          if (cell.code === 'ok')
            expect(`${label}: ${r.threw ? `threw ${r.threw}` : `answered ${JSON.stringify(r.saw)}`}`)
              .toBe(`${label}: answered ${JSON.stringify(op.want ? op.want(kind) : r.saw)}`)
          else
            expect(`${label}: ${r.threw ? `refused "${r.threw}"` : `allowed, answered ${JSON.stringify(r.saw)}`}`)
              .toBe(`${label}: refused "${r.threw}"`)
          expect(behaves).toBe(true)
          return
        }

        // A defect cell asserts the defect SURVIVES. When it stops surviving the
        // grid is stale, and a stale grid is how the register went wrong before.
        expect(`${label}: ${cell.issue} still open`).toBe(
          behaves
            ? `${label}: ${cell.issue} appears FIXED — it now ${cell.code === 'ok' ? 'answers correctly' : 'refuses by name'}. ` +
              `Promote the cell to \`${cell.code}\` and close the issue.`
            : `${label}: ${cell.issue} still open`)
      })
    }
  }
})
