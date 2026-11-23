/**
 * hydrate() — a flagged DOM compile adopts the page a `hydratable: true`
 * server render wrote (`IDEAS/hydration.md` 2.1–2.4): the server's nodes are
 * the client's nodes, and a missing marker or a wrong branch is re-rendered
 * (`FJS-D2260`) with a warning naming it.
 *
 * Trap: each module is written to the package root so its runtime imports
 * resolve, and removed after the run.
 */
// @vitest-environment happy-dom
import { describe, it, expect, afterAll, vi } from 'vitest'
import { writeFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import * as acorn from 'acorn'
import { compile } from '../src/compiler.js'
import { renderToHTML, renderToParts } from '../src/render.js'
import { hydrate, flushSync } from '../src/runtime.js'

const written = []
let n = 0

// One source compiled both ways, under one file name so both share a scope id.
async function build(src, name = `Hy${n++}`, { dev = false, client = src } = {}) {
  const out = {}
  for (const target of ['server', undefined]) {
    const { result } = await compile(target ? src : client, { target, filename: `${name}.mesa`, dev, css: false, warning: () => {}, hydratable: true })
    acorn.parse(result, { ecmaVersion: 'latest', sourceType: 'module' })
    const side = target ? 'server' : 'dom'
    const js = result
      .replace(/'@frontierjs\/mesa\/runtime\/server'/g, `'./src/runtime-server.js'`)
      .replace(/'@frontierjs\/mesa\/runtime'/g, `'./src/runtime.js'`)
      .replace(/from '\.\/(\w+)\.mesa'/g, (_, c) => `from './_tmp_hy_${c}_${side}.mjs'`)
      .replace(/import\("\.\/(\w+)\.mesa"\)/g, (_, c) => `import('./_tmp_hy_${c}_${side}.mjs')`)
    const file = path.join(process.cwd(), `_tmp_hy_${name}_${side}.mjs`)
    writeFileSync(file, js)
    written.push(file)
    out[side] = (await import('file://' + file)).default
  }
  return out
}

afterAll(() => { for (const f of written) try { unlinkSync(f) } catch {} })

async function served(c, props = {}) {
  const root = document.createElement('div')
  root.innerHTML = await renderToHTML(c.server, props, { target: 'server', hydratable: true })
  document.body.append(root)
  return root
}

const PAGE = `<script>
  export let start = 2
  let n = start
  let items = [{ id: 'a', t: 'x' }, { id: 'b', t: 'y' }]
  const add = () => { items = [...items, { id: 'c', t: 'z' }] }
</script>
<h1>Static</h1><p class:on={n > 2}>Hello {n} and {n * 2}</p><button onclick={() => n++}>go</button>{#if n > 1}<b>yes</b>{/if}<ul>{#each items as it (it.id)}<li>{it.t}</li>{/each}</ul><i onclick={add}>add</i>`

describe('hydrate()', () => {
  it('keeps the server nodes and binds them', async () => {
    const c = await build(PAGE)
    const root = await served(c)
    const p = root.querySelector('p'), h1 = root.querySelector('h1')
    p.__tagged = true
    hydrate(root, c.dom)
    expect(root.querySelector('p')).toBe(p)
    expect(root.querySelector('h1')).toBe(h1)
    expect(root.querySelectorAll('p')).toHaveLength(1)
    root.querySelector('button').click()
    flushSync()
    expect(p.textContent).toBe('Hello 3 and 6')
    expect(p.className).toBe('on')
  })

  it('places an {#each} row added after adoption inside its list', async () => {
    const c = await build(PAGE)
    const root = await served(c)
    hydrate(root, c.dom)
    root.querySelector('i').click()
    flushSync()
    expect([...root.querySelectorAll('ul > li')].map((li) => li.textContent)).toEqual(['x', 'y', 'z'])
    expect(root.querySelectorAll('li')).toHaveLength(3)
  })

  it('reads a parent $context in an adopted child', async () => {
    await build(`<script>const theme = $context.theme</script><em>{theme}</em>`, 'Kid')
    const c = await build(`<script>
  import Kid from './Kid.mesa'
  $context.theme = 'dark'
</script>
<section><Kid/></section>`)
    const root = await served(c)
    const em = root.querySelector('em')
    hydrate(root, c.dom)
    expect(root.querySelector('em')).toBe(em)
    expect(em.textContent).toBe('dark')
  })

  it('adopts a child called after an adopted {#if}, under a root that opens with text', async () => {
    const c = await build(`<script>
  import Kid from './Kid.mesa'
  $context.theme = 'dark'
  let on = true
</script>
lead <b>{on}</b>{#if on}<s>x</s>{/if}<section><Kid/></section>`, 'Late', { dev: true })
    const root = await served(c)
    const [s, em] = [root.querySelector('s'), root.querySelector('em')]
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hydrate(root, c.dom)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
    expect(root.querySelector('s')).toBe(s)
    expect(root.querySelector('em')).toBe(em)
  })

  it('adopts content a parent hands a child as children, rendered inside an element the server never keyed', async () => {
    await build(`<script>\n  export let children\n</script>\n<div id="shell">{@render children?.()}</div>`, 'Shell')
    await build(`<div id="box"><slot /></div>`, 'Box')
    const c = await build(`<script>
  import Shell from './Shell.mesa'
  import Box from './Box.mesa'
  import Kid from './Kid.mesa'
  $context.theme = 'dark'
  let n = 1
</script>
<Shell><p onclick={() => n++}>{n}</p><Kid/></Shell><Box><b>{n}</b></Box>`, 'Wraps', { dev: true })
    const root = await served(c)
    const [shell, p, em, b] = ['#shell', 'p', 'em', 'b'].map((s) => root.querySelector(s))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hydrate(root, c.dom)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
    expect(['#shell', 'p', 'em', 'b'].map((s) => root.querySelector(s))).toEqual([shell, p, em, b])
    expect(root.querySelector('#shell').firstElementChild).toBe(p)
    p.click()
    flushSync()
    expect([p.textContent, b.textContent, root.querySelectorAll('p')]).toEqual(['2', '2', expect.objectContaining({ length: 1 })])
  })

  it('adopts the server branch of an {#if} and the rows of an {#each} as the same nodes', async () => {
    const c = await build(PAGE)
    const root = await served(c)
    const b = root.querySelector('b'), lis = [...root.querySelectorAll('li')]
    hydrate(root, c.dom)
    expect(root.querySelector('b')).toBe(b)
    expect([...root.querySelectorAll('li')]).toEqual(lis)
    root.querySelector('i').click()
    flushSync()
    expect([...root.querySelectorAll('li')].slice(0, 2)).toEqual(lis)
  })

  it('adopts the content of a {#key} block, and rebuilds it when the key changes (FJS-4515)', async () => {
    const c = await build(`<script>\n  let id = 1\n  let n = 0\n</script>\n<button onclick={() => id++}>next</button>{#key id}<b onclick={() => n++}>{id} {n}</b>{/key}`, undefined, { dev: true })
    const root = await served(c)
    const b = root.querySelector('b')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hydrate(root, c.dom)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
    expect(root.querySelector('b')).toBe(b)
    b.click()
    flushSync()
    expect(b.textContent).toBe('1 1')
    root.querySelector('button').click()
    flushSync()
    expect(root.querySelectorAll('b').length).toBe(1)
    expect(root.querySelector('b')).not.toBe(b)
    expect(root.querySelector('b').textContent).toBe('2 1')
  })

  it('adopts the nodes an {@html} wrote, replaces them on the next write, and replaces markup the client parses differently (FJS-4515)', async () => {
    const src = `<script>\n  export let m = '<i>one</i>'\n  let n = 0\n</script>\n<p>a{@html m}b</p><button onclick={() => { m = '<u>two</u>'; n++ }}>{n}</button>`
    const c = await build(src, undefined, { dev: true })
    const root = await served(c)
    const i = root.querySelector('i'), p = root.querySelector('p')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hydrate(root, c.dom)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
    expect(root.querySelector('p')).toBe(p)
    expect(root.querySelector('i')).toBe(i)
    root.querySelector('button').click()
    flushSync()
    expect(p.innerHTML.replace(/<!--[^>]*-->/g, '')).toBe('a<u>two</u>b')

    const other = await served(c)
    hydrate(other, c.dom, { m: '<b>else</b>' })
    expect(other.querySelector('p').innerHTML.replace(/<!--[^>]*-->/g, '')).toBe('a<b>else</b>b')
  })

  it('adopts the settled branch of an {#await}', async () => {
    const c = await build(`<script>\n  let p = Promise.resolve(5)\n</script>\n<div>{#await p}{:then v}<i>got {v}</i>{/await}</div>`)
    const root = await served(c)
    const i = root.querySelector('i')
    expect(i.textContent).toBe('got 5')
    hydrate(root, c.dom)
    expect(root.querySelector('i')).toBe(i)
    await new Promise((r) => setTimeout(r, 0))
    flushSync()
    expect(root.querySelector('i')).toBe(i)
    expect(root.querySelectorAll('i')).toHaveLength(1)
  })

  it('adopts a single-element root with no key, and refuses by name when it is not on the page', async () => {
    const c = await build('<section><b>hi</b></section>', 'Solo', { dev: true })
    const root = await served(c)
    const section = root.querySelector('section')
    hydrate(root, c.dom)
    expect(root.querySelector('section')).toBe(section)
    const again = await served(c)
    again.querySelector('section').replaceWith(document.createTextNode('gone'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hydrate(again, c.dom)
    expect(warn.mock.calls.flat().join(' ')).toMatch(/Solo\.mesa: the root element of 0 is not on the page; re-rendered the page/)
    warn.mockRestore()
    expect(again.querySelectorAll('section')).toHaveLength(1)
  })

  it('re-renders the page, naming the binding, when a marker at a component root is missing', async () => {
    const c = await build(PAGE, undefined, { dev: true })
    const root = await served(c)
    const mark = [...root.querySelector('p').childNodes].find((x) => x.nodeType === 8)
    const p = root.querySelector('p')
    mark.remove()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hydrate(root, c.dom)
    expect(warn.mock.calls.flat().join(' ')).toMatch(/no marker for binding \w+ \(source offset \d+\)/)
    warn.mockRestore()
    expect(root.querySelector('p')).not.toBe(p)
    expect(root.querySelectorAll('p')).toHaveLength(1)
    expect(root.querySelectorAll('li')).toHaveLength(2)
  })

  it('re-renders the page when a text binding\'s marker is missing under a root element its code names (FJS-4519)', async () => {
    const c = await build(`<script>\n  let n = 0\n</script>\n<button onclick={() => n++}>{n}</button>`, undefined, { dev: true })
    const root = await served(c)
    const button = root.querySelector('button')
    ;[...button.childNodes].find((x) => x.nodeType === 8).remove()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hydrate(root, c.dom)
    expect(warn.mock.calls.flat().join(' ')).toMatch(/no marker for binding \w+ \(source offset \d+\) in 0; re-rendered the page/)
    warn.mockRestore()
    expect(root.querySelector('button')).not.toBe(button)
    expect(root.querySelectorAll('button')).toHaveLength(1)
  })

  it('adopts a root element with no key of its own, as a spread root is', async () => {
    const c = await build(`<script>\n  let n = 0\n</script>\n<p {...$attributes}><b onclick={() => n++}>{n}</b></p>`, undefined, { dev: true })
    const root = await served(c)
    const p = root.querySelector('p'), b = root.querySelector('b')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hydrate(root, c.dom)
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
    expect(root.querySelector('p')).toBe(p)
    b.click()
    flushSync()
    expect(root.querySelector('b')).toBe(b)
    expect(b.textContent).toBe('1')
  })

  it('detects a wrong {#if} branch and re-renders only that block', async () => {
    const c = await build(PAGE, undefined, { dev: true })
    const root = await served(c, { start: 2 })
    const h1 = root.querySelector('h1'), p = root.querySelector('p')
    expect(root.querySelector('b')).not.toBeNull()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hydrate(root, c.dom, { start: 0 })
    expect(warn.mock.calls.flat().join(' ')).toMatch(/\{#if\} \w+ in 0 took branch 0 on the server and -1 here; re-rendered the block/)
    warn.mockRestore()
    expect(root.querySelector('h1')).toBe(h1)
    expect(root.querySelector('p')).toBe(p)
    expect(root.querySelector('b')).toBeNull()
  })

  it('detects a missing row and re-renders only that {#each}', async () => {
    const src = `<script>\n  export let ids = []\n</script>\n<h2>t</h2><ul>{#each ids as id (id)}<li>{id}</li>{/each}</ul>`
    const c = await build(src, undefined, { dev: true })
    const root = await served(c, { ids: ['a', 'b'] })
    const h2 = root.querySelector('h2')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hydrate(root, c.dom, { ids: ['a'] })
    expect(warn.mock.calls.flat().join(' ')).toMatch(/\{#each\} \w+ in 0 wrote rows \[0\[a\],0\[b\]\] on the server and \[0\[a\]\] here; re-rendered the block/)
    warn.mockRestore()
    expect(root.querySelector('h2')).toBe(h2)
    expect([...root.querySelectorAll('li')].map((li) => li.textContent)).toEqual(['a'])
  })

  it('retries a mismatch inside a child instance at its enclosing block, not the page', async () => {
    await build('<script>\n  export let v\n</script>\n<em>{v}</em>', 'Leaf', { dev: true })
    const c = await build(`<script>\n  import Leaf from './Leaf.mesa'\n  let on = true\n  let v = 1\n</script>\n<p>{v}</p>{#if on}<div><Leaf v={v} /></div>{/if}`, undefined, { dev: true })
    const root = await served(c)
    const p = root.querySelector('p'), em = root.querySelector('em')
    ;[...em.childNodes].find((x) => x.nodeType === 8).remove()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hydrate(root, c.dom)
    expect(warn.mock.calls.flat().join(' ')).toMatch(/Leaf\.mesa: no marker for binding \w+ \(source offset \d+\) in 0\.\w+; re-rendered \{#if\}/)
    warn.mockRestore()
    expect(root.querySelector('p')).toBe(p)
    expect(root.querySelector('em')).not.toBe(em)
    expect(root.querySelectorAll('em')).toHaveLength(1)
    expect(root.querySelector('em').textContent).toBe('1')
  })

  it('fails closed on a page written by another build of the component (FJS-D2177)', async () => {
    const src = '<script>\n  let n = 1\n</script>\n<p>{n}</p>\n<style>p { color: red }</style>'
    const c = await build(src, 'Stale', { dev: true, client: src.replace('red', 'blue') })
    const root = await served(c)
    const p = root.querySelector('p')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hydrate(root, c.dom)
    expect(warn.mock.calls.flat().join(' ')).toMatch(/Stale\.mesa: 0 was rendered by scope \S+ and this build is \S+, a page and a bundle from different builds; re-rendered the page/)
    warn.mockRestore()
    expect(root.querySelector('p')).not.toBe(p)
    expect(root.querySelectorAll('p')).toHaveLength(1)
  })

  it('warns nothing in a production build', async () => {
    const c = await build(PAGE)
    const root = await served(c, { start: 2 })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hydrate(root, c.dom, { start: 0 })
    expect(warn).not.toHaveBeenCalled()
    warn.mockRestore()
  })
})

// 3.1: what the server settled reaches the client without a second fetch.
describe('hydrate() with server state', () => {
  const SRC = `<script>\n  const load = () => { globalThis.__hyLoads = (globalThis.__hyLoads ?? 0) + 1; return Promise.resolve({ n: 7, secret: 's' }) }\n</script>\n<div>{#await load()}{:then v}<i>got {v.n}</i>{/await}</div>`
  const render = (c) => renderToParts(c.server, {}, { target: 'server', hydratable: true })

  it('collects each settled {#await} value under its instance id and the key its marker carries', async () => {
    const c = await build(SRC)
    const { html, state } = await render(c)
    const [, id, key] = html.match(/<!--\[ (\S+) (\S+) then-->/)
    expect(state).toEqual({ [`${id} ${key}`]: { n: 7, secret: 's' } })
  })

  it('reads its entry instead of evaluating the expression, and adopts the server text', async () => {
    const c = await build(SRC)
    const { html, state } = await render(c)
    const root = document.createElement('div')
    root.innerHTML = html
    document.body.append(root)
    const i = root.querySelector('i')
    globalThis.__hyLoads = 0
    hydrate(root, c.dom, {}, { state: JSON.parse(JSON.stringify(state)) })
    await new Promise((r) => setTimeout(r, 0))
    flushSync()
    expect(globalThis.__hyLoads).toBe(0)
    expect(root.querySelector('i')).toBe(i)
    expect(i.textContent).toBe('got 7')
  })

  it('falls back to evaluating a missing entry, and a dev build names the binding', async () => {
    const c = await build(SRC, 'HyMiss', { dev: true })
    const { html } = await render(c)
    const root = document.createElement('div')
    root.innerHTML = html
    document.body.append(root)
    globalThis.__hyLoads = 0
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hydrate(root, c.dom, {}, { state: {} })
    await new Promise((r) => setTimeout(r, 0))
    flushSync()
    expect(globalThis.__hyLoads).toBe(1)
    expect(warn.mock.calls.flat().join(' ')).toMatch(/HyMiss\.mesa: \{#await\} \S+ in 0 has no server state; evaluated it again/)
    expect(root.querySelector('i').textContent).toBe('got 7')
    warn.mockRestore()
  })

  it('an unflagged string render carries no state', async () => {
    const c = await build(SRC)
    expect(await renderToParts(c.server, {}, { target: 'server' })).not.toHaveProperty('state')
  })
})

describe('an adopted {#await} still re-runs on what it reads', () => {
  it('a change to its argument loads once, with the new value', async () => {
    const c = await build(`<script>\n  let id = 1\n  const load = (i) => { globalThis.__hyIds.push(i); return Promise.resolve('v' + i) }\n</script>\n<div>{#await load(id)}{:then v}<i>{v}</i>{/await}<button onclick={() => id++}>next</button></div>`)
    globalThis.__hyIds = []
    const { html, state } = await renderToParts(c.server, {}, { target: 'server', hydratable: true })
    const root = document.createElement('div')
    root.innerHTML = html
    document.body.append(root)
    globalThis.__hyIds = []
    hydrate(root, c.dom, {}, { state })
    await new Promise((r) => setTimeout(r, 0))
    flushSync()
    expect(globalThis.__hyIds).toEqual([])
    expect(root.querySelector('i').textContent).toBe('v1')
    root.querySelector('button').click()
    flushSync()
    await new Promise((r) => setTimeout(r, 0))
    flushSync()
    expect(globalThis.__hyIds).toEqual([2])
    expect(root.querySelector('i').textContent).toBe('v2')
  })

  it('an expression whose reads it cannot separate from its calls is evaluated, and a dev build names it', async () => {
    const c = await build(`<script>\n  let id = 1\n  const load = (i) => { globalThis.__hyIds.push(i); return Promise.resolve('v' + i) }\n  const pick = (i) => i\n</script>\n<div>{#await load(pick(id))}{:then v}<i>{v}</i>{/await}</div>`, 'HyNest', { dev: true })
    globalThis.__hyIds = []
    const { html, state } = await renderToParts(c.server, {}, { target: 'server', hydratable: true })
    const root = document.createElement('div')
    root.innerHTML = html
    document.body.append(root)
    globalThis.__hyIds = []
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hydrate(root, c.dom, {}, { state })
    await new Promise((r) => setTimeout(r, 0))
    flushSync()
    expect(globalThis.__hyIds).toEqual([1])
    expect(warn.mock.calls.flat().join(' ')).toMatch(/HyNest\.mesa: \{#await\} \S+ in 0 reads through a call or a member chain/)
    warn.mockRestore()
  })
})

// FJS-D2285: a build renders every page in one process.
describe('a module store carried from one page into the next', () => {
  it('warns on a page that watches it, naming the store and both pages, and not on one that does not', async () => {
    const store = path.join(process.cwd(), '_tmp_hy_store.mjs')
    writeFileSync(store, 'export const cart = { count: 0 }\n')
    written.push(store)
    const imp = `import { cart } from './_tmp_hy_store.mjs'`
    const writer = await build(`<script>\n  ${imp}\n  $: cart\n  cart.count = 3\n</script>\n<b>{cart.count}</b>`, 'HyWriter')
    const reader = await build(`<script>\n  ${imp}\n  $: cart\n</script>\n<b>{cart.count}</b>`, 'HyReader')
    const about = await build('<p>about</p>', 'HyAbout')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const page = (c, label) => renderToParts(c.server, {}, { target: 'server', hydratable: true, label })
    await page(writer, '/shop/')
    expect(warn).not.toHaveBeenCalled()
    await page(about, '/about/')
    expect(warn).not.toHaveBeenCalled()
    await page(reader, '/cart/')
    expect(warn.mock.calls.flat().join(' ')).toMatch(/store 'cart' starts page \/cart\/ holding a value page \/shop\/ wrote/)
    warn.mockRestore()
  })
})

describe('hydrate() with an awaited const', () => {
  // The {#await} holds the render open, so the load lands inside it: the
  // string mode does not wait on a boundary.
  const SRC = `<script>\n  let id = 1\n  const load = (i) => { globalThis.__hyUsers.push(i); return Promise.resolve({ name: 'user' + i }) }\n  const user = await load(id)\n  const tick = new Promise((r) => setTimeout(r, 5))\n</script>\n{#await tick}{:then t}<u>t</u>{/await}<mesa:boundary><p>{user.name}</p>{#snippet failed(e)}<s>failed</s>{/snippet}</mesa:boundary><button onclick={() => id++}>next</button>`
  const page = async (c) => {
    globalThis.__hyUsers = []
    const { html, state } = await renderToParts(c.server, {}, { target: 'server', hydratable: true })
    const root = document.createElement('div')
    root.innerHTML = html
    document.body.append(root)
    globalThis.__hyUsers = []
    return { root, html, state }
  }
  const settle = async () => { for (let i = 0; i < 2; i++) { await new Promise((r) => setTimeout(r, 10)); flushSync() } }

  it('a load that lands during the render is recorded under the const', async () => {
    const c = await build(SRC)
    const { state } = await page(c)
    expect(Object.entries(state).filter(([k]) => k.includes('$'))).toEqual([[expect.stringMatching(/^0 \$\w+$/), { name: 'user1' }]])
  })

  it('the client starts from the entry, loads nothing, and loads once when what it reads changes', async () => {
    const c = await build(SRC)
    const { root, state } = await page(c)
    hydrate(root, c.dom, {}, { state: JSON.parse(JSON.stringify(state)) })
    await settle()
    expect(globalThis.__hyUsers).toEqual([])
    expect(root.querySelector('p').textContent).toBe('user1')
    root.querySelector('button').click()
    flushSync()
    await settle()
    expect(globalThis.__hyUsers).toEqual([2])
    expect(root.querySelectorAll('p')).toHaveLength(1)
    expect(root.querySelector('p').textContent).toBe('user2')
  })

  // Nothing else holds the render open, so the boundary has to wait itself.
  it('the server waits on a boundary, and the client adopts what it wrote (FJS-4517)', async () => {
    const slow = SRC.replace(/\{#await tick\}.*?\{\/await\}/, '').replace("return Promise.resolve({ name: 'user' + i })", "return new Promise((r) => setTimeout(() => r({ name: 'user' + i }), 5))")
    const c = await build(slow)
    const { root, html, state } = await page(c)
    expect(html).toMatch(/<p>[^<]*user1/)
    const p = root.querySelector('p')
    hydrate(root, c.dom, {}, { state: JSON.parse(JSON.stringify(state)) })
    await settle()
    expect(globalThis.__hyUsers).toEqual([])
    expect(root.querySelectorAll('p')).toHaveLength(1)
    expect(root.querySelector('p')).toBe(p)
  })

  it('a missing entry is loaded, and a dev build names it', async () => {
    const c = await build(SRC, 'HyConst', { dev: true })
    const { root } = await page(c)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hydrate(root, c.dom, {}, { state: {} })
    await settle()
    expect(globalThis.__hyUsers).toEqual([1])
    expect(warn.mock.calls.flat().join(' ')).toMatch(/HyConst\.mesa: the awaited const at \$\w+ in 0 has no server state; loaded it again/)
    expect(root.querySelector('p').textContent).toBe('user1')
    warn.mockRestore()
  })
})

describe('a client:* subtree under the flag (FJS-D2174)', () => {
  // An idle trigger and a dynamic import, then the claim; a first import of a
  // module written moments ago is slow.
  const tick = () => new Promise((r) => setTimeout(r, 200))
  const KID = `<script>
  export let label = 'a'
  const theme = $context.theme
  let n = 0
</script>
<button onclick={() => n++}>{label} {theme} {n}</button>`

  it('keeps its server nodes, attaches on its trigger, and starts from the parent\'s latest props', async () => {
    await build(KID, 'Tick')
    const c = await build(`<script>
  import Tick from './Tick.mesa'
  $context.theme = 'dark'
  export let label = 'a'
  export function relabel(v) { label = v }
</script>
<section><Tick client:idle {label}/></section>`, 'Idle')
    const root = await served(c)
    const button = root.querySelector('button')
    expect(button.textContent).toBe('a dark 0')
    const api = hydrate(root, c.dom)
    button.click()
    flushSync()
    expect(button.textContent).toBe('a dark 0')
    await tick()
    flushSync()
    expect(root.querySelector('button')).toBe(button)
    button.click()
    flushSync()
    expect(button.textContent).toBe('a dark 1')
    expect(api).toBeTruthy()
  })

  it('a push made before the trigger reaches the subtree when it attaches, and later pushes stay live', async () => {
    await build(KID, 'Tock')
    const c = await build(`<script>
  import Tock from './Tock.mesa'
  let label = 'a'
</script>
<i onclick={() => label += 'b'}>more</i><Tock client:idle {label}/>`, 'Pushed')
    const root = await served(c)
    hydrate(root, c.dom)
    root.querySelector('i').click()
    flushSync()
    expect(root.querySelector('button').textContent).toBe('a  0')
    await tick()
    flushSync()
    expect(root.querySelector('button').textContent).toBe('ab  0')
    root.querySelector('i').click()
    flushSync()
    expect(root.querySelector('button').textContent).toBe('abb  0')
  })

  it('bind:this resolves to the subtree\'s interface once it attaches (FJS-4518)', async () => {
    await build(`<script>\n  export let label = 'a'\n  export function shout() { return label + '!' }\n</script>\n<button>{label}</button>`, 'Ref')
    const c = await build(`<script>
  import Ref from './Ref.mesa'
  let kid
</script>
<b onclick={() => { globalThis.__hyRef = kid }}>peek</b><Ref client:idle label="r" bind:this={kid}/>`, 'RefHost')
    const root = await served(c)
    hydrate(root, c.dom)
    await tick()
    flushSync()
    root.querySelector('b').click()
    expect(globalThis.__hyRef?.label).toBe('r')
    expect(globalThis.__hyRef?.shout()).toBe('r!')
  })

  it('client:static adopts the structure and never attaches', async () => {
    await build(KID, 'Still')
    const c = await build(`<script>import Still from './Still.mesa'</script><Still client:static/>`, 'Static')
    const root = await served(c)
    hydrate(root, c.dom)
    await tick()
    root.querySelector('button').click()
    flushSync()
    expect(root.querySelector('button').textContent).toBe('a  0')
  })

  it('bounds the site on the server only under the flag', async () => {
    await build(KID, 'Bnd')
    const c = await build(`<script>import Bnd from './Bnd.mesa'</script><p>x</p><Bnd client:idle/>`, 'Bounded')
    const html = await renderToHTML(c.server, {}, { target: 'server', hydratable: true })
    expect(html).toMatch(/<!--\[ 0 (\S+)--><!--i 0\.\1 \S+--><button>[\s\S]*<!--\] 0 \1-->$/)
  })

  it('a mismatch when the trigger attaches re-renders that site alone, and a dev build names it', async () => {
    await build(KID, 'Odd', { dev: true })
    const c = await build(`<script>import Odd from './Odd.mesa'</script><p>keep</p><Odd client:idle label="z"/>`, 'Mismatch', { dev: true })
    const root = await served(c)
    const p = root.querySelector('p')
    const stale = root.querySelector('button')
    // Another build's scope id on the subtree's instance marker: its root claim fails.
    const mark = stale.previousSibling
    mark.data = mark.data.replace(/ \S+$/, ' zzzz')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hydrate(root, c.dom)
    expect(warn).not.toHaveBeenCalled()
    await tick()
    flushSync()
    expect(warn.mock.calls.map((a) => String(a[0])).join('\n')).toMatch(/re-rendered the client:idle <Odd>/)
    warn.mockRestore()
    const button = root.querySelector('button')
    expect(button).not.toBe(stale)
    expect(root.querySelectorAll('button').length).toBe(1)
    expect(root.querySelector('p')).toBe(p)
    button.click()
    flushSync()
    expect(button.textContent).toBe('z  1')
  })

  it('a text binding whose marker is missing re-renders the site when the trigger attaches (FJS-4519)', async () => {
    await build(KID, 'Unmarked', { dev: true })
    const c = await build(`<script>import Unmarked from './Unmarked.mesa'</script><p>keep</p><Unmarked client:idle label="z"/>`, 'UnmarkedHost', { dev: true })
    const root = await served(c)
    const p = root.querySelector('p')
    const stale = root.querySelector('button')
    ;[...stale.childNodes].find((x) => x.nodeType === 8).remove()
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    hydrate(root, c.dom)
    await tick()
    flushSync()
    expect(warn.mock.calls.map((a) => String(a[0])).join('\n')).toMatch(/no marker for binding \w+ \(source offset \d+\) in 0\.\w+; re-rendered the client:idle <Unmarked>/)
    warn.mockRestore()
    const button = root.querySelector('button')
    expect(button).not.toBe(stale)
    expect(root.querySelectorAll('button')).toHaveLength(1)
    expect(root.querySelector('p')).toBe(p)
    button.click()
    flushSync()
    expect(button.textContent).toBe('z  1')
  })

  it('an {#await} inside the subtree reads its server state when it attaches, and loads nothing', async () => {
    await build(`<script>\n  const load = () => { globalThis.__hyIsl = (globalThis.__hyIsl ?? 0) + 1; return Promise.resolve({ n: 4 }) }\n</script>\n<div>{#await load()}{:then v}<i>got {v.n}</i>{/await}</div>`, 'Awaits')
    const c = await build(`<script>import Awaits from './Awaits.mesa'</script><Awaits client:idle/>`, 'AwaitHost')
    const { html, state } = await renderToParts(c.server, {}, { target: 'server', hydratable: true })
    const root = document.createElement('div')
    root.innerHTML = html
    document.body.append(root)
    const i = root.querySelector('i')
    globalThis.__hyIsl = 0
    hydrate(root, c.dom, {}, { state: JSON.parse(JSON.stringify(state)) })
    await tick()
    flushSync()
    expect(globalThis.__hyIsl).toBe(0)
    expect(root.querySelector('i')).toBe(i)
    expect(i.textContent).toBe('got 4')
  })

  it('splits the component into its own import() only when nothing else names it', async () => {
    const opts = { filename: 'P.mesa', css: false, warning: () => {}, hydratable: true }
    const lazy = (await compile(`<script>import Tick from './Tick.mesa'</script><Tick client:visible/>`, opts)).result
    acorn.parse(lazy, { ecmaVersion: 'latest', sourceType: 'module' })
    expect(lazy).toContain('import("./Tick.mesa")')
    expect(lazy).not.toMatch(/import Tick from/)
    const both = (await compile(`<script>import Tick from './Tick.mesa'</script><Tick client:visible/><Tick/>`, opts)).result
    acorn.parse(both, { ecmaVersion: 'latest', sourceType: 'module' })
    expect(both).toMatch(/import Tick from/)
    expect(both).toContain('$$runtime.hydIsland(')
    const plain = (await compile(`<script>import Tick from './Tick.mesa'</script><Tick client:visible/>`, { ...opts, hydratable: false })).result
    expect(plain).not.toContain('hydIsland')
  })
})
