/**
 * FJS-1929: `class:x` / `part:x` on a COMPONENT tag compiled to a prop named
 * "class:x" that nothing reads, so the style was dropped with no word. On an
 * element `class:x={cond}` is a toggle and stays legal.
 */

import { describe, it, expect } from 'vitest'
import { compile } from '../src/compiler.js'

async function errorsOf(source) {
  const ctx = await compile(source, { filename: 'Probe.mesa', warning: () => {} })
  return ctx.analysis?.errors ?? []
}

const WITH_CARD = `<script>
  import Card from './Card.mesa'
</script>
`

describe('class:/part: on a component tag (FJS-1929)', () => {
  it('refuses class:name on a component, naming {class} passthrough', async () => {
    const errors = await errorsOf(WITH_CARD + `<Card class:header="tight" />`)
    expect(errors.some((e) => e.includes('class:header') && e.includes('<Card ') && e.includes('class='))).toBe(true)
  })

  it('refuses part:name on a component', async () => {
    const errors = await errorsOf(WITH_CARD + `<Card part:header="tight" />`)
    expect(errors.some((e) => e.includes('part:header') && e.includes('<Card '))).toBe(true)
  })

  it('refuses the toggle form class:name={expr} too', async () => {
    const errors = await errorsOf(WITH_CARD + `<Card class:active={on} />`)
    expect(errors.some((e) => e.includes('class:active'))).toBe(true)
  })

  it('still allows class:name on an element, and plain class on a component', async () => {
    const errors = await errorsOf(WITH_CARD + `<div class:active={true}></div><Card class="raised" />`)
    expect(errors.filter((e) => e.includes('class:'))).toEqual([])
  })
})
