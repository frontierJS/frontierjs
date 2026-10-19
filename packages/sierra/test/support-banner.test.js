// @vitest-environment happy-dom
//
// support-banner.test.js — the banner an app no longer hand-writes (FJS-2838).
//
// The real SupportBanner.mesa, compiled by the workspace's mesa and run on its
// runtime, with sierra's session, client and refresh handed in. It renders from
// `session.user.support` and from nothing else, so a banner never outlives the
// episode, and Stop ends the episode and then asks who the caller is now.

import { describe, it, expect, beforeEach, vi } from 'vitest'
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

const src = readFileSync(resolve(here, '../src/resource/SupportBanner.mesa'), 'utf8')

let session, endSupport, refresh
async function mount(props = {}) {
  const Banner = await build(src, '/SupportBanner.mesa', {
    session, refresh, getClient: () => ({ auth: { endSupport } }),
  })
  const wrap = document.createElement('div')
  document.body.appendChild(wrap)
  const anchor = document.createElement('span')
  wrap.appendChild(anchor)
  runtime.mount(anchor, Banner, { props })
  await settle()
  return wrap
}

beforeEach(() => {
  document.body.innerHTML = ''
  session = runtime.watchProxy({ user: { id: 1, support: { reason: 'billing question' } } })
  endSupport = vi.fn(async () => ({ ended: true }))
  refresh = vi.fn(async () => { session.user = { id: 2 } })
})

describe('SupportBanner', () => {
  it('shows the reason while the principal carries a support episode', async () => {
    const wrap = await mount()
    expect(wrap.querySelector('[role="alert"].alert.warning')).not.toBeNull()
    expect(wrap.textContent).toContain('billing question')
  })

  it('renders nothing when the principal carries none', async () => {
    session.user = { id: 1 }
    const wrap = await mount()
    expect(wrap.querySelector('[role="alert"]')).toBeNull()
  })

  it('Stop ends the episode, then asks who the caller is, then calls onend', async () => {
    const order = []
    endSupport.mockImplementation(async () => { order.push('end') })
    refresh.mockImplementation(async () => { order.push('refresh'); session.user = { id: 2 } })
    const onend = vi.fn(() => order.push('onend'))
    const wrap = await mount({ onend })
    wrap.querySelector('button').click()
    await settle()
    await settle()
    expect(order).toEqual(['end', 'refresh', 'onend'])
    expect(wrap.querySelector('[role="alert"]')).toBeNull()
  })
})
