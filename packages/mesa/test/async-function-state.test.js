/**
 * async-function-state.test.js
 *
 * `$async.<name>` on a top-level `async function` — RULE 16 widened so a write
 * outside `<Form>` stops hand-keeping a `busy`/`error` pair
 * (`IDEAS/shipped/async-function-state.md`). And the refusal RULE 16 never had: a read
 * of any other name compiled to a bare `$async.n.error` and failed on the page
 * (`FJS-1720`).
 *
 * The browser half — that a failed call the template shows does not ALSO reach
 * `unhandledrejection`, and one it does not show does — is
 * `test/browser/runtime/specs/async-function.spec.mjs`.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { compileSource } from '../src/compiler.js'
import * as $rt from '../src/runtime.js'
import { parse as parseJs } from 'acorn'

const compile = (src) => compileSource(src, { filename: '/t/T.mesa', css: false, debug: false, dev: false })

// Invariant 15: a clean compile is not proof of valid JS.
const parses = (js) => parseJs(js, { sourceType: 'module', ecmaVersion: 'latest' })

const build = async (src) => {
  const ctx = await compile(src)
  expect(ctx.analysis.errors).toEqual([])
  parses(ctx.result)
  const code = ctx.result.replace(/^import\s+.+?from\s+'[^']+';$/gm, '')
    .replace(/^export default\s+/m, 'const __c = ')
  return new Function('$$runtime', code + '\nreturn __c')($rt)
}

const mount = (Comp, props) => {
  const c = document.createElement('div')
  document.body.appendChild(c)
  const l = document.createElement('span')
  c.appendChild(l)
  $rt.mount(l, Comp, { props })
  $rt.flushSync()
  return c
}

const settle = async () => { await new Promise((r) => setTimeout(r, 0)); $rt.flushSync() }

beforeEach(() => { document.body.innerHTML = '' })

describe('an async function whose $async is read', () => {
  const SRC = `<script>
  export let api
  let removed = 0
  async function remove(gate) {
    await gate
    removed++
  }
  api.remove = remove
</script>
<button disabled={$async.remove.pending}>Delete</button>
<p id="status">{$async.remove.status}</p>
<p id="removed">{removed}</p>
{#if $async.remove.error}<p id="error">{$async.remove.error.message}</p>{/if}`

  it('tracks each call: idle, pending, success, error, and clears the error on the next', async () => {
    const api = {}
    const c = mount(await build(SRC), { api })
    const button = c.querySelector('button')
    const status = () => c.querySelector('#status').textContent

    expect(status()).toBe('idle')
    expect(button.disabled).toBe(false)

    let open
    const call = api.remove(new Promise((r) => { open = r }))
    $rt.flushSync()
    expect(status()).toBe('pending')
    expect(button.disabled).toBe(true)

    open()
    await call
    await settle()
    expect(status()).toBe('success')
    expect(button.disabled).toBe(false)
    expect(c.querySelector('#removed').textContent).toBe('1')

    await api.remove(Promise.reject(new Error('refused'))).catch(() => {})
    await settle()
    expect(status()).toBe('error')
    expect(c.querySelector('#error').textContent).toBe('refused')

    const again = api.remove(new Promise(() => {}))
    $rt.flushSync()
    expect(c.querySelector('#error')).toBeNull()
    void again
  })

  it('still rejects to a caller that awaits it', async () => {
    const api = {}
    mount(await build(SRC), { api })
    const err = new Error('refused')
    await expect(api.remove(Promise.reject(err))).rejects.toBe(err)
  })

  it('marks the rejection handled where the template reads .error, and only there', async () => {
    const shown = await compile(SRC)
    expect(shown.result).toContain('makeCallState(true)')
    const unshown = await compile(SRC.replace(/\{#if[\s\S]*$/, ''))
    expect(unshown.result).toContain('makeCallState()')
  })

  it('keeps the name for every caller, the export included', async () => {
    const ctx = await compile(`<script>
  export async function save() {}
  async function twice() { await save(); await save() }
</script>
<button onclick={twice} disabled={$async.save.pending}>Save</button>`)
    expect(ctx.analysis.errors).toEqual([])
    parses(ctx.result)
    expect(ctx.result).toContain('async function $$fn_save()')
    expect(ctx.result).toMatch(/function save\(\) \{ return \$\$async_save\.run\(\$\$fn_save, this, arguments\); \}/)
    expect(ctx.result).toContain('registerExports({ save })')
    // `twice` is not read through $async, so it is left exactly as written.
    expect(ctx.result).not.toContain('$$fn_twice')
  })

  it('answers to the door spelling as well', async () => {
    const ctx = await compile(`<script>async function go() {}</script>
<button onclick={go} disabled={$.async.go.pending}>Go</button>`)
    expect(ctx.analysis.errors).toEqual([])
    parses(ctx.result)
    expect(ctx.result).toContain('$$async_go')
  })
})

// FJS-390 / FJS-D591: `pending` counts every call, so a row action reading it
// disables every row while one is in flight.
describe('$async.f.for(key) — one row of a row action', () => {
  const SRC = `<script>
  export let api
  let rows = [{ id: 'a' }, { id: 'b' }]
  async function remove(id, gate) { await gate }
  api.remove = remove
</script>
{#each rows as row (row.id)}
  <button id={row.id} disabled={$async.remove.for(row.id).pending}>Delete</button>
  {#if $async.remove.for(row.id).error}<p class="error">{row.id}: {$async.remove.for(row.id).error.message}</p>{/if}
{/each}`

  it('disables only the row whose call is in flight, and shows only its error', async () => {
    const api = {}
    const c = mount(await build(SRC), { api })
    const a = c.querySelector('#a'), b = c.querySelector('#b')

    let open
    const call = api.remove('a', new Promise((r) => { open = r }))
    $rt.flushSync()
    expect(a.disabled).toBe(true)
    expect(b.disabled).toBe(false)

    open()
    await call
    await settle()
    expect(a.disabled).toBe(false)

    await api.remove('b', Promise.reject(new Error('refused'))).catch(() => {})
    await settle()
    expect([...c.querySelectorAll('.error')].map((p) => p.textContent)).toEqual(['b: refused'])
  })

  it('counts a keyed .error read as handling the rejection', async () => {
    expect((await compile(SRC)).result).toContain('makeCallState(true)')
    const unshown = SRC.replace(/\s*\{#if[\s\S]*?\{\/if\}/, '')
    expect((await compile(unshown)).result).toContain('makeCallState()')
    const nested = `<script>async function f(k) {}</script>
{#if $async.f.for(String(1)).error}x{/if}`
    expect((await compile(nested)).result).toContain('makeCallState(true)')
  })

  it('refuses a keyed read of a name that is not async state', async () => {
    const { analysis } = await compile(`<script>let n = 1</script><p>{$async.n.for(1).pending}</p>`)
    expect(analysis.errors).toHaveLength(1)
  })
})

describe('an async function nobody reads $async of', () => {
  it('compiles exactly as it did before the feature', async () => {
    const ctx = await compile(`<script>
  let n = 0
  async function bump() { await null; n++ }
</script>
<button onclick={bump}>{n}</button>`)
    expect(ctx.analysis.errors).toEqual([])
    expect(ctx.result).toContain('async function bump() { await null;')
    expect(ctx.result).not.toContain('$$async')
    expect(ctx.result).not.toContain('makeCallState')
  })
})

describe('the $async state of an awaited const is reactive wherever it is read', () => {
  // Every field is a getter behind a property read, which the static/reactive
  // split could not see: an attribute reading only `$async` was written once.
  it('re-renders an attribute that reads nothing else', async () => {
    const C = await build(`<script>
  export let api
  let q = 'a'
  const rows = await new Promise((r) => { api.resolve = r; void q })
</script>
<p title={$async.rows.status}>{$async.rows.pending}</p>`)
    const api = {}
    const c = mount(C, { api })
    const p = c.querySelector('p')
    expect(p.getAttribute('title')).toBe('pending')
    expect(p.textContent).toBe('true')
    api.resolve([])
    await settle()
    expect(p.getAttribute('title')).toBe('success')
    expect(p.textContent).toBe('false')
  })
})

describe('RULE 16 is refused, not left to the page (FJS-1720)', () => {
  const errorsOf = async (src) => (await compile(src)).analysis.errors

  it('refuses a read of a plain variable and names both legal forms', async () => {
    const [e, ...rest] = await errorsOf(`<script>let n = 1</script><p>{$async.n.error}</p>`)
    expect(rest).toEqual([])
    expect(e).toContain('`$async.n` names no async state')
    expect(e).toContain('const n = await')
    expect(e).toContain('async function n()')
  })

  it('refuses a name nothing declares', async () => {
    expect(await errorsOf(`<p>{$async.ghost.pending}</p>`)).toHaveLength(1)
  })

  it('refuses a synchronous function', async () => {
    expect(await errorsOf(`<script>function f() {}</script><p>{$async.f.pending}</p>`)).toHaveLength(1)
  })

  it('says to declare an async arrow as a function', async () => {
    const [e] = await errorsOf(`<script>const f = async () => {}</script><p>{$async.f.pending}</p>`)
    expect(e).toContain('declare it `async function f()')
  })

  it('refuses an async generator, which has no single call', async () => {
    const [e] = await errorsOf(`<script>async function* f() {}</script><p>{$async.f.pending}</p>`)
    expect(e).toContain('async generator')
  })

  it('refuses a script-side read too', async () => {
    const errs = await errorsOf(`<script>let n = 1\n$: console.log($async.n.status)</script><p>{n}</p>`)
    expect(errs).toHaveLength(1)
  })

  it('accepts both legal forms, and a computed key it cannot judge', async () => {
    expect(await errorsOf(`<script>
  let q = ''
  const rows = await load(q)
  async function save() {}
  const k = 'rows'
</script>
<p>{$async.rows.pending} {$async.save.status} {$async[k]?.status}</p>`)).toEqual([])
  })

  it('does not count prose or a string as a read', async () => {
    expect(await errorsOf(`<script>const s = '$async.x.error'</script><p>The $async.x bag</p><p>{s}</p>`)).toEqual([])
  })
})

describe('$async.<const>.refresh() re-runs an awaited const (FJS-D2058)', () => {
  const SRC = `<script>
  export let api
  let region = 'TX'
  const rows = await api.load(region)
</script>
<button onclick={() => $async.rows.refresh()}>Reload</button>
<p id="rows">{rows}</p>
<p id="pending">{$async.rows.pending}</p>
<p id="error">{$async.rows.error}</p>`

  it('compiles to parseable output that calls the state object', async () => {
    const ctx = await compile(SRC)
    expect(ctx.analysis.errors).toEqual([])
    parses(ctx.result)
    expect(ctx.result).toContain('$async.rows.refresh()')
  })

  it('re-runs on a click, keeps the old value while pending, and keeps the latest reply', async () => {
    const open = []
    const api = { load: (r) => new Promise((resolve) => open.push(() => resolve(`${r}-${open.length}`))) }
    const c = mount(await build(SRC), { api })
    const text = (id) => c.querySelector(id).textContent
    open[0]()
    await settle()
    expect(text('#rows')).toBe('TX-1')
    expect(text('#pending')).toBe('false')

    c.querySelector('button').click()
    $rt.flushSync()
    expect(open).toHaveLength(2)
    expect(text('#rows')).toBe('TX-1')
    expect(text('#pending')).toBe('true')

    c.querySelector('button').click()
    open[2]()
    await settle()
    expect(text('#rows')).toBe('TX-3')
    open[1]()
    await settle()
    expect(text('#rows')).toBe('TX-3')
    expect(text('#pending')).toBe('false')
  })

  const errorsOf = async (src) => (await compile(src)).analysis.errors

  it('refuses .refresh() on a function and names .for(key)', async () => {
    const [e, ...rest] = await errorsOf(`<script>async function save() {}</script>
<button onclick={() => $async.save.refresh()}>x</button>`)
    expect(rest).toEqual([])
    expect(e).toContain('`$async.save.refresh()`')
    expect(e).toContain('`.for(key)`')
  })

  // A one-shot reads nothing the compiler can see, so its loader is a global
  // the test owns (`FJS-D2062`).
  const ONE_SHOT = `<script>
  const rows = await globalThis.__oneShot()
</script>
<button onclick={() => $async.rows.refresh()}>Reload</button>
<p id="rows">{rows}</p>
<p id="pending">{$async.rows.pending}</p>
<p id="error">{$async.rows.error}</p>`

  it('compiles .refresh() on an awaited const that reads nothing reactive', async () => {
    const ctx = await compile(ONE_SHOT)
    expect(ctx.analysis.errors).toEqual([])
    parses(ctx.result)
    expect(ctx.result).toContain('$$runtime.asyncDerived(')
    expect(ctx.result).not.toContain("_update('start')")
  })

  it('refreshes a one-shot, keeping the old value while pending', async () => {
    const open = []
    globalThis.__oneShot = () => new Promise((resolve) => open.push(() => resolve(`r-${open.length}`)))
    try {
      const c = mount(await build(ONE_SHOT))
      const text = (id) => c.querySelector(id).textContent
      open[0]()
      await settle()
      expect(text('#rows')).toBe('r-1')

      c.querySelector('button').click()
      $rt.flushSync()
      expect(open).toHaveLength(2)
      expect(text('#rows')).toBe('r-1')
      expect(text('#pending')).toBe('true')
      open[1]()
      await settle()
      expect(text('#rows')).toBe('r-2')
      expect(text('#pending')).toBe('false')
    } finally {
      delete globalThis.__oneShot
    }
  })

  it('does not re-run a one-shot on a signal its loader reads synchronously', async () => {
    const seen = $rt.track(0)
    let calls = 0
    globalThis.__oneShot = () => { calls++; $rt.get(seen); return Promise.resolve('once') }
    try {
      const c = mount(await build(ONE_SHOT))
      await settle()
      expect(c.querySelector('#rows').textContent).toBe('once')
      $rt.set(seen, 1)
      $rt.flushSync()
      await settle()
      expect(calls).toBe(1)
    } finally {
      delete globalThis.__oneShot
    }
  })

  it('refuses .refresh() on a plain variable as a name with no async state', async () => {
    const [e] = await errorsOf(`<script>let n = 1</script><button onclick={() => $async.n.refresh()}>{n}</button>`)
    expect(e).toContain('`$async.n` names no async state')
  })
})

// A rejected load with nothing on the page to show it failed (`FJS-4290`).
// ReactiveScript refuses the same shape as UNHANDLED_FAILURE (its rule R-f-5).
describe('an awaited const whose failure nothing shows', () => {
  const errorsOf = async (src) => (await compile(src)).analysis.errors
  const LOAD = `<script>let id = 1; const user = await fetchUser(id)</script>`

  it('refuses a template read with no catching boundary and no .error read', async () => {
    const errors = await errorsOf(LOAD + `<h1>{user.name}</h1>`)
    expect(errors.map((m) => m.split(':')[0])).toEqual(['UNHANDLED_FAILURE', 'ASYNC_OUTSIDE_LOADING_BOUNDARY'])
    const [e] = errors
    expect(e).toContain(`'user'`)
    expect(e).toContain('{#snippet failed(error, reset)}')
    expect(e).toContain('`$async.user.error`')
  })

  it('refuses a read under a boundary that has no failed snippet', async () => {
    const [e] = await errorsOf(LOAD + `<mesa:boundary><h1>{user.name}</h1></mesa:boundary>`)
    expect(e).toMatch(/^UNHANDLED_FAILURE: /)
  })

  it('refuses a read in a snippet rendered outside a catching boundary', async () => {
    const [e] = await errorsOf(LOAD + `{#snippet row()}<i>{user}</i>{/snippet}{@render row()}`)
    expect(e).toMatch(/^UNHANDLED_FAILURE: /)
  })

  it.each([
    ['a template .error read', `<h1 aria-busy={$async.user.pending}>{user?.name}</h1>{#if $async.user.error}<p>failed</p>{/if}`],
    ['a template .status read', `<h1>{user.name}</h1><p>{$.async.user.status}</p>`],
    ['a boundary with a failed snippet', `<mesa:boundary><h1>{user.name}</h1>{#snippet failed(e, r)}<p>failed</p>{/snippet}</mesa:boundary>`],
    ['a top-level failed snippet', `{#snippet failed(e, r)}<p>failed</p>{/snippet}<mesa:boundary><h1>{user.name}</h1></mesa:boundary>`],
    ['a snippet rendered only inside a catching boundary', `{#snippet row()}<i>{user}</i>{/snippet}<mesa:boundary>{@render row()}{#snippet failed(e, r)}no{/snippet}</mesa:boundary>`],
    ['the name in prose, a property or a string', `<h1>user {x.user} {'user'}</h1>`],
  ])('compiles when the failure is shown or never read: %s', async (_, tpl) => {
    expect(await errorsOf(LOAD.replace('let id = 1', 'let id = 1; let x = {}') + tpl)).toEqual([])
  })

  it('compiles a script .error read as handled', async () => {
    const ctx = await compile(`<script>let id = 1; const user = await fetchUser(id)
  $effect(() => { if ($async.user.error) console.log('failed') })</script><h1 aria-busy={$async.user.pending}>{user?.name}</h1>`)
    expect(ctx.analysis.errors).toEqual([])
    expect(ctx.result).toContain('$$runtime.makeAsyncState();')
  })

  const rejecting = (src) => async () => {
    const seen = []
    const spy = console.error
    console.error = (...a) => seen.push(a)
    globalThis.__failLoad = () => Promise.reject(new Error('down'))
    try {
      mount(await build(src))
      await settle()
    } finally {
      console.error = spy
      delete globalThis.__failLoad
    }
    return seen
  }

  it('prints UNHANDLED_FAILURE with the error when a load nothing shows rejects', async () => {
    const seen = await rejecting(`<script>const user = await globalThis.__failLoad()
  const name = user?.name</script><h1>{name}</h1>`)()
    expect(seen).toHaveLength(1)
    expect(seen[0][0]).toMatch(/^\[Mesa\] UNHANDLED_FAILURE: the load of 'user' rejected/)
    expect(seen[0][1].message).toBe('down')
  })

  it('prints nothing when the template shows the failure', async () => {
    const seen = await rejecting(`<script>const user = await globalThis.__failLoad()</script>
{#if $async.user.error}<p>failed</p>{:else if $async.user.loading}<p>…</p>{:else}<h1>{user.name}</h1>{/if}`)()
    expect(seen).toEqual([])
  })
})

// An awaited const holds `undefined` until its first answer, so a template that
// reads it with nothing holding the read threw a bare TypeError out of mount
// (`FJS-4292`). Solid names the shape ASYNC_OUTSIDE_LOADING_BOUNDARY.
describe('an awaited const read before its first answer', () => {
  const errorsOf = async (src) => (await compile(src)).analysis.errors
  const LOAD = `<script>let id = 1; const user = await fetchUser(id)</script>`
  const SHOWN = `{#if $async.user.error}<p>failed</p>{/if}`

  it('refuses a template read with no boundary and no loading read', async () => {
    const errors = await errorsOf(LOAD + `<h1>{user.name}</h1>` + SHOWN)
    expect(errors).toHaveLength(1)
    expect(errors[0]).toMatch(/^ASYNC_OUTSIDE_LOADING_BOUNDARY: /)
    expect(errors[0]).toContain(`'user'`)
    expect(errors[0]).toContain('<mesa:boundary>')
    expect(errors[0]).toContain('`$async.user.loading`')
  })

  it('refuses a read in a snippet rendered outside a boundary', async () => {
    const [e] = await errorsOf(LOAD + `{#snippet row()}<i>{user.name}</i>{/snippet}{@render row()}` + SHOWN)
    expect(e).toMatch(/^ASYNC_OUTSIDE_LOADING_BOUNDARY: /)
  })

  it.each([
    ['a boundary with a failed snippet', `<mesa:boundary><h1>{user.name}</h1>{#snippet failed(e, r)}<p>failed</p>{/snippet}</mesa:boundary>`],
    ['a boundary with no pending snippet', `<mesa:boundary><h1>{user.name}</h1></mesa:boundary>` + SHOWN],
    ['a template .loading read', `{#if $async.user.loading}<p>…</p>{:else}<h1>{user.name}</h1>{/if}` + SHOWN],
    ['a template .pending read', `<h1 aria-busy={$async.user.pending}>{user?.name}</h1>` + SHOWN],
    ['a template .status read', `{#if $async.user.status === 'success'}<h1>{user.name}</h1>{/if}`],
  ])('compiles when the read is held or the wait is read: %s', async (_, tpl) => {
    expect(await errorsOf(LOAD + tpl)).toEqual([])
  })

  it('names the const when a read the compiler cannot see throws on mount', async () => {
    const seen = []
    const spy = console.error
    console.error = (...a) => seen.push(a)
    globalThis.__slowLoad = () => new Promise((r) => setTimeout(() => r({ name: 'Ada' }), 5))
    let thrown
    try {
      mount(await build(`<script>const user = await globalThis.__slowLoad()
  const label = user.name</script><h1>{label}</h1>${SHOWN}`))
    } catch (e) {
      thrown = e
    } finally {
      console.error = spy
      delete globalThis.__slowLoad
    }
    expect(thrown).toBeInstanceOf(TypeError)
    const mesa = seen.filter((a) => /^\[Mesa\] ASYNC_OUTSIDE_LOADING_BOUNDARY/.test(a[0]))
    expect(mesa).toHaveLength(1)
    expect(mesa[0][0]).toContain(`'user'`)
  })

  // A handler runs outside every effect, so an effect's first-run catch never
  // saw its throw (`FJS-4327`).
  it('names the const when an event handler reads it before its first answer', async () => {
    const seen = []
    const spy = console.error
    console.error = (...a) => seen.push(a)
    globalThis.__slowLoad = () => new Promise((r) => setTimeout(() => r({ id: 7 }), 5))
    try {
      const c = mount(await build(`<script>const user = await globalThis.__slowLoad()
  let saved = 0
  function save() { saved = user.id }</script><button onclick={save}>save</button>${SHOWN}`))
      // happy-dom reports a listener's throw rather than raising it from click()
      try { c.querySelector('button').click() } catch {}
    } finally {
      console.error = spy
      delete globalThis.__slowLoad
    }
    const mesa = seen.filter((a) => /^\[Mesa\] ASYNC_OUTSIDE_LOADING_BOUNDARY/.test(String(a[0])))
    expect(mesa).toHaveLength(1)
    expect(mesa[0][0]).toContain(`'user'`)
    expect(mesa[0][1]).toBeInstanceOf(TypeError)
  })

  // An async handler's read after its own await rejects the promise it
  // returned, which a catch around the call never sees (`FJS-4328`).
  it('names the const when an async handler reads it after its own await', async () => {
    const seen = []
    const spy = console.error
    console.error = (...a) => seen.push(a)
    const rejected = []
    const onRejection = (reason) => rejected.push(reason)
    process.on('unhandledRejection', onRejection)
    globalThis.__slowLoad = () => new Promise((r) => setTimeout(() => r({ id: 7 }), 30))
    try {
      const c = mount(await build(`<script>const user = await globalThis.__slowLoad()
  let saved = 0
  async function save() { await Promise.resolve(); saved = user.id }</script><button onclick={save}>save</button>${SHOWN}`))
      try { c.querySelector('button').click() } catch {}
      await new Promise((r) => setTimeout(r, 5))
    } finally {
      console.error = spy
      process.off('unhandledRejection', onRejection)
      delete globalThis.__slowLoad
    }
    const mesa = seen.filter((a) => /^\[Mesa\] ASYNC_OUTSIDE_LOADING_BOUNDARY/.test(String(a[0])))
    expect(mesa).toHaveLength(1)
    expect(mesa[0][0]).toContain(`'user'`)
    expect(mesa[0][1]).toBeInstanceOf(TypeError)
    // Named, not swallowed: the rejection still reaches the page's own report.
    expect(rejected).toHaveLength(1)
    expect(rejected[0]).toBe(mesa[0][1])
  })

  it('says nothing when a binding throws with every load answered', async () => {
    const seen = []
    const spy = console.error
    console.error = (...a) => seen.push(a)
    let thrown
    try {
      mount(await build(`<script>let box = null</script><h1>{box.name}</h1>`))
    } catch (e) {
      thrown = e
    } finally {
      console.error = spy
    }
    expect(thrown).toBeInstanceOf(TypeError)
    expect(seen.filter((a) => /ASYNC_OUTSIDE_LOADING_BOUNDARY/.test(String(a[0])))).toEqual([])
  })
})
