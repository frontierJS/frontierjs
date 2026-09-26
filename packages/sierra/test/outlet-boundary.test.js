// @vitest-environment happy-dom
//
// outlet-boundary.test.js — a route that throws while it renders (FJS-D376).
//
// Every level of the chain ChainRenderer draws sits inside a `<mesa:boundary>`,
// so a page that throws is replaced by `failed` and its layouts stay standing,
// where before it left a half-drawn page and a console line. Mounted rather
// than compiled and grepped: which level catches is decided by where the
// compiled content's nodes hang in the owner tree, which only a mount shows.
//
// The real ChainRenderer.mesa, compiled by the workspace's mesa and run on its
// runtime. Its two imports are handed in: `page` as a plain object, since
// nothing here navigates, and itself for the recursion.

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileSource } from '../../mesa/src/compiler.js'
import * as runtime from '../../mesa/src/runtime.js'

const here = dirname(fileURLToPath(import.meta.url))
const tick = () => new Promise((r) => setTimeout(r, 0))
const settle = async () => { runtime.flushSync(); await tick(); runtime.flushSync() }

async function build(src, filename, globals) {
  const ctx = await compileSource(src, { filename, dev: false, css: false })
  if (ctx.analysis?.errors?.length) throw new Error(ctx.analysis.errors[0])
  let code = ctx.result.replace(/^import\s+.+?from\s+'[^']+';$/gm, '').trim()
  code = code.replace(/^export default\s+/m, 'const __component = ') + '\nreturn __component'
  const names = Object.keys(globals)
  return new Function('$$runtime', ...names, code)(runtime, ...names.map((k) => globals[k]))
}

const page = { data: {}, params: {} }
let ChainRenderer
const chainSrc = readFileSync(resolve(here, '../src/components/ChainRenderer.mesa'), 'utf8')

async function mount(chain, props = {}) {
  ChainRenderer ??= await build(chainSrc, '/ChainRenderer.mesa', {
    page,
    ChainRendererInner: (...a) => ChainRenderer(...a),
  })
  const wrap = document.createElement('div')
  document.body.appendChild(wrap)
  const anchor = document.createElement('span')
  wrap.appendChild(anchor)
  runtime.mount(anchor, ChainRenderer, { props: { chain, depth: 0, ...props } })
  await settle()
  return wrap
}

let errorSpy
beforeEach(() => {
  document.body.innerHTML = ''
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
})
afterEach(() => { errorSpy.mockRestore() })

const Layout = () => build(`
<script>export let children</script>
<header id="layout">shell</header>
<main>{@render children()}</main>`, '/Layout.mesa', {})

const Throws = () => build(`
<script>const user = null</script>
<p id="page">{user.name}</p>`, '/Page.mesa', {})

describe('a route that throws while rendering', () => {
  it('shows a failed message in its place, with a way to try again', async () => {
    const wrap = await mount([{ component: await Throws() }])
    const alert = wrap.querySelector('[role="alert"]')
    expect(alert).not.toBeNull()
    expect(alert.querySelector('button').textContent).toBe('Try again')
    expect(wrap.querySelector('#page')).toBeNull()
    expect(errorSpy).toHaveBeenCalled()
  })

  it('leaves the layouts above it standing', async () => {
    const wrap = await mount([{ component: await Layout() }, { component: await Throws() }])
    expect(wrap.querySelector('#layout')?.textContent).toBe('shell')
    expect(wrap.querySelector('main [role="alert"]')).not.toBeNull()
  })

  it('renders the app\'s own failed when RouterView was given one', async () => {
    const App = await build(`
<script>
  import ChainRenderer from './ChainRenderer.mesa'
  export let chain
</script>
{#snippet failed(error, reset)}<p id="app-failed">{error.message}</p><button id="again" onclick={reset}>again</button>{/snippet}
<ChainRenderer {chain} depth={0} appFailed={failed} />`, '/App.mesa', { ChainRenderer: (...a) => ChainRenderer(...a) })

    const wrap = document.createElement('div')
    document.body.appendChild(wrap)
    const anchor = document.createElement('span')
    wrap.appendChild(anchor)
    ChainRenderer ??= await build(chainSrc, '/ChainRenderer.mesa', {
      page, ChainRendererInner: (...a) => ChainRenderer(...a),
    })
    runtime.mount(anchor, App, { props: { chain: [{ component: await Throws() }] } })
    await settle()

    expect(wrap.querySelector('#app-failed')?.textContent).toMatch(/null|name/)
    expect(wrap.querySelector('[role="alert"]')).toBeNull()
  })
})
