/**
 * A `debugLabel` build names each anchor comment for the block it anchors
 * (`FJS-936`). Every anchor is written into the compiled TEMPLATE STRING, so
 * the test reads the string rather than a render.
 */
import { describe, it, expect } from 'vitest'
import { compileSource } from '../src/compiler.js'

const anchors = async (body, { debugLabel = true } = {}) => {
  const ctx = await compileSource(
    `<script>let a = [1]\nlet ok = true\nlet p = Promise.resolve(1)</script>\n${body}`,
    { filename: 'T.mesa', css: false, dev: true, debug: true, debugLabel, loc: false })
  expect(ctx.analysis.errors).toEqual([])
  return [...ctx.result.matchAll(/<!--(.*?)-->/g)].map((m) => m[1])
}

describe('debugLabel anchors', () => {
  it('never write the word undefined', async () => {
    const found = await anchors(
      `<div>{#each a as x}<i>{x}</i>{/each}{#if ok}<b>y</b>{/if}` +
      `{#key ok}<u>k</u>{/key}{#await p}<s>w</s>{:then v}<s>{v}</s>{/await}</div>`)
    expect(found.length).toBeGreaterThan(0)
    for (const data of found) expect(data).not.toContain('undefined')
  })

  it('name the block kind', async () => {
    const found = await anchors(`<div>{#each a as x}<i>{x}</i>{/each}{#if ok}<b>y</b>{/if}</div>`)
    expect(found).toContain('$ each ')
    expect(found).toContain('$ if ')
  })

  it('stay unnamed without debugLabel', async () => {
    const found = await anchors(`<div>{#if ok}<b>y</b>{/if}</div>`, { debugLabel: false })
    expect(found).toEqual([])
  })
})

describe('debugLabel component anchors', () => {
  it('name the component', async () => {
    const ctx = await compileSource(
      `<script>import Card from './Card.mesa'</script>\n<div><Card /></div>`,
      { filename: 'T.mesa', css: false, dev: true, debug: true, debugLabel: true, loc: false })
    expect(ctx.result).toContain('<!--$ Card -->')
  })
})
