// ─── a flow expression, written as text ───────────────────────────────────────
//
// `compileExpression` parses the text with the same parser a `.lite` policy is
// parsed with (`FJS-D271`) and hands back what the resolver runs. Two halves are
// graded here and they fail differently:
//
//   VALUES   — a `$.` path, a call, a lambda — are the engine's, and a wrong one
//              shows up as a wrong answer.
//   CONDITIONS — are the predicate kit's, three-valued, and a wrong one shows up
//              as an edge that fires when a value was NULL. Those rows are the
//              reason the language is shared rather than copied: JavaScript
//              would answer `false` where SQL answers unknown, and `!false` is
//              `true` — an edge that fires on missing data.

import { describe, test, expect } from 'bun:test'
import { compileExpression } from '../../../src/engine/expression/text'
import { ExpressionResolver } from '../../../src/engine/expression/index'

const resolver = new ExpressionResolver()
const run = (src: string, ctx: { trigger?: unknown; nodes?: Record<string, unknown> } = {}) =>
  resolver.resolve(compileExpression(src), { trigger: ctx.trigger ?? null, nodes: ctx.nodes ?? {} })

const CART = {
  trigger: { body: { amount: 120, email: '  Ada@Example.COM ' } },
  nodes: {
    lead: { data: { tier: 'gold', owner: { id: 'u_1' } } },
    cart: { items: [{ price: 300, qty: 2 }, { price: 50, qty: 0 }, { price: 25, qty: 4 }] },
    empty: { value: null },
  },
}

describe('values', () => {
  test('a path reads the trigger and a node output, at any depth', () => {
    expect(run('$.trigger.body.amount', CART)).toBe(120)
    expect(run('$.lead.data.owner.id', CART)).toBe('u_1')
  })

  test('calls nest', () => {
    expect(run('lower(trim($.trigger.body.email))', CART)).toBe('ada@example.com')
    expect(run("last(split(lower(trim($.trigger.body.email)), '@'))", CART)).toBe('example.com')
  })

  test('map, filter and reduce take a lambda, and its parameter is a path', () => {
    expect(run('map($.cart.items, i => mul(i.price, i.qty))', CART)).toEqual([600, 0, 100])
    expect(run('filter($.cart.items, i => gt(i.qty, 0))', CART)).toEqual([
      { price: 300, qty: 2 }, { price: 25, qty: 4 },
    ])
    expect(run('reduce($.cart.items, 0, (acc, i) => add(acc, mul(i.price, i.qty)))', CART)).toBe(700)
  })

  test('a lambda parameter is in scope only inside its own body', () => {
    expect(() => compileExpression('add(i.price, map($.cart.items, i => i.price))'))
      .toThrow(/'i' is not defined here/)
  })

  test('a ternary picks a value', () => {
    expect(run("$.lead.data.tier == 'gold' ? 'vip' : 'standard'", CART)).toBe('vip')
  })
})

describe('conditions answer the way a policy does', () => {
  test('a comparison and the boolean operators', () => {
    expect(run("$.trigger.body.amount > 100 && $.lead.data.tier == 'gold'", CART)).toBe(true)
    expect(run("$.trigger.body.amount > 500 || $.lead.data.tier == 'gold'", CART)).toBe(true)
    expect(run("!($.lead.data.tier == 'gold')", CART)).toBe(false)
  })

  test('a comparison with a missing value is UNKNOWN, not false', () => {
    // SQL's answer, and the reason for sharing the language: `null > 1` is
    // unknown, so the negation is unknown too rather than flipping to true.
    expect(run('$.empty.value > 1', CART)).toBe(null)
    expect(run('!($.empty.value > 1)', CART)).toBe(null)
    expect(run('$.empty.value == null', CART)).toBe(true)
  })

  test('unknown AND false is false, unknown OR true is true', () => {
    expect(run('$.empty.value > 1 && $.trigger.body.amount > 500', CART)).toBe(false)
    expect(run('$.empty.value > 1 || $.trigger.body.amount > 100', CART)).toBe(true)
    expect(run('$.empty.value > 1 && $.trigger.body.amount > 100', CART)).toBe(null)
  })

  test('membership, and a call inside a condition', () => {
    expect(run("$.lead.data.tier in ['gold', 'platinum']", CART)).toBe(true)
    expect(run("lower(trim($.trigger.body.email)) == 'ada@example.com'", CART)).toBe(true)
  })

  test('a condition inside a ternary', () => {
    expect(run("$.empty.value > 1 ? 'yes' : 'no'", CART)).toBe('no')
  })
})

describe('refusals', () => {
  test('a bare name is not a column here', () => {
    expect(() => compileExpression("status == 'paid'")).toThrow(/'status' is not defined here/)
  })

  test("a policy's own words are refused by name", () => {
    expect(() => compileExpression('auth().id == 1')).toThrow(/belongs to a policy/)
    expect(() => compileExpression("check(owner, 'read')")).toThrow(/belongs to a policy/)
  })

  test('text after the expression is refused rather than ignored', () => {
    expect(() => compileExpression('$.a $.b')).toThrow(/Unexpected/)
  })

  test('an iterator without a lambda, and a lambda where none belongs', () => {
    expect(() => compileExpression('map($.cart.items)')).toThrow(/takes a lambda/)
    expect(() => compileExpression('upper($.a, i => i)')).toThrow(/does not take a lambda/)
    expect(() => compileExpression('reduce($.cart.items, i => i)')).toThrow(/accumulator|starting value/)
  })

  test('a refusal carries the position it failed at', () => {
    try {
      compileExpression("$.a == 'x' && status == 'y'")
      throw new Error('expected a refusal')
    } catch (err) {
      expect((err as Error).message).toMatch(/line 1, col 15/)
    }
  })
})

describe('the compiled shape', () => {
  test('a condition is one predicate node holding the parsed tree', () => {
    const compiled = compileExpression('$.a > 1') as { type: string; ast: any }
    expect(compiled.type).toBe('predicate')
    expect(compiled.ast.type).toBe('compare')
    expect(compiled.ast.left).toEqual({ type: 'hole', expr: { type: 'ref', path: '$.a' } })
    expect(compiled.ast.right).toEqual({ type: 'literal', value: 1 })
  })

  test('a value is the node the resolver already runs', () => {
    expect(compileExpression('map($.items, i => upper(i.name))')).toEqual({
      type: 'map',
      over: { type: 'ref', path: '$.items' },
      as:   'i',
      body: { type: 'fn', name: 'upper', args: [{ type: 'ref', path: '$.i.name' }] },
    })
  })
})

// `FJS-D513`: the two value-assembling forms of the shared grammar.
describe('template and object', () => {
  test('a template interpolates any expression, and a number or a ternary reads as text', () => {
    expect(run('`Hello, ${$.lead.data.tier}!`', CART)).toBe('Hello, gold!')
    expect(run('`${$.trigger.body.amount} units`', CART)).toBe('120 units')
    expect(run("`tier: ${$.lead.data.tier == 'gold' ? 'vip' : 'standard'}`", CART)).toBe('tier: vip')
    expect(run('`${upper(trim($.trigger.body.email))}`', CART)).toBe('ADA@EXAMPLE.COM')
  })

  test('a template compiles to the node the resolver already runs', () => {
    expect(compileExpression('`a ${$.x} b`')).toEqual({
      type: 'template',
      parts: [
        { type: 'literal', value: 'a ' },
        { type: 'ref', path: '$.x' },
        { type: 'literal', value: ' b' },
      ],
    })
    expect(compileExpression('``')).toEqual({ type: 'template', parts: [] })
  })

  test('escapes: a backslash, a backtick and a dollar-brace are text', () => {
    expect(run('`a \\${b} \\` \\\\`')).toBe('a ${b} ` \\')
    expect(run('`$5 and {x}`')).toBe('$5 and {x}')
  })

  test('a template nests, and a brace inside a string does not close a hole', () => {
    expect(run('`o ${`i ${$.lead.data.tier}`} e`', CART)).toBe('o i gold e')
    expect(run("`${'}'}`")).toBe('}')
  })

  test('an unclosed hole is refused with the position', () => {
    expect(() => compileExpression('`a ${$.x`')).toThrow(/Unterminated|unclosed/i)
    expect(() => compileExpression('`a ${}`')).toThrow(/line 1/)
    expect(() => compileExpression('`a ${$.x $.y}`')).toThrow(/line 1/)
  })

  test('an object builds from expressions, keys bare or quoted', () => {
    expect(run('{ title: `Lead ${$.lead.data.tier}`, n: $.trigger.body.amount, \'a key\': true }', CART))
      .toEqual({ title: 'Lead gold', n: 120, 'a key': true })
    expect(run('{}')).toEqual({})
    expect(compileExpression('{ a: 1 }')).toEqual({
      type: 'object',
      properties: { a: { type: 'literal', value: 1 } },
    })
  })

  test('an object refuses a repeated key and a key with no value', () => {
    expect(() => compileExpression('{ a: 1, a: 2 }')).toThrow(/'a'.*twice|repeated|duplicate/i)
    expect(() => compileExpression('{ a }')).toThrow(/line 1/)
  })

  test('an object may be a lambda body and a ternary branch', () => {
    expect(run('map($.cart.items, i => { total: mul(i.price, i.qty) })', CART))
      .toEqual([{ total: 600 }, { total: 0 }, { total: 100 }])
    expect(run("$.lead.data.tier == 'gold' ? { vip: true } : { vip: false }", CART)).toEqual({ vip: true })
  })

  test('inside a condition they are values the resolver fills', () => {
    expect(run("`x${$.lead.data.tier}` == 'xgold'", CART)).toBe(true)
  })
})
