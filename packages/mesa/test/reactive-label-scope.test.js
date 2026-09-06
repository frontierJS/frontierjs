/**
 * RULE 1 — `$:` is top-level only, enforced (`FJS-877`).
 *
 * A `$:` nested in a function body was never visited by the pass that compiles
 * reactive labels, so it survived into the output as a plain JavaScript label
 * wrapping a one-shot assignment: the author asked for a derivation and got a
 * value that is right on the first call and stale after it, with the page still
 * rendering a plausible number.
 *
 * Every refusal below is PAIRED with the legitimate form one line away, because
 * a check that refused the top-level form too would satisfy any test that only
 * asked about the refusal.
 */
import { describe, it, expect } from 'vitest'
import { compile } from '../src/compiler.js'

const compileIt = (src) => compile(src, { filename: '/T.mesa', warning: () => {} })

const refusal = async (src) => {
  try { await compileIt(src); return null }
  catch (e) { return e.message }
}

describe('a nested $: is refused', () => {
  it('inside a function declaration', async () => {
    const msg = await refusal(`<script>
let a = 1
function go() {
  $: b = a * 2
  return b
}
</script>
<p>{go()}</p>`)
    expect(msg).toMatch(/top-level only \(RULE 1\)/)
    expect(msg).toContain('$: b = a * 2')          // it names the line
  })

  it('inside an arrow callback', async () => {
    const msg = await refusal(`<script>
let a = 1
const f = () => { $: c = a + 1 }
</script>
<p>{a}</p>`)
    expect(msg).toMatch(/top-level only/)
  })

  it('inside a plain block', async () => {
    const msg = await refusal(`<script>
let a = 1
if (a) { $: d = a + 1 }
</script>
<p>{a}</p>`)
    expect(msg).toMatch(/top-level only/)
  })

  it('a named debug label is the same rule', async () => {
    const msg = await refusal(`<script>
let a = 1
function go() { $_watch: a }
</script>
<p>{a}</p>`)
    expect(msg).toMatch(/top-level only/)
  })
})

describe('the legitimate forms still compile', () => {
  it('a top-level $: assignment', async () => {
    expect(await refusal(`<script>
let a = 1
$: b = a * 2
</script>
<p>{b}</p>`)).toBe(null)
  })

  it('a top-level $: block — its body is the label\'s own', async () => {
    expect(await refusal(`<script>
let a = 1
$: { a, () => console.log(a) }
</script>
<p>{a}</p>`)).toBe(null)
  })

  it('an ordinary JavaScript label in a function is not a Mesa label', async () => {
    expect(await refusal(`<script>
let a = 1
function go() {
  outer: for (let i = 0; i < 2; i++) break outer
  return a
}
</script>
<p>{go()}</p>`)).toBe(null)
  })
})
