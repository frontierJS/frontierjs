/*
 * hover — `fixtures/Hover.mesa`: `mousemove`, the Combobox shape.
 *
 * A green run pins a move with no button held arriving at the row under the
 * pointer and bubbling to the list once, so a row that moves the cursor on
 * hover does, and a press on it still clicks. Moving within a row fires again,
 * as it does per pixel in a browser.
 */
export const name = 'hover'

export async function run(t) {
  const Hover = await t.compile('Hover')
  await t.mount(Hover, {}, { height: 10 })
  await t.settle()

  let frame = await t.frame()
  t.expectFrame(frame, ['active -1 moves 0 heard 0', '  ann', '  bo'], 'no move, no cursor')

  await t.hover('bo')
  frame = await t.frame()
  t.expectFrame(frame, ['active 1 moves 1 heard 1', '  ann', '> bo'], 'a move reaches the row under the pointer and bubbles to the list once')

  await t.hover('cy')
  await t.hover('ann')
  frame = await t.frame()
  t.expectFrame(frame, ['active 0 moves 3 heard 3', '> ann', '  cy'], 'each move lands on the row it is over')

  await t.click('cy')
  frame = await t.frame()
  t.expectFrame(frame, ['picked cy'], 'a press on a row that listens to mousemove still clicks')
}
