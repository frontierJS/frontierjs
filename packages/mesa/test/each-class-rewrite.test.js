/**
 * each-class-rewrite.test.js
 *
 * `FJS-2494` -- a keyed row whose item object is replaced (a rename that
 * moves nothing else) re-ran `class="layer" class:active={...}` and wrote the
 * identical class string back. An attribute write that changes nothing still
 * queues a MutationObserver record, so a host watching the list saw n rows
 * change for one keystroke.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { writeFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { compileSource } from '../src/compiler.js'
import { mount, flushSync } from '../src/runtime.js'

let n = 0

async function mountSrc(src) {
  const ctx = await compileSource(src, { filename: `/CR${n}.mesa`, dev: false })
  const file = path.join(process.cwd(), `_tmp_classrw_${n++}.mjs`)
  writeFileSync(file, ctx.result.replace(/'@frontierjs\/mesa\/runtime'/g, `'./src/runtime.js'`))
  let Comp
  try { Comp = (await import('file://' + file)).default }
  finally { try { unlinkSync(file) } catch {} }
  const wrap = document.createElement('div')
  document.body.appendChild(wrap)
  const anchor = document.createElement('span')
  wrap.appendChild(anchor)
  mount(anchor, Comp, { props: {} })
  flushSync()
  return wrap
}

async function renamed(row) {
  const wrap = await mountSrc(`<script>
  let layers = [{ id: 1, name: 'a' }, { id: 2, name: 'b' }, { id: 3, name: 'c' }]
  let active = 2
</script>
<button onclick={() => layers = layers.map((l) => l.id === active ? { ...l, name: l.name + 'x' } : l)}>rename</button>
<ul>
{#each layers as l (l.id)}
  ${row}
{/each}
</ul>`)
  const seen = []
  const mo = new MutationObserver((recs) => { for (const r of recs) seen.push(`${r.target.nodeName}:${r.attributeName ?? r.type}`) })
  mo.observe(wrap.querySelector('ul'), { subtree: true, attributes: true, characterData: true, childList: true })
  wrap.querySelector('button').click()
  flushSync()
  seen.push(...mo.takeRecords().map((r) => `${r.target.nodeName}:${r.attributeName ?? r.type}`))
  mo.disconnect()
  return { wrap, seen }
}

describe('a row whose item object changes', () => {
  beforeEach(() => { document.body.innerHTML = '' })

  it('writes the text that changed and no class that came out the same', async () => {
    const { wrap, seen } = await renamed(`<li class="layer" class:active={l.id === active}>{l.name}</li>`)
    expect(wrap.querySelector('li.active').textContent).toBe('bx')
    expect(seen.filter((s) => s.endsWith(':class'))).toEqual([])
  })

  it('a dynamic class expression that came out the same is not written either', async () => {
    const { seen } = await renamed(`<li class={l.id === active ? 'layer on' : 'layer'}>{l.name}</li>`)
    expect(seen.filter((s) => s.endsWith(':class'))).toEqual([])
  })
})
