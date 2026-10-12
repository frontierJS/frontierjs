/*
 * selection.spec.mjs — createSelection, Checkbox `indeterminate` and BulkBar
 * on one screen (FJS-D671).
 *
 * What only a browser shows: that a template re-renders off the selection's
 * signal with no `$:` (the row boxes, the header tri-state, the bar's count),
 * that `indeterminate` reaches the DOM PROPERTY and Chrome tells assistive
 * tech `mixed`, and that a press on a part-ticked header ticks the rest — the
 * browser flips an indeterminate box to checked, which is what makes
 * `onchange={(on) => s.set(rows, on)}` the whole header handler.
 *
 * The pure semantics (order, retain, no-op writes) are `test/selection.mjs`.
 */
export const name = 'Selection'
export const covers = ['forms/Checkbox', 'display/BulkBar']

const prop = (sel, p) => `document.querySelector(${JSON.stringify(sel)}).${p}`

export async function run(t) {
  await t.mount('selection')

  t.is(await t.evaluate(`return document.querySelector('[data-bar]');`), null,
    'the bar renders nothing while nothing is ticked')
  t.is(await t.evaluate(`return ${prop('[data-all]', 'indeterminate')};`), false,
    'an empty selection: the header box is not mixed')

  await t.clickAt('[data-row="message:7"]')
  await t.eventually(prop('[data-row="message:7"]', 'checked'), true, 'select one: its box is ticked')
  await t.eventually(prop('[data-row="task:7"]', 'checked'), false,
    'ticket 7 is not ticked by message 7 — the two kinds are keyed apart')
  await t.eventually(prop('[data-all]', 'indeterminate'), true, 'one of four: the header box is mixed')
  t.is(await t.axProp('[data-all]', 'checked'), 'mixed', 'and Chrome reports it to assistive tech as mixed')
  await t.eventually(prop('[data-group-all="a"]', 'indeterminate'), true, 'group a is mixed')
  t.is(await t.evaluate(`return ${prop('[data-group-all="b"]', 'indeterminate')};`), false,
    'group b, untouched, is not — the tri-state is per group')
  await t.eventually(`document.querySelector('[data-bulk-count]')?.textContent.trim()`, '1 selected',
    'the bar appears with the count')

  await t.clickAt('[data-all]')
  await t.eventually(`window.__picked.count`, 4, 'pressing the mixed header ticks the rest')
  await t.eventually(prop('[data-all]', 'checked'), true, 'the header box is ticked')
  t.is(await t.evaluate(`return ${prop('[data-all]', 'indeterminate')};`), false,
    'and no longer mixed')
  t.is(await t.axProp('[data-all]', 'checked'), 'true', 'Chrome reports it checked')
  await t.eventually(`document.querySelector('[data-bulk-count]')?.textContent.trim()`, '4 selected', 'the bar counts four')

  await t.clickAt('[data-group-all="b"]')
  await t.eventually(prop('[data-group-all="b"]', 'checked'), false, 'a full group header unticks that group')
  await t.eventually(prop('[data-group-all="a"]', 'checked'), true, 'and leaves the other group ticked')
  await t.eventually(prop('[data-all]', 'indeterminate'), true, 'which leaves the whole list mixed again')

  // A key outlives its row's visibility: hide b with message 8 ticked, and
  // the header judges only what is shown while the bar still counts it.
  await t.clickAt('[data-row="message:8"]')
  await t.eventually(`window.__picked.count`, 3, 'message 8 ticked again')
  await t.clickAt('#hide-b')
  await t.eventually(`document.querySelector('[data-group="b"]')`, null, 'group b is off screen')
  await t.eventually(prop('[data-all]', 'checked'), true, 'the header box is all over the rows on screen')
  t.is(await t.evaluate(`return ${prop('[data-all]', 'indeterminate')};`), false, 'and not mixed')
  await t.eventually(`document.querySelector('[data-bulk-count]')?.textContent.trim()`, '3 selected',
    'the bar still counts the hidden row — the number is what the action will touch')
  await t.clickAt('#hide-b')

  // The slot holds the actions, and an action reads the keys.
  await t.clickAt('[data-act]')
  await t.eventually(`document.getElementById('acted').textContent`, 'message:7,task:7,message:8',
    'a bulk action is handed the keys, in the order ticked')
  await t.eventually(`document.querySelector('[data-bar]')`, null, 'and the bar goes once the action clears')

  // Clear is the bar's own.
  await t.clickAt('[data-row="task:9"]')
  await t.eventually(`!!document.querySelector('[data-bulk-clear]')`, true, 'the bar is back with one ticked')
  await t.clickAt('[data-bulk-clear]')
  await t.eventually(`window.__picked.count`, 0, 'Clear empties the selection')
  await t.eventually(`document.querySelector('[data-bar]')`, null, 'and the bar hides itself')
  await t.eventually(prop('[data-row="task:9"]', 'checked'), false, 'the row box is unticked')

  // indeterminate is set AND cleared on the element, by the prop alone.
  await t.clickAt('[data-row="task:9"]')
  await t.eventually(prop('[data-group-all="b"]', 'indeterminate'), true, 'the prop sets the property')
  await t.clickAt('[data-row="task:9"]')
  await t.eventually(prop('[data-group-all="b"]', 'indeterminate'), false, 'and clears it')
  t.is(await t.axProp('[data-group-all="b"]', 'checked'), 'false', 'Chrome reports it unchecked')

  // The browser clears the flag on a press. A caller still saying mixed has
  // nothing new to hand down, so the component has to put it back.
  t.is(await t.evaluate(`return ${prop('[data-held]', 'indeterminate')};`), true, 'a box held mixed starts mixed')
  await t.clickAt('[data-held]')
  await t.evaluate('await new Promise(r => setTimeout(r, 50)); return true;')
  t.is(await t.evaluate(`return ${prop('[data-held]', 'indeterminate')};`), true,
    'and is still mixed after a press its caller did not act on')
}
