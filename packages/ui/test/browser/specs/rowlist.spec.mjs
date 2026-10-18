/*
 * rowlist.spec.mjs — rowlist (FJS-2009).
 *
 * A list of rows has no keyboard contract of its own, so a screen worked from
 * the keyboard writes one. What this holds is what a render cannot see: the
 * list is ONE tab stop, the cursor follows ↑/↓ and j/k, Enter opens and a key
 * selects, and none of it is taken from a field or a button inside a row.
 */
export const name = 'rowlist'
export const covers = []

const stops   = `[...document.querySelectorAll('#list [data-row]')].filter(r => r.tabIndex === 0).map(r => r.dataset.id).join(',')`
const focused = `document.activeElement?.dataset?.id ?? document.activeElement?.id`
const log     = `window.kitLog()`

export async function run(t) {
  await t.mount('rowlist')

  t.is(await t.evaluate(`return ${stops};`), '1', 'one row is the tab stop, the first by default')
  t.is(await t.evaluate(`return document.querySelectorAll('#list [data-row][tabindex="-1"]').length;`), 3,
    'every other row is -1')

  await t.evaluate(`document.querySelector('#before').focus(); return true;`)
  await t.press('Tab')
  t.is(await t.evaluate(`return ${focused};`), '1', 'Tab from outside lands on the cursor row')

  await t.press('ArrowDown')
  t.is(await t.evaluate(`return ${focused};`), '2', 'ArrowDown moves to the next row')
  t.is(await t.evaluate(`return ${stops};`), '2', 'and the tab stop moved with it')

  await t.press('j')
  t.is(await t.evaluate(`return ${focused};`), '4', 'j moves down and steps over a disabled row')
  await t.press('j')
  t.is(await t.evaluate(`return ${focused};`), '4', 'the cursor stops at the last row')
  await t.press('k')
  t.is(await t.evaluate(`return ${focused};`), '2', 'k moves up over the disabled row')
  await t.press('ArrowUp')
  await t.press('ArrowUp')
  t.is(await t.evaluate(`return ${focused};`), '1', 'the cursor stops at the first row')
  await t.press('End')
  t.is(await t.evaluate(`return ${focused};`), '4', 'End goes to the last row')
  await t.press('Home')
  t.is(await t.evaluate(`return ${focused};`), '1', 'Home goes to the first row')

  await t.press('Enter')
  await t.press('x')
  await t.press(' ')
  t.is(await t.evaluate(`return ${log};`), 'open:1,pick:1,pick:1', 'Enter opens; x and Space select')

  // Leaving and coming back returns to the row the cursor was on.
  await t.press('j')
  await t.evaluate(`document.querySelector('#after').focus(); return true;`)
  await t.evaluate(`document.querySelector('#before').focus(); return true;`)
  await t.press('Tab')
  t.is(await t.evaluate(`return ${focused};`), '2', 'Tab back into the list returns to the row it was left on')

  // The controls of the other rows are not stops: Tab goes through the cursor
  // row's own, then leaves the list.
  await t.press('Tab')
  t.is(await t.evaluate(`return ${focused};`), 'b2', 'Tab goes on into the cursor row\'s own controls')
  await t.press('Tab')
  await t.press('Tab')
  t.is(await t.evaluate(`return ${focused};`), 'after', 'and then out of the list, past every other row')
  await t.evaluate(`document.querySelector('#before').focus(); return true;`)
  await t.press('Tab')

  // Inside a row, keys belong to the control.
  await t.evaluate(`document.querySelector('#i2').focus(); return true;`)
  await t.type('jk x')
  t.is(await t.evaluate(`return document.querySelector('#i2').value;`), 'jk x', 'letters typed in a field are letters')
  t.is(await t.evaluate(`return ${focused};`), 'i2', 'and the cursor did not move')
  await t.evaluate(`document.querySelector('#b2').focus(); return true;`)
  await t.press('Enter')
  t.is(await t.evaluate(`return ${log};`), 'open:1,pick:1,pick:1,btn:2', 'Enter on a button inside a row is the button, not an open')

  // Clicking a row moves the cursor.
  await t.evaluate(`document.querySelector('#r4').focus(); return true;`)
  t.is(await t.evaluate(`return ${stops};`), '4', 'focus on a row moves the tab stop')

  // The list changes under the cursor.
  await t.evaluate(`window.kitDrop(4); return true;`)
  await t.eventually(stops, '2', 'a removed cursor row hands the stop to the row now in its place')
  await t.evaluate(`window.kitAdd(); return true;`)
  await t.eventually(`document.querySelectorAll('#list [data-row][tabindex="0"]').length`, 1, 'still exactly one stop after a row is added')
}
