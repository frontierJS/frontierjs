// watch-follows-calls.test.js
//
// `{money(v)}` under `$: prefs.currency` — a call to an imported function reads
// the store out of the compiler's sight, so it subscribed to nothing and moved
// only when another binding sharing its render() happened to name `prefs`
// (`FJS-D404`). A call to an import, or to a local function reaching one, now
// re-runs when the component's import watches fire — in a template binding or
// a synchronous derived const, and nowhere a re-run would be a side effect.
//
// Every case mounts, writes the watched path through the proxy the way a store
// does, and reads the screen; none has a sibling binding naming the store,
// since that sibling is the accident the rows exist to rule out.

import { describe, it, expect, beforeEach } from 'vitest'
import * as acorn from 'acorn'
import { compileSource } from '../src/compiler.js'
import * as runtime from '../src/runtime.js'

const tick = () => new Promise((r) => setTimeout(r, 0))
const settle = async () => { runtime.flushSync(); await tick(); runtime.flushSync() }

async function compile(src) {
  const ctx = await compileSource(src, { filename: `/C${Math.random()}.mesa`, dev: false, css: false })
  if (ctx.analysis.errors.length) throw new Error(ctx.analysis.errors[0])
  acorn.parse(ctx.result, { ecmaVersion: 'latest', sourceType: 'module' })
  return ctx.result
}

// `./store.js` resolves to the object handed in, as one ESM instance would,
// and `./Child.mesa` to the component handed in as `Child`.
async function mount(src, store) {
  let code = (await compile(src)).replace(/^import \{ ([^}]+) \} from '\.\/store\.js';$/m, 'const { $1 } = __store;')
  code = code.replace(/^import (\w+) from '\.\/Child\.mesa';$/m, 'const $1 = __store.Child;')
  code = code.replace(/^import\s+.+?from\s+'[^']+';$/gm, '').trim()
  code = code.replace(/^export default\s+/m, 'const __c = ') + '\nreturn __c'
  const Comp = new Function('$$runtime', '__store', code)(runtime, store)
  const host = document.createElement('div')
  const anchor = document.createElement('span')
  host.appendChild(anchor)
  document.body.appendChild(host)
  runtime.mount(anchor, Comp, {})
  await tick()
  return host
}

async function childOf(src) {
  let code = (await compile(src)).replace(/^import\s+.+?from\s+'[^']+';$/gm, '').trim()
  code = code.replace(/^export default\s+/m, 'const __c = ') + '\nreturn __c'
  return new Function('$$runtime', code)(runtime)
}

const text = (host) => host.textContent.replace(/\s+/g, ' ').trim()

let prefs, money
beforeEach(() => {
  document.body.innerHTML = ''
  prefs = { currency: 'USD', dense: false }
  money = (v) => (prefs.currency === 'USD' ? '$' : '€') + v
})
const flip = () => { runtime.watchProxy(prefs).currency = 'EUR' }

describe('a call follows the component\'s import watches (FJS-D404)', () => {
  it('an imported function in the template', async () => {
    const host = await mount(`<script>
  import { money, prefs } from './store.js'
  $: prefs.currency
</script>
<p>{money(5)}</p>`, { money, prefs })
    expect(text(host)).toBe('$5')
    flip(); await settle()
    expect(text(host)).toBe('€5')
  })

  it('a derived const calling one — the MoneyCell shape', async () => {
    const host = await mount(`<script>
  import { money, prefs } from './store.js'
  export let value = 5
  $: prefs.currency
  const shown = value == null ? '' : money(value)
</script>
{shown}`, { money, prefs })
    flip(); await settle()
    expect(text(host)).toBe('€5')
  })

  it('a local helper that reaches one', async () => {
    const host = await mount(`<script>
  import { money, prefs } from './store.js'
  $: prefs.currency
  function price(v) { return money(v) + '!' }
</script>
<p>{price(5)}</p>`, { money, prefs })
    flip(); await settle()
    expect(text(host)).toBe('€5!')
  })

  it('inside a callback handed to a method call', async () => {
    const host = await mount(`<script>
  import { money, prefs } from './store.js'
  $: prefs.currency
  let rows = [1, 2]
</script>
<p>{rows.map((r) => money(r)).join(' ')}</p>`, { money, prefs })
    flip(); await settle()
    expect(text(host)).toBe('€1 €2')
  })

  it('in each position a binding takes: {#if}, an attribute, class:, an {#each} row, a prop', async () => {
    const isEur = () => prefs.currency === 'EUR'
    const Child = await childOf(`<script>export let label</script><u>{label}</u>`)
    const host = await mount(`<script>
  import Child from './Child.mesa'
  import { money, isEur, prefs } from './store.js'
  $: prefs.currency
  let rows = [1]
</script>
{#if isEur()}<i>eur</i>{:else}<i>usd</i>{/if}
<b data-c={money(0)} class:eur={isEur()}></b>
{#each rows as r}<em>{money(r)}</em>{/each}
<Child label={money(2)} />`, { money, isEur, prefs, Child })
    flip(); await settle()
    expect(host.querySelector('i').textContent).toBe('eur')
    expect(host.querySelector('b').dataset.c).toBe('€0')
    expect(host.querySelector('b').classList.contains('eur')).toBe(true)
    expect(host.querySelector('em').textContent).toBe('€1')
    expect(host.querySelector('u').textContent).toBe('€2')
  })

  it('a watch on another path of the store does not fire it', async () => {
    let runs = 0
    const count = () => ++runs
    await mount(`<script>
  import { count, prefs } from './store.js'
  $: prefs.currency
</script>
<p>{count()}</p>`, { count, prefs })
    runtime.watchProxy(prefs).dense = true; await settle()
    expect(runs).toBe(1)
  })
})

describe('where a watch adds no trigger (FJS-D404)', () => {
  it('a static const stays the value it was at mount', async () => {
    const host = await mount(`<script>
  import { money, prefs } from './store.js'
  $: prefs.currency
  const label = money(5)
</script>
{label}`, { money, prefs })
    flip(); await settle()
    expect(text(host)).toBe('$5')
  })

  it('an {#await} does not load again', async () => {
    let loads = 0
    const load = () => { loads++; return Promise.resolve(prefs.currency) }
    await mount(`<script>
  import { load, prefs } from './store.js'
  $: prefs.currency
</script>
{#await load()}{:then c}<p>{c}</p>{/await}`, { load, prefs })
    flip(); await settle()
    expect(loads).toBe(1)
  })

  it('an async const does not load again', async () => {
    let loads = 0
    const load = (id) => { loads++; return Promise.resolve(id) }
    await mount(`<script>
  import { load, prefs } from './store.js'
  export let id = 1
  $: prefs.currency
  const row = await load(id)
</script>
<p>{row}</p>`, { load, prefs })
    flip(); await settle()
    expect(loads).toBe(1)
  })

  it('a handler, a callback prop, and a callback that runs later, read no watch', async () => {
    const out = await compile(`<script>
  import Child from './Child.mesa'
  import { money, save, prefs } from './store.js'
  $: prefs.currency
</script>
<button onclick={() => save(money(1))}>{money(2)}</button>
<Child onsave={() => save(money(4))} />
<p>{[1].forEach(() => 0) ?? setTimeout(() => money(3))}</p>`)
    expect(out.match(/\$\$watches\(money\)/g)).toHaveLength(1)
    expect(out).toContain('$$watches(money)(2)')
  })

  it('a component watching no import emits nothing for it', async () => {
    const out = await compile(`<script>
  import { money } from './store.js'
  let n = 1
</script>
<p>{money(n)}</p>`)
    expect(out).not.toContain('$$watches')
  })
})
