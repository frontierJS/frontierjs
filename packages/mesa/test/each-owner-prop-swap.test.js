/**
 * each-owner-prop-swap.test.js
 *
 * FJS-3766 -- a parent swaps `keys`, `read` and `fixed` on a child in one write.
 * The child's `{#each keys as k (k)}` cell blocks for the OLD keys must not run
 * against the NEW function props before the each drops them.
 */
import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest'
import { writeFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { compileSource } from '../src/compiler.js'
import { flushSync, mount } from '../src/runtime.js'

const tick = () => new Promise((r) => setTimeout(r, 0))
let n = 0
const made = []
afterAll(() => { for (const f of made) try { unlinkSync(f) } catch {} })

async function load(src, swap = {}) {
  const ctx = await compileSource(src, { filename: `/S${n}.mesa`, dev: false })
  let js = ctx.result.replace(/'@frontierjs\/mesa\/runtime'/g, `'./src/runtime.js'`)
  for (const [from, to] of Object.entries(swap)) js = js.replaceAll(from, to)
  const file = path.join(process.cwd(), `_tmp_swap_${n++}.mjs`)
  writeFileSync(file, js)
  made.push(file)
  return { mod: await import('file://' + file), name: path.basename(file) }
}

beforeEach(() => { document.body.innerHTML = ''; globalThis.__stale = [] })

const CHILD = `<script>
  export const keys = []
  export const read = null
  export const fixed = null
</script>
<table><tbody><tr>
  {#each keys as k (k)}
    {@const v = read(1, k)}
    <td class:fixed={fixed(1, k)}>{v}</td>
  {/each}
</tr></tbody></table>`

const PARENT = (childPath) => `<script>
  import Grid from '${childPath}'
  let flat = false
  const rows = [1]
  const flatCols = flat ? { paths: new Map([['address.city', ['address', 'city']]]), keys: ['address.city'] } : null
  const keys1 = flatCols ? flatCols.keys : ['a', 'address']
  const keys2 = keys1.filter(() => true)
  const shown = keys2.map((k) => k)
  const read = flatCols
    ? (r, k) => { if (!flatCols.paths.has(k)) (globalThis.__stale ??= []).push('read:' + k); return (flatCols.paths.get(k) ?? []).join('/') }
    : (r, k) => 'own:' + k
  const fixed = flatCols ? (r, k) => { if (!flatCols.paths.has(k)) (globalThis.__stale ??= []).push('fixed:' + k); return false } : (r, k) => false
</script>
<button onclick={() => flat = !flat}>t</button>
<Grid keys={shown} {read} {fixed} />`

describe('keyed each item against a function prop swapped in the same flush', () => {
  it('the cells follow the swap both ways with no throw', async () => {
    const child = await load(CHILD)
    const parent = await load(PARENT('./' + child.name), {})
    // the child file was removed after import; re-import path is only needed at load
    const wrap = document.createElement('div')
    document.body.appendChild(wrap)
    const anchor = document.createElement('span')
    wrap.appendChild(anchor)
    const errors = []
    const spy = vi.spyOn(console, 'error').mockImplementation((...a) => { errors.push(String(a[0]?.stack ?? a[0]).split("\n").slice(0, 7).join('\n')) })
    mount(anchor, parent.mod.default, { props: {} })
    flushSync(); await tick()
    expect([...wrap.querySelectorAll('td')].map((t) => t.textContent)).toEqual(['own:a', 'own:address'])
    for (const flat of [true, false, true, false]) {
      wrap.querySelector('button').click()
      flushSync(); await tick(); flushSync(); await tick()
      expect(errors).toEqual([])
      expect([...wrap.querySelectorAll('td')].map((t) => t.textContent))
        .toEqual(flat ? ['address/city'] : ['own:a', 'own:address'])
    }
    expect(globalThis.__stale ?? []).toEqual([])
    spy.mockRestore()
  })
})
