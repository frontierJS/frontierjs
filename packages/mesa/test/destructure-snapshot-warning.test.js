/**
 * FJS-2106 — `const { rows, loading } = r.tethered()` reads each getter once, at
 * setup, and a resource handle's getters read signals. D667: a dev build
 * checks the one temporary the expansion binds, at runtime, and says so when a
 * destructured key is an accessor. A plain object stays quiet.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { compile } from '../src/compiler.js'
import * as runtime from '../src/runtime.js'

function execCompiled(code) {
  code = code.replace(/^import\s+.+?from\s+'[^']+';$/gm, '').trim()
  code = code.replace(/^export default\s+/m, 'const __component = ')
  code += '\nreturn __component'
  return new Function('$$runtime', code)(runtime)
}

async function mount(src, config) {
  const ctx = await compile(src, { debug: false, css: false, ...config })
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
  return { text: () => container.textContent, ctx }
}

let warn
beforeEach(() => {
  runtime.resetDestructureWarnings()
  globalThis.makeHandle = () => ({ get rows() { return [1, 2] }, get loading() { return false }, plain: 7 })
  globalThis.makePlain = () => ({ rows: [1, 2], loading: false })
  warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => { warn.mockRestore(); delete globalThis.makeHandle; delete globalThis.makePlain })

const said = () => warn.mock.calls.map((c) => String(c[0]))

const handleSrc = `<script>
  const { rows, loading } = globalThis.makeHandle()
</script>
<p>{rows.length}|{loading}</p>`

describe('a destructure of a getter-holding value (FJS-2106)', () => {
  it('warns in a dev build, naming the keys that are accessors', async () => {
    const m = await mount(handleSrc, { dev: true })
    expect(m.text()).toBe('2|false')
    expect(said().some((s) => s.includes('rows') && s.includes('loading') && s.includes('getter'))).toBe(true)
  })

  it('names only the accessor keys among those destructured', async () => {
    await mount(`<script>
  const { rows, plain } = globalThis.makeHandle()
</script>
<p>{rows.length}|{plain}</p>`, { dev: true })
    const msg = said().find((s) => s.includes('getter'))
    expect(msg).toContain('rows')
    expect(msg).not.toContain('plain,')
  })

  it('stays quiet for a plain object', async () => {
    await mount(handleSrc.replace('makeHandle', 'makePlain'), { dev: true })
    expect(said()).toEqual([])
  })

  it('stays quiet in a production build, and emits nothing for it', async () => {
    const m = await mount(handleSrc, { dev: false })
    expect(said()).toEqual([])
    expect(m.ctx.result).not.toContain('destructure')
  })

  it('warns once per site', async () => {
    await mount(handleSrc, { dev: true })
    await mount(handleSrc, { dev: true })
    expect(said().filter((s) => s.includes('getter')).length).toBe(1)
  })

  it('calls the source once', async () => {
    let calls = 0
    globalThis.makeHandle = () => { calls++; return { get rows() { return [] }, get loading() { return false } } }
    await mount(handleSrc, { dev: true })
    expect(calls).toBe(1)
  })
})
