/*
 * snippets — `fixtures/Snippets.mesa` renders a snippet it declares last, a
 * `<mesa:element>` whose tag moves, two snippets handed to `fixtures/Rows.mesa`
 * as props, and two `<svg>`s the author marked `aria-hidden`.
 *
 * A green run pins: a body's snippet is reachable from a `{@render}` written
 * above it; a snippet passed to a component is called by the child once per
 * row with GETTERS, so a new row and a parent signal both repaint it; the
 * optional `{@render empty?.()}` paints when the list empties; a changed tag
 * rebuilds the element once rather than adding a second; and the hidden
 * `<svg>`s are left out of the frame rather than refused at compile time.
 */
export const name = 'snippets'

const count = (frame, s) => frame.split(s).length - 1

export async function run(t) {
  const Snippets = await t.compile('Snippets')
  await t.mount(Snippets, {}, { height: 16 })

  let frame = await t.frame()
  t.expectFrame(frame, ['[top]', 'Title 2', '0: ant x0', '1: bee x0', 'More', 'Level', 'Clear', '[end]'],
    'a snippet rendered above and below its declaration, rows from a snippet prop')

  await t.tab()
  await t.enter()
  frame = await t.frame()
  t.expectFrame(frame, ['0: ant x1', '1: bee x1', '2: cat x1', 'More'],
    'a new row calls the snippet again, and the parent signal repaints every row')

  await t.tab()
  await t.enter()
  frame = await t.frame()
  t.expectFrame(frame, ['[top]', 'Title 3', '0: ant x1'], 'a changed tag rebuilds the element with its content')
  t.ok(count(frame, 'Title') === 1, 'and leaves one of it, not two')
  await t.enter()
  frame = await t.frame()
  t.ok(count(frame, 'Title 2') === 1 && count(frame, 'Title') === 1, 'and back again, still one')

  await t.tab()
  await t.enter()
  frame = await t.frame()
  t.expectFrame(frame, ['Title 2', 'none', 'More'], 'an emptied list paints the optional else snippet')
  t.ok(!frame.includes('ant'), 'and no row survives it')
}
