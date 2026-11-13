/**
 * each-self-assign.test.js
 *
 * FJS-4257 -- `tabs = tabs` after `t.dirty = true` is RULE 43's "mutated in
 * place, notify anyway". The {#each} re-runs and finds every row holding the
 * same item at the same index, so a row that skipped its item write never
 * re-read the field: Lathe's tab strip kept its unsaved dot hidden.
 */
import { describe, it, expect, afterAll } from 'vitest'
import { writeFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { compileSource } from '../src/compiler.js'
import { flushSync, mount } from '../src/runtime.js'

let n = 0
const made = []
afterAll(() => { for (const f of made) try { unlinkSync(f) } catch {} })

async function show(head) {
  const src = `<script>
  let tabs = [{ name: 'a', dirty: false }, { name: 'b', dirty: false }]
  globalThis.__mark = (i) => { tabs[i].dirty = true; tabs = tabs }
  globalThis.__copy = (i) => { tabs[i].dirty = true; tabs = [...tabs] }
</script>
${head}
  <p class="tab" data-dirty={t.dirty ? 'yes' : 'no'}>{t.name}{#if t.dirty}<b>*</b>{/if}</p>
{/each}`
  const ctx = await compileSource(src, { filename: `/Self${n}.mesa`, dev: false })
  const file = path.join(process.cwd(), `_tmp_self_assign_${n++}.mjs`)
  writeFileSync(file, ctx.result.replace(/'@frontierjs\/mesa\/runtime'/g, `'./src/runtime.js'`))
  made.push(file)
  const mod = await import('file://' + file)
  document.body.innerHTML = ''
  const anchor = document.createComment('')
  document.body.appendChild(anchor)
  mount(anchor, mod.default, { props: {} })
  flushSync()
}

const rows = () => [...document.querySelectorAll('.tab')].map((p) => `${p.dataset.dirty}:${p.textContent}`)

describe.each([
  ['unkeyed', '{#each tabs as t}'],
  ['keyed', '{#each tabs as t (t.name)}'],
])('{#each} %s over a list assigned to itself', (_, head) => {
  it('re-reads a field mutated in place', async () => {
    await show(head)
    expect(rows()).toEqual(['no:a', 'no:b'])
    globalThis.__mark(1)
    flushSync()
    expect(rows()).toEqual(['no:a', 'yes:b*'])
  })

  it('a copied list over the same items still leaves an unchanged row alone', async () => {
    await show(head)
    const before = document.querySelectorAll('.tab')[1]
    globalThis.__copy(1)
    flushSync()
    // a new array is not a self-assignment, so its rows keep the equality guard
    expect(rows()).toEqual(['no:a', 'no:b'])
    expect(document.querySelectorAll('.tab')[1]).toBe(before)
  })
})
