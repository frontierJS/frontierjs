/**
 * Hydration markers — what a `hydratable: true` server render writes
 * (`FJS-D2286`, `IDEAS/hydration.md` steps 1.3–1.5).
 *
 * The client will look every marker up by key and adopt the node before it,
 * so each assertion here is on the PARSED page, not on the string: a marker
 * whose previous sibling is not the node it names is a binding the client
 * wires to the wrong place, and the string can look right while the parse
 * merges two texts (Invariant 15).
 *
 * Trap: the module is written to the package root so its runtime imports
 * resolve, and removed after the import.
 */
import { describe, it, expect } from 'vitest'
import { writeFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import * as acorn from 'acorn'
import { compile, bindingKey } from '../src/compiler.js'
import { renderToHTML } from '../src/render.js'

const quiet = () => {}
let n = 0
const kept = []

async function build(src, extra = {}) {
  const { result } = await compile(src, { target: 'server', filename: `H${n}.mesa`, dev: false, css: false, warning: quiet, ...extra })
  acorn.parse(result, { ecmaVersion: 'latest', sourceType: 'module' })
  const js = result
    .replace(/'@frontierjs\/mesa\/runtime\/server'/g, `'./src/runtime-server.js'`)
    .replace(/'@frontierjs\/mesa\/runtime'/g, `'./src/runtime.js'`)
    .replace(/from '\.\/(Child\d+)\.mesa'/g, (_, c) => `from './_tmp_hyd_${c}.mjs'`)
  const file = path.join(process.cwd(), `_tmp_hyd_${extra.as ?? n++}.mjs`)
  writeFileSync(file, js)
  if (extra.as) { kept.push(file); return null }
  try { return (await import('file://' + file)).default } finally { try { unlinkSync(file) } catch {} }
}

async function page(src, props = {}) {
  const html = await renderToHTML(await build(src, { hydratable: true }), props, { target: 'server' })
  const root = document.createElement('div')
  root.innerHTML = html
  const comments = []
  const walk = document.createTreeWalker(root, 128)
  while (walk.nextNode()) comments.push(walk.currentNode)
  return { html, root, comments, markers: comments.filter((c) => /^[imr[\]] /.test(c.data)) }
}

const at = (src, needle) => bindingKey(src.indexOf(needle))

describe('a flagged render', () => {
  const SRC = '<script>\n  let n = 1\n  let c = \'x\'\n  const k = 2\n</script>\n' +
    '<p title={c}>a {n} b</p><p>{k}</p>'

  it('opens with the instance marker and marks each live node after it', async () => {
    const { markers } = await page(SRC)
    expect(markers[0].data).toMatch(/^i 0 m\w+$/)
    const text = markers.find((m) => m.data === `m 0 ${at(SRC, 'a {n}')}`)
    expect(text.previousSibling.nodeType).toBe(3)
    expect(text.previousSibling.data).toBe('a 1 b')
    const el = markers.find((m) => m.data === `m 0 ${at(SRC, '<p title')}`)
    expect(el.previousSibling.getAttribute('title')).toBe('x')
  })

  it('writes nothing for a binding that reads no signal', async () => {
    const { markers } = await page(SRC)
    expect(markers.map((m) => m.data)).toHaveLength(3)
  })

  it('says a text binding rendered nothing, where no Text node exists to find', async () => {
    const src = '<script>\n  let e = \'\'\n</script>\n<span>{e}</span>'
    const { markers } = await page(src)
    const m = markers.find((x) => x.data.startsWith('m '))
    expect(m.data).toBe(`m 0 ${at(src, '{e}')} empty`)
    expect(m.previousSibling).toBe(null)
  })

  it('keeps a live text apart from text a component wrote before it', async () => {
    await build('<script>\n  export let t\n</script>\n{t}', { as: 'Child1', hydratable: true })
    const src = '<script>\n  import Child from \'./Child1.mesa\'\n  let n = 1\n</script>\n<p><Child t="x" />{n}</p>'
    const { root, markers } = await page(src)
    const m = markers.find((x) => x.data === `m 0 ${at(src, '{n}')}`)
    expect(m.previousSibling.data).toBe('1')
    expect(root.innerHTML).toContain('<!---->1')
    for (const f of kept.splice(0)) try { unlinkSync(f) } catch {}
  })
})

describe('instance ids', () => {
  it('give a snippet rendered twice one id per call site', async () => {
    const src = '<script>\n  let n = 1\n</script>\n{#snippet s()}<u>{n}</u>{/snippet}\n{@render s()}{@render s()}'
    const { markers } = await page(src)
    const key = at(src, '{n}')
    const ids = markers.filter((m) => m.data.startsWith('m ') && m.data.endsWith(key)).map((m) => m.data.split(' ')[1])
    expect(new Set(ids).size).toBe(2)
    expect(ids[0]).toBe(`0.${bindingKey(src.indexOf('{@render'))}`)
    expect(ids[1]).toBe(`0.${bindingKey(src.lastIndexOf('{@render'))}`)
  })

  it('derive a child component\'s id from its call site and carry its scope id', async () => {
    await build('<script>\n  export let t\n  let m = 0\n</script>\n<i>{t}{m}</i>\n<style>i { color: red }</style>', { as: 'Child2', hydratable: true })
    const src = '<script>\n  import Child from \'./Child2.mesa\'\n</script>\n<Child t="a" /><Child t="b" />'
    const { markers } = await page(src)
    const inst = markers.filter((m) => m.data.startsWith('i ')).map((m) => m.data.split(' '))
    expect(inst.map(([, id]) => id)).toEqual(['0', `0.${bindingKey(src.indexOf('<Child'))}`, `0.${bindingKey(src.lastIndexOf('<Child'))}`])
    expect(inst[1][2]).toMatch(/^m\w+/)
    for (const f of kept.splice(0)) try { unlinkSync(f) } catch {}
  })
})

describe('block boundaries', () => {
  it('write the {#if} branch taken, and -1 when none is', async () => {
    const src = '<script>\n  let n = 2\n</script>\n{#if n === 1}a{:else if n === 2}b{/if}{#if n > 5}c{/if}'
    const { markers } = await page(src)
    const opens = markers.filter((m) => m.data.startsWith('[ ')).map((m) => m.data)
    expect(opens).toEqual([`[ 0 ${at(src, '{#if n === 1')} 1`, `[ 0 ${at(src, '{#if n > 5')} -1`])
    expect(markers.filter((m) => m.data.startsWith('] '))).toHaveLength(2)
  })

  it('write a row per {#each} item, keyed, with the row\'s bindings under the row id', async () => {
    const src = '<script>\n  let list = [{ id: \'a-b c\', t: 1 }, { id: 7, t: 2 }]\n</script>\n{#each list as r (r.id)}<i>{r.t}</i>{/each}'
    const { markers } = await page(src)
    const rows = markers.filter((m) => m.data.startsWith('r ')).map((m) => m.data.slice(2))
    expect(rows).toEqual(['0[a%2Db%20c]', '0[7]'])
    const bound = markers.filter((m) => m.data.startsWith('m ')).map((m) => m.data.split(' ')[1])
    expect(bound).toEqual(rows)
  })

  it('write which state an {#await} settled in', async () => {
    const src = '<script>\n  const p = Promise.resolve(3)\n  const q = Promise.reject(new Error(\'no\'))\n</script>\n' +
      '{#await p}…{:then v}{v}{/await}{#await q}…{:then v}{v}{:catch e}bad{/await}'
    const { markers } = await page(src)
    const opens = markers.filter((m) => m.data.startsWith('[ ')).map((m) => m.data)
    expect(opens).toEqual([`[ 0 ${at(src, '{#await p')} then`, `[ 0 ${at(src, '{#await q')} catch`])
  })
})

describe('renderToHTML({ hydratable: true })', () => {
  it('refuses a factory compiled without the flag, by name', async () => {
    const Comp = await build('<p>x</p>')
    await expect(renderToHTML(Comp, {}, { target: 'server', hydratable: true })).rejects.toThrow(/not compiled hydratable/)
  })
})
