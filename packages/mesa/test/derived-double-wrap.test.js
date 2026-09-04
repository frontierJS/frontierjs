/**
 * derived-double-wrap.test.js
 *
 * `FJS-424`. A derived `const` referenced on the right-hand side of an
 * assignment to a reactive `let` was emitted wrapped twice:
 *
 *   $$runtime.get($$runtime.get(cellFor))(pickColor, sz)
 *
 * `rewriteExpr` is applied at more than a dozen sites, and in several of them it
 * runs over text `rewriteAssignments` has already put it through — that function
 * rewrites an assignment's right-hand side itself, and its callers then rewrite
 * the whole statement. For a reactive `let` the double application is harmless:
 * the accessor is `$$runtime.get($$sig_x)` and `$$sig_x` is not a name in the
 * map, so the second pass finds nothing. For a DERIVED `const` the accessor is
 * `$$runtime.get(x)`, which still contains `x` — so it wrapped again.
 *
 * The consequence is not cosmetic and the two halves fail differently.
 * `runtime.get` CALLS a plain function it is handed, so:
 *
 *   · a derived holding a FUNCTION was invoked with no arguments and the result
 *     called — `$$runtime.get(...) is not a function`, thrown at mount with the
 *     component half-built and the message naming neither file nor identifier
 *   · a derived holding a VALUE silently produced a different one
 *
 * The issue described the shape as narrow — a nested callback, inside a `$:`
 * block. It is neither: a bare `pick = derived(1)` inside a plain function does
 * it, which is why the four attempts to reduce it recorded on the issue did not
 * land. What IS required is that the target be a reactive `let` (a plain local
 * is clean) and the source be a derived (a reactive `let` read is clean).
 *
 * The fix is idempotence in `rewriteExpr` rather than making every caller apply
 * it exactly once, which is a rule nothing can check.
 */

import { describe, test, expect } from 'vitest'
import { compileSource } from '../src/compiler.js'

const compile = async (src) =>
  (await compileSource(src, { filename: '/test/T.mesa', dev: false })).result

/** The emitted JS with comments dropped — a source comment naming the broken
 *  form travels into the output, and matching that is a test reading the
 *  documentation of the defect rather than the defect. */
const code = (js) => js.split('\n').filter(l => !l.trim().startsWith('//')).join('\n')

const doubleWrapped = (js) => /\$\$runtime\.get\(\s*\$\$runtime\.get\(/.test(code(js))

describe('a derived is wrapped once, however it is reached', () => {
  test('assigned into a reactive let from a plain function', async () => {
    const js = await compile(`<script>
  let rows = [1]
  let pick = null
  const cellFor = (x) => rows.find(v => v === x)
  function go() { pick = cellFor(1) }
</script>
<p on:click={go}>{pick}</p>`)

    expect(doubleWrapped(js)).toBe(false)
    // Wrapped once, and still wrapped — an over-eager fix that stopped
    // rewriting the identifier would read the module-scope const rather than
    // the derived, which is a stale value and no error.
    expect(code(js)).toContain('$$runtime.get(cellFor)(1)')
  })

  test('inside a $: block, through a nested callback — the shape as reported', async () => {
    const js = await compile(`<script>
  let rows = [{ color: 'a', size: 's', stock: 1 }]
  let pickColor = null
  let pickSize = null
  const avail = (v) => (v?.stock ?? 0)
  const cellFor = (c, sz) => rows.find(v => v.color === c && v.size === sz) ?? null
  const sizesFor = (c) => rows.filter(v => v.color === c).map(v => v.size)
  $: {
    const offered = pickColor ? sizesFor(pickColor) : []
    if (offered.length) {
      pickSize = offered.find(sz => avail(cellFor(pickColor, sz)) > 0) ?? offered[0]
    }
  }
</script>
<p>{pickSize}</p>`)

    expect(doubleWrapped(js)).toBe(false)
  })

  test('a derived holding a VALUE — the half that failed silently', async () => {
    // No throw here, ever: `get` of a number returns the number. It produced a
    // wrong value instead, which is why this half went unnoticed while the
    // function half was being worked around twice in one file.
    const js = await compile(`<script>
  let rows = [1, 2]
  let pick = 0
  const n = rows.length
  function go() { pick = n + 1 }
</script>
<p on:click={go}>{pick}</p>`)

    expect(doubleWrapped(js)).toBe(false)
    expect(code(js)).toContain('$$runtime.get(n) + 1')
  })

  test('a compound assignment reaches it too', async () => {
    const js = await compile(`<script>
  let rows = [1]
  let pick = null
  const cellFor = (x) => rows.find(v => v === x)
  function go() { pick ??= cellFor(1) }
</script>
<p on:click={go}>{pick}</p>`)

    expect(doubleWrapped(js)).toBe(false)
  })

  test('and so does an arrow that is never invoked', async () => {
    const js = await compile(`<script>
  let rows = [1]
  let pick = null
  const cellFor = (x) => rows.find(v => v === x)
  function go() { pick = (sz) => cellFor(sz) }
</script>
<p on:click={go}>{pick}</p>`)

    expect(doubleWrapped(js)).toBe(false)
  })
})

describe('what was already correct stays correct', () => {
  test('a reactive let read into a reactive let', async () => {
    const js = await compile(`<script>
  let rows = [1]
  let pick = null
  function go() { pick = rows.length }
</script>
<p on:click={go}>{pick}</p>`)

    expect(doubleWrapped(js)).toBe(false)
    expect(code(js)).toContain('$$runtime.get($$sig_rows).length')
  })

  test('a derived read with no assignment', async () => {
    const js = await compile(`<script>
  let rows = [1]
  const cellFor = (x) => rows.find(v => v === x)
  function go() { console.log(cellFor(1)) }
</script>
<p on:click={go}>x</p>`)

    expect(doubleWrapped(js)).toBe(false)
    expect(code(js)).toContain('$$runtime.get(cellFor)(1)')
  })

  // `FJS-465`, asserted STILL BROKEN so that fixing it turns this red rather
  // than leaving a stale expectation. A local `const` shadowing a derived is
  // rewritten as a read of the derived: valid JavaScript, no warning, wrong
  // value. It is not this issue's fix — `rewriteAssignments` hands `rewriteExpr`
  // the right-hand side sliced out on its own, so the enclosing function body
  // and everything it declares are not in the text being walked. Confirmed
  // pre-existing against the previous compiler.
  test('FJS-465 — a local shadowing a derived still reads the derived', async () => {
    const js = await compile(`<script>
  let rows = [1]
  let pick = null
  const cellFor = (x) => rows.find(v => v === x)
  function go() {
    const cellFor = (x) => x
    pick = cellFor(1)
  }
</script>
<p on:click={go}>{pick}</p>`)

    expect(doubleWrapped(js)).toBe(false)
    // The LOCAL one, called plainly. Reading the derived here would call the
    // module-scope function silently, with the local two lines above unused.
    expect(code(js)).toContain('set_pick(cellFor(1))')
    expect(code(js)).not.toContain('get(cellFor)(1)')
  })
})
