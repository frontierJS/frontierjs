/**
 * Children handed to a component with no `<slot>` for them are dropped, and
 * were dropped in silence (`FJS-926`).
 *
 * The grading is against the slot names the child's own template DECLARES.
 * Svelte's equivalent grades against what has been RENDERED and has answered
 * the resulting false positive twice — a component whose `<slot>` sits inside
 * an `{#if}` has rendered nothing at the moment the check runs. Those two
 * shapes are the controls here, and they are the reason the test exists.
 */
import { describe, it, expect, beforeEach } from 'vitest'
import { writeFileSync, unlinkSync } from 'node:fs'
import path from 'node:path'
import { compileSource } from '../src/compiler.js'
import { flushSync, mount, resetSlotWarnings } from '../src/runtime.js'

// Written into the package root and unlinked as soon as they are imported,
// which is what the other compiled-fixture suites here do. Not a temp
// directory: vitest resolves a dynamic import through Vite, which refuses a
// path outside the project root — and a directory left behind shows up as an
// untracked path somebody has to ask about.
const DIR = process.cwd()
let n = 0

/** Compile a child and a parent that calls it, mount, return what was warned. */
async function run(childSrc, parentBody) {
  const id = n++
  const childFile = path.join(DIR, `_slot_Child${id}.mesa`)
  writeFileSync(childFile, childSrc)

  const written = [childFile]
  const compileTo = async (src, file) => {
    const ctx = await compileSource(src, { filename: file, dev: false })
    const js = ctx.result
      .replace(/'@frontierjs\/mesa\/runtime\.js'/g, `'${path.join(DIR, 'src/runtime.js')}'`)
      .replace(/'\.\/Child\.mesa'/g, `'./_slot_Child${id}.mjs'`)
    const out = file.replace(/\.mesa$/, '.mjs')
    writeFileSync(out, js)
    written.push(out)
    return out
  }

  await compileTo(childSrc, childFile)
  const parentFile = path.join(DIR, `_slot_Parent${id}.mesa`)
  const parentSrc = `<script>import Child from './Child.mesa'</script>\n${parentBody}`
  writeFileSync(parentFile, parentSrc)
  written.push(parentFile)
  const parentOut = await compileTo(parentSrc, parentFile)

  let Comp
  try { Comp = (await import('file://' + parentOut)).default }
  finally { for (const f of written) { try { unlinkSync(f) } catch {} } }
  const seen = []
  const real = console.warn
  console.warn = (...a) => seen.push(a.join(' '))
  try {
    const wrap = document.createElement('div')
    document.body.appendChild(wrap)
    const label = document.createElement('span')
    wrap.appendChild(label)
    mount(label, Comp, { props: {} })
    flushSync()
    return { warnings: seen.filter((w) => w.includes('[Mesa]')), html: wrap.innerHTML, child: `_slot_Child${id}` }
  } finally { console.warn = real }
}

beforeEach(() => { resetSlotWarnings(); document.body.innerHTML = '' })

describe('a component that cannot render the children it was given', () => {
  it('names itself, the content, and what it does render', async () => {
    const { warnings, child } = await run(
      `<script>export let text = ''</script>\n<button>{text}</button>`,
      `<div><Child text="a">GO</Child></div>`)
    expect(warnings.length).toBe(1)
    // Derived from the fixture's own name rather than written out: the file
    // name IS the component name, so a literal here breaks whenever the
    // fixture is renamed and says nothing about the warning.
    expect(warnings[0]).toContain(`<${child}>`)
    expect(warnings[0]).toContain('children')
    expect(warnings[0]).toContain('renders no slots at all')
  })

  it('names the other slots when it has some', async () => {
    const { warnings } = await run(
      `<div><slot name="left" /></div>`,
      `<div><Child><span slot="right">R</span></Child></div>`)
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('slot "right"')
    expect(warnings[0]).toContain('<slot name="left" />')
  })

  it('warns once, not once per instance', async () => {
    const { warnings } = await run(
      `<script>export let text = ''</script>\n<button>{text}</button>`,
      `<div>{#each [1, 2, 3] as i}<Child>GO</Child>{/each}</div>`)
    expect(warnings.length).toBe(1)
  })
})

describe('the shapes that must NOT warn', () => {
  it('a slot rendered inside an {#if} — Svelte #4546 / #6325', async () => {
    const { warnings, html } = await run(
      `<div>{#if $slots.default}<slot />{/if}</div>`,
      `<div><Child>KEPT</Child></div>`)
    expect(warnings).toEqual([])
    expect(html).toContain('KEPT')
  })

  it('a slot behind a condition that is FALSE — the accordion', async () => {
    // The children are genuinely not rendered, and that is the component
    // working. A check that graded what has been rendered would warn here.
    const { warnings, html } = await run(
      `<script>export let open = false</script>\n<div>{#if open}<slot />{/if}</div>`,
      `<div><Child>HIDDEN</Child></div>`)
    expect(warnings).toEqual([])
    expect(html).not.toContain('HIDDEN')
  })

  it('whitespace-only children pass no block at all — Svelte PR #4501', async () => {
    const { warnings } = await run(
      `<script>export let text = ''</script>\n<button>{text}</button>`,
      `<div><Child>\n  \n</Child></div>`)
    expect(warnings).toEqual([])
  })

  it('an ordinary component that renders its children', async () => {
    const { warnings, html } = await run(
      `<div><slot /></div>`,
      `<div><Child>KEPT</Child></div>`)
    expect(warnings).toEqual([])
    expect(html).toContain('KEPT')
  })
})
