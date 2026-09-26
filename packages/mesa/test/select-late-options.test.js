// select-late-options.test.js
//
// `bind:value` on a select applied the value when the VALUE changed and never
// when the OPTIONS did. An edit screen's pickers load their options after the
// row, so every one showed its first option or its placeholder, and a person
// correcting what they saw overwrote what was stored (`FJS-1320`).
//
// The browser's half — that Chrome then selects the first option — is
// `test/browser/runtime/specs/select-late-options.spec.mjs`. This is the part
// happy-dom can see: which option the binding leaves selected.

import { describe, it, expect, beforeEach } from 'vitest'
import { compileSource } from '../src/compiler.js'
import * as runtime from '../src/runtime.js'

const tick = () => new Promise((r) => setTimeout(r, 0))

async function compileComp(src) {
  const ctx = await compileSource(src, { filename: '/C.mesa', dev: false, css: false })
  if (ctx.analysis?.errors?.length) throw new Error(ctx.analysis.errors[0])
  let code = ctx.result.replace(/^import\s+.+?from\s+'[^']+';$/gm, '').trim()
  code = code.replace(/^export default\s+/m, 'const __component = ') + '\nreturn __component'
  return new Function('$$runtime', code)(runtime)
}

beforeEach(() => { document.body.innerHTML = '' })

const SRC = `
<script>
  export let api
  let v    = 'c'
  let many = ['b', 'c']
  let opts = []
  api.load  = () => opts = ['a', 'b', 'c']
  api.shift = () => opts = ['c', 'a', 'b']
</script>
<select id="one" bind:value={v}>{#each opts as o}<option value={o}>{o}</option>{/each}</select>
<select id="many" multiple bind:value={many}>{#each opts as o}<option value={o}>{o}</option>{/each}</select>`

const selected = (id) => [...document.querySelector(id).options].filter((o) => o.selected).map((o) => o.value)

describe('a bound select whose options arrive after its value', () => {
  it('selects the bound value once they are there', async () => {
    const Comp = await compileComp(SRC)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const anchor = document.createElement('span')
    host.appendChild(anchor)
    const api = {}
    runtime.mount(anchor, Comp, { props: { api } })
    await tick()

    api.load()
    await tick()
    expect(selected('#one')).toEqual(['c'])
    expect(selected('#many')).toEqual(['b', 'c'])

    // An unkeyed reorder rebinds each option's value in place.
    api.shift()
    await tick()
    expect(selected('#one')).toEqual(['c'])
    expect(document.querySelector('#one').selectedIndex).toBe(0)
    expect(selected('#many')).toEqual(['c', 'b'])
  })

  it('stops watching once the select is destroyed', async () => {
    const Comp = await compileComp(SRC)
    const host = document.createElement('div')
    document.body.appendChild(host)
    const anchor = document.createElement('span')
    host.appendChild(anchor)
    const api = {}
    const inst = runtime.mount(anchor, Comp, { props: { api } })
    await tick()
    api.load()
    await tick()
    const one = document.querySelector('#one')
    expect(one.selectedIndex).toBe(2)
    inst.destroy()
    // The node outlives the component here. A binding still answering its
    // mutations would put `c` back over what the page did to it afterwards.
    one.selectedIndex = 0
    one.options[1].setAttribute('value', 'q')
    await tick()
    expect(one.selectedIndex).toBe(0)
  })
})
