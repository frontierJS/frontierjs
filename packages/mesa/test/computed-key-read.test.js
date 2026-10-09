/**
 * computed-key-read.test.js
 *
 * `FJS-1917`. A computed key is an expression, so a reactive name inside it is a
 * read. `rewriteExpr` skipped every identifier reached through a `key`, which is
 * right for `{ server: 1 }` and wrong for `{ [server]: 1 }` — the object was
 * keyed by the signal itself, `[object Object]`, while a template literal beside
 * it read the value. Nothing warned: the shape compiles, parses and renders.
 *
 * A non-computed key must stay untouched, or `{ server: 1 }` would become
 * `{ $$runtime.get(server): 1 }` and the module would not parse (Invariant 15).
 */

import { describe, test, expect } from 'vitest'
import * as acorn from 'acorn'
import { compileSource } from '../src/compiler.js'

const compile = async (src) =>
  (await compileSource(src, { filename: '/test/T.mesa', dev: false })).result

const code = (js) => js.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

const parses = (js) => acorn.parse(js, { ecmaVersion: 'latest', sourceType: 'module' })

describe('a reactive name in a computed key is read', () => {
  test('a derived const as an object-literal key', async () => {
    const js = await compile(`<script>
  export const app = null
  const server = 'x' + app
  const f = () => JSON.stringify({ [server]: 1 })
  const g = () => \`\${server}\`
</script>
<p>{f()}{g()}</p>`)

    expect(code(js)).toMatch(/\{\s*\[\$\$runtime\.get\(server\)\]:\s*1\s*\}/)
    expect(() => parses(js)).not.toThrow()
  })

  test('a reactive let as a key, beside a plain key of the same name', async () => {
    const js = await compile(`<script>
  let k = 'a'
  const pick = () => ({ [k]: 1, k: 2 })
</script>
<p on:click={() => k = 'b'}>{JSON.stringify(pick())}</p>`)

    expect(code(js)).toMatch(/\[\$\$runtime\.get\(\$\$sig_k\)\]:\s*1/)
    expect(code(js)).toMatch(/[{,]\s*k:\s*2/)
    expect(() => parses(js)).not.toThrow()
  })

  test('a computed key in a template expression', async () => {
    const js = await compile(`<script>
  let k = 'a'
</script>
<p>{JSON.stringify({ [k]: 1 })}</p>`)

    expect(code(js)).toMatch(/\[\$\$runtime\.get\(\$\$sig_k\)\]:\s*1/)
    expect(() => parses(js)).not.toThrow()
  })

  test('a computed class member name', async () => {
    const js = await compile(`<script>
  let k = 'a'
  const make = () => new (class { [k]() { return 1 } })()
</script>
<p>{Object.getOwnPropertyNames(Object.getPrototypeOf(make()))[1]}</p>`)

    expect(code(js)).toMatch(/\[\$\$runtime\.get\(\$\$sig_k\)\]\(\)/)
    expect(() => parses(js)).not.toThrow()
  })

  test('renders the value, not [object Object]', async () => {
    const { renderComponent } = await import('../src/render-component.js')
    const html = await renderComponent(`<script>
  const name = 'srv'
  let suffix = '-1'
  const server = name + suffix
  const cfg = () => JSON.stringify({ [server]: 1 })
</script>
<p>{cfg()}</p>`, { filename: '/test/T.mesa' })
    const out = typeof html === 'string' ? html : html.html
    expect(out).toContain('srv-1')
    expect(out).not.toContain('object Object')
  })
})
