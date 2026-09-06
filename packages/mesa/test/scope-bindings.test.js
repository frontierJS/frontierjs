/**
 * scope-bindings.test.js
 *
 * FJS-831 — a partial reopen of FJS-465. `rewriteExpr` walks the script looking
 * for reads and writes of a reactive `let` and must not touch a name a nested
 * scope has rebound. It knew about function parameters and a block's own
 * `let`/`const`/`function`, and about nothing else, so a `catch (e)` beside a
 * `let e` was rewritten AT ITS BINDING SITE and emitted
 * `catch ($$runtime.get($$sig_e))` — which acorn refuses, from a compile that
 * reported no error at all (Invariant 15).
 *
 * The names involved — `e`, `err`, `msg`, `value`, `Item` — are exactly what a
 * component also has as state, which is why this is not an exotic shape.
 *
 * Every case is asserted the same way: the compile reports nothing, AND the
 * emitted module parses. The second half is the whole point — a test that only
 * checked `analysis.errors` passed against every one of these before the fix.
 *
 * Run: npx vitest run scope-bindings.test.js
 */

import { describe, it, expect } from 'vitest'
import * as acorn from 'acorn'
import { compile } from '../src/compiler.js'

async function emit(source) {
  const warnings = []
  const ctx = await compile(source, {
    filename: 'Scope.mesa',
    warning: (w) => warnings.push(w.message ?? String(w))
  })
  return { js: ctx.result, warnings, errors: ctx.analysis?.errors ?? [] }
}

/** Invariant 15 — acorn is the compiler's own parser. */
function parses(js) {
  acorn.parse(js, { sourceType: 'module', ecmaVersion: 'latest' })
  return true
}

async function clean(source) {
  const { js, errors } = await emit(source)
  expect(errors).toEqual([])
  expect(() => parses(js)).not.toThrow()
  return js
}

describe('a binding the rewriter must not touch', () => {
  it('a catch parameter shadowing a reactive let', async () => {
    const js = await clean(
      '<script>\nlet e = 1\nfunction go() { try { throw 1 } catch (e) { return e } }\n</script>' +
      '<b on:click={go}>{e}</b>'
    )
    expect(js).not.toContain('catch ($$runtime.get')
  })

  it('a destructured catch parameter', async () => {
    await clean(
      '<script>\nlet msg = 1\nfunction go() { try { throw 1 } catch ({ message: msg }) { return msg } }\n</script>' +
      '<b on:click={go}>{msg}</b>'
    )
  })

  it('a class declared inside a function body', async () => {
    const js = await clean(
      '<script>\nlet Item = 1\nfunction go() { class Item { get n() { return 2 } }\n  return new Item().n }\n</script>' +
      '<b on:click={go}>{Item}</b>'
    )
    expect(js).not.toContain('class $$runtime.get')
  })

  it('a named function expression referring to itself', async () => {
    const js = await clean(
      '<script>\nlet f = 1\nfunction go() { const g = function f(n) { return n < 1 ? 0 : f(n - 1) }\n  return g(2) }\n</script>' +
      '<b on:click={go}>{f}</b>'
    )
    expect(js).not.toContain('function $$runtime.get')
  })

  // A switch's declarations live under `cases`, one level below the `body` the
  // block collector reads, so they were never collected at all.
  it('a let declared in a switch case', async () => {
    await clean(
      '<script>\nlet n = 1\nfunction go(k) { switch (k) { case 1: let n = 2; return n; default: return 0 } }\n</script>' +
      '<b on:click={go}>{n}</b>'
    )
  })

  it('a class expression naming itself', async () => {
    await clean(
      '<script>\nlet C = 1\nfunction go() { const K = class C { self() { return C } }\n  return new K() }\n</script>' +
      '<b on:click={go}>{C}</b>'
    )
  })
})

// The rewriter's job is still to rewrite. A fix that stopped touching anything
// would satisfy every assertion above, so each one is paired with the same name
// read where nothing has rebound it.
describe('and the reads it still must rewrite', () => {
  it('reads the signal where no scope rebinds the name', async () => {
    const { js } = await emit(
      '<script>\nlet e = 1\nfunction go() { try { throw 1 } finally { return e } }\n</script>' +
      '<b on:click={go}>{e}</b>'
    )
    expect(js).toContain('$$runtime.get($$sig_e)')
  })

  it('reads the signal in a switch case that declares something else', async () => {
    const { js } = await emit(
      '<script>\nlet n = 1\nfunction go(k) { switch (k) { case 1: let m = 2; return n + m; default: return n } }\n</script>' +
      '<b on:click={go}>{n}</b>'
    )
    expect(js).toContain('$$runtime.get($$sig_n)')
  })

  it('reads the signal inside a class body that does not rebind it', async () => {
    const { js } = await emit(
      '<script>\nlet total = 1\nfunction go() { class Box { get v() { return total } }\n  return new Box().v }\n</script>' +
      '<b on:click={go}>{total}</b>'
    )
    expect(js).toContain('$$runtime.get($$sig_total)')
  })

  it('writes through the setter from inside a catch that rebinds another name', async () => {
    const { js } = await emit(
      '<script>\nlet n = 1\nfunction go() { try { throw 1 } catch (e) { n = 2 } }\n</script>' +
      '<b on:click={go}>{n}</b>'
    )
    expect(js).toMatch(/\$\$set_n\(/)
  })
})
