/**
 * <mesa:window|document|body onevent|modifier={fn}> takes the same modifiers an
 * element does (FJS-1627).
 *
 * The global-target branch kept only the four guards and emitted
 * `addGlobalEvent(target, event, handler)` with no options, so `|capture`
 * registered a bubble-phase listener and `|once`, `|passive`, `|debounce` and
 * `|throttle` did nothing — while the same modifier on an element worked and an
 * unknown one was refused. A page that takes a key in the capture phase to get
 * ahead of a control inside it ran second.
 */

import { describe, it, expect } from 'vitest'
import { compile } from '../src/compiler.js'

const cx = (src) => compile(src, { debug: false, css: false })
const globalCall = (out) => out.result.split('\n').find((l) => l.includes('addGlobalEvent('))

describe('<mesa:window> event modifiers', () => {
  it('|capture reaches addEventListener as an option', async () => {
    const out = await cx(`<mesa:window onkeydown|capture={(e) => {}} />`)
    expect(out.analysis.errors).toEqual([])
    expect(globalCall(out)).toContain('{ capture: true }')
  })

  it('|once and |passive are passed together', async () => {
    const out = await cx(`<mesa:document onscroll|once|passive={() => {}} />`)
    expect(out.analysis.errors).toEqual([])
    expect(globalCall(out)).toContain('once: true')
    expect(globalCall(out)).toContain('passive: true')
  })

  it('|debounce and |throttle wrap the handler', async () => {
    const d = await cx(`<mesa:window onresize|debounce(200)={() => {}} />`)
    expect(d.analysis.errors).toEqual([])
    expect(globalCall(d)).toContain('$$runtime.debounce(')
    const t = await cx(`<mesa:body onmousemove|throttle(50)={() => {}} />`)
    expect(t.analysis.errors).toEqual([])
    expect(globalCall(t)).toContain('$$runtime.throttle(')
  })

  it('a guard still wraps the handler beside an option', async () => {
    const out = await cx(`<mesa:window onkeydown|preventDefault|capture={() => {}} />`)
    expect(globalCall(out)).toContain('$$e.preventDefault()')
    expect(globalCall(out)).toContain('capture: true')
  })

  it('refuses an unknown modifier by name, as an element does', async () => {
    const out = await cx(`<mesa:window onkeydown|captrue={() => {}} />`)
    expect(out.analysis.errors.join('')).toContain(`Unknown event modifier 'captrue'`)
  })

  it('a bare listener passes no options', async () => {
    const out = await cx(`<mesa:window onkeydown={() => {}} />`)
    expect(globalCall(out)).not.toContain('{ ')
  })
})
