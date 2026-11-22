/**
 * The binding key — the server's string mode and the DOM builder name the
 * same live bindings (`IDEAS/hydration.md` step 1.1).
 *
 * A hydratable render writes a marker per live binding and the client looks
 * each one up by key. The server walks the IR (`src/host/emit.js`) and the
 * client walks the AST (`src/compiler.js`), so a binding only one walk thinks
 * is live is a marker the client never asks for, or a lookup that finds
 * nothing and replaces its block (`FJS-D2260`). Every corpus file is compiled
 * both ways and the two key sets compared; a file the string mode refuses has
 * no server set and is skipped, as `bun run corpus -- --portability server`
 * skips it.
 */
// @vitest-environment node
import { describe, it, expect } from 'vitest'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import * as acorn from 'acorn'
import { compile, bindingKey } from '../src/compiler.js'

const ROOT = join(import.meta.dirname, '..', '..', '..')
const quiet = { warning: () => {}, css: false, loc: false }

async function keys(source, extra = {}) {
  try {
    const ctx = await compile(source, { ...quiet, ...extra })
    // A refused file with a <script module> compiles its data half and no template.
    if (ctx.targetRefusal) return { refused: ctx.targetRefusal }
    return [...(ctx.liveBindings ?? []), ...(ctx.hydrationSites ?? [])].sort()
  } catch (err) {
    return { refused: String(err?.message ?? err) }
  }
}

const both = async (source, filename) => ({
  dom: await keys(source, { filename }),
  server: await keys(source, { filename, target: 'server' }),
})

describe('the binding key', () => {
  it('is the source offset of the binding', () => {
    expect(bindingKey(0)).toBe('0')
    expect(bindingKey(1234)).toBe((1234).toString(36))
  })

  it('names a live text binding the same on both walks, and a constant one on neither', async () => {
    const src = '<script>\n  let n = 1\n  const fixed = 2\n</script>\n<p>a {n} b</p><p>{fixed}</p>'
    const { dom, server } = await both(src)
    expect(dom).toEqual([bindingKey(src.indexOf('a {n}'))])
    expect(server).toEqual(dom)
  })

  it('names an element with a live attribute, class or style by the element', async () => {
    const src = '<script>\n  let c = 1\n</script>\n<p title={c}>a</p><i class:on={c}>b</i><b style:color={c}>x</b><s title="k">y</s>'
    const { dom, server } = await both(src)
    expect(dom).toEqual(['<p', '<i', '<b'].map((t) => bindingKey(src.indexOf(t))).sort())
    expect(server).toEqual(dom)
  })

  it('names an element the client reaches only by a handler, bind:, {@attach} or bind:this', async () => {
    const src = '<script>\n  let v = 1\n  let el\n  const go = () => {}\n  const fx = () => {}\n</script>\n<button onclick={go}>a</button><input bind:value={v}><i {@attach fx}>c</i><b bind:this={el}>d</b><s>e</s>'
    const { dom, server } = await both(src)
    expect(dom).toEqual(['<button', '<input', '<i {', '<b bind'].map((t) => bindingKey(src.indexOf(t))).sort())
    expect(server).toEqual(dom)
  })

  it('names each block boundary and instance call site on both walks', async () => {
    const src = "<script>\n  import C from './C.mesa'\n  let on = true\n  let xs = []\n</script>\n{#snippet s()}<b>s</b>{/snippet}{#if on}<b>y</b>{/if}{#each xs as x (x)}<i>{x}</i>{/each}{#await Promise.resolve(1)}{:then v}{v}{/await}<C/>{@render s()}"
    const { dom, server } = await both(src)
    const at = (t) => bindingKey(src.indexOf(t))
    for (const k of ['block ' + at('{#if'), 'block ' + at('{#each'), 'block ' + at('{#await'), 'site ' + at('<C/>'), 'site ' + at('{@render')]) expect(dom).toContain(k)
    expect(server).toEqual(dom)
  })

  it('names a flagged <mesa:boundary> by its own offset on both walks (FJS-4517)', async () => {
    const src = "<script>\n  const u = $async(() => Promise.resolve(1))\n</script>\n<mesa:boundary>{#snippet pending()}<i>w</i>{/snippet}<p>{u}</p></mesa:boundary><b>after</b>"
    const dom = await keys(src, { hydratable: true }), server = await keys(src, { target: 'server', hydratable: true })
    expect(dom).toContain('block ' + bindingKey(src.indexOf('<mesa:boundary')))
    expect(server).toEqual(dom)
  })

  it('names a snippet rendered twice once, by the snippet body, on both walks', async () => {
    const src = '<script>\n  let n = 1\n</script>\n{#snippet s()}<b>{n}</b>{/snippet}\n{@render s()}{@render s()}'
    const { dom, server } = await both(src)
    expect(dom.filter((k) => !k.includes(' '))).toEqual([bindingKey(src.indexOf('{n}'))])
    expect(server).toEqual(dom)
  })
})

const UNRESOLVED_TODAY = 83

describe('every corpus file', () => {
  // rg skips node_modules and gitignored build output, as scripts/corpus.mjs does.
  const files = execFileSync('rg', ['--files', '-g', '*.mesa'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n').filter(Boolean).sort()

  it('has the same key set on the server and the client', async () => {
    const differ = []
    let compared = 0
    for (const file of files) {
      const { dom, server } = await both(readFileSync(join(ROOT, file), 'utf8'), file)
      if (dom.refused || server.refused) continue
      compared++
      const only = (a, b) => a.filter((k) => !b.includes(k))
      if (dom.join() !== server.join()) differ.push(`${file}  dom-only [${only(dom, server)}]  server-only [${only(server, dom)}]`)
    }
    expect(compared).toBeGreaterThan(100)
    expect(differ).toEqual([])
  }, 300_000)

  // Equal key sets are not enough: the flagged client may read a node the
  // server never keyed, as a layout's element around {@render children()} was.
  it('compiles every file flagged so the client reads only nodes the server keyed', async () => {
    const unresolved = []
    for (const file of files) {
      const source = readFileSync(join(ROOT, file), 'utf8')
      const server = await keys(source, { filename: file, target: 'server' })
      if (server.refused) continue
      let ctx
      try { ctx = await compile(source, { ...quiet, filename: file, hydratable: true }) }
      catch { continue }
      if (ctx.targetRefusal) continue
      const written = new Set(server.map((k) => k.replace(/^\w+ /, '')))
      const unkeyed = [...ctx.result.matchAll(/unkeyed: "([^"]+)"|adopting\("[^"]*", "([^"]+)"\)/g)].map((m) => m[1] ?? m[2])
      const taken = [...ctx.result.matchAll(/\$\$h\.take\("(\w+)"\)/g)].map((m) => m[1]).filter((k) => !written.has(k))
      if (unkeyed.length || taken.length) unresolved.push(`${file}  unkeyed [${unkeyed}]  taken, never written [${taken}]`)
    }
    // A ratchet: these files still re-render the block that reads the node,
    // by name, and the number only goes down.
    expect(unresolved.length, unresolved.join('\n')).toBeLessThanOrEqual(UNRESOLVED_TODAY)
  }, 300_000)

  // Invariant 15: a flagged compile returning is not a flagged compile that produced JavaScript.
  it('compiles every file flagged into JavaScript that parses', async () => {
    const invalid = []
    for (const file of files) {
      let ctx
      try { ctx = await compile(readFileSync(join(ROOT, file), 'utf8'), { ...quiet, filename: file, target: 'server', hydratable: true }) }
      catch { continue }
      try { acorn.parse(ctx.result, { ecmaVersion: 'latest', sourceType: 'module' }) }
      catch (err) { invalid.push(`${file}  ${err.message}`) }
    }
    expect(invalid).toEqual([])
  }, 300_000)

  // FJS-D2176: the flag off is the output of a compile that never heard of it.
  it('compiles byte-identically with hydratable off, on both paths', async () => {
    const moved = []
    for (const file of files) {
      const source = readFileSync(join(ROOT, file), 'utf8')
      for (const target of [undefined, 'server']) {
        const out = async (extra) => {
          try { return (await compile(source, { ...quiet, filename: file, target, ...extra })).result }
          catch (err) { return `refused ${err?.message ?? err}` }
        }
        if (await out({}) !== await out({ hydratable: false })) moved.push(`${file} [${target ?? 'dom'}]`)
      }
    }
    expect(moved).toEqual([])
  }, 300_000)
})
