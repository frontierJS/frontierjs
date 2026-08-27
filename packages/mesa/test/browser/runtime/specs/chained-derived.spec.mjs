/*
 * chained-derived — a block test that reads a `$:` derived rather than a `let`.
 *
 * The failure this was written from is silent and reads as a stale screen: the
 * derived recomputes, an attribute bound to it updates, and every `{#if}`
 * testing the same value renders nothing. Nothing throws and nothing warns
 * (`FJS-512`).
 *
 * It PASSES, and it always did — the cause was never the shape. Two blocks
 * separated by whitespace shared an anchor, and the whitespace at a component
 * ROOT is collapsed, so this fixture's blocks each had their own. What it pins
 * now is the shape itself, which is worth keeping: the attribute is asserted
 * before the blocks, deliberately, because that separates "the derived did not
 * recompute" from "the blocks did not re-run", which are different bugs with
 * different fixes.
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
