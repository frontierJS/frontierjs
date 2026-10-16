/*
 * statements.mjs — the SQL a request costs, counted over `example`'s schema.
 *
 *   bun bench/statements.mjs              run the workload, fail on a rise
 *   bun bench/statements.mjs --update     write the numbers that went DOWN into bench.baseline.json
 *   bun bench/statements.mjs --adopt      write every number, raises included
 *   bun bench/statements.mjs --why        print each failed request's refusal
 *   bun bench/statements.mjs --all        print every churned statement, whole
 *
 * The gated quantities `IDEAS/performance-regression-watch.md` names for this
 * package — prepared-statement shapes per request, and statement-cache
 * evictions over `example`. Both are counts, so they repeat on any machine.
 *
 *   shapes.<kind>   distinct SQL texts one kind of request issued, summed over
 *                   every model and principal. A rise is a request that got
 *                   more statements, or a statement whose text varies
 *   shapes.total    distinct cacheable texts over the whole workload — what a
 *                   process serving every screen holds against the 500-entry
 *                   statement cache in `src/core/databases.js`
 *   churn           shapes first seen on the second pass, which repeats the
 *                   first with other ids, other limits and another user at the
 *                   same level. Each one is a value or a principal that entered
 *                   the SQL text, so the cache cannot hold the hot set
 *   evictions       cached statements the LRU finalized before close
 *   failed          requests that threw
 *   unseeded        models whose fixture failed to build
 *   unasked         requests skipped for want of a row or a writable field
 *
 * The last three are gated because each one shrinks the workload, and a
 * smaller workload issues fewer statements and reads as an improvement.
 *
 * Counted at the engine seam: a `setEngine` wrapper around bun:sqlite sees
 * every connection the client opens, read and write, so nothing is trusted to
 * report itself. The ratchet is `packages/cli/core/bench.js`'s, the one every
 * byte gate uses — `--update` cannot raise a number and `--adopt` is the verb
 * that can (root Invariant 14's shape). A model added to `example` moves these
 * with nothing wrong, and `--adopt` is the answer then.
 */
import { join }                                            from 'node:path'
import { fileURLToPath }                                   from 'node:url'
import { setEngine }                                       from '../src/core/engine.js'
import { NO_CACHE, SINGLE_USE }                            from '../src/core/databases.js'
import bunSqlite                                           from '../src/engines/bun-sqlite.js'
import { createTestEnv }                                   from '../src/testing.js'
import { ratchet, readBaseline, writeBaseline }            from '../../cli/core/bench.js'

const HERE   = fileURLToPath(new URL('.', import.meta.url))
const SCHEMA = join(HERE, '../../../example/db/schema.lite')

const argv = process.argv.slice(2)
const flag = (f) => argv.includes(f)

// ─── the counting engine ─────────────────────────────────────────────────────

// wrapDb keeps NO_CACHE out of its cache because a savepoint's name counts up,
// so each is new text by design and is not a shape; SINGLE_USE is an EXPLAIN,
// finalized after its one call.

let counting  = false
let bucket    = null
let evictions = 0
const executed = []   // [bucket, sql] per execution while counting

function wrapStatement(st, sql) {
  for (const m of ['all', 'get', 'run', 'values', 'iterate']) {
    const o = st[m]
    if (typeof o !== 'function') continue
    st[m] = function (...a) { if (counting) executed.push([bucket, sql]); return o.apply(this, a) }
  }
  const fin = st.finalize
  if (typeof fin === 'function') st.finalize = function () { if (counting && !SINGLE_USE.test(sql)) evictions++; return fin.call(this) }
  return st
}

setEngine(Object.assign(Object.create(bunSqlite), {
  name: 'bun:sqlite (counting)',
  open(path, options) {
    const raw = bunSqlite.open(path, options)
    for (const m of ['prepare', 'query']) {
      const orig = raw[m]
      raw[m] = function (sql, ...r) { return wrapStatement(orig.call(this, sql, ...r), String(sql)) }
    }
    return raw
  },
}))

// ─── the app ─────────────────────────────────────────────────────────────────

const env = await createTestEnv({
  schema:        SCHEMA,
  autoFactories: true,
  seed:          1,
  now:           '2026-06-01T12:00:00.000Z',
  encryptionKey: 'deadbeef'.repeat(8),
})

const byAccessor = new Map(env.schema.models.map(m => [m.name[0].toLowerCase() + m.name.slice(1), m]))
const modelNames = new Set(env.schema.models.map(m => m.name))
const accessors  = Object.keys(env.factories).filter(a => byAccessor.has(a)).sort()

// A fixture that fails to build is a fixture, not a measurement; it is the same
// failure on every run because the factories are seeded.
let seeded = 0
await env.setup(async ({ factories }) => {
  for (const a of accessors) { try { await factories[a].createMany(3); seeded++ } catch {} }
  await factories.user.createMany(2)
})
const [userA, userB] = await env.system.user.findMany({ orderBy: { id: 'desc' }, limit: 2 })

// A field the patch request can write back unchanged: any refusal it meets is
// the access rule, never the value.
const UNWRITABLE = new Set(['id', 'unique', 'immutable', 'guarded', 'system', 'computed', 'from', 'derived',
  'updatedAt', 'encrypted', 'secret', 'hashed', 'generated', 'personal', 'sequence'])
const patchField = (model) => model.fields.find(f =>
  f.type.kind === 'scalar' && !f.type.array && ['String', 'Int', 'Boolean'].includes(f.type.name) &&
  !f.attributes.some(a => UNWRITABLE.has(a.kind)))

const relationsOf = (model) => model.fields.filter(f => modelNames.has(f.type.name)).map(f => f.name)

// ─── the workload ────────────────────────────────────────────────────────────

const KINDS = ['list', 'get', 'count', 'include', 'patch', 'create']
let requests = 0, failed = 0, unasked = 0

async function request(kind, fn) {
  bucket = kind
  requests++
  try { await fn() } catch (e) { failed++; if (flag('--why')) console.log(`  ${kind}\t${String(e?.message).split('\n')[0]}`) }
  // The audit logger writes on setImmediate, and its statements belong to the
  // write that caused them rather than to the next request.
  await new Promise(r => setImmediate(r))
  await new Promise(r => setImmediate(r))
}

async function pass(n, principal) {
  for (const a of accessors) {
    const model = byAccessor.get(a)
    const pk    = env.db.$primaryKey(a)
    const key   = Array.isArray(pk) ? (pk.length === 1 ? pk[0] : null) : pk
    const row   = key ? (await env.system[a].findMany({ orderBy: { [key]: 'asc' }, limit: 2 }))[n] : null
    const rels  = relationsOf(model)
    const field = patchField(model)

    for (const [who, db] of [['system', env.system], ['user', principal]]) {
      await request('list',  () => db[a].findMany({ limit: 20 + n, offset: n, ...(key && { orderBy: { [key]: 'asc' } }) }))
      await request('count', () => db[a].count())
      if (row) await request('get', () => db[a].findUnique({ where: { [key]: row[key] } }))
      else unasked++
      if (rels.length) await request('include', () => db[a].findMany({ limit: 5 + n, include: Object.fromEntries(rels.map(r => [r, true])) }))
      if (row && field) await request('patch', () => db[a].update({ where: { [key]: row[key] }, data: { [field.name]: row[field.name] } }))
      else unasked++
      if (who === 'system') await request('create', () => env.factories[a].asSystem().createOne())
    }
  }
}

// ─── main ────────────────────────────────────────────────────────────────────

const firstSeen = new Map()   // sql → pass it first executed in
const shapes    = Object.fromEntries(KINDS.map(k => [k, new Set()]))

counting = true
for (const n of [0, 1]) {
  const from = executed.length
  await pass(n, env.actingAs(n === 0 ? userA : userB))
  for (const [kind, sql] of executed.slice(from)) {
    if (NO_CACHE.test(sql) || SINGLE_USE.test(sql)) continue
    shapes[kind]?.add(sql)
    if (!firstSeen.has(sql)) firstSeen.set(sql, n)
  }
}
counting = false
const churned = [...firstSeen].filter(([, n]) => n === 1).map(([sql]) => sql)
env.close()

const current = {
  ...Object.fromEntries(KINDS.map(k => [`shapes.${k}`, shapes[k].size])),
  'shapes.total': firstSeen.size,
  churn:          churned.length,
  evictions,
  failed,
  unseeded:       accessors.length - seeded,
  unasked,
}

// ─── report ──────────────────────────────────────────────────────────────────

const failures = []
// A schema that loads no models, or a workload that asked nothing, reads as a
// clean run unless it is refused.
if (!accessors.length) failures.push(`${SCHEMA} gave no SQLite models`)
if (!requests)         failures.push('the workload ran no request')

console.log(`\nexample: ${accessors.length} models, ${seeded} seeded, ${requests} requests, ${unasked} not asked (no row, or no writable field)`)
for (const [k, v] of Object.entries(current)) console.log(`  ${k.padEnd(16)}${String(v).padStart(6)}`)
// Churn below the IN_INLINE arity in query.js is by design: one statement per
// list length up to it, then one json_each form at every length.
if (churned.length) {
  const all = flag('--all')
  console.log(`\n  churned — text that differed on the second pass${all ? '' : ' (--all for every one)'}:`)
  for (const sql of churned.slice(0, all ? Infinity : 5)) console.log(`    ${sql.replace(/\s+/g, ' ').slice(0, all ? Infinity : 160)}`)
}

const baseline = readBaseline(HERE)
const verdict  = ratchet(current, baseline)
const first    = !Object.keys(baseline).length

console.log('')
for (const r of verdict.regressions)  console.log(`  raised    ${r.key} ${r.was} → ${r.now}`)
for (const r of verdict.improvements) console.log(`  lowered   ${r.key} ${r.was} → ${r.now}`)
if (!first) for (const r of verdict.unbaselined) console.log(`  new       ${r.key} ${r.value}`)
for (const k of verdict.unmeasured)   console.log(`  unmeasured ${k} — kept at ${baseline[k]}`)

if (failures.length) {
  console.log('baseline not written: the run failed its checks')
} else if (first || flag('--adopt')) {
  writeBaseline(HERE, verdict.adopted)
  console.log(`baseline ${first ? 'written' : 'adopted'} — bench/bench.baseline.json`)
} else if (flag('--update') && (verdict.improvements.length || verdict.unbaselined.length)) {
  writeBaseline(HERE, verdict.next)
  console.log('baseline updated with the improvements')
} else if (verdict.improvements.length || verdict.unbaselined.length) {
  console.log('  `--update` writes the improvements back')
}
if (verdict.regressions.length && !flag('--adopt'))
  failures.push(`${verdict.regressions.length} number(s) rose — fix it, or \`--adopt\` with the reason in the commit message`)

for (const f of failures) console.log(`  ✗ ${f}`)
process.exit(failures.length ? 1 : 0)
