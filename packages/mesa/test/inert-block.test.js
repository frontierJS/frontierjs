// inert-block.test.js
//
// `$: { }` runs code. If the body provably does nothing — every statement is a
// bare read — the author reached for braces to express a watch and got silence:
// effects don't drive renders in Mesa, so an effect with no side effect is
// unobservable. Verified: an effect subscribing to a signal a template also
// reads causes zero extra renders.
//
// This is now reported. Previously it was worse than either alternative:
//
//   $: { (a, b) }
//     → orderedGroup([{ deps: [a], handler: <the VALUE of b> }])
//     → "fn is not a function" the first time `a` changed
//
// The parenthesised sequence and the handler shorthand have identical ASTs —
// `{ (a, b) }` and `{ a, syncFn }` are both SequenceExpressions with an
// Identifier tail — so the parens are the only thing distinguishing them, and
// the check reads them from source position. See RULE 14b.

import { describe, test, expect } from 'vitest'
import { compileSource } from '../src/compiler.js'

async function inertErrors(script) {
  const ctx = await compileSource(
    `<script>\n${script}\n</script><p>{1}</p>`,
    { filename: '/t/T.mesa', dev: false }
  )
  return (ctx.analysis?.errors ?? []).filter(e => /does nothing|is empty/.test(e))
}

describe('inert blocks are reported', () => {

  test('empty block', async () => {
    const e = await inertErrors(`let a = 1\n$: { }`)
    expect(e).toHaveLength(1)
    expect(e[0]).toContain('is empty')
  })

  test('parenthesised sequence — the case that used to throw at runtime', async () => {
    const e = await inertErrors(`let a = 1, b = 2\n$: { (a, b) }`)
    expect(e).toHaveLength(1)
    expect(e[0]).toContain('does nothing')
    // The message should point at the form they wanted.
    expect(e[0]).toContain('$: (a, b)')
  })

  test('single bare identifier', async () => {
    expect(await inertErrors(`let count = 1\n$: { count }`)).toHaveLength(1)
  })

  test('bare member read on an import', async () => {
    // Doubly useless: no side effect, and no path watch registered either.
    const e = await inertErrors(`import { cart } from './s.js'\n$: { cart.total }`)
    expect(e).toHaveLength(1)
    expect(e[0]).toContain('$: cart.total')
  })

  test('optional chaining is still a bare read', async () => {
    expect(await inertErrors(`import { cart } from './s.js'\n$: { cart?.total }`)).toHaveLength(1)
  })
})

describe('blocks that do something are left alone', () => {

  const ok = [
    ['a call',                `function fn(){}\n$: { fn() }`],
    ['an update',             `let x = 1\n$: { x++ }`],
    ['an assignment',         `let t = 'a'\n$: { document.title = t }`],
    ['a conditional',         `let a = 1\nfunction f(){}\n$: { if (a) f() }`],
    ['watch + arrow handler', `let a = 1\nfunction f(){}\n$: { a, () => f() }`],
    ['multi-dep + handler',   `let a=1,b=2\nfunction f(){}\n$: { (a, b), () => f() }`],
    ['ordered group',         `let a=1\nfunction f(){}\nfunction g(){}\n$: {\n  a, () => f()\n  a, () => g()\n}`],
  ]

  for (const [label, script] of ok) {
    test(label, async () => {
      expect(await inertErrors(script)).toEqual([])
    })
  }
})

describe('handlers inside a block must be inline functions', () => {

  // `{ a, syncFn }` and `{ a, b }` have identical ASTs, so the reference
  // shorthand cannot coexist with detecting a bare multi-value read. Blocks
  // require `() =>`; the unbraced form keeps the shorthand.

  test('a function reference is rejected', async () => {
    const e = await inertErrors(`let a = 1\nfunction syncFn(){}\n$: { a, syncFn }`)
    expect(e).toHaveLength(1)
    expect(e[0]).toContain('must be an inline')
    // The message covers both readings, since they are indistinguishable.
    expect(e[0]).toContain('() => syncFn()')
    expect(e[0]).toContain('$: (a, syncFn)')
  })

  test('a bare pair of values gets the same message', async () => {
    const e = await inertErrors(`let a = 1, b = 2\n$: { a, b }`)
    expect(e).toHaveLength(1)
    expect(e[0]).toContain('must be an inline')
  })

  test('an inline arrow is accepted', async () => {
    expect(await inertErrors(`let a = 1\nfunction f(){}\n$: { a, () => f() }`)).toEqual([])
  })

  test('a function expression is accepted', async () => {
    expect(await inertErrors(`let a = 1\nfunction f(){}\n$: { a, function(){ f() } }`)).toEqual([])
  })

  test('the unbraced form keeps the reference shorthand', async () => {
    expect(await inertErrors(`let a = 1\nfunction syncFn(){}\n$: a, syncFn`)).toEqual([])
  })

  test('a parenthesised sequence gets the watch-oriented message instead', async () => {
    const e = await inertErrors(`let a = 1, b = 2\n$: { (a, b) }`)
    expect(e[0]).not.toContain('must be an inline')
    expect(e[0]).toContain('$: (a, b)')
  })
})

describe('the unbraced forms are unaffected', () => {

  test('$: (a, b) is a multi-path watch, not inert', async () => {
    expect(await inertErrors(`let a = 1, b = 2\n$: (a, b)`)).toEqual([])
  })

  test('$: cart.total is a path watch, not inert', async () => {
    expect(await inertErrors(`import { cart } from './s.js'\n$: cart.total`)).toEqual([])
  })

  test('$: count is a watch, not inert', async () => {
    expect(await inertErrors(`let count = 1\n$: count`)).toEqual([])
  })
})

describe('compilation still succeeds', () => {

  test('an inert block reports but does not abort the build', async () => {
    // analysis.errors surface as warnings in Mesa today — see the note in
    // CHANGES.md about whether they should be fatal.
    const ctx = await compileSource(
      `<script>let a = 1, b = 2\n$: { (a, b) }</script><p>{a}</p>`,
      { filename: '/t/T.mesa', dev: false }
    )
    expect(ctx.result).toBeTruthy()
  })

  test('and no longer emits the throwing orderedGroup', async () => {
    const ctx = await compileSource(
      `<script>let a = 1, b = 2\n$: { (a, b) }</script><p>{a}</p>`,
      { filename: '/t/T.mesa', dev: false }
    )
    expect(ctx.result).not.toContain('orderedGroup')
  })
})
