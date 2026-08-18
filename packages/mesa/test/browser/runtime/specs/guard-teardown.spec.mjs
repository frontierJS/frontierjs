/*
 * {#if} as a guard — the block must be gone before its contents recompute.
 *
 * `FJS-303`. A jagged array behind a length check is the ordinary shape, and
 * the failure is a throw from inside an event handler: the component simply
 * stops responding, and nothing points at the guard.
 *
 * Two fixtures, because only one of them ever failed and the difference is the
 * whole diagnosis. A plain array read in a text interpolation was always fine.
 * What broke needed all three of: a DERIVED guarded value, so the change
 * arrives through the derivation layer rather than as an assignment; a FIXED
 * outer grid, so the block for a row the new value does not have is still
 * standing at the moment of the change; and a MEMO inside the guard —
 * `{@const}` — which the flush settled to quiescence before any block ran.
 */
export const name = '{#if} guards its own subtree (FJS-303)'
export const covers = ['if-guard', 'block-teardown-order']

export async function run(t) {
  await t.mount('guard-teardown')

  t.is(await t.evaluate(`return document.querySelectorAll('#grid .row').length;`), 3,
    'a plain array behind a guard renders its rows')

  await t.clickAt('#shrink')
  await t.eventually(`document.querySelectorAll('#grid .row').length`, '1',
    'and shrinking it leaves one')
  await t.clickAt('#grow')
  await t.eventually(`document.querySelectorAll('#grid .row').length`, '3',
    'and it grows back')

  // The shape that threw. `#next` moves from a 3-row value to a 1-row one.
  await t.mount('guard-derived')
  t.is(await t.evaluate(`return document.querySelectorAll('#grid .row').length;`), 3,
    'the derived shape renders its rows')
  t.is(await t.evaluate(`return document.querySelectorAll('#grid .cell').length;`), 7,
    'and only the non-zero cells inside the nested guard')

  await t.clickAt('#next')
  await t.eventually(`document.querySelectorAll('#grid .row').length`, '1',
    'a shorter derived value removes the rows it no longer has')
  t.is(await t.evaluate(`return document.querySelectorAll('#grid .cell').length;`), 3,
    'with the surviving row intact')

  // The assertions above can all pass over a component that threw mid-flush,
  // because a throw leaves the DOM wherever it got to. These are the ones that
  // say it is still alive.
  await t.clickAt('#prev')
  await t.eventually(`document.querySelectorAll('#grid .row').length`, '3',
    'and it goes back — the component still responds')
  await t.clickAt('#next')
  await t.eventually(`document.querySelectorAll('#grid .cell').length`, '3',
    'repeatedly, in both directions')
  t.is(await t.evaluate(`return document.querySelector('#month').textContent;`), '1',
    'with its own state intact')
}
