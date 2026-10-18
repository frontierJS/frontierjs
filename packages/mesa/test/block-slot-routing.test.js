/**
 * `slot=` is an attribute on an ELEMENT, so `{#if c}<b slot="actions"/>{/if}`
 * used to put the whole block in the DEFAULT slot (`FJS-607`). The caller was
 * then read as having written the component's content themselves, and a
 * component that branches on `$slots.default` — `<Form>` deciding whether to
 * generate its field list — turned itself off. The failure was total and
 * silent: every field gone, the form still submitting.
 *
 * A block whose every branch is slotted with one name belongs to that slot.
 * Where the branches disagree, or slotted and unslotted content are mixed, the
 * block cannot belong anywhere and the compiler says so — that case is
 * unchanged behavior plus a warning, never a guess.
 */
import { describe, it, expect } from 'vitest'
import { compileSource } from '../src/compiler.js'

const build = async (tpl) => {
  const warnings = []
  const ctx = await compileSource(
    `<script>import Child from './Child.mesa'\nlet c = true\nlet xs = [1]</script>\n<div>${tpl}</div>`,
    { filename: '/P.mesa', warning: (w) => warnings.push(w.message ?? String(w)) })
  // The props the call passes: every slot is a snippet prop by now (`FJS-D668`),
  // the default slot's under `children`.
  const call = ctx.result.match(/Child\(\$\$el\d+, (\{[\s\S]*?\})\);\n/)?.[1] ?? ''
  return { call, warnings: warnings.filter((w) => w.includes('slot')) }
}

describe('a block whose every branch is slotted', () => {
  it('{#if} with one slotted child goes to that slot', async () => {
    const { call, warnings } = await build(`<Child>{#if c}<b slot="actions">A</b>{/if}</Child>`)
    expect(call).toContain('actions: $$snip')
    expect(call).not.toContain('children: $$snip')
    expect(warnings).toEqual([])
  })

  it('{#if}/{:else} agreeing on one slot goes to it', async () => {
    const { call } = await build(
      `<Child>{#if c}<b slot="actions">A</b>{:else}<i slot="actions">B</i>{/if}</Child>`)
    expect(call).toContain('actions: $$snip')
    expect(call).not.toContain('children: $$snip')
  })

  it('{#each} of slotted children goes to the slot', async () => {
    const { call } = await build(`<Child>{#each xs as x}<b slot="actions">{x}</b>{/each}</Child>`)
    expect(call).toContain('actions: $$snip')
  })

  it('the slot= attribute does not survive into the rendered element', async () => {
    const { call } = await build(`<Child>{#if c}<b slot="actions">A</b>{/if}</Child>`)
    expect(call).not.toContain('slot=')
  })
})

describe('a block that cannot belong to one slot', () => {
  it('branches naming different slots stay default, and say so', async () => {
    const { call, warnings } = await build(
      `<Child>{#if c}<b slot="x">A</b>{:else}<i slot="y">B</i>{/if}</Child>`)
    expect(call).toContain('children: $$snip')
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('more than one slot')
    expect(warnings[0]).toMatch(/x|y/)
  })

  it('slotted beside unslotted stays default, and says so', async () => {
    const { call, warnings } = await build(`<Child>{#if c}<b slot="x">A</b><p>p</p>{/if}</Child>`)
    expect(call).toContain('children: $$snip')
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('mixes slotted and unslotted')
  })
})

describe('what must not change', () => {
  it('an ordinary block is still default content, silently', async () => {
    const { call, warnings } = await build(`<Child>{#if c}<p>body</p>{/if}</Child>`)
    expect(call).toContain('children: $$snip')
    expect(warnings).toEqual([])
  })

  it('a directly slotted element is unaffected', async () => {
    const { call, warnings } = await build(`<Child><b slot="actions">A</b></Child>`)
    expect(call).toContain('actions: $$snip')
    expect(warnings).toEqual([])
  })

  it('a slotted element beside default content still splits', async () => {
    const { call } = await build(`<Child><b slot="actions">A</b><p>body</p></Child>`)
    expect(call).toContain('actions: $$snip')
    expect(call).toContain('children: $$snip')
  })

  it('slot="default" joins the default content instead of being a second default key', async () => {
    const ctx = await compileSource(
      `<script>import Child from './Child.mesa'</script>\n<div><Child><b slot="default">A</b><p>P</p></Child></div>`,
      { filename: '/P.mesa' })
    expect(ctx.result.match(/children: \$\$snip/g)).toHaveLength(1)
    expect(ctx.result).toContain('`<b>A</b><p>P</p>`')
  })

  it('a block routed to a slot leaves a nested call\'s own slot= to that call', async () => {
    const ctx = await compileSource(
      `<script>import Child from './Child.mesa'\nlet c = true</script>\n` +
      `<div><Child>{#if c}<div slot="a"><Child><b slot="x">X</b></Child></div>{/if}</Child></div>`,
      { filename: '/P.mesa' })
    expect(ctx.result).toContain('a: $$snip')
    expect(ctx.result).toContain('x: $$snip')
  })
})

describe('a slot is a snippet with no arguments (FJS-D668)', () => {
  const errorsOf = async (src) => {
    const warned = []
    await compileSource(src, { filename: '/P.mesa', warning: (w) => warned.push(w.message ?? String(w)) })
    return warned
  }

  it('content given twice under one name is refused, naming both spellings', async () => {
    const warned = await errorsOf(`<script>import Child from './Child.mesa'</script>\n` +
      `<Child><b slot="actions">A</b>{#snippet actions()}<i>B</i>{/snippet}</Child>`)
    expect(warned.some((w) => w.includes('given "actions" twice') && w.includes('slot="actions"'))).toBe(true)
  })

  it('a slot name no snippet can carry is refused with the identifier to write', async () => {
    const warned = await errorsOf(`<script>import Child from './Child.mesa'</script>\n` +
      `<Child><b slot="side-bar">A</b></Child>`)
    expect(warned.some((w) => w.includes('"side-bar"') && w.includes("'sideBar'"))).toBe(true)
  })

  it('a prop written under the same name overrides the content, which is its fallback', async () => {
    const src = `<script>import Form from './Form.mesa'\nexport let actions = null</script>\n` +
      `<Form {actions}><b slot="actions">go</b></Form>`
    const dom = await compileSource(src, { filename: '/O.mesa' })
    expect(dom.result).toMatch(/Form\(\$\$el\d+, \{actions: \(\$\$runtime\.get\(\$\$sig_actions\)\) \?\? \$\$snip\d+_actions\}\)/)
    const tui = await compileSource(src, { filename: '/O.mesa', target: 'terminal' })
    expect(tui.result).toMatch(/Form\(\$\$m\d+, \{actions: \(\$\$runtime\.get\(\$\$sig_actions\)\) \?\? \$\$snip\d+_actions\}\)/)
  })

  it('a <slot> declares the prop it reads, once, beside one the script declares', async () => {
    const ctx = await compileSource(`<script>export let header = null</script>\n` +
      `<div><slot name="header" /><slot /><slot /></div>`, { filename: '/C.mesa' })
    expect(ctx.result.match(/makeExternalProperty\('header'/g)).toHaveLength(1)
    expect(ctx.result.match(/makeExternalProperty\('children'/g)).toHaveLength(1)
  })
})
