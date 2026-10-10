/*
 * enter — `fixtures/Enter.mesa`: `mouseenter` and `mouseleave`, the Tooltip
 * and DatePicker shape.
 *
 * A green run pins one event at each element the pointer comes onto or goes
 * off, leaves before enters, outermost entered first; that neither bubbles,
 * so the box is entered once while the pointer crosses its children; that a
 * link inside a line of prose is told apart from the words around it; and
 * that an element built under a still pointer is entered on the next frame.
 */
export const name = 'enter'

export async function run(t) {
  await t.mount(await t.compile('Enter'), {}, { width: 40, height: 10 })
  await t.settle()
  const log = async () => (await t.frame()).split('\n').find((l) => l.startsWith('log')).trim()

  t.is(await log(), 'log', 'no move, no event')

  await t.hover('alpha')
  t.is(await log(), 'log +box +a', 'onto a child: the box first, then the child')

  await t.hover('bravo')
  t.is(await log(), 'log +box +a -a +b', 'across siblings: one leaves, one enters, the box hears neither')

  await t.hover('see')
  t.is(await log(), 'log -a +b -b>p -box', 'off the box from inside it: innermost leaves first')

  await t.hover('charlie')
  t.is(await log(), 'log +b -b>p -box +box', 'back onto a child that listens to nothing: the box alone enters')

  await t.hover('docs')
  t.is(await log(), 'log -box +box -box +link', 'a link inside prose is entered on its own cells')

  await t.hover('here')
  t.is(await log(), 'log +box -box +link -link', 'and left on the words after it')

  await t.hover('floor')
  await t.press('l')
  await t.frame()
  t.is(await log(), 'log -box +link -link +late', 'an element drawn under a still pointer is entered')
}
