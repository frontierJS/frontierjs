/**
 * The runtime clock (`FJS-D2059`, IDEAS/mesa-clock.md Phase 2): every timer
 * Mesa owns reads `clock`, so a held `virtualClock()` decides when a
 * `|debounce` handler or a transition's fallback fires. The ordering rules are
 * Playwright's `runFor`: fire time then creation order, an `every` re-arms from
 * its scheduled time, delay 0 armed inside a callback lands at now + 1.
 */

import { describe, it, expect, afterEach } from 'vitest'
import { compile } from '../src/compiler.js'
import * as runtime from '../src/runtime.js'

const { clock, virtualClock } = runtime

afterEach(() => { clock.use(null) })

describe('virtualClock()', () => {
  it('holds time still and fires each timer at its own time, then creation order', async () => {
    const v = virtualClock(1000)
    const seen = []
    v.after(20, () => seen.push(['b', v.now()]))
    v.after(10, () => seen.push(['a', v.now()]))
    v.after(20, () => seen.push(['c', v.now()]))
    expect(v.now()).toBe(1000)
    await v.advance(15)
    expect(seen).toEqual([['a', 1010]])
    expect(v.now()).toBe(1015)
    await v.advance(5)
    expect(seen).toEqual([['a', 1010], ['b', 1020], ['c', 1020]])
  })

  it('re-arms an every from its scheduled time, not from when it fired', async () => {
    const v = virtualClock(0)
    const at = []
    v.after(5, () => {})
    v.every(10, () => at.push(v.now()))
    await v.advance(35)
    expect(at).toEqual([10, 20, 30])
  })

  it('lands delay 0 armed inside a callback at now + 1', async () => {
    const v = virtualClock(0)
    const at = []
    v.after(0, () => { at.push(v.now()); v.after(0, () => at.push(v.now())) })
    await v.advance(0)
    expect(at).toEqual([0])
    await v.advance(1)
    expect(at).toEqual([0, 1])
  })

  it('puts a frame on the 16 ms grid', async () => {
    const v = virtualClock(5)
    const at = []
    v.frame((t) => at.push(t))
    await v.advance(10)
    expect(at).toEqual([])
    await v.advance(1)
    expect(at).toEqual([16])
    v.frame((t) => at.push(t))
    await v.advance(16)
    expect(at).toEqual([16, 32])
  })

  it('cancels with the function each verb returns', async () => {
    const v = virtualClock(0)
    let fired = 0
    const a = v.after(10, () => fired++)
    const e = v.every(10, () => fired++)
    const f = v.frame(() => fired++)
    a(); e(); f()
    await v.advance(100)
    expect(fired).toBe(0)
    expect(await v.settle()).toEqual({ settled: true, armed: [] })
  })

  it('settles after timers and frames, and names an every rather than spinning on it', async () => {
    const v = virtualClock(0)
    const seen = []
    v.after(50, () => { seen.push('after'); v.frame(() => seen.push('frame')) })
    v.every(1000, () => seen.push('tick'), 'poll')
    const out = await v.settle()
    expect(seen).toEqual(['after', 'frame'])
    expect(out).toEqual({ settled: false, armed: ['poll'] })
  })

  it('stops settling at its limit and says what is still armed', async () => {
    const v = virtualClock(0)
    let n = 0
    const again = () => { n++; v.after(1, again, 'loop') }
    v.after(1, again, 'loop')
    const out = await v.settle({ limit: 25 })
    expect(n).toBe(25)
    expect(out).toEqual({ settled: false, armed: ['loop'] })
  })

  it('lets a promise continuation settle between two timers', async () => {
    const v = virtualClock(0)
    const seen = []
    v.after(1, () => { Promise.resolve().then(() => seen.push('continuation')) })
    v.after(2, () => seen.push('second'))
    await v.advance(2)
    expect(seen).toEqual(['continuation', 'second'])
  })
})

describe('clock.use()', () => {
  it('answers the source it replaced, and null restores the DOM source', () => {
    const v = virtualClock(42)
    const dom = clock.use(v)
    expect(clock.now()).toBe(42)
    expect(clock.use(dom)).toBe(v)
    expect(Math.abs(clock.now() - Date.now())).toBeLessThan(50)
  })
})

// ─── Mounted sites (the plan's done-when) ────────────────────────────────

function execCompiled(code) {
  code = code.replace(/^import\s+.+?from\s+'[^']+';$/gm, '').trim()
  code = code.replace(/^export default\s+/m, 'const __component = ')
  code += '\nreturn __component'
  return new Function('$$runtime', code)(runtime)
}

async function mount(src) {
  const ctx = await compile(src, { debug: false, css: false })
  if (ctx.analysis.errors.length) throw new Error(ctx.analysis.errors[0])
  const Component = execCompiled(ctx.result)
  const container = document.createElement('div')
  document.body.appendChild(container)
  const anchor = document.createComment('')
  container.appendChild(anchor)
  runtime.createRoot(() => {
    Component(anchor, {}, null)
    runtime.registerComponentAnchor(anchor)
  })
  runtime.flushSync()
  return container
}

describe('a held clock drives the runtime', () => {
  it('fires a |debounce handler only once the clock is advanced past its delay', async () => {
    const v = virtualClock()
    clock.use(v)
    const root = await mount(`<script>
  let n = 0
</script>
<button onclick|debounce(200)={() => n++}>{n}</button>`)
    const button = root.querySelector('button')
    button.click()
    button.click()
    runtime.flushSync()
    expect(button.textContent).toBe('0')
    await v.advance(199)
    runtime.flushSync()
    expect(button.textContent).toBe('0')
    await v.advance(1)
    runtime.flushSync()
    expect(button.textContent).toBe('1')
  })

  it('completes a fade exit on its duration + 50 fallback without transitionend', async () => {
    const v = virtualClock()
    clock.use(v)
    const container = document.createElement('div')
    document.body.appendChild(container)
    const anchor = document.createComment('')
    container.appendChild(anchor)
    const [show, setShow] = runtime.createSignal(true)
    const p = document.createElement('p')
    const block = runtime.makeBlock(
      (() => { const f = document.createDocumentFragment(); f.appendChild(p.cloneNode()); return f })(),
      (parent) => {
        const el = parent.nodeType === 11 ? parent.firstChild : parent
        runtime.attach(el, () => runtime.fade({ duration: 200 }))
      }
    )
    runtime.createRoot(() => runtime.ifBlock(anchor, () => show() ? 0 : null, [block]))
    runtime.flushSync()
    await Promise.resolve()
    setShow(false)
    runtime.flushSync()
    expect(container.querySelector('p')?.style.opacity).toBe('0')
    await v.advance(249)
    expect(container.querySelector('p')).toBeTruthy()
    await v.advance(1)
    expect(container.querySelector('p')).toBeFalsy()
  })
})

describe('the drive hook, globalThis.__fjsClock', () => {
  afterEach(() => { delete globalThis.__fjsClock })

  it('is what clock dispatches to when no source was installed, labels and all', async () => {
    const v = virtualClock(5000)
    globalThis.__fjsClock = v
    let fired = 0
    clock.after(100, () => fired++, '$.after')
    expect(clock.now()).toBe(5000)
    expect((await v.settle({ limit: 0 })).armed).toEqual(['$.after'])
    await v.advance(100)
    expect(fired).toBe(1)
  })

  it('loses to a source installed explicitly, and the DOM source answers once it is gone', async () => {
    const page = virtualClock(5000)
    const test = virtualClock(0)
    globalThis.__fjsClock = page
    clock.use(test)
    expect(clock.now()).toBe(0)
    clock.use(null)
    expect(clock.now()).toBe(5000)
    delete globalThis.__fjsClock
    expect(Math.abs(clock.now() - Date.now())).toBeLessThan(1000)
  })

  it('imports nothing, because the drive injects the file as text', async () => {
    const { default: text } = await import('../src/clock.js?raw')
    expect(text.match(/^import\b.*$/gm)).toBeNull()
  })
})
