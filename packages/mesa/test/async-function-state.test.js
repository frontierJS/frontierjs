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
