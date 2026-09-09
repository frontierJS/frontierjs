/**
 * tests/filter-operators-real.mjs — the operator a filter bar asks with,
 * graded against the boundary that answers it. Run with bun:
 *
 *     bun run test:safety
 *
 * ── Why this is not in the vitest suite ───────────────────────────────────
 *
 * The same reason as `static-safety-real.mjs` beside it: Litestone imports
 * `bun:sqlite` and Sierra's suite runs under Node. A fake boundary here would
 * be worse than useless — it would agree with whatever this package's table
 * says, and agreement is the entire thing under test.
 *
 * ── What is under test ────────────────────────────────────────────────────
 *
 * `filterOpFor(display)` is a table in Sierra and `buildWhere` is the runtime
 * half in Litestone: **two statements of one rule**, which is the shape that
 * drifts. A bar deriving `contains` for a kind the boundary refuses offers a
 * filter that comes back 400. The quieter half is an operator that is LEGAL
 * and wrong — `equals` where `contains` was meant returns a smaller answer
 * that looks like a real one.
 *
 * So this is an ORACLE. Every operator the table hands out is put to a real
 * client over a column of that kind, and every kind the table refuses is
 * asserted to be refused by the boundary too, in the boundary's own words.
 *
 * The pairing is the point: a table that offered nothing would satisfy every
 * refusal row on its own, and one that offered `contains` everywhere would
 * satisfy every acceptance row.
 *
 * Exits non-zero on the first failure.
 */

import { createClient, parse, generateJsonSchema } from '@frontierjs/litestone'
import { buildFieldRules, displayFor, filterOpFor } from '../src/junction/field-rules.js'

let passed = 0
const failures = []

async function check(name, fn) {
  try { await fn(); passed++; console.log(`  ok    ${name}`) }
  catch (err) { failures.push({ name, err }); console.log(`  FAIL  ${name}\n        ${err.message}`) }
}
function assert(cond, msg) { if (!cond) throw new Error(msg) }

const SRC = `
database main { path ":memory:" }

enum Kind { one two }

model Doc {
  id     Int      @id @default(autoincrement())
  title  String
  n      Int
  price  Int      @money(USD)
  kind   Kind     @default(one)
  flag   Boolean  @default(false)
  meta   Json?
  tags   String[]
  when   DateTime @default(now())
}
`

const defs   = generateJsonSchema(parse(SRC).schema, { mode: 'full' }).$defs
const deref  = (ref) => defs[String(ref).split('/').pop()]
const fields = buildFieldRules(defs.Doc, deref)

const displayOf = (name) => displayFor(fields[name], { field: name, model: 'Doc' }).display
const filterOf  = (name) => filterOpFor(displayOf(name))

const db  = await createClient({ schema: SRC })
const sys = db.asSystem()

/** Does the boundary take this where clause? Its own answer, never a guess. */
async function accepts(where) {
  try { await sys.doc.findMany({ where }); return { ok: true, message: '' } }
  catch (e) { return { ok: false, message: String(e?.message ?? e) } }
}

// A value the column legitimately holds, for the operator under test.
const SAMPLE = {
  title: 'x', n: 1, price: 100, kind: 'one', flag: true,
  when: new Date().toISOString(), tags: ['a'],
}

// ─── every operator the table hands out, the boundary takes ──────────────────

for (const name of ['title', 'n', 'price', 'kind', 'flag', 'tags', 'when']) {
  await check(`${name} — the ${displayOf(name)} filter compiles`, async () => {
    const f = filterOf(name)
    assert(f?.op, `${name} has no operator`)

    for (const op of [].concat(f.op)) {
      const operand = f.kind === 'set' && !Array.isArray(SAMPLE[name]) ? [SAMPLE[name]] : SAMPLE[name]
      const answer  = await accepts({ [name]: { [op]: operand } })
      assert(answer.ok, `${name}.${op} was refused — ${answer.message}`)
    }
  })
}

// ─── every kind the table refuses, the boundary refuses too ──────────────────

await check('a Json column offers no filter, and asking anyway is refused by name', async () => {
  const f = filterOf('meta')
  assert(f.op === null, 'a Json column was offered a filter')
  assert(f.reason, 'the refusal carries no reason')

  const answer = await accepts({ meta: { contains: 'x' } })
  assert(!answer.ok, 'the boundary accepted a text match on a JSON document')
  assert(/JSON document/.test(answer.message), `refused for another reason: ${answer.message}`)
})

await check('an array column filters by ELEMENT, and the obvious wrong operator is refused', async () => {
  assert(filterOf('tags').op === 'hasSome', 'an array column was not offered hasSome')
  assert((await accepts({ tags: { hasSome: ['a'] } })).ok, 'hasSome was refused')

  const wrong = await accepts({ tags: { contains: 'a' } })
  assert(!wrong.ok, 'the boundary accepted a text match on an array')
  assert(/JSON array/.test(wrong.message), `refused for another reason: ${wrong.message}`)
})

await check('a boolean compares and does not match text', async () => {
  assert(filterOf('flag').op === 'equals', 'a boolean was not offered equals')

  const wrong = await accepts({ flag: { contains: 'true' } })
  assert(!wrong.ok, 'the boundary accepted a text match on a Boolean')
  assert(/Boolean/.test(wrong.message), `refused for another reason: ${wrong.message}`)
})

// ─── the table is not one answer wearing three names ─────────────────────────

await check('three integer-shaped columns get three different questions', async () => {
  // `price` and `n` are both integers and `title` is not, so a table answering
  // one operator everywhere passes every acceptance row above.
  const price = filterOf('price'), title = filterOf('title'), kind = filterOf('kind')
  assert(price.kind === 'range',  `price is ${price.kind}, not a range`)
  assert(title.kind === 'text',   `title is ${title.kind}, not text`)
  assert(kind.kind  === 'set',    `kind is ${kind.kind}, not a set`)
})

await check('a kind nothing named has no filter and says so', async () => {
  assert(filterOpFor(null) === null, 'an unnamed kind was offered a filter')
  assert(filterOpFor('duration') === null, 'an app-registered display name was offered one')
})

console.log(`\n  ${passed}/${passed + failures.length} passed\n`)
if (failures.length) process.exit(1)
