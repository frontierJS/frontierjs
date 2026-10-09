/*
 * spread-element — `fixtures/SpreadEl.mesa`: `{...expr}` on an element, the
 * `$$tui.spread` owner. An input takes `value` and `placeholder` from one
 * object, a button its `onclick` and `disabled` from another, and both
 * objects are replaced while mounted.
 *
 * A green run pins three things: a function under `onclick` is the click
 * handler; a replaced object swaps the handler rather than stacking a second
 * one (stacked, Go would run inc and dec and leave n at 1, not 0); and a key
 * the object stops carrying is removed — the input's text clears. The last
 * step tells a skipped Go from a focused-but-inert one by where two Tabs
 * from Lock land: on Swap, which leaves n alone, or on Go, which would not.
 */
export const name = 'spread-element'

export async function run(t) {
  const SpreadEl = await t.compile('SpreadEl')
  await t.mount(SpreadEl)

  let frame = await t.frame()
  t.expectFrame(frame, ['ada', 'Go', 'Swap', 'Lock', 'n: 0'], 'the input takes its value from the spread')

  await t.tab()          // input
  await t.tab()          // Go
  await t.enter()
  frame = await t.frame()
  t.expectFrame(frame, ['n: 1'], 'a spread onclick is the click handler')

  await t.tab()          // Swap
  await t.enter()
  frame = await t.frame()
  t.ok(!frame.includes('ada'), 'a key the replaced object dropped is removed')
  t.expectFrame(frame, ['gone', 'Go'], 'and the one it carries is written')

  await t.tab()          // Lock
  await t.tab()          // input
  await t.tab()          // Go
  await t.enter()
  frame = await t.frame()
  t.expectFrame(frame, ['n: 0'], 'the replaced handler runs alone')

  await t.tab()          // Swap
  await t.tab()          // Lock
  await t.enter()
  await t.tab()          // input
  await t.tab()          // Go is out of the order: Swap
  await t.enter()
  frame = await t.frame()
  t.expectFrame(frame, ['n: 0'], 'disabled from a spread takes the button out of the Tab order')
}
