// ─── an expression, written back out as text ──────────────────────────────────
//
// `expressionToText` is the inverse of `compileExpression`, and an emitter is a
// restatement of a grammar it does not own — so what is graded here is the
// ROUND TRIP rather than the spelling:
//
//   text → Expression → text → Expression, and the two trees must be equal.
//
// Structure and not string, because the failure this is shaped to catch is a
// dropped bracket: `a && (b || c)` emitted without its group still parses, and
// answers a different question. Comparing text would pass — the emitter's own
// output is its own input by then — and comparing the TREE cannot.
//
// The corpus is the parser's own test file plus every precedence pair, since a
// grammar's sharp edges are where two levels meet.

import { describe, test, expect } from 'bun:test'
import { compileExpression } from '../../../src/engine/expression/text'
import { expressionToText }  from '../../../src/engine/expression/emit'
import { ExpressionResolver } from '../../../src/engine/expression/index'

/** text → Expression → text → Expression. Answers both texts and both trees. */
function trip(src: string) {
  const first  = compileExpression(src)
  const { text, reason } = expressionToText(first)
  if (text === null) throw new Error(`no text form for ${src} — ${reason}`)
  const second = compileExpression(text)
  return { text, first, second }
}

const SOURCES = [
  // values
  '$',
  '$.trigger.body.amount',
  '$.lead.data.owner.id',
  "'a string'",
  "'it\\'s got a quote'",
  "'a backslash \\\\ and a quote \\' together'",
  '42',
  '-7',
  '3.5',
  'true',
  'false',
  'null',
  'lower(trim($.trigger.body.email))',
  "last(split(lower(trim($.trigger.body.email)), '@'))",
  'add(1, 2)',
  'map($.cart.items, i => mul(i.price, i.qty))',
  'filter($.cart.items, i => gt(i.qty, 0))',
  'reduce($.cart.items, 0, (acc, i) => add(acc, mul(i.price, i.qty)))',

  // the two value-assembling forms (`FJS-D513`)
  '``',
  '`plain`',
  '`Release failed: ${$.trigger.record.toImage}`',
  '`${$.a}${$.b}`',
  "`${'x'}${'y'}`",
  "`${$.a > 1 ? 'big' : 'small'} and ${upper($.name)}`",
  '`a \\${not a hole} and a \\` backtick and a \\\\ backslash`',
  '`outer ${`inner ${$.a}`} end`',
  "`brace in a string ${'}'} still closes`",
  '`${5}`',
  '{}',
  '{ title: `Lead ${$.lead.name}`, n: $.lead.score }',
  "{ 'a key': 1, b: { c: $.x } }",
  "map($.items, i => { id: i.id, label: `#${i.id}` })",
  '$.a == 1 ? { a: 1 } : { a: 2 }',
  '$.a > 1 && `x` == `x`',

  // array, pipe and let (`FJS-D1429`)
  '[$.a, $.b + 1]',
  "[$.a, 'x', [1, 2]]",
  "['a', 2]",
  '$.a in [$.b, $.c]',
  "$.name |> lower |> split(',')",
  '$.name |> lower()',
  '$.items |> map(i => $.i.price) |> sum',
  '$.items |> filter(i => $.i.qty > 0) |> reduce(0, (acc, i) => add($.acc, $.i.qty))',
  '$.items |> map($.other, i => $.i.v)',
  "$.a |> $ == 'x' ? 1 : 2",
  '$.a ? $.b : $.c |> lower',
  '($.a |> lower) == $.b',
  'upper($.a |> lower)',
  '$.a |> (let n = $; $.n)',
  'let n = $.items.length; n * 2',
  'let a = 1, b = a; [a, b]',
  'let a = $.x |> lower, b = upper(a); { a: a, b: b }',
  'let a = 1; let b = 2; add(a, b)',
  'let a = (let b = 1; b); a',
  '`${let a = 1; a}`',
  'map($.items, i => let d = $.i.qty * 2; d + 1)',

  // ternaries, including the nesting the grammar's right-associativity buys
  "$.lead.data.tier == 'gold' ? 'vip' : 'standard'",
  "$.a > 3 ? 'high' : $.a > 1 ? 'mid' : 'low'",
  "($.a ? 1 : 2) == 1",
  "$.a == ($.open ? $.x : $.y)",

  // conditions
  '$.trigger.body.amount > 100',
  "$.trigger.body.amount > 100 && $.lead.data.tier == 'gold'",
  "$.trigger.body.amount > 500 || $.lead.data.tier == 'gold'",
  "!($.lead.data.tier == 'gold')",
  '!!($.a > 1)',
  '$.empty.value == null',
  "$.lead.data.tier in ['gold', 'platinum']",
  '$.n in [1, 2, 3]',
  "lower(trim($.trigger.body.email)) == 'ada@example.com'",

  // every place two precedence levels meet
  '$.a > 1 && $.b > 2 && $.c > 3',
  '$.a > 1 || $.b > 2 || $.c > 3',
  '$.a > 1 && ($.b > 2 || $.c > 3)',
  '($.a > 1 || $.b > 2) && $.c > 3',
  '!($.a > 1 && $.b > 2)',
  '!($.a > 1) && $.b > 2',
  '$.a > 1 || $.b > 2 && $.c > 3',
  "$.a > 1 && $.b > 2 ? 'both' : 'not'",
  "($.a > 1 ? $.b : $.c) > 2",

  // arithmetic (FJS-D1365): * over + -, both left to right, all under a comparison
  '$.a + $.b * $.c',
  '($.a + $.b) * $.c',
  '$.a - ($.b - $.c)',
  '$.a - $.b - $.c',
  '$.a * ($.b * $.c)',
  '$.qty * $.price > 100',
  'round($.qty * $.price * 0.01)',
  '$.a * -1 + 2 == 1',
]

describe('the round trip', () => {
  for (const src of SOURCES) {
    test(src, () => {
      const { first, second } = trip(src)
      expect(second).toEqual(first)
    })
  }

  test('emitting twice is stable, so a field does not rewrite itself on every open', () => {
    for (const src of SOURCES) {
      const once  = trip(src).text
      const twice = expressionToText(compileExpression(once)).text
      expect(twice).toBe(once)
    }
  })
})

describe('a dropped bracket changes the answer, which is what the trip is for', () => {
  const resolver = new ExpressionResolver()
  const CTX = { trigger: null, nodes: { a: { v: 1 }, b: { v: 9 } } }
  const answer = (src: string) => resolver.resolve(compileExpression(src), CTX as never)

  test('the emitted text answers what the original answered', () => {
    for (const src of [
      '$.a.v > 0 && ($.b.v > 100 || $.a.v > 0)',
      '($.a.v > 100 || $.b.v > 0) && $.a.v > 100',
      '!($.a.v > 100 && $.b.v > 0)',
      "$.a.v > 0 && $.b.v > 0 ? 'both' : 'not'",
    ]) {
      expect(answer(expressionToText(compileExpression(src)).text!)).toEqual(answer(src))
    }
  })

  // The control, and it is the whole reason the trip compares TREES. `&&` binds
  // tighter than `||`, so dropping the group moves the second operand out of
  // the conjunction: with a false left side the grouped form is false and the
  // ungrouped one is whatever the trailing disjunct says. Without a pair that
  // actually disagrees, every assertion above is satisfied by an emitter that
  // brackets nothing.
  test('and the ungrouped spelling answers something else', () => {
    const grouped   = '$.a.v > 100 && ($.b.v > 100 || $.b.v > 0)'
    const ungrouped = '$.a.v > 100 && $.b.v > 100 || $.b.v > 0'
    expect(answer(grouped)).toBe(false)
    expect(answer(ungrouped)).toBe(true)
    // And the emitter writes the one that means what the tree means.
    expect(expressionToText(compileExpression(grouped)).text).toBe(grouped)
  })
})

describe('what has no text form says so rather than guessing', () => {
  const none = (expr: unknown) => expressionToText(expr as never)

  test('an array, a pipeline and a let no text re-parses to', () => {
    const one = { type: 'literal', value: 1 }
    for (const [expr, word] of [
      [{ type: 'array', items: [] },                             'empty array'],
      [{ type: 'array', items: [one, { type: 'literal', value: 'a' }] }, 'list'],
      [{ type: 'pipe',  steps: [] },                             'pipeline'],
      [{ type: 'pipe',  steps: [one] },                          'pipeline'],
      [{ type: 'pipe',  steps: [one, { type: 'fn', name: 'now', args: [] }] }, 'now'],
      [{ type: 'pipe',  steps: [one, { type: 'fn', name: 'null' }] }, 'null'],
      [{ type: 'let',   bindings: {}, body: one },               'let'],
      [{ type: 'let',   bindings: { 'a-b': one }, body: one },   'a-b'],
    ] as Array<[unknown, string]>) {
      const answered = none(expr)
      expect(answered.text).toBe(null)
      expect(answered.reason).toContain(word)
    }
  })

  test('a value the grammar cannot spell, wherever it sits', () => {
    // An object as a literal, an exponent the tokenizer reads digits-and-a-dot
    // for, and an empty list the parser refuses as matching nothing.
    expect(none({ type: 'literal', value: { a: 1 } }).text).toBe(null)
    expect(none({ type: 'literal', value: 1e21 }).text).toBe(null)
    expect(none({ type: 'literal', value: [] }).text).toBe(null)
    // …and it is refused from INSIDE a condition too, which is the case a
    // top-level check would miss.
    expect(none({
      type: 'predicate',
      ast: { type: 'compare', op: '==', left: { type: 'hole', expr: { type: 'ref', path: '$.a' } },
             right: { type: 'literal', value: { a: 1 } } },
    }).text).toBe(null)
  })

  test('a call to a word the grammar reads as something else', () => {
    // `now()` parses to a node the flow compiler does not accept and
    // `map(x)` to an iterator with no lambda, so emitting either would write
    // text this package refuses to read back.
    for (const name of ['now', 'auth', 'check', 'round', 'map', 'filter', 'reduce']) {
      expect(none({ type: 'fn', name, args: [] }).text).toBe(null)
    }
  })

  test('a path that is not a path', () => {
    expect(none({ type: 'ref', path: '$.a-b' }).text).toBe(null)
    expect(none({ type: 'ref', path: 'trigger.id' }).text).toBe(null)
  })
})

// The documents this repo's flows hold for the three forms (`FJS-2136`), as
// `test/engine/expression/index.test.ts` and the compiler's test store them.
// Each is emitted, re-parsed, and compared as a TREE.
describe('the stored array, pipe and let documents round-trip (FJS-D1429)', () => {
  const ref = (path: string) => ({ type: 'ref', path })
  const lit = (value: unknown) => ({ type: 'literal', value })
  const fn  = (name: string, args?: unknown[]) => (args ? { type: 'fn', name, args } : { type: 'fn', name })

  const DOCS: Array<[string, unknown, string]> = [
    ['array of mixed values', { type: 'array', items: [lit('static'), ref('$.parseLead.data.name'), ref('$.score.data.value')] },
      "['static', $.parseLead.data.name, $.score.data.value]"],
    ['array in a compiled config', { type: 'array', items: [ref('$.ghost.name'), lit('ok')] },
      "[$.ghost.name, 'ok']"],
    ['pipe of bare steps', { type: 'pipe', steps: [ref('$.trigger.body.email'), fn('lower'), fn('trim')] },
      '$.trigger.body.email |> lower |> trim'],
    ['pipe with an argument', { type: 'pipe', steps: [ref('$.trigger.body.email'), fn('split', [lit('@')]), fn('last')] },
      "$.trigger.body.email |> split('@') |> last"],
    ['pipe with a template step', { type: 'pipe', steps: [ref('$.parseLead.data.name'), fn('upper'),
      { type: 'template', parts: [lit('LEAD: '), ref('$')] }] },
      '$.parseLead.data.name |> upper |> `LEAD: ${$}`'],
    ['pipe with a map step', { type: 'pipe', steps: [
      ref('$.fetchProducts.data.Account.Order.Products'),
      { type: 'map', as: 'p', body: fn('mul', [ref('$.p.Price'), ref('$.p.Quantity')]) },
      fn('sum')] },
      '$.fetchProducts.data.Account.Order.Products |> map(p => mul($.p.Price, $.p.Quantity)) |> sum'],
    ['let over a pipe', { type: 'let',
      bindings: {
        domain: { type: 'pipe', steps: [ref('$.trigger.body.email'), fn('split', [lit('@')]), fn('last')] },
        upper:  fn('upper', [ref('$.trigger.body.name')]),
      },
      body: { type: 'object', properties: { domain: ref('$.domain'), upper: ref('$.upper') } } },
      "let domain = $.trigger.body.email |> split('@') |> last, upper = upper($.trigger.body.name); { domain: $.domain, upper: $.upper }"],
    ['let whose bindings read earlier ones', { type: 'let',
      bindings: { base: lit(10), double: fn('mul', [ref('$.base'), lit(2)]), quad: fn('mul', [ref('$.double'), lit(2)]) },
      body: ref('$.quad') },
      'let base = 10, double = mul($.base, 2), quad = mul($.double, 2); $.quad'],
  ]

  for (const [name, doc, text] of DOCS) {
    test(name, () => {
      expect(expressionToText(doc as never)).toEqual({ text })
      expect(compileExpression(text)).toEqual(doc as never)
    })
  }

  // Four stored documents have no text, and say why. `$.$` is the flowing value
  // spelled as a path, which the grammar writes `$`; an object literal and an
  // all-literal array have no spelling that re-parses to them.
  test('and the ones that cannot say so', () => {
    const nested = { type: 'array', items: [{ type: 'array', items: [lit(1), lit(2)] }, lit(3)] }
    const shadow = { type: 'let', bindings: { parseLead: lit({ data: { name: 'Shadowed' } }) }, body: ref('$.parseLead.data.name') }
    const dollar = { type: 'pipe', steps: [ref('$.a'), { type: 'template', parts: [lit('LEAD: '), ref('$.$')] }] }
    for (const doc of [{ type: 'array', items: [] }, nested, shadow, dollar, { type: 'pipe', steps: [lit(42)] }]) {
      const answered = expressionToText(doc as never)
      expect(answered.text).toBe(null)
      expect(answered.reason).toBeTruthy()
    }
  })
})

describe('what a stored definition actually holds', () => {
  // The shapes this repo's own flows are written with, as they are stored —
  // the inspector reads these and not text somebody typed.
  test('a literal, a ref and a condition off the seed', () => {
    expect(expressionToText({ type: 'literal', value: 'Deployment' })).toEqual({ text: "'Deployment'" })
    expect(expressionToText({ type: 'literal', value: ['update'] })).toEqual({ text: "['update']" })
    expect(expressionToText({ type: 'ref', path: '$.trigger.record.id' })).toEqual({ text: '$.trigger.record.id' })
    expect(expressionToText({
      type: 'fn', name: 'eq',
      args: [{ type: 'ref', path: '$.trigger.record.status' }, { type: 'literal', value: 'failed' }],
    })).toEqual({ text: "eq($.trigger.record.status, 'failed')" })
  })

  test('and so does the template beside them (FJS-D513)', () => {
    expect(expressionToText({
      type: 'template',
      parts: [{ type: 'literal', value: 'Release failed: ' }, { type: 'ref', path: '$.trigger.record.toImage' }],
    })).toEqual({ text: '`Release failed: ${$.trigger.record.toImage}`' })
  })

  test('an object writes its keys bare when it can and quoted when it must', () => {
    expect(expressionToText({
      type: 'object',
      properties: { title: { type: 'literal', value: 'x' }, 'a key': { type: 'ref', path: '$.a' } },
    })).toEqual({ text: "{ title: 'x', 'a key': $.a }" })
  })

  test('a template part that would merge with its neighbor stays a hole', () => {
    expect(expressionToText({
      type: 'template',
      parts: [{ type: 'literal', value: 'a' }, { type: 'literal', value: 'b' }],
    })).toEqual({ text: "`a${'b'}`" })
  })

  test('an empty key is quoted, since a bare one is not a name', () => {
    expect(expressionToText({
      type: 'object',
      properties: { '': { type: 'literal', value: 1 } },
    }).text).toBe("{ '': 1 }")
  })
})
