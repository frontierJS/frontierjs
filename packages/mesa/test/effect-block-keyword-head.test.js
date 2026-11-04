/**
 * effect-block-keyword-head.test.js
 *
 * `FJS-3917`. `rewriteExpr` parses its input as an expression first, and a
 * `$: { if (current) { … } }` block is a valid OBJECT LITERAL: `if (current)
 * { … }` is a method named `if` with a parameter named `current`. The walk then
 * treated `current` as a local, so a derived or reactive `let` read in the
 * condition — and every read of it in the body — stayed bare, and the page threw
 * `current is not defined` at runtime from an otherwise clean compile.
 */

import { describe, test, expect } from 'vitest'
import { compileSource } from '../src/compiler.js'

const compile = async (src) =>
  (await compileSource(src, { filename: '/test/T.mesa', dev: false })).result

const effect = (js) => js.split('\n').find((l) => l.includes('createEffect')) ?? ''

const page = (block) => `<script>
  let idx = 0
  let rows = []
  let seen = []
  let flag = true
  $: current = rows[idx] ?? null
  $: ${block}
</script>
<p>{seen.length}</p>`

describe('a $: block opening with a statement that parses as a method', () => {
  test('if (derived) — condition and body both read the signal', async () => {
    const line = effect(await compile(page('{ if (current) { seen = [current.id] } }')))
    expect(line).not.toMatch(/if \(current\)/)
    expect(line).not.toMatch(/\[current\.id\]/)
    expect(line).toContain('$$sig_current')
  })

  test('if (reactive let)', async () => {
    const line = effect(await compile(page('{ if (flag) { seen = [idx] } }')))
    expect(line).not.toMatch(/if \(flag\)/)
  })

  test('while and switch heads', async () => {
    const w = effect(await compile(page('{ while (flag) { seen = [idx] } }')))
    expect(w).not.toMatch(/while \(flag\)/)
    const s = effect(await compile(page('{ switch (idx) { case 0: seen = [current]; break } }')))
    expect(s).not.toMatch(/switch \(idx\)/)
  })

  test('an object literal keeps its shorthand key', async () => {
    const js = await compile(`<script>
  let idx = 0
  const o = { idx }
</script>
<p>{JSON.stringify({ idx })}</p>`)
    expect(js).toMatch(/idx: \$\$runtime\.get\(\$\$sig_idx\)/)
  })
})
