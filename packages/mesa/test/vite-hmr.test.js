/**
 * vite-hmr.test.js — the HMR boundary this package injects into compiled output.
 *
 * The boundary had no test in either package that used it, which is how a real
 * bug survived here for as long as it did: `import.meta.hot.accept` set
 * `__setMark` on the OLD module's function while passing the NEW one to
 * `__mesa_hot_update`. The client tests the function it was handed, so the mark
 * was never applied — the first update registered with `hmrMark: undefined` and
 * the SECOND dropped the entry as stale. HMR worked once per page load and then
 * reported no connected instances. Sierra's copy had fixed it; `FJS-D16` made
 * this the only copy, so the fix and its test belong here.
 *
 * Compiled output is produced by the real compiler rather than hand-written:
 * both patterns the transform depends on are shapes of that output, so a fixture
 * would keep passing after the shape it describes stopped being emitted.
 */

import { describe, test, expect } from 'vitest'
import { parse }                  from 'acorn'

import { compileSource }             from '../src/compiler.js'
import { injectHMR, canInject }      from '../mesa-vite/hmr.js'

const CLIENT = '/@test/hmr-client'
const ROOT   = '/app'

const SOURCE = `
<script>
  let count = 0
</script>

<button onclick={() => count++}>{count}</button>
`

// compileSource is async and answers a context; `result` is the emitted JS —
// the same property Sierra's plugin hands to injectHMR.
const compiled = async () =>
  (await compileSource(SOURCE, { filename: 'Counter.mesa' })).result

// Invariant 15 — a clean transform is not proof of valid JS. acorn is the
// compiler's own parser, so this asks the same question the compiler answers.
const parses = (js) => {
  parse(js, { ecmaVersion: 'latest', sourceType: 'module' })
  return true
}

describe('canInject', () => {
  test('accepts what the compiler actually emits', async () => {
    expect(canInject(await compiled())).toBe(true)
  })

  // Failing closed is the whole reason this is a separate question. A bare pair
  // of .replace() calls whose patterns stop matching emits half a boundary and
  // says nothing.
  test('refuses output it cannot wrap', async () => {
    expect(canInject('export default function Nope() {}')).toBe(false)
    expect(canInject('')).toBe(false)
  })
})

describe('injectHMR', () => {
  const wrapped = async () => injectHMR(await compiled(), `${ROOT}/src/Counter.mesa`, ROOT, CLIENT)

  test('the result is valid JavaScript', async () => {
    const js = await wrapped()
    expect(() => parses(js)).not.toThrow()
  })

  test('imports the client at the id the CALLER serves it from', async () => {
    expect(await wrapped()).toContain(
      `import { __mesa_register, __mesa_hot_update } from '${CLIENT}';`)
  })

  test('the default export becomes the wrapper, and the original is kept', async () => {
    const js = await wrapped()
    expect(js).toContain('function __mesaOrigFn(__anchor, __props, __block)')
    expect(js).toContain('export default function __mesaHMRWrap(')
    expect(js).toContain('export { __mesaOrigFn }')
    // Exactly one default export, and it is the wrapper — the compiler's own
    // `export default function Name(…)` has to be gone, not merely joined.
    expect([...js.matchAll(/export default /g)]).toHaveLength(1)
  })

  test('the registry key is root-relative', async () => {
    expect(await wrapped()).toContain(`__mesa_register('/src/Counter.mesa'`)
  })

  test('an instance registers itself, guarded by import.meta.hot', async () => {
    const js = await wrapped()
    expect(js).toContain('__mesa_register(')
    expect(js).toMatch(/if \(import\.meta\.hot\) \{\s*\n\s*__mesa_register\(/)
  })

  // THE REGRESSION. `next` is the new module's function and the one the client
  // reads `__setMark` off; assigning to `__mesaOrigFn` instead reaches the old
  // module and the mark is silently never applied.
  test('__setMark is assigned to the function that is handed to the client', async () => {
    const js = await wrapped()
    expect(js).toContain('next.__setMark = m.__setMark')
    expect(js).toContain('__mesa_hot_update(')
    expect(js).not.toContain('__mesaOrigFn.__setMark = m.__setMark')

    // …and the same expression is what gets passed on.
    const accept = js.slice(js.indexOf('import.meta.hot.accept'))
    expect(accept).toMatch(/const next = m\.__mesaOrigFn \?\? m\.default[\s\S]*__mesa_hot_update\([^,]+, next\)/)
  })

  test('a hot update with no new module is ignored rather than throwing', async () => {
    expect(await wrapped()).toContain('if (!m) return')
  })

  // Both land inside single-quoted strings in the emitted source. A filename may
  // legally contain an apostrophe, and the id may on any platform.
  test('an apostrophe in the path does not break the emitted string', async () => {
    const js = injectHMR(await compiled(), `${ROOT}/src/Bob's.mesa`, ROOT, CLIENT)
    expect(() => parses(js)).not.toThrow()
    expect(js).toContain("mesa:hmr:Bob\\'s.mesa")
  })

  test('an id outside the root is left absolute rather than mangled', async () => {
    const js = injectHMR(await compiled(), '/elsewhere/Counter.mesa', ROOT, CLIENT)
    expect(js).toContain(`__mesa_register('/elsewhere/Counter.mesa'`)
  })
})
