/**
 * FJS-1677 — a top-level binding named for an Object.prototype member
 * (`toString`, `valueOf`, `constructor`…) compiles.
 *
 * The sort read its dependency maps off plain objects, so `extraDeps['valueOf']`
 * was the inherited function and spreading it threw an internal TypeError with
 * no line.
 */

import { describe, it, expect } from 'vitest'
import { compile } from '../src/compiler.js'

const cx = src => compile(src, { debug: false, css: false }).then(c => c.result)

describe('FJS-1677 — prototype-member binding names', () => {
  for (const name of ['toString', 'valueOf', 'constructor', 'hasOwnProperty', 'toLocaleString']) {
    it(`compiles a top-level const named ${name}`, async () => {
      const code = await cx(`<script>let n = 1; const ${name} = () => String(n)</script><p>{${name}()}</p>`)
      expect(code).toContain(name)
      new Function(code.replace(/^import[^\n]*\n/gm, '').replace(/export default /, 'return '))
    })
  }

  it('compiles when a class is also present', async () => {
    const code = await cx(`<script>class C {}; let n = 1; const valueOf = () => new C(); const x = valueOf()</script><p>{x}</p>`)
    expect(code).toContain('valueOf')
  })
})
