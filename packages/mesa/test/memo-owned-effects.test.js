// memo-owned-effects.test.js
//
// A handle built inside a derivation — `const list = blocks.list({ where: {
// pageId } })` over a prop, which FJS-D212 makes a memo — opens an effect or
// registers a teardown while the memo computes. The memo set the listener and
// left the OWNER alone, so those landed on whatever was reading: on first read
// that is a render effect, and its next run prunes the children it believes it
// built (`FJS-852`). The list stopped hearing announcements and presence left
// its room in the tick it joined, both after one good read (`FJS-1747`).
//
// The memo owns what its body builds: replaced when it recomputes, disposed
// with the component, untouched by the effects that read it.

import { describe, test, expect, beforeAll } from 'vitest'
import { compile } from '../src/compiler.js'
import * as runtime from '../src/runtime.js'

let createSignal, createEffect, createMemo, createRoot, flushSync, onCleanup

beforeAll(async () => {
  const { Window } = await import('happy-dom')
  const win = new Window({ url: 'http://localhost/' })
  for (const k of ['document', 'HTMLElement', 'Node', 'Event', 'Comment']) {
    try { Object.defineProperty(globalThis, k, { value: win[k], configurable: true, writable: true }) } catch {}
  }
  globalThis.window = win
  ;({ createSignal, createEffect, createMemo, createRoot, flushSync, onCleanup } = runtime)
})

describe('a memo owns the effects its body creates', () => {

  test('a reader re-running does not dispose them', () => {
    const [feed, setFeed] = createSignal(0)
    const [other, setOther] = createSignal(0)
    let heard = 0, left = 0

    createRoot(() => {
      const handle = createMemo(() => {
        createEffect(() => { feed(); heard++ })
        onCleanup(() => { left++ })
        return {}
      })
      createEffect(() => { handle(); other() })
    })
    expect(heard).toBe(1)

    setOther(1)
    flushSync()
    expect(left).toBe(0)

    setFeed(1)
    flushSync()
    expect(heard).toBe(2)
  })

  test('a recompute replaces them and disposal ends them', () => {
    const [key, setKey] = createSignal('a')
    const [feed, setFeed] = createSignal(0)
    const heard = [], left = []

    const dispose = createRoot((d) => {
      const handle = createMemo(() => {
        const k = key()
        createEffect(() => { feed(); heard.push(k) })
        onCleanup(() => { left.push(k) })
        return k
      })
      createEffect(() => { handle() })
      return d
    })

    setKey('b')
    flushSync()
    expect(left).toEqual(['a'])

    heard.length = 0
    setFeed(1)
    flushSync()
    // Only the handle the current computation built is still listening.
    expect(heard).toEqual(['b'])

    dispose()
    expect(left).toEqual(['a', 'b'])
  })
})

// The shape the stressor wrote: a const over a prop calling a factory that
// opens an effect, read by the template beside a value that moves on its own.
describe('a const handle over a prop keeps listening (FJS-1747)', () => {
  function execCompiled(code, mock = {}) {
    const importNames = [], importValues = []
    for (const m of code.matchAll(/^import\s+\{([^}]+)\}\s+from\s+'[^']+';$/gm)) {
      m[1].split(',').forEach(spec => {
        const [o, a] = spec.split(/\s+as\s+/)
        importNames.push((a || o).trim())
        importValues.push(mock[o.trim()])
      })
    }
    code = code.replace(/^import\s+.+?from\s+'[^']+';$/gm, '').trim()
    code = code.replace(/^export default\s+/m, 'const __component = ')
    code += '\nreturn __component'
    return new Function('$$runtime', ...importNames, code)(runtime, ...importValues)
  }

  test('an announcement after the template re-renders still reaches the list', async () => {
    const [announced, announce] = runtime.createSignal(0)
    const [tick, setTick] = runtime.createSignal(0)
    let finds = 0
    const blocks = {
      list({ where }) {
        const [rows, setRows] = runtime.createSignal(0)
        runtime.createEffect(() => { announced(); finds++; setRows(finds) })
        return { where, rows }
      }
    }
    const src = `<script>
import { blocks, tick } from './res.js'
export let pageId
const list = blocks.list({ where: { pageId } })
</script>
<p>{list.rows()}:{tick()}</p>`
    const ctx = await compile(src, { debug: false, css: false })
    if (ctx.analysis.errors.length) throw new Error(ctx.analysis.errors[0])
    const Component = execCompiled(ctx.result, { blocks, tick })
    const container = document.createElement('div')
    document.body.appendChild(container)
    const anchor = document.createComment('')
    container.appendChild(anchor)
    runtime.createRoot(() => { Component(anchor, { pageId: 'p1' }, null) })
    runtime.flushSync()
    expect(finds).toBe(1)

    setTick(1)
    runtime.flushSync()
    announce(1)
    runtime.flushSync()
    expect(finds).toBe(2)
    expect(container.textContent).toBe('2:1')
  })
})
