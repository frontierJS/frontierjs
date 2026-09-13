// bench/ablation.mjs
// What one declaration costs, measured against the same schema without it.
//
// Run: bun bench/ablation.mjs [filter] [--rounds=N] [--json]
//
// Each case is one schema, one principal and one operation. Its FLOOR is another
// case that differs by the declaration alone, and the delta between the two is
// the number — never the absolute microseconds, which are a statement about one
// laptop (IDEAS/performance-regression-watch.md). Rounds are interleaved across
// every case and the MIN is reported, because the noise here is one-sided: a
// loaded round only ever makes a case slower.
//
// Traps in this file:
//   • A case whose floor does not run reports no delta. A filter keeps the floor
//     of every case it matches, or `write/tenancy` alone would print a number
//     with nothing under it.
//   • A case that throws is a FAILURE and the exit code says so. `gate-getlevel`
//     in audit-bench.mjs died on a wrong accessor and was skipped for three
//     weeks, because a skipped row and a quiet row read the same.
//   • The audit logger writes on setImmediate, and a loop that only awaits
//     resolved promises never yields to it — every timed loop ends by awaiting
//     one macrotask, or @@log would be measured without its write.
//   • A read policy narrows WHICH rows come back, and materializing a row is
//     most of a read. `rows/op` is printed beside every read so a delta bought
//     by returning fewer rows cannot pass for a cheap policy.
//   • Everything is `:memory:`, so this measures the framework and not the disk.
//     A WAL commit costs nothing here; speed-and-footprint.md has that number.

import { createClient } from '../src/index.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const args    = process.argv.slice(2)
const filter  = args.find(a => !a.startsWith('--')) ?? ''
const ROUNDS  = Number(args.find(a => a.startsWith('--rounds='))?.split('=')[1] ?? 5)
const asJson  = args.includes('--json')
const DIR     = mkdtempSync(join(tmpdir(), 'ls-ablation-'))
const WRITES  = 3000
const READS   = 1000
const SEEDED  = 5000
const COUNTED = 20

const tick = () => new Promise(r => setImmediate(r))
const who  = { id: 1, workspaceId: 1 }

// ─── schemas ──────────────────────────────────────────────────────────────────

const STATE = `enum State { draft  review  published }`

/** One model, with `extra` columns and `rules` dropped in. */
const item = ({ extra = '', rules = '', head = '' } = {}) => `
${head}
${STATE}
model Item {
  id          Int    @id
  workspaceId Int
  ownerId     Int
  title       String
  status      State  @default(draft)
  ${extra}
  ${rules}
}`

const TENANCY    = `tenancy {\n  strategy row\n  column   workspaceId\n}`
const ROW_POLICY = `@@allow('read', ownerId == auth().id || status == 'published')`
const TRANSITION = `@@transitions(status,\n    submit:  draft  -> review,\n    publish: review -> published\n  )`
const AUDIT_DB   = `database audit {\n  path   "${DIR}/audit/"\n  driver logger\n}`

/**
 * A leaf and `depth` parents above it, each reachable by its key. With `policy`
 * every level delegates its read to the one above through `check()`, and only
 * the top decides — so one read of a leaf compiles the whole chain.
 */
function chain(depth, policy) {
  const models = []
  for (let d = depth; d >= 1; d--) {
    const up   = d < depth ? `parentId Int\n  parent P${d + 1} @relation(fields: [parentId], references: [id])` : 'ownerId Int'
    const down = d > 1 ? `P${d - 1}[]` : 'Item[]'
    const rule = !policy ? '' : d < depth ? `@@allow('read', check(parent))` : `@@allow('read', ownerId == auth().id)`
    models.push(`model P${d} {\n  id Int @id\n  ${up}\n  children ${down}\n  ${rule}\n}`)
  }
  const leafUp = depth ? `parentId Int\n  parent P1 @relation(fields: [parentId], references: [id])` : ''
  const leaf   = policy && depth ? `@@allow('read', check(parent))` : ''
  return `${STATE}\n${models.join('\n')}\nmodel Item {\n  id Int @id\n  title String\n  status State @default(draft)\n  ${leafUp}\n  ${leaf}\n}`
}

async function seedChain(sys, depth) {
  for (let d = depth; d >= 1; d--) {
    const data = Array.from({ length: 50 }, (_, i) =>
      d < depth ? { id: i + 1, parentId: i + 1 } : { id: i + 1, ownerId: 1 })
    await sys[`p${d}`].createMany({ data })
  }
  await sys.item.createMany({ data: Array.from({ length: SEEDED }, (_, i) =>
    ({ title: `t${i}`, ...(depth ? { parentId: (i % 50) + 1 } : {}) })) })
}

const seedItems = (sys, withWorkspace = true) => sys.item.createMany({
  data: Array.from({ length: SEEDED }, (_, i) => ({
    ...(withWorkspace ? { workspaceId: 1 } : {}),
    ownerId: (i % 50) + 1,
    title:   `t${i}`,
    status:  i % 2 ? 'published' : 'draft',
  })),
})

const rowsFor = (n) => Array.from({ length: n }, (_, i) => ({ workspaceId: 1, ownerId: 1, title: `t${i}` }))

// ─── cases ────────────────────────────────────────────────────────────────────
// `op(t, i, state)` is timed. `seed(sys)` returns the state it hands to `op`.

const CASES = [
  // create — one row per call
  { name: 'create/bare',        floor: null,           schema: item(),
    op: (t, i) => t.item.create({ data: { workspaceId: 1, ownerId: 1, title: `t${i}` } }) },
  { name: 'create/tenancy-row', floor: 'create/bare',  schema: item({ head: TENANCY }),
    op: (t, i) => t.item.create({ data: { ownerId: 1, title: `t${i}` } }) },
  { name: 'create/allow',       floor: 'create/bare',  schema: item({ rules: `@@allow('create', auth() != null)\n  ${ROW_POLICY}` }),
    op: (t, i) => t.item.create({ data: { workspaceId: 1, ownerId: 1, title: `t${i}` } }) },
  { name: 'create/version',     floor: 'create/bare',  schema: item({ extra: 'version Int @version' }),
    op: (t, i) => t.item.create({ data: { workspaceId: 1, ownerId: 1, title: `t${i}` } }) },
  { name: 'create/log-audit',   floor: 'create/bare',  schema: item({ head: AUDIT_DB, rules: '@@log(audit)' }),
    op: (t, i) => t.item.create({ data: { workspaceId: 1, ownerId: 1, title: `t${i}` } }) },
  { name: 'create/unique',      floor: 'create/bare',  schema: item({ extra: 'email String @unique' }),
    op: (t, i) => t.item.create({ data: { workspaceId: 1, ownerId: 1, title: `t${i}`, email: `e${i}@x.test` } }) },
  { name: 'create/softdelete-unique', floor: 'create/unique',
    schema: item({ extra: 'email String @unique\n  deletedAt DateTime?', rules: '@@softDelete' }),
    op: (t, i) => t.item.create({ data: { workspaceId: 1, ownerId: 1, title: `t${i}`, email: `e${i}@x.test` } }) },

  // update — one seeded row per call, draft → review
  { name: 'update/bare',        floor: null,           schema: item(), seed: (sys) => sys.item.createMany({ data: rowsFor(WRITES + COUNTED) }),
    op: (t, i) => t.item.update({ where: { id: i + 1 }, data: { status: 'review' } }) },
  { name: 'update/transitions', floor: 'update/bare',  schema: item({ rules: TRANSITION }), seed: (sys) => sys.item.createMany({ data: rowsFor(WRITES + COUNTED) }),
    op: (t, i) => t.item.update({ where: { id: i + 1 }, data: { status: 'review' } }) },
  { name: 'update/version',     floor: 'update/bare',  schema: item({ extra: 'version Int @version' }),
    seed: async (sys) => {
      await sys.item.createMany({ data: rowsFor(WRITES + COUNTED) })
      const rows = await sys.item.findMany({ select: { id: true, version: true } })
      return new Map(rows.map(r => [r.id, r.version]))
    },
    op: (t, i, versions) => t.item.update({ where: { id: i + 1 }, data: { status: 'review', version: versions.get(i + 1) } }) },

  // $audit — no floor: it is a call nothing else makes
  { name: 'audit/$audit',       floor: null,           schema: item({ head: AUDIT_DB }),
    op: (t, i) => t.$audit({ operation: 'bench.event', model: 'Item', records: [i], meta: { i } }) },

  // read — 100 of 5,000 rows per call
  { name: 'read/bare',          floor: null,           schema: item(), seed: seedItems, reads: true,
    op: (t) => t.item.findMany({ limit: 100 }) },
  { name: 'read/allow',         floor: 'read/bare',    schema: item({ rules: ROW_POLICY }), seed: seedItems, reads: true,
    op: (t) => t.item.findMany({ limit: 100 }) },
  { name: 'read/tenancy-row',   floor: 'read/bare',    schema: item({ head: TENANCY }), seed: seedItems, reads: true,
    op: (t) => t.item.findMany({ limit: 100 }) },
  { name: 'read/computed',      floor: 'read/bare',    schema: item({ extra: 'label String @computed' }), seed: seedItems, reads: true,
    computed: { Item: { label: { needs: ['title', 'status'], compute: r => `${r.title} (${r.status})` } } },
    op: (t) => t.item.findMany({ limit: 100 }) },
  { name: 'read/from-count',    floor: 'read/from-bare', reads: true, n: 50,
    schema: item({ extra: 'lines Line[]\n  lineCount Int @from(Line, count: true)', head: `model Line {\n  id Int @id\n  itemId Int\n  item Item @relation(fields: [itemId], references: [id])\n}` }),
    seed: seedWithLines, op: (t) => t.item.findMany({ limit: 100 }) },
  { name: 'read/from-count-indexed', floor: 'read/from-bare', reads: true,
    schema: item({ extra: 'lines Line[]\n  lineCount Int @from(Line, count: true)', head: `model Line {\n  id Int @id\n  itemId Int\n  item Item @relation(fields: [itemId], references: [id])\n  @@index([itemId])\n}` }),
    seed: seedWithLines, op: (t) => t.item.findMany({ limit: 100 }) },
  { name: 'read/from-bare',     floor: null,           reads: true,
    schema: item({ extra: 'lines Line[]', head: `model Line {\n  id Int @id\n  itemId Int\n  item Item @relation(fields: [itemId], references: [id])\n}` }),
    seed: seedWithLines, op: (t) => t.item.findMany({ limit: 100 }) },

  ...[1, 2, 3].flatMap(depth => [
    { name: `read/chain-${depth}-bare`,  floor: null, reads: true, schema: chain(depth, false),
      seed: (sys) => seedChain(sys, depth), op: (t) => t.item.findMany({ limit: 100 }) },
    { name: `read/chain-${depth}-check`, floor: `read/chain-${depth}-bare`, reads: true, schema: chain(depth, true),
      seed: (sys) => seedChain(sys, depth), op: (t) => t.item.findMany({ limit: 100 }) },
  ]),
]

async function seedWithLines(sys) {
  await seedItems(sys)
  await sys.line.createMany({ data: Array.from({ length: SEEDED }, (_, i) => ({ itemId: (i % 500) + 1 })) })
}

// ─── harness ──────────────────────────────────────────────────────────────────

const byName   = new Map(CASES.map(c => [c.name, c]))
const selected = new Set()
for (const c of CASES) {
  if (!c.name.includes(filter)) continue
  selected.add(c.name)
  for (let f = c.floor; f; f = byName.get(f).floor) selected.add(f)
}
const running = CASES.filter(c => selected.has(c.name))

/** One measurement of one case: µs/op, statements/op, rows/op. */
async function measure(c) {
  const db  = await createClient({ schema: c.schema, db: ':memory:', computed: c.computed, claims: ['workspaceId'] })
  const sys = db.asSystem()
  const state = c.seed ? await c.seed(sys) : undefined
  const t   = c.name.startsWith('audit/') ? db : db.$setAuth(who)
  const n   = c.n ?? (c.reads ? READS : WRITES)

  // Update cases consume rows by id, so the warm pass and the counted pass
  // must not reuse the ids the timed loop will write.
  const warm = c.reads ? 50 : 0
  for (let i = 0; i < warm; i++) await c.op(t, i, state)

  const t0 = performance.now()
  for (let i = 0; i < n; i++) await c.op(t, i, state)
  await tick()
  const us = (performance.now() - t0) / n * 1000

  let statements = 0
  const untap = db.$tapQuery(() => { statements++ })
  let rows = 0
  for (let i = n; i < n + COUNTED; i++) {
    const r = await c.op(t, i, state)
    if (Array.isArray(r)) rows += r.length
  }
  await tick()
  untap()
  db.$close()
  return { us, statements: statements / COUNTED, rows: c.reads ? rows / COUNTED : null }
}

const results = new Map(running.map(c => [c.name, { samples: [], statements: 0, rows: null, error: null }]))

for (let round = 0; round < ROUNDS; round++) {
  for (const c of running) {
    const r = results.get(c.name)
    if (r.error) continue
    try {
      const m = await measure(c)
      r.samples.push(m.us)
      r.statements = m.statements
      r.rows = m.rows
    } catch (e) {
      r.error = String(e.message).split('\n')[0]
    }
  }
  if (!asJson) process.stderr.write(`round ${round + 1}/${ROUNDS}\n`)
}

rmSync(DIR, { recursive: true, force: true })

// ─── report ───────────────────────────────────────────────────────────────────

// A delta smaller than the spread of the two cases it subtracts is not a finding.
// The spread is median minus min: how far a typical round sat above the best one.
for (const r of results.values()) {
  const s  = [...r.samples].sort((a, b) => a - b)
  r.min    = s[0]
  r.spread = s.length ? s[Math.floor(s.length / 2)] - s[0] : 0
}

const rowsOut = running.map(c => {
  const r      = results.get(c.name)
  const floor  = c.floor ? results.get(c.floor) : null
  const delta  = floor && !floor.error && !r.error ? r.min - floor.min : null
  const noise  = delta === null ? null : r.spread + floor.spread
  return {
    case:       c.name,
    floor:      c.floor,
    usPerOp:    r.error ? null : +r.min.toFixed(2),
    spreadUs:   r.error ? null : +r.spread.toFixed(2),
    deltaUs:    delta === null ? null : +delta.toFixed(2),
    deltaPct:   delta === null ? null : +(delta / floor.min * 100).toFixed(1),
    withinNoise: delta === null ? null : Math.abs(delta) <= noise,
    statements: r.error ? null : r.statements,
    rows:       r.rows,
    error:      r.error,
  }
})

const failed = rowsOut.filter(r => r.error)

if (asJson) {
  console.log(JSON.stringify({ rounds: ROUNDS, declared: CASES.length, ran: running.length, cases: rowsOut }, null, 2))
} else {
  const pad = (v, w) => String(v ?? '—').padStart(w)
  console.log(`\n${'case'.padEnd(28)} ${pad('µs/op', 9)} ${pad('±', 6)} ${pad('Δ µs', 8)} ${pad('Δ %', 7)} ${pad('stmts', 6)} ${pad('rows', 5)}  floor`)
  for (const r of rowsOut) {
    if (r.error) { console.log(`${r.case.padEnd(28)} FAILED  ${r.error}`); continue }
    const mark = r.withinNoise ? '~' : ' '
    console.log(`${r.case.padEnd(28)} ${pad(r.usPerOp, 9)} ${pad(r.spreadUs, 6)} ${pad(r.deltaUs, 8)} ${pad(r.deltaPct, 7)}${mark}${pad(r.statements, 5)} ${pad(r.rows, 5)}  ${r.floor ?? ''}`)
  }
  console.log(`\n${running.length} of ${CASES.length} cases ran, ${ROUNDS} rounds, min reported, ~ = delta inside the two cases' spread${failed.length ? ` — ${failed.length} FAILED` : ''}`)
}

process.exit(failed.length ? 1 : 0)
