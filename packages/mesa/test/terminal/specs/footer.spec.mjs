/*
 * footer — `fixtures/Long.mesa` with `fixtures/Status.mesa` mounted in
 * `footerOf(renderer)`, and `fixtures/Kinds.mesa` (`FJS-D987`).
 *
 * A green run pins that the footer takes the screen's last row and keeps it
 * while the page scrolls, Tab past the bottom edge and PageDown alike, so a
 * mode line is never carried off; and that a focused node answers `tagName`
 * and, on an input, the `type` a DOM handler reads — lower-cased, and `text`
 * where none was written.
 */
export const name = 'footer'

const lines = async (t) => (await t.frame()).split('\n').map((l) => l.replace(/[█▀▄]+$/, '').trimEnd())

export async function run(t) {
  const page = await t.mount(await t.compile('Long'), {}, { width: 40, height: 10 })
  t.tui.mount(await t.compile('Status'), { renderer: page.renderer, parent: t.tui.footerOf(page.renderer) })
  await t.settle()

  t.is((await lines(t))[9], 'status line', 'the footer takes the last row')
  t.is((await lines(t))[0], 'Top', 'and the page starts at the top, above it')

  await t.tab()
  await t.tab()
  await t.tab()
  t.is((await lines(t))[9], 'status line', 'focus past the bottom edge scrolls the page and not the footer')
  t.is((await lines(t))[8], '[ last ]', 'and brings the control on screen above it')

  await t.press('\x1b[5~')
  t.is((await lines(t))[9], 'status line', 'PageUp leaves it where it is')

  await t.mount(await t.compile('Kinds'))
  const seen = []
  for (let i = 0; i < 5; i++) {
    const node = t.tui.focusNext()
    seen.push(`${node.tagName}${node.type ? ':' + node.type : ''}`)
  }
  t.is(seen.join(' '), 'BUTTON INPUT:text INPUT:checkbox INPUT:email TEXTAREA', 'each node answers tagName, and an input its type')
}
