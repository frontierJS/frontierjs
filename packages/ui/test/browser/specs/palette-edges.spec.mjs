/*
 * palette-edges.spec.mjs — CommandPalette when its list or its action misbehaves.
 *
 * The fixture's default list is shared with palette.spec.mjs, so the two cases
 * that need a different one take their own: `kitShrink(n)` swaps `items` for
 * the first n commands, and `throwing` appends a command whose action throws
 * (`FJS-2894`).
 */
export const name = 'CommandPalette — shrinking list, throwing action'
export const covers = []

const rows = `[...document.querySelectorAll('.fjs-cp-row')]`
const activeLabel = `document.querySelector('.fjs-cp-row--active .item-title')?.textContent.trim()`

export async function run(t) {
  // Active on the last of six rows, then the list shrinks to three. An
  // unclamped cursor sat at 5 with no row there: nothing active, Enter inert.
  await t.mount('palette')
  await t.press('k', 2)
  await t.evaluate(`return await waitVisible('.fjs-cp-panel');`)
  for (let i = 0; i < 5; i++) await t.press('ArrowDown')
  t.is(await t.evaluate(`return ${activeLabel};`), 'Switch theme', 'the cursor starts on the last row')
  await t.evaluate(`window.kitShrink(3); return true;`)
  await t.eventually(`${rows}.length`, 3, 'the list shrinks to three')
  t.is(await t.evaluate(`return ${activeLabel};`), 'Refund an order',
    'a shrunken list keeps an active row, the last one left')
  await t.press('Enter')
  await t.eventually(`document.querySelector('#ran').textContent`, 'refund', 'and Enter runs it')

  // A throwing action propagates its error, and the palette still closes:
  // left open it sits over a command that has already failed.
  t.allow(/Error: boom/)
  await t.mount('palette', { throwing: true })
  await t.press('k', 2)
  await t.evaluate(`return await waitVisible('.fjs-cp-panel');`)
  await t.type('explode')
  await t.eventually(`${rows}.length`, 1, 'the throwing command is found')
  await t.press('Enter')
  await t.eventually(`document.querySelector('#ran').textContent`, 'boom', 'Enter ran the action, which threw')
  await t.evaluate(`await waitFor(() => !document.querySelector('.fjs-cp-panel')); return true;`)
  t.is(await t.evaluate(`return document.querySelectorAll('.fjs-cp-panel').length;`), 0,
    'the palette closes anyway')
}
