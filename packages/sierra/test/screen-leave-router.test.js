// @vitest-environment happy-dom
//
// screen-leave-router.test.js — a screen being left must not be asked about the
// screen it is going to (FJS-1684).
//
// `apps/[id]` → `deployments/[id]` re-mounted the OLD screen with the new id,
// so it called `apps.get` with a deployment's id. Mounted, with the real router,
// RouterView and ChainRenderer, because it is the order the flush wakes the
// outlet's blocks in that decides it — a hand-written commit does not reproduce.
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { readFileSync } from 'node:fs'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { compileSource } from '../../mesa/src/compiler.js'
import * as runtime from '../../mesa/src/runtime.js'
import { initRouter, goto, page, _resetPage } from '../src/router/index.js'
import { resolveChain, remountKey, _resetInternals } from '../src/router/internals.js'

const here = dirname(fileURLToPath(import.meta.url))
const read = (rel) => readFileSync(resolve(here, rel), 'utf8')
const settle = () => new Promise((r) => setTimeout(r, 25))

async function build(src, filename, globals) {
  const ctx = await compileSource(src, { filename, dev: false, css: false })
  if (ctx.analysis?.errors?.length) throw new Error(ctx.analysis.errors[0])
  let code = ctx.result.replace(/^import\s+.+?from\s+'[^']+';$/gm, '').trim()
  code = code.replace(/^export default\s+/m, 'const __component = ') + '\nreturn __component'
  const names = Object.keys(globals)
  return new Function('$$runtime', ...names, code)(runtime, ...names.map((k) => globals[k]))
}

let _path = '/'
function installWindowMock(initialPath) {
  _path = initialPath
  globalThis.window = {
    history: {
      scrollRestoration: 'auto', state: { index: 0 },
      replaceState(st, _, p) { if (p) _path = p; this.state = { ...st } },
      pushState(st, _, p) { if (p) _path = p; this.state = { ...st } },
      back() {}, forward() {},
    },
    location: {
      get pathname() { return _path.split('?')[0] },
      get search() { return _path.includes('?') ? '?' + _path.split('?')[1] : '' },
      get hash() { return '' },
    },
    scrollY: 0, scrollTo() {}, addEventListener() {},
  }
  globalThis.MutationObserver = class { observe() {} disconnect() {} }
  globalThis.IntersectionObserver = class { observe() {} unobserve() {} disconnect() {} }
}

const tree = () => ({
  id: 'root', path: '/', file: 'src/routes/index.mesa', companion: null,
  layout: 'src/routes/_module.mesa', meta: {}, params: [], children: [
    { id: 'apps.[id]', path: '/apps/:id/', file: 'src/routes/apps/[id]/index.mesa', companion: null,
      layout: 'src/routes/_module.mesa', meta: {}, params: ['id'], children: [] },
    { id: 'deployments.[id]', path: '/deployments/:id/', file: 'src/routes/deployments/[id]/index.mesa', companion: null,
      layout: 'src/routes/_module.mesa', meta: {}, params: ['id'], children: [] },
    { id: 'apps', path: '/apps/', file: 'src/routes/apps/index.mesa', companion: null,
      layout: 'src/routes/_module.mesa', meta: {}, params: [], children: [] },
  ],
})

let seen, mounted
// A screen that does what basecamp's [id] screens do: load on mount, load again
// when the id moves, and record the id it was asked about.
const screen = (name) => build(`
<script>
  function load() { record(${JSON.stringify(name)}, page.params.id) }
  load()
  $: page.params.id, () => load()
</script>
<p id="${name}">{page.params.id}</p>`, `/${name}.mesa`, { page, record: (n, id) => seen.push([n, id]) })

beforeEach(() => { document.body.innerHTML = ''; _resetInternals(); _resetPage(); seen = [] })
afterEach(() => { mounted?.destroy(); delete globalThis.window })

async function boot() {
  installWindowMock('/apps/app_1/')
  const t = tree()
  const comps = {
    'root': async () => ({ default: await screen('home') }),
    'apps.[id]': async () => ({ default: await screen('apps') }),
    'deployments.[id]': async () => ({ default: await screen('deployments') }),
    'apps': async () => ({ default: await screen('applist') }),
  }
  const layouts = { 'src/routes/_module.mesa': async () => ({ default: await build(`
<script>export let children</script>
<main>{@render children()}</main>`, '/Layout.mesa', {}) }) }
  let ChainRenderer
  const inner = (...a) => ChainRenderer(...a)
  ChainRenderer = await build(read('../src/components/ChainRenderer.mesa'), '/ChainRenderer.mesa', { page, remountKey, ChainRendererInner: inner })
  const RouterView = await build(read('../src/components/RouterView.mesa'), '/RouterView.mesa', { page, resolveChain, ChainRenderer: inner })
  initRouter(t, comps, {}, { trailingSlash: 'always' }, layouts)
  await settle()
  const anchor = document.createElement('span')
  document.body.appendChild(anchor)
  mounted = runtime.mount(anchor, RouterView, { props: {} })
  await settle()
}

describe('the real router leaving an [id] screen', () => {
  it('for another [id] screen never asks the old one about the new id', async () => {
    await boot()
    expect(document.querySelector('#apps')?.textContent).toBe('app_1')
    seen.length = 0

    await goto('/deployments/dep_9/')
    await settle()

    expect(seen.filter(([n]) => n === 'apps')).toEqual([])
    expect(document.querySelector('#deployments')?.textContent).toBe('dep_9')
  })

  it('for a list never asks the old one about no id', async () => {
    await boot()
    seen.length = 0

    await goto('/apps/')
    await settle()

    expect(seen.filter(([n]) => n === 'apps')).toEqual([])
  })
})
