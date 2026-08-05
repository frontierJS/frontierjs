// external-reactivity.test.js
//
// A template read of an imported signal is only reactive if the name appears in
// the `externalSignals` map the consuming build passes. A miss fails silently:
// the expression reads nothing reactive, so it's hoisted out of the render block
// and the signal object — always truthy — renders once and never updates.
//
// This is the diagnostic for that. It reports the high-confidence cases only:
// an identifier imported from a module the map DOES describe, but which the
// entry doesn't cover. When the module isn't described at all we stay quiet,
// because a signal and a constant are indistinguishable at that point.
//
// See docs/EXTERNAL_REACTIVITY.md for the full failure matrix.

import { describe, test, expect } from 'vitest'
import { compileSource } from '../src/compiler.js'

const MOD = '@frontierjs/sierra/junction'
const ES = { [MOD]: ['connected', 'reconnecting'] }

const NONE = Symbol('no externalSignals')

async function warnings(src, externalSignals = ES) {
  const opts = { filename: '/t/T.mesa', dev: false }
  // A default parameter can't express "explicitly none" — undefined triggers
  // the default — so the absent case uses a sentinel.
  if (externalSignals !== NONE) opts.externalSignals = externalSignals
  const ctx = await compileSource(src, opts)
  return (ctx.analysis?.warnings ?? []).filter(w => /externalSignals|not be reactive/.test(w))
}

describe('reports undeclared names from a described module', () => {

  test('warns for a name the entry omits', async () => {
    const w = await warnings(
      `<script>import { connected, isActive } from '${MOD}'</script>` +
      `<p>{isActive ? 'a' : 'b'}</p>`
    )
    expect(w).toHaveLength(1)
    expect(w[0]).toContain("'isActive'")
    expect(w[0]).toContain(MOD)
  })

  test('warns for reads in an attribute', async () => {
    const w = await warnings(
      `<script>import { missing } from '${MOD}'</script><p class={missing}>x</p>`
    )
    expect(w).toHaveLength(1)
  })

  test('warns for reads in a block header', async () => {
    const w = await warnings(
      `<script>import { missing } from '${MOD}'</script>{#if missing}<b>y</b>{/if}`
    )
    expect(w).toHaveLength(1)
  })

  test('reports each name once, however many times it is read', async () => {
    const w = await warnings(
      `<script>import { missing } from '${MOD}'</script>` +
      `<p>{missing}</p><p>{missing ? 1 : 2}</p><p class={missing}>z</p>`
    )
    expect(w).toHaveLength(1)
  })
})

describe('namespace imports', () => {

  test('warns when a declared signal is reached through a namespace', async () => {
    // `import * as j` is never rewritten, even when `connected` is declared —
    // so this is the one case where being ON the list still fails.
    const w = await warnings(
      `<script>import * as j from '${MOD}'</script><p>{j.connected ? 'a' : 'b'}</p>`
    )
    expect(w).toHaveLength(1)
    expect(w[0]).toContain('namespace imports are not rewritten')
  })

  test('stays quiet for a namespace member that is not a known signal', async () => {
    const w = await warnings(
      `<script>import * as j from '${MOD}'</script><p>{j.somethingElse}</p>`
    )
    expect(w).toEqual([])
  })
})

describe('stays quiet where it should', () => {

  test('declared names', async () => {
    expect(await warnings(
      `<script>import { connected } from '${MOD}'</script><p>{connected ? 'a' : 'b'}</p>`
    )).toEqual([])
  })

  test('modules the map does not describe', async () => {
    // Could be a signal, could be a constant — no basis to guess.
    expect(await warnings(
      `<script>import { whatever } from './lib/rx.js'</script><p>{whatever ? 'a' : 'b'}</p>`
    )).toEqual([])
  })

  test('callee position — being called, not read', async () => {
    expect(await warnings(
      `<script>import { isActive } from '${MOD}'</script><p>{isActive('/x') ? 'a' : 'b'}</p>`
    )).toEqual([])
  })

  test('event handlers — the value is meant to be a function', async () => {
    // on:click={toggleTheme} reads an imported function as a value, which is
    // correct and extremely common. Warning here made the diagnostic noisy
    // enough to be worth turning off.
    expect(await warnings(
      `<script>import { toggle } from '${MOD}'</script><button on:click={toggle}>x</button>`
    )).toEqual([])
    expect(await warnings(
      `<script>import { toggle } from '${MOD}'</script><button onclick={toggle}>x</button>`
    )).toEqual([])
  })

  test('directives', async () => {
    expect(await warnings(
      `<script>import { fade } from '${MOD}'</script><p transition:fade={fade}>x</p>`
    )).toEqual([])
  })

  test('local variables', async () => {
    expect(await warnings(`<script>let n = 1</script><p>{n ? 'a' : 'b'}</p>`)).toEqual([])
  })

  test('no externalSignals configured at all', async () => {
    expect(await warnings(
      `<script>import { anything } from '${MOD}'</script><p>{anything}</p>`, NONE
    )).toEqual([])
  })
})

// ─── Path-watch tier ─────────────────────────────────────────────────────────
// Imported plain objects are inert; §4.1 `$:` declarations make specific paths
// reactive. A member read with no covering watch compiles to a static value.
//
// Two confidence levels, because a plain imported config object and a mutable
// store are indistinguishable:
//   default — the file already watches something on this import, so intent is
//             clear and an uncovered path is an oversight
//   strict  — any uncovered member read (opt-in; a migration aid)

describe('path-watch tier', () => {
  const S = "import { page, cfg } from './state.js'"
  const strict = { externalReactivityHints: 'strict' }

  const pathWarn = async (src, cfg = {}) => {
    const ctx = await compileSource(src, { filename: '/t/T.mesa', dev: false, ...cfg })
    return (ctx.analysis?.warnings ?? []).filter(w => /watch covers it/.test(w))
  }

  test('warns for an uncovered path when the file watches the same root', async () => {
    const w = await pathWarn(
      `<script>${S}\n$: page.path</script><p>{page.path}{page.params.id}</p>`
    )
    expect(w).toHaveLength(1)
    expect(w[0]).toContain("'page.params.id'")
    expect(w[0]).toContain('$: page.params.id')
  })

  test('a covered path is silent', async () => {
    expect(await pathWarn(`<script>${S}\n$: page.path</script><p>{page.path}</p>`)).toEqual([])
  })

  test('a prefix watch covers deeper reads', async () => {
    expect(await pathWarn(`<script>${S}\n$: page.params</script><p>{page.params.id}</p>`)).toEqual([])
  })

  test('a whole-object watch covers everything', async () => {
    expect(await pathWarn(
      `<script>${S}\n$: page</script><p>{page.params.id}{page.data}</p>`
    )).toEqual([])
  })

  test('silent by default when the file watches nothing on that import', async () => {
    // Could be a plain config object read intentionally as a static value.
    expect(await pathWarn(`<script>${S}</script><p>{cfg.name}</p>`)).toEqual([])
  })

  test('strict mode warns for any uncovered member read', async () => {
    expect(await pathWarn(`<script>${S}</script><p>{cfg.name}</p>`, strict)).toHaveLength(1)
  })

  test('local objects are never reported', async () => {
    expect(await pathWarn(`<script>let o = { a: 1 }</script><p>{o.a}</p>`, strict)).toEqual([])
  })

  test('method calls are not value reads', async () => {
    expect(await pathWarn(`<script>${S}</script><p>{cfg.fmt('x')}</p>`, strict)).toEqual([])
  })

  test('defers to externalSignals — declared signals need no $:', async () => {
    // `page` is a signal here, so the accessor rewrite already makes it
    // reactive. Reporting it would double up with the signal tier and fire on
    // every component in an app using the current architecture.
    const w = await pathWarn(
      `<script>import { page } from '@frontierjs/sierra/router'</script><p>{page.path}</p>`,
      { ...strict, externalSignals: { '@frontierjs/sierra/router': ['page'] } }
    )
    expect(w).toEqual([])
  })

  test('reports each path once however many times it is read', async () => {
    const w = await pathWarn(
      `<script>${S}\n$: page.path</script><p>{page.a.b}</p><p>{page.a.b}</p><i>{page.a.b}</i>`
    )
    expect(w).toHaveLength(1)
  })
})

describe('does not disturb compilation', () => {

  test('a warned component still compiles, and still compiles wrongly', async () => {
    // The diagnostic reports; it does not fix. The undeclared read is still
    // emitted as a bare reference — that is the bug it is pointing at.
    const ctx = await compileSource(
      `<script>import { missing } from '${MOD}'</script><p>{missing ? 'a' : 'b'}</p>`,
      { filename: '/t/T.mesa', dev: false, externalSignals: ES }
    )
    expect(ctx.result).toContain("missing ? 'a' : 'b'")
    expect(ctx.result).not.toContain('missing.get()')
  })

  test('a declared read is rewritten as normal', async () => {
    const ctx = await compileSource(
      `<script>import { connected } from '${MOD}'</script><p>{connected ? 'a' : 'b'}</p>`,
      { filename: '/t/T.mesa', dev: false, externalSignals: ES }
    )
    expect(ctx.result).toContain('connected.get()')
  })

  test('template shapes with non-array node parts do not crash the walker', async () => {
    // `parts` is not always an array; an earlier version spread it and threw
    // "object is not iterable" on real components.
    const src = `<script>import { connected } from '${MOD}'</script>
      {#each [1,2] as n}<p>{n}</p>{/each}
      {#if connected}<b>y</b>{:else}<i>n</i>{/if}
      <p>{connected ? 'a' : 'b'}</p>`
    await expect(
      compileSource(src, { filename: '/t/T.mesa', dev: false, externalSignals: ES })
    ).resolves.toBeDefined()
  })
})
