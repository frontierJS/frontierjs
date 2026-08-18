/**
 * slot-attributes.test.js — `<slot>` takes no attribute but `name`.
 *
 * `<slot tipId={tipId} />` compiled, rendered the caller's content and
 * delivered nothing; there is no `let:` directive to read such a value with
 * either, so the recommended spelling for a hole was also the one that could
 * not parameterise it. `@frontierjs/ui`'s `Tooltip` shipped the
 * documented-but-impossible form for as long as it existed (`FJS-299`).
 *
 * Silence was the one clearly wrong answer, so this is refused by name — the
 * same call as an unknown `mesa:*` element (`FJS-023`): a typo and a missing
 * feature must not be the same event. VISION RULE 35b.
 */
import { describe, test, expect } from 'vitest'
import { compileSource } from '../src/compiler.js'

async function errors(src) {
  const ctx = await compileSource(src, { filename: '/t/T.mesa' })
  return ctx.analysis?.errors ?? []
}

describe('<slot> attributes are refused', () => {

  test('an attribute on the default slot', async () => {
    const e = await errors('<script>export let tipId = 1</script><div><slot tipId={tipId} /></div>')
    expect(e).toHaveLength(1)
    expect(e[0]).toContain('<slot> takes no attributes')
    expect(e[0]).toContain('tipId')
  })

  test('names the slot it was written on', async () => {
    const e = await errors('<script>export let x = 1</script><div><slot:header foo={x} /></div>')
    expect(e[0]).toContain('<slot:header>')
  })

  test('points at the form that CAN pass a value', async () => {
    const e = await errors('<script>export let x = 1</script><div><slot foo={x} /></div>')
    expect(e[0]).toContain('export let children')
    expect(e[0]).toContain('@render')
  })

  // Everything a slot legitimately is. A refusal that also refuses these would
  // be worse than the silence it replaces.
  test.each([
    ['a bare default slot',        '<div><slot /></div>'],
    ['a named slot via elArg',     '<div><slot:header /></div>'],
    ['a named slot via attribute', '<div><slot name="header" /></div>'],
    ['fallback content',           '<div><slot:header><h1>fallback</h1></slot:header></div>'],
    ['the parent routing attribute', '<script>import C from "./C.mesa"</script><C><p slot="header">t</p></C>'],
  ])('%s still compiles', async (_label, src) => {
    expect(await errors(src)).toHaveLength(0)
  })
})
