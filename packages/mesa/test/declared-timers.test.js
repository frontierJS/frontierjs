/**
 * `$.after` and `$.every` (`FJS-D2059`, IDEAS/mesa-clock.md Phase 3): a timer
 * controlled by its declaration — armed while `when` holds and its owner
 * lives, re-armed fresh by a change of `key`, cancelled with the owner. And the
 * raw `setTimeout`/`setInterval` warning that points at them (`FJS-D2060`).
 */

import { describe, it, expect, afterEach } from 'vitest'
import * as acorn from 'acorn'
import { compile } from '../src/compiler.js'
import * as runtime from '../src/runtime.js'
import { renderComponent } from '../src/render-component.js'
import { EXAMPLES } from '../example/examples.js'

const { clock, virtualClock } = runtime

afterEach(() => { clock.use(null) })

async function compiled(src) {
  const ctx = await compile(src, { debug: false, css: false, loc: false, warning: () => {} })
  if (ctx.analysis.errors.length) throw new Error(ctx.analysis.errors[0])
  // Invariant 15: a clean compile is not proof the output is JavaScript.
  acorn.parse(ctx.result, { ecmaVersion: 'latest', sourceType: 'module' })
  return ctx
}

function execCompiled(code) {
  code = code.replace(/^import\s+.+?from\s+'[^']+';$/gm, '').trim()
  code = code.replace(/^export default\s+/m, 'const __component = ')
  code += '\nreturn __component'
  return new Function('$$runtime', code)(runtime)
}

async function mount(src) {
  const Component = execCompiled((await compiled(src)).result)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const anchor = document.createComment('')
  container.appendChild(anchor)
  // `mount` attaches the delegated listeners a click needs.
  const app = runtime.mount(anchor, Component)
  runtime.flushSync()
  const click = (sel) => { container.querySelector(sel).click(); runtime.flushSync() }
  const text = (sel) => container.querySelector(sel).textContent
  return { container, click, text, dispose: () => app.destroy() }
}

const step = async (v, ms) => { await v.advance(ms); runtime.flushSync() }

describe('$.after', () => {
  it('is torn down with its owner: unmounted before its delay, fn never fires', async () => {
    const v = virtualClock()
    clock.use(v)
    globalThis.__fired = 0
    const m = await mount(`<script>
  $.after(500, () => { globalThis.__fired++ })
</script>
<p>x</p>`)
    expect((await v.settle({ limit: 0 })).armed).toEqual(['$.after'])
    m.dispose()
    await step(v, 1000)
    expect(globalThis.__fired).toBe(0)
    expect(await v.settle()).toEqual({ settled: true, armed: [] })
  })

  it('re-arms on a key change: three changes 100 ms apart fire once, 300 ms after the last', async () => {
    const v = virtualClock(0)
    clock.use(v)
    const m = await mount(`<script>
  let query = ''
  let searched = []
  $.after(300, () => { searched = [...searched, query] }, { key: query })
</script>
<button id="k" onclick={() => query = query + 'a'}>type</button>
<p id="s">{searched.join(',')}</p>`)
    await step(v, 300)
    expect(m.text('#s')).toBe('')  // the first arm fires with the initial key
    m.click('#k')
    await step(v, 100)
    m.click('#k')
    await step(v, 100)
    m.click('#k')
    await step(v, 299)
    expect(m.text('#s')).toBe('')
    await step(v, 1)
    expect(m.text('#s')).toBe(',aaa')
    await step(v, 1000)
    expect(m.text('#s')).toBe(',aaa')
  })

  it('a flash auto-clear: armed only while when holds, re-armed by a new flash', async () => {
    const v = virtualClock(0)
    clock.use(v)
    const m = await mount(`<script>
  let flash = null
  let n = 0
  $.after(3000, () => flash = null, { key: flash, when: flash != null })
</script>
<button id="f" onclick={() => flash = 'saved ' + (++n)}>save</button>
<p id="m">{flash ?? ''}</p>`)
    expect(await v.settle({ limit: 0 })).toEqual({ settled: true, armed: [] })
    m.click('#f')
    await step(v, 2000)
    m.click('#f')
    await step(v, 2999)
    expect(m.text('#m')).toBe('saved 2')
    await step(v, 1)
    expect(m.text('#m')).toBe('')
    expect(await v.settle()).toEqual({ settled: true, armed: [] })
  })
})

describe('$.every', () => {
  it('ticks on its cadence under advance', async () => {
    const v = virtualClock(0)
    clock.use(v)
    const m = await mount(`<script>
  let n = 0
  $.every(1000, () => n++)
</script>
<p id="n">{n}</p>`)
    await step(v, 999)
    expect(m.text('#n')).toBe('0')
    await step(v, 1)
    expect(m.text('#n')).toBe('1')
    await step(v, 3000)
    expect(m.text('#n')).toBe('4')
    expect((await v.settle({ limit: 0 })).armed).toEqual(['$.every'])
  })

  it('is gated by when: stops when false, a key change while false arms nothing, true restarts the phase', async () => {
    const v = virtualClock(0)
    clock.use(v)
    const m = await mount(`<script>
  let n = 0
  let on = true
  let k = 0
  $.every(1000, () => n++, { key: k, when: on })
</script>
<button id="t" onclick={() => on = !on}>toggle</button>
<button id="k" onclick={() => k++}>key</button>
<p id="n">{n}</p>`)
    await step(v, 2500)
    expect(m.text('#n')).toBe('2')
    m.click('#t')  // off at 2500
    await step(v, 5000)
    expect(m.text('#n')).toBe('2')
    m.click('#k')  // paused: a key change arms nothing
    expect(await v.settle({ limit: 0 })).toEqual({ settled: true, armed: [] })
    await step(v, 5000)
    expect(m.text('#n')).toBe('2')
    m.click('#t')  // on at 12500: the phase starts here, not on the old grid
    await step(v, 999)
    expect(m.text('#n')).toBe('2')
    await step(v, 1)
    expect(m.text('#n')).toBe('3')
    m.click('#k')  // running: a key change restarts the phase
    await step(v, 999)
    expect(m.text('#n')).toBe('3')
    await step(v, 1)
    expect(m.text('#n')).toBe('4')
  })

  it('skips the ticks due while an async fn is pending, and a rejection does not stop it (FJS-D2064)', async () => {
    const v = virtualClock(0)
    clock.use(v)
    const settle = []
    let calls = 0
    globalThis.__poll = () => { calls++; return new Promise((resolve, reject) => settle.push({ resolve, reject })) }
    const seen = []
    const onUnhandled = (e) => seen.push(e)
    process.on('unhandledRejection', onUnhandled)
    try {
      await mount(`<script>
  $.every(1000, () => globalThis.__poll())
</script>
<p>poll</p>`)
      await step(v, 3000)
      expect(calls).toBe(1)
      // settled on a task of its own, as a response lands
      settle[0].resolve()
      await new Promise((r) => setTimeout(r))
      await step(v, 1000)
      expect(calls).toBe(2)
      settle[1].reject(new Error('offline'))
      await new Promise((r) => setTimeout(r))
      await step(v, 1000)
      expect(calls).toBe(3)
      await new Promise((r) => setTimeout(r, 10))
      expect(seen.map((e) => e.message)).toEqual(['offline'])
    } finally {
      process.off('unhandledRejection', onUnhandled)
      delete globalThis.__poll
    }
  })

  it('arms nothing in a server render', async () => {
    const v = virtualClock(0)
    clock.use(v)
    globalThis.__ticks = 0
    const src = `<script>
  let n = 0
  $.every(1000, () => { n++; globalThis.__ticks++ })
  $.after(10, () => { globalThis.__ticks++ })
</script>
<p>{n}</p>`
    // Both server paths: the string mode, and happy-dom.
    for (const compileOptions of [{}, { target: undefined }]) {
      const out = await renderComponent(src, { compileOptions })
      expect(JSON.stringify(out)).toContain('<p>0</p>')
    }
    expect(clock.use(v)).toBe(v)  // the render restored the held clock
    expect(await v.settle()).toEqual({ settled: true, armed: [] })
    await v.advance(5000)
    expect(globalThis.__ticks).toBe(0)
  })
})

describe('the declaration rules', () => {
  it('passes ms, key and when as getters and fn as a value', async () => {
    const { result } = await compiled(`<script>
  let q = ''
  let ms = 300
  $.after(ms, () => console.log(q), { key: q, when: q !== '' })
</script>
<input bind:value={q} />`)
    expect(result).toContain('after: $$runtime.after, every: $$runtime.every,')
    expect(result).toMatch(/\$\.after\(\(\) => \(\$\$runtime\.get\(\$\$sig_ms\)\), \(\) => console\.log\(\$\$runtime\.get\(\$\$sig_q\)\), \{ key: \(\) => \(\$\$runtime\.get\(\$\$sig_q\)\), when: \(\) => \(\$\$runtime\.get\(\$\$sig_q\) !== ''\) \}\);/)
  })

  it('adds nothing to $ for a component that declares no timer', async () => {
    const { result } = await compiled(`<script>
  $.onMount(() => {})
</script>
<p>x</p>`)
    expect(result).not.toContain('$$runtime.after')
  })

  it('refuses a call inside a function, naming the top-level form and the gates', async () => {
    await expect(compiled(`<script>
  function later() { $.after(100, () => {}) }
</script>
<button onclick={later}>x</button>`)).rejects.toThrow(/'\$\.after' is declared at the top level of <script>.*'when'.*'key'/s)
    await expect(compiled(`<script>
  const stop = $.every(100, () => {})
</script>
<p>x</p>`)).rejects.toThrow(/'\$\.every' is declared at the top level/)
    await expect(compiled(`<script>
  let n = 0
</script>
<button onclick={() => $.after(10, () => n++)}>x</button>`)).rejects.toThrow(/'\$\.after' is declared at the top level/)
  })
})

describe('the raw-timer warning (FJS-D2060)', () => {
  const warnings = async (src) => (await compiled(src)).analysis.warnings.filter((w) => /FJS-D2060/.test(w))

  it('warns on setTimeout and setInterval, in either script, naming the declared form', async () => {
    const w = await warnings(`<script module>
  const id = setInterval(() => {}, 1000)
</script>
<script>
  function later() { const t = window.setTimeout(() => {}, 10); clearTimeout(t) }
  globalThis.setTimeout(later, 5)
</script>
<button onclick={later}>x</button>`)
    expect(w).toHaveLength(2)
    expect(w[0]).toMatch(/^setTimeout\(\) is called 2 times.*\$\.after\(ms, fn, \{ key, when \}\)/)
    expect(w[1]).toMatch(/^setInterval\(\) is called once.*\$\.every\(ms, fn, \{ key, when \}\)/)
  })

  it('is quiet for $.after, $.every and a clear alone', async () => {
    const w = await warnings(`<script>
  let n = 0
  $.after(10, () => n++)
  $.every(10, () => n++)
  function stop(id) { clearTimeout(id); clearInterval(id) }
</script>
<button onclick={stop}>{n}</button>`)
    expect(w).toEqual([])
  })
})

describe('|debounce belongs to its owner', () => {
  it('a debounce pending at unmount never fires', async () => {
    const v = virtualClock()
    clock.use(v)
    globalThis.__fired = 0
    const m = await mount(`<script>
  function hit() { globalThis.__fired++ }
</script>
<button onclick|debounce(200)={hit}>x</button>`)
    m.click('button')
    m.dispose()
    await step(v, 500)
    expect(globalThis.__fired).toBe(0)
  })
})

describe('$.sleep (FJS-D2063)', () => {
  it('resolves inside an async handler only once the clock passes ms', async () => {
    const v = virtualClock(0)
    clock.use(v)
    const m = await mount(`<script>
  let status = 'idle'
  async function save() {
    status = 'saving'
    await $.sleep(500)
    status = 'saved'
  }
</script>
<button id="b" onclick={save}>go</button>
<p id="s">{status}</p>`)
    m.click('#b')
    expect(m.text('#s')).toBe('saving')
    expect((await v.settle({ limit: 0 })).armed).toEqual(['$.sleep'])
    await step(v, 499)
    expect(m.text('#s')).toBe('saving')
    await step(v, 1)
    expect(m.text('#s')).toBe('saved')
    m.dispose()
  })

  it('never resolves once its component is destroyed, so neither the continuation nor a finally runs', async () => {
    const v = virtualClock(0)
    clock.use(v)
    globalThis.__after = []
    const m = await mount(`<script>
  async function go() {
    try {
      await $.sleep(500)
      globalThis.__after.push('continued')
    } finally {
      globalThis.__after.push('finally')
    }
  }
</script>
<button id="b" onclick={go}>go</button>`)
    m.click('#b')
    m.dispose()
    await step(v, 1000)
    expect(globalThis.__after).toEqual([])
    expect(await v.settle()).toEqual({ settled: true, armed: [] })
  })

  it('resolves at once in a server render, so an {#await} behind it writes its settled branch', async () => {
    const v = virtualClock(0)
    clock.use(v)
    // Both server paths: the string mode, and happy-dom.
    for (const compileOptions of [{}, { target: undefined }]) {
      const t0 = Date.now()
      const out = await renderComponent(EXAMPLES.awaitBlock.src, { compileOptions })
      expect(Date.now() - t0).toBeLessThan(1000)
      expect(JSON.stringify(out)).toContain('resolved: <strong>payload #0</strong>')
      expect(JSON.stringify(out)).not.toContain('loading…')
    }
    expect(clock.use(v)).toBe(v)
    expect(await v.settle()).toEqual({ settled: true, armed: [] })
  })

  it('compiles inside a function and after an await, where $.after still throws', async () => {
    const { result } = await compiled(`<script>
  let n = 0
  async function later() {
    await fetch('/x')
    await $.sleep(10)
    n++
  }
  $.onMount(async () => { await later(); await $.sleep(5) })
</script>
<button onclick={later}>{n}</button>`)
    expect(result).toContain('const $$sleep    = $$runtime.sleeper();')
    expect(result).toContain('$.sleep = $$sleep;')
    expect(result).not.toContain('sleep: ')
    await expect(compiled(`<script>
  async function later() { await $.sleep(10); $.after(10, () => {}) }
</script>
<button onclick={later}>x</button>`)).rejects.toThrow(/'\$\.after' is declared at the top level/)
  })

  it('adds nothing to $ for a component that does not sleep', async () => {
    const { result } = await compiled(`<script>
  $.onMount(() => {})
</script>
<p>x</p>`)
    expect(result).not.toContain('sleeper')
  })

  it('draws no raw-timer warning, and the setTimeout warning names it', async () => {
    const d2060 = (ctx) => ctx.analysis.warnings.filter((w) => /FJS-D2060/.test(w))
    expect(d2060(await compiled(`<script>
  async function go() { await $.sleep(10) }
</script>
<button onclick={go}>x</button>`))).toEqual([])
    const [timeout, interval] = d2060(await compiled(`<script>
  setTimeout(() => {}, 10)
  setInterval(() => {}, 10)
</script>
<p>x</p>`))
    expect(timeout).toContain(`a sleep is 'await $.sleep(ms)'`)
    expect(interval).not.toContain('$.sleep')
  })
})
