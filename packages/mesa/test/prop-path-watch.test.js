/**
 * A `$:` path watch rooted at a PROP — `$: verse.verseId, () => …` on
 * `export let verse`. The prop root fell into the import set, so its proxy was
 * emitted in the head as `watchProxy(verse)`, above anything named `verse`, and
 * the component threw `ReferenceError: verse is not defined` at mount from a
 * clean compile (`FJS-1469`).
 */
import { describe, it, expect } from 'vitest'
import { compileSource } from '../src/compiler.js'
import * as $rt from '../src/runtime.js'

const build = async (src) => {
  const ctx = await compileSource(src, { filename: 'References.mesa', css: false, debug: false })
  expect(ctx.analysis.errors).toEqual([])
  const code = ctx.result.replace(/^import\s+.+?from\s+'[^']+';$/gm, '')
    .replace(/^export default\s+/m, 'const __c = ')
  return new Function('$$runtime', code + '\nreturn __c')($rt)
}

const mount = (Comp, props = {}) => {
  const c = document.createElement('div')
  document.body.appendChild(c)
  const l = document.createElement('span')
  c.appendChild(l)
  const inst = $rt.mount(l, Comp, { props })
  $rt.flushSync()
  return { c, inst }
}

const SRC = (decl, line) => `<script>
  ${decl} verse = null
  let runs = 0
  ${line}
</script>
<p>{verse?.verseId}:{runs}</p>`

describe('a path watch on a prop (FJS-1469)', () => {
  for (const decl of ['export let', 'export const']) {
    for (const line of [
      '$: verse.verseId',
      '$: verse?.verseId, () => { runs++ }',
    ]) {
      it(`${decl} with \`${line}\` mounts`, async () => {
        const C = await build(SRC(decl, line))
        const { c } = mount(C, { verse: { verseId: 7 } })
        expect(c.textContent).toContain('7:')
      })
    }
  }
})

describe('the watch follows the prop (FJS-1469)', () => {
  it('re-runs the handler when the parent hands a new record', async () => {
    const Child = await build(SRC('export let', '$: verse?.verseId, () => { runs++ }'))
    const pctx = await compileSource(`<script>
  import Child from './Child.mesa'
  let v = { verseId: 7 }
  globalThis.__next = () => { v = { verseId: 8 } }
</script>
<Child verse={v} />`, { filename: 'P.mesa', css: false, debug: false })
    expect(pctx.analysis.errors).toEqual([])
    const code = pctx.result.replace(/^import\s+.+?from\s+'[^']+';$/gm, '')
      .replace(/^export default\s+/m, 'const __c = ')
    const P = new Function('$$runtime', 'Child', code + '\nreturn __c')($rt, Child)
    const { c } = mount(P)
    const before = c.textContent
    globalThis.__next()
    $rt.flushSync()
    expect(before).toMatch(/^7:/)
    expect(c.textContent).toMatch(/^8:/)
    expect(Number(c.textContent.split(':')[1])).toBeGreaterThan(Number(before.split(':')[1]))
  })
})
