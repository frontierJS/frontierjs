/*
 * chained-derived — a block test that reads a `$:` derived rather than a `let`.
 *
 * The failure this was written from is silent and reads as a stale screen: the
 * derived recomputes, an attribute bound to it updates, and every `{#if}`
 * testing the same value keeps the branch it already had. Nothing throws and
 * nothing warns, so the only symptom is a control set describing the previous
 * state (`FJS-512`).
 *
 * It PASSES, and that is what it is for — the shape is ruled out rather than
 * reproduced. The attribute is asserted before the blocks, deliberately: it
 * separates "the derived did not recompute" from "the blocks did not re-run",
 * which are different bugs with different fixes.
 */
export const name = 'a block test reading a derived'
export const covers = ['chained-derived']

export async function run(t) {
  await t.mount('chained-derived')

  t.is(await t.evaluate(`return document.querySelector('#actions').dataset.moves;`), 'drain,reboot',
    'the derived starts correct')
  t.is(await t.evaluate(`return !!document.querySelector('#drain');`), true,
    'and the block reading it drew the matching control')
  t.is(await t.evaluate(`return !!document.querySelector('#undrain');`), false,
    'and drew nothing for a move that is not legal yet')

  await t.clickAt('#go')
  await t.eventually(`document.querySelector('#state').textContent`, 'draining',
    'the plain let moved')

  // The derived tracked the let — if this fails the rest is a different bug.
  await t.eventually(`document.querySelector('#actions').dataset.moves`, 'undrain',
    'the derived recomputed from it')

  t.is(await t.evaluate(`return !!document.querySelector('#undrain');`), true,
    'and the block testing the derived re-ran')
  t.is(await t.evaluate(`return !!document.querySelector('#drain');`), false,
    'and the branch that is no longer legal was torn down')
}
