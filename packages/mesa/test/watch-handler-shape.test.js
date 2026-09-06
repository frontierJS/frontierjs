/**
 * watch-handler-shape.test.js — what may sit in a `$: deps, handler`.
 *
 * RULE 7 says the handler is last and RULE 52's sibling paragraph says it is a
 * function — an arrow, a function expression, or the name of one. Anything
 * else in the sequence is a dependency and must name a value.
 *
 * The compiler read that list two ways. `$: o.x, doThing()` is not a handler
 * shape, so it fell to the multi-path branch, which kept whatever named a path
 * and dropped the rest in silence: no error, no warning, a handler that never
 * ran. `$: o.x, hits++` lost the author's statement from the output entirely
 * (`FJS-848`). Every element that names nothing is refused here, by name and
 * with a position.
 */
import { describe, it, expect } from 'vitest'
import { compileSource } from '../src/compiler.js'

const compile = (src, filename = 'T.mesa') =>
  compileSource(src, { filename, css: false, debug: false })

const script = (body) => `<script>\n${body}\n</script>\n<p>{hits}</p>`

describe('a `$:` element that names no value (FJS-848)', () => {
  it('refuses a call in the handler position, naming it and the line', async () => {
    const ctx = await compile(script(`let o = { x: 1 }
let hits = 0
$: o.x, doThing()
function doThing() { hits++ }`), 'CallHandler.mesa')
    expect(ctx.analysis.errors.length).toBe(1)
    expect(ctx.analysis.errors[0]).toContain('doThing()')
    expect(ctx.analysis.errors[0]).toContain('() => doThing()')
    expect(ctx.analysis.errors[0]).toMatch(/CallHandler\.mesa:4:9/)
  })

  it('refuses an update expression rather than deleting the statement', async () => {
    // The statement used to vanish from the output — the author's line was in
    // the file and in nothing the browser ran.
    const ctx = await compile(script(`let o = { x: 1 }
let hits = 0
$: o.x, hits++`), 'UpdateHandler.mesa')
    expect(ctx.analysis.errors.length).toBe(1)
    expect(ctx.analysis.errors[0]).toContain('hits++')
    expect(ctx.result).not.toContain('hits++')
  })

  it('says the same thing on a scalar dep as on an object one', async () => {
    // One rule, one message. The scalar spelling reported the deep-watch
    // refusal instead, which is about `a` and not about the handler.
    const ctx = await compile(script(`let a = 1
let hits = 0
$: a, hits++`), 'ScalarDep.mesa')
    expect(ctx.analysis.errors.length).toBe(1)
    expect(ctx.analysis.errors[0]).toContain('hits++')
  })

  it('refuses a dep that names no path, naming it', async () => {
    const ctx = await compile(script(`import { store } from './s.js'
let hits = 0
$: (store[hits], store.b)`), 'ComputedDep.mesa')
    expect(ctx.analysis.errors.length).toBe(1)
    expect(ctx.analysis.errors[0]).toContain('store[hits]')
  })

  // ─── the shapes that must still compile ──────────────────────────────────
  // A refusal that also refuses the correct spelling proves nothing about the
  // typo, so each accepted form is asserted beside the refusals.

  it('accepts an arrow handler', async () => {
    const ctx = await compile(script(`let o = { x: 1 }
let hits = 0
$: o.x, () => { hits++ }`), 'ArrowHandler.mesa')
    expect(ctx.analysis.errors).toEqual([])
  })

  it('accepts a function reference handler', async () => {
    const ctx = await compile(script(`let o = { x: 1 }
let hits = 0
function bump() { hits++ }
$: o.x, bump`), 'RefHandler.mesa')
    expect(ctx.analysis.errors).toEqual([])
  })

  it('accepts a multi-path watch with no handler', async () => {
    const ctx = await compile(script(`import { store } from './s.js'
let hits = 0
$: (store.a, store.b)`), 'MultiPath.mesa')
    expect(ctx.analysis.errors).toEqual([])
  })

  it('accepts a soft path, and registers the watch it names', async () => {
    // `?.` parses as a ChainExpression, which the path reader did not know, so
    // a soft path was dropped exactly as an unnameable element was — with the
    // difference that this one is a documented form (`soft:` reads it).
    const ctx = await compile(script(`import { store } from './s.js'
let hits = 0
$: (store?.a, store.b)`), 'SoftPath.mesa')
    expect(ctx.analysis.errors).toEqual([])
    expect(ctx.result).toContain(`watchPath(store, 'a')`)
  })
})
