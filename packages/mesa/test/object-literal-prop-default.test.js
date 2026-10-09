/**
 * FJS-2122 — `export let r = { a: 1, b: 2 }` is a prop whose default is an
 * object literal. The fallback was emitted as `() => { a: 1, b: 2 }`, a block
 * body: a SyntaxError at load, or for one key a label that returns undefined.
 */

import { describe, it, expect } from 'vitest'
import { compile } from '../src/compiler.js'

const load = async (src) => {
  const ctx = await compile(src, { debug: false, css: false })
  if (ctx.analysis.errors.length) throw new Error(ctx.analysis.errors[0])
  const code = ctx.result.replace(/^import\s+.+?from\s+'[^']+';$/gm, '').replace(/^export default\s+/m, 'const __c = ')
  return code
}

describe('object-literal prop default (FJS-2122)', () => {
  it('two-key literal parses', async () => {
    const code = await load(`<script>\n  export let r = { a: 1, b: 2 }\n</script>\n<p>{r.a}</p>`)
    expect(() => new Function('$$runtime', code)).not.toThrow()
  })

  it('one-key literal fallback returns the object, not undefined', async () => {
    const code = await load(`<script>\n  export let r = { a: 1 }\n</script>\n<p>{r.a}</p>`)
    const m = code.match(/makeExternalProperty\('r'[^\n]*/)[0]
    expect(m).toContain('() => ({ a: 1 })')
  })

  it('a literal reading a reactive var parses (deferred default)', async () => {
    const code = await load(`<script>\n  let n = 1\n  export let r = { a: n, b: 2 }\n</script>\n<p>{r.a}</p>`)
    expect(() => new Function('$$runtime', code)).not.toThrow()
  })
})
