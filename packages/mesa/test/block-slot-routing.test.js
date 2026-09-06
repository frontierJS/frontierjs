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
  const call = ctx.result.match(/Child\(el\d+, \{\}, ([\s\S]*?)\);\n/)?.[1] ?? ''
  return { call, warnings: warnings.filter((w) => w.includes('slot')) }
}

describe('a block whose every branch is slotted', () => {
  it('{#if} with one slotted child goes to that slot', async () => {
    const { call, warnings } = await build(`<Child>{#if c}<b slot="actions">A</b>{/if}</Child>`)
    expect(call).toContain(`'actions':`)
    expect(call).not.toContain('default:')
    expect(warnings).toEqual([])
  })

  it('{#if}/{:else} agreeing on one slot goes to it', async () => {
    const { call } = await build(
      `<Child>{#if c}<b slot="actions">A</b>{:else}<i slot="actions">B</i>{/if}</Child>`)
    expect(call).toContain(`'actions':`)
    expect(call).not.toContain('default:')
  })

  it('{#each} of slotted children goes to the slot', async () => {
    const { call } = await build(`<Child>{#each xs as x}<b slot="actions">{x}</b>{/each}</Child>`)
    expect(call).toContain(`'actions':`)
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
    expect(call).toContain('default:')
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('more than one slot')
    expect(warnings[0]).toMatch(/x|y/)
  })

  it('slotted beside unslotted stays default, and says so', async () => {
    const { call, warnings } = await build(`<Child>{#if c}<b slot="x">A</b><p>p</p>{/if}</Child>`)
    expect(call).toContain('default:')
    expect(warnings.length).toBe(1)
    expect(warnings[0]).toContain('mixes slotted and unslotted')
  })
})

describe('what must not change', () => {
  it('an ordinary block is still default content, silently', async () => {
    const { call, warnings } = await build(`<Child>{#if c}<p>body</p>{/if}</Child>`)
    expect(call).toContain('default:')
    expect(warnings).toEqual([])
  })

  it('a directly slotted element is unaffected', async () => {
    const { call, warnings } = await build(`<Child><b slot="actions">A</b></Child>`)
    expect(call).toContain(`'actions':`)
    expect(warnings).toEqual([])
  })

  it('a slotted element beside default content still splits', async () => {
    const { call } = await build(`<Child><b slot="actions">A</b><p>body</p></Child>`)
    expect(call).toContain(`'actions':`)
    expect(call).toContain('default:')
  })
})
