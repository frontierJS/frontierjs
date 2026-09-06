/*
 * nested delegation roots — Invariant 11, both halves.
 *
 * The nearest root owns an event and a handler fires ONCE. Two mounted trees
 * at different depths is the ordinary Sierra shape (an app at the page
 * container, an island inside it), and a handler written on a wrapper BETWEEN
 * them belongs to the outer root: no root nearer to it exists.
 *
 * Only a real browser can ask this. happy-dom has no delegation root at all in
 * mesa's vitest harness, so both halves — the dead handler and the double
 * fire — are invisible there.
 */
export const name = 'nested delegation roots (FJS-833)'
export const covers = ['delegation-root', 'invariant-11']

const plantInner = `
  const { mount } = await import('@frontierjs/mesa/runtime.js')
  const mod  = await import('/mesa/test/browser/runtime/fixtures/nested-inner.mesa')
  const host = document.querySelector('#inner-host')
  const label = document.createComment('inner')
  host.appendChild(label)
  window.__innerMount = mount(label, mod.default, { props: {}, root: host })
  await new Promise((r) => setTimeout(r, 0))
  return true
`

export async function run(t) {
  await t.mount('nested-outer')
  await t.evaluate(plantInner)

  try {
    // The click starts inside the INNER root and bubbles through `#wrap`,
    // which belongs to the outer root. Both must fire, each exactly once.
    await t.clickAt('#inner-btn')
    await t.eventually(`document.querySelector('#inner-hits').textContent`, '1',
      'the inner root delivers to its own handler')
    await t.eventually(`document.querySelector('#wrap-hits').textContent`, '1',
      'a handler on the wrapper BETWEEN two roots fires')

    // The other half of the invariant: nesting must not deliver twice.
    await t.clickAt('#inner-btn')
    await t.eventually(`document.querySelector('#wrap-hits').textContent`, '2',
      'and fires exactly once per click, not once per enclosing root')
    t.is(await t.evaluate(`return document.querySelector('#inner-hits').textContent;`), '2',
      'the inner handler is likewise delivered once')

    // Control: a click that never enters the inner root behaves as before.
    await t.clickAt('#sibling')
    await t.eventually(`document.querySelector('#sibling-hits').textContent`, '1',
      'a sibling outside the inner root still fires')
    t.is(await t.evaluate(`return document.querySelector('#wrap-hits').textContent;`), '3',
      'and the wrapper above it fires once more')
    t.is(await t.evaluate(`return document.querySelector('#inner-hits').textContent;`), '2',
      'while the inner root delivers nothing for an event it never saw')
  } finally {
    // The stage teardown destroys the OUTER mount only; the inner root would
    // stay registered on a detached node and take part in every later spec.
    await t.evaluate(`window.__innerMount?.destroy(); window.__innerMount = null; return true;`)
  }
}
