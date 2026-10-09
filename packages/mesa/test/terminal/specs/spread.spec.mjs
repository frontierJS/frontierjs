/*
 * spread — `fixtures/Spread.mesa` passes one object to `fixtures/Card.mesa`
 * twice with `{...card}`, the second time beside a written `title`.
 *
 * A green run pins that a spread reaches the child as props, that a written
 * prop wins over the spread whichever side of it it is written on (the DOM
 * path merges the written props last), and that replacing the spread object
 * pushes the new value into both children.
 */
export const name = 'spread'

export async function run(t) {
  const Spread = await t.compile('Spread')
  await t.mount(Spread, {}, { height: 16 })

  let frame = await t.frame()
  t.expectFrame(frame, ['Spread (1)', 'empty card', 'Pick', 'Written (1)', 'empty card', 'Pick', 'Bump'],
    'each card takes its props from the spread, the written title winning')
  t.ok(!frame.includes('Untitled'), 'no card fell back to its default title')

  await t.tab()          // Pick
  await t.tab()          // Pick
  await t.tab()          // Bump
  await t.enter()
  frame = await t.frame()
  t.expectFrame(frame, ['Spread (2)', 'Written (2)'], 'a replaced spread object repaints both children')
  t.ok(!frame.includes('Spread (1)') && !frame.includes('Written (1)'), 'and leaves no stale count')
}
